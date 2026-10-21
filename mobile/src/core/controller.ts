import {
  UsbFrameSource,
  type Control,
  type ButtonDiagnostics,
} from "./usb-source";
import type { Frame } from "./wire";
import { WalkingScheduler } from "./scheduler";
import { ModuleRegistry } from "./modules";
import { OpenAITransport } from "./openai";
import { FeedbackManager } from "./feedback";
import { builtInModules, type ModuleHost } from "../modules/builtins";
import type { VidexModule } from "./modules";
import type { Rotation } from "./orientation";
export class AppController {
  readonly ai = new OpenAITransport();
  readonly registry = new ModuleRegistry();
  readonly feedback: FeedbackManager;
  readonly walking: WalkingScheduler;
  private listeners = new Set<() => void>();
  private source?: UsbFrameSource;
  private latest?: Frame;
  private previewBlocked?: Frame;
  private revision = 0;
  private generation = 0;
  private modeChain = Promise.resolve();
  private pendingSelections = 0;
  private resolutionReady = false;
  private lastDetection = "UNKNOWN";
  private epoch?: number;
  state = {
    mode: "walking",
    caption: "VIDEX를 눌러 진단에서 장치를 연결하세요.",
    connection: "DISCONNECTED",
    input: "영상 대기",
    walking: "UNKNOWN",
    reason: "영상 대기",
    processed: 0,
    dropped: 0,
    error: "",
    session: "idle",
    configured: false,
    rotation: "cw90" as Rotation,
    button: null as ButtonDiagnostics | null,
    buttonDispatch: null as {
      type: Control["type"];
      mode: string;
      at: number;
    } | null,
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  preview = () => ({
    frame:
      this.state.connection === "CONNECTED" &&
      !this.pendingSelections &&
      this.latest !== this.previewBlocked
        ? this.latest
        : undefined,
    rotation: this.state.rotation,
    version: this.generation,
    connection: this.state.connection,
  });
  private emit = () => {
    this.state.processed = this.walking?.processed ?? 0;
    this.state.dropped = this.walking?.dropped ?? 0;
    this.state.session =
      this.registry.get(this.state.mode)?.getStage?.() ?? "idle";
    this.revision++;
    this.listeners.forEach((f) => f());
  };
  constructor(modules: (host: ModuleHost) => VidexModule[] = builtInModules) {
    this.feedback = new FeedbackManager(
      this.ai,
      (text) => {
        this.state.caption = text;
        this.emit();
      },
      this.emit,
    );
    this.walking = new WalkingScheduler((result) => {
      this.state.walking = result.state;
      this.state.reason = result.reason;
      this.announceWalking();
      this.emit();
    });
    const host: ModuleHost = {
      ai: this.ai,
      walking: this.walking,
      frame: () => this.latest,
      ready: () => this.resolutionReady,
      rotation: () => this.state.rotation,
      say: (text, priority) => this.feedback.say(text, priority),
      error: (text) => {
        this.state.error = text;
        this.feedback.say(text, 2);
        this.emit();
      },
      changed: this.emit,
    };
    for (const module of modules(host)) this.registry.register(module);
    this.modeChain = this.registry.init(host);
  }
  configure(imageConsent: boolean, speechConsent: boolean, fallback: boolean) {
    this.disconnect();
    this.ai.configure(imageConsent, speechConsent);
    this.feedback.remoteSpeech = speechConsent;
    this.feedback.localFallback = fallback;
    const callbacks: [
      (frame: Frame) => void,
      (event: Control) => void,
      (state: string) => void,
    ] = [
      (frame) => {
        if (this.epoch === undefined) this.epoch = frame.epoch;
        else if (this.epoch !== frame.epoch) {
          this.invalidate();
          this.epoch = frame.epoch;
          void this.setResolution();
        }
        this.previewBlocked = undefined;
        this.latest = frame;
        this.state.input = `${frame.width}×${frame.height} · frame ${frame.frameId}`;
        this.registry.frame(frame);
        this.emit();
      },
      (event) => this.control(event),
      (state) => {
        this.state.connection = state;
        if (state === "CONNECTED") {
          // Negotiation may follow a final pre-hello CAM2 frame. Commit the
          // session here so its first frame cannot enqueue a second mode write.
          this.epoch = undefined;
          this.latest = undefined;
          void this.setResolution();
          this.feedback.say("장치가 연결되었습니다.", 0);
        } else {
          this.latest = undefined;
          this.state.input = "영상 대기";
          this.epoch = undefined;
          this.invalidate();
          this.walking.reset();
          if (state.startsWith("UNKNOWN") && this.state.configured)
            this.feedback.say("장치 연결을 확인할 수 없습니다.", 2);
        }
        this.emit();
      },
    ];
    this.source = new UsbFrameSource(
      ...callbacks,
      undefined,
      "legacy",
      (value) => {
        this.state.button = value;
        this.emit();
      },
    );
    this.state.configured = true;
    this.state.error = "";
    void this.source.start();
    this.emit();
  }
  private announceWalking() {
    if (this.pendingSelections || this.state.mode !== "walking") return;
    const state = this.state.walking;
    if (state === this.lastDetection) return;
    this.lastDetection = state;
    if (state === "WARNING")
      this.feedback.say("앞에 장애물 후보가 있어요. 조심하세요!", 3);
    else if (state === "UNKNOWN" && this.state.configured)
      this.feedback.say("보행 감지를 확인할 수 없습니다.", 2);
  }
  private control(event: Control) {
    // Dispatch intent only. Existing module stage/error remains authoritative.
    this.state.buttonDispatch = {
      type: event.type,
      mode: this.state.mode,
      at: performance.now(),
    };
    this.emit();
    if (event.type === "button_long") void this.cycle();
    else if (event.type === "button_short") void this.capture();
  }
  cycle() {
    return this.enqueueSelection(() => {
      const list = this.registry.list(),
        i = list.findIndex((m) => m.id === this.state.mode);
      return list[(i + 1) % list.length].id;
    });
  }
  select(id: string) {
    return this.enqueueSelection(() => id);
  }
  private enqueueSelection(target: () => string) {
    // Silence results synchronously, including queued/asynchronous selections.
    this.pendingSelections++;
    this.lastDetection = "";
    this.invalidate();
    this.feedback.clear();
    this.modeChain = this.modeChain
      .then(async () => {
        const id = target();
        this.invalidate();
        await this.registry.select(id);
        this.state.mode = id;
        this.feedback.say(
          this.registry.get(id)?.activationCaption ??
            `${this.registry.get(id)?.manifest.label} 모드입니다.`,
          0,
        );
        this.emit();
        await this.setResolution();
      })
      .catch(() => {
        this.state.error = "기능 전환 실패";
        this.emit();
      })
      .finally(() => {
        this.pendingSelections--;
        this.announceWalking();
        this.emit();
      });
    return this.modeChain;
  }
  private async setResolution() {
    this.resolutionReady = false;
    const generation = ++this.generation;
    const source = this.source;
    if (!source || this.state.connection !== "CONNECTED") return;
    try {
      await source.resolution(
        this.registry.get(this.state.mode)?.manifest.frame?.resolutionMode ?? 0,
      );
      if (
        generation === this.generation &&
        source === this.source &&
        this.state.connection === "CONNECTED"
      ) {
        this.resolutionReady = true;
        this.state.error = "";
      }
    } catch (error) {
      if (generation === this.generation) {
        this.state.error =
          error instanceof Error
            ? error.message
            : "해상도 변경 실패 · 장치/연결을 확인하세요";
        this.feedback.say(this.state.error, 2);
      }
    }
    this.emit();
  }
  async capture() {
    try {
      await this.registry.get(this.state.mode)?.onShort?.();
    } catch {
      this.state.error = "기능 실행 실패";
      this.feedback.say(this.state.error, 2);
    }
    this.emit();
  }
  private invalidate() {
    // Require a new received frame after a mode/rotation/session boundary.
    this.previewBlocked = this.latest;
    this.generation++;
    this.resolutionReady = false;
    this.registry.cancel();
  }
  cancelCapture() {
    this.invalidate();
    void this.setResolution();
    this.emit();
  }
  setRotation(rotation: Rotation) {
    if (!["none", "cw90", "ccw90", "180"].includes(rotation)) return;
    this.state.rotation = rotation;
    this.walking.setRotation(rotation);
    this.cancelCapture();
  }
  disconnect() {
    this.state.configured = false;
    this.feedback.remoteSpeech = false;
    this.ai.clear();
    this.feedback.clear();
    this.source?.stop();
    this.source = undefined;
    this.state.button = null;
    this.state.buttonDispatch = null;
    this.latest = undefined;
    this.epoch = undefined;
    this.invalidate();
    this.feedback.clear();
    this.walking.reset();
    this.ai.clear();
    this.state.connection = "DISCONNECTED";
    this.state.input = "영상 대기";
    this.state.caption = "세션이 종료되었습니다. 진단에서 다시 연결하세요.";
    this.emit();
  }
  suspend() {
    this.disconnect();
    this.state.caption =
      "백그라운드에서 보행 감지는 중단됩니다. 진단에서 다시 연결하세요.";
    this.emit();
  }
  dispose() {
    this.disconnect();
    this.walking.dispose();
    void this.registry.dispose();
    this.listeners.clear();
  }
}

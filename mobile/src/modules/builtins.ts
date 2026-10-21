import type { VidexModule, ModuleManifest } from "../core/modules";
import { CaptureSession, selectFrame, mergeSides } from "../core/capture";
import type { Frame } from "../core/wire";
import type { OpenAITransport } from "../core/openai";
import type { Priority } from "../core/feedback";
import type { WalkingScheduler } from "../core/scheduler";
import type { Rotation } from "../core/orientation";
export interface ModuleHost {
  ai: OpenAITransport;
  walking: WalkingScheduler;
  frame(): Frame | undefined;
  ready(): boolean;
  rotation(): Rotation;
  say(text: string, priority?: Priority): void;
  error(text: string): void;
  changed(): void;
}
export function builtInModules(host: ModuleHost): VidexModule[] {
  const walking: VidexModule = {
    manifest: {
      id: "walking",
      label: "보행 감지",
      color: "#FF5033",
      kind: "continuous",
      source: "s3",
      permissions: ["s3-frames", "speech"],
      priority: "critical",
      frame: { resolutionMode: 0 },
    },
    activationCaption: "보행 감지 모드입니다. 주변을 직접 확인하세요.",
    async init() {},
    async activate() {},
    async deactivate() {},
    async dispose() {},
    onFrame: (frame) => host.walking.submit(frame),
    async onShort() {
      host.say(
        host.walking.state === "WARNING"
          ? "앞에 장애물 후보가 있어요. 주변을 직접 확인하세요."
          : host.walking.state === "MONITORING"
            ? "보행 영상 분석 중입니다. 안전을 보장하지 않습니다."
            : "보행 감지를 확인할 수 없습니다.",
        2,
      );
    },
  };
  return [
    walking,
    new RecognitionModule(
      {
        id: "ocr",
        label: "글씨 읽기",
        color: "#3978F6",
        kind: "on-demand",
        source: "s3",
        permissions: ["s3-frames", "speech", "network:openai-image"],
        priority: "normal",
        frame: { resolutionMode: 1 },
      },
      host,
      "ocr",
    ),
    new RecognitionModule(
      {
        id: "object",
        label: "물체 인식",
        color: "#865CEB",
        kind: "composite",
        source: "s3",
        permissions: ["s3-frames", "speech", "network:openai-image"],
        priority: "normal",
        frame: { resolutionMode: 1 },
      },
      host,
      "object",
    ),
  ];
}
class RecognitionModule implements VidexModule {
  private session = new CaptureSession();
  private generation = 0;
  private operation?: AbortController;
  private busy = false;
  activationCaption: string;
  constructor(
    public manifest: ModuleManifest,
    private host: ModuleHost,
    private kind: "ocr" | "object",
  ) {
    this.activationCaption =
      kind === "ocr"
        ? "글씨 읽기 모드입니다. 글씨를 향하고 짧게 눌러 촬영하세요."
        : "물건의 앞면을 보여주고 짧게 눌러 촬영하세요.";
  }
  async init() {}
  async activate() {
    this.session.begin(this.kind);
  }
  async deactivate() {
    this.cancel();
  }
  async dispose() {
    this.cancel();
  }
  getStage() {
    return this.session.stage;
  }
  cancel() {
    this.generation++;
    this.operation?.abort();
    this.operation = undefined;
    this.busy = false;
    this.session.reset();
    this.host.changed();
  }
  async onShort() {
    if (this.busy) {
      this.host.say("인식 처리 중입니다. 잠시 기다려 주세요.");
      return;
    }
    const frame = this.host.frame();
    if (
      !frame ||
      performance.now() - frame.receivedAt > 2000 ||
      !this.host.ready() ||
      frame.width !== 640 ||
      frame.height !== 480
    ) {
      this.host.say("현재 모드의 새 640×480 영상을 기다려 주세요.", 2);
      return;
    }
    if (this.session.stage === "idle" || this.session.stage === "ready")
      this.session.begin(this.kind);
    this.busy = true;
    const generation = this.generation,
      operation = (this.operation = new AbortController());
    const timer = setTimeout(() => operation.abort(), 50000);
    try {
      const selected = await selectFrame(
        frame,
        this.host.rotation(),
        this.kind === "ocr" ? 0.95 : 0.9,
      );
      if (generation !== this.generation || operation.signal.aborted) return;
      this.session.accept(selected.image, selected.quality, selected.analysis);
      this.host.changed();
      if (this.session.stage === "back") {
        this.host.say(
          "앞면 촬영 완료. 물건의 뒷면을 보여주고 짧게 눌러 주세요.",
          1,
        );
        return;
      }
      const image =
        this.kind === "object"
          ? await mergeSides(this.session.images)
          : this.session.images[0];
      if (generation !== this.generation || operation.signal.aborted) return;
      const text = await this.host.ai.vision(
        image,
        this.kind,
        operation.signal,
      );
      if (generation !== this.generation || operation.signal.aborted) return;
      if (this.kind === "object" && text === "인식 실패")
        throw Error("제품을 식별할 수 없습니다.");
      this.session.reset();
      this.host.say(
        this.kind === "object"
          ? `인식된 제품은 ${text}입니다.`
          : text || "인식된 글자가 없습니다.",
        1,
      );
    } catch (error) {
      if (generation === this.generation)
        this.host.error(error instanceof Error ? error.message : "인식 실패");
    } finally {
      clearTimeout(timer);
      if (this.operation === operation) {
        this.operation = undefined;
        this.busy = false;
      }
      this.host.changed();
    }
  }
}

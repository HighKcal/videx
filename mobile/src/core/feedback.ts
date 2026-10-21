import type { OpenAITransport } from "./openai";
import { playRemoteSpeech } from "./progressive-speech";
export type Priority = 0 | 1 | 2 | 3; // guidance, recognition, fault, obstacle
interface Message {
  text: string;
  priority: Priority;
  at: number;
}
function* speechChunks(text: string, limit: number) {
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    yield text.slice(start, end);
    start = end;
  }
}
export class FeedbackManager {
  private output?: HTMLAudioElement;
  /** Call only in a real click/submit gesture; browsers may still require a retry. */
  enableAudio() {
    if (!this.remoteSpeech) {
      if (typeof window !== "undefined") window.speechSynthesis?.resume();
      this.status = "기기 음성 사용 · 한국어 로컬 음성/브라우저 권한 확인";
      this.changed();
      return;
    }
    if (this.current) return;
    this.cleanup();
    const bytes = new Uint8Array(844),
      d = new DataView(bytes.buffer);
    for (const [offset, text] of [
      [0, "RIFF"],
      [8, "WAVE"],
      [12, "fmt "],
      [36, "data"],
    ] as const)
      bytes.set(new TextEncoder().encode(text), offset);
    d.setUint32(4, 836, true);
    d.setUint32(16, 16, true);
    d.setUint16(20, 1, true);
    d.setUint16(22, 1, true);
    d.setUint32(24, 8000, true);
    d.setUint32(28, 8000, true);
    d.setUint16(32, 1, true);
    d.setUint16(34, 8, true);
    d.setUint32(40, 800, true);
    bytes.fill(128, 44);
    const url = (this.url = URL.createObjectURL(
      new Blob([bytes], { type: "audio/wav" }),
    ));
    const audio = (this.audio = this.output ??= new Audio());
    audio.src = url;
    audio.onended = () => {
      if (this.url === url) this.cleanup();
    };
    setTimeout(() => {
      if (this.url === url && !this.current) this.cleanup();
    }, 2000);
    void audio.play().catch(() => {
      if (this.url !== url) return;
      this.status = "음성 재생 활성화가 필요합니다. 화면 버튼을 눌러 주세요.";
      this.cleanup();
      this.changed();
    });
  }
  private current?: { message: Message; controller: AbortController };
  private queue: Message[] = [];
  private audio?: HTMLAudioElement;
  private url?: string;
  private recent = new Map<string, number>();
  private release?: () => void;
  localFallback = false;
  remoteSpeech = false;
  status = "음성 대기";
  constructor(
    private ai: OpenAITransport,
    private caption: (text: string) => void,
    private changed: () => void = () => {},
  ) {}
  say(text: string, priority: Priority = 0) {
    const now = performance.now();
    if (now - (this.recent.get(text) ?? -Infinity) < 5000) return;
    this.recent.set(text, now);
    if (this.recent.size > 64)
      this.recent.delete(this.recent.keys().next().value!);
    const m = { text, priority, at: now };
    if (this.current && this.current.message.priority > priority) {
      this.queue = this.queue.filter((x) => x.priority > priority);
      this.queue.push(m);
      this.queue = this.queue.slice(-8);
      return;
    }
    this.cancel();
    this.play(m);
  }
  private async play(message: Message) {
    const controller = new AbortController();
    this.current = { message, controller };
    this.caption(message.text);

    try {
      if (!this.remoteSpeech) {
        await this.playLocal(message.text, controller.signal);
        if (this.current?.controller === controller)
          this.status = "기기 음성 완료";
        return;
      }
      for (const part of speechChunks(message.text, 4000)) {
        controller.signal.throwIfAborted();
        this.status = "OpenAI AI 음성 생성 중";
        this.changed();
        const audio = (this.audio = this.output ??= new Audio());
        await playRemoteSpeech(this.ai, part, audio, controller.signal, () => {
          this.status = "OpenAI AI 음성 재생 중";
          this.changed();
        });
        if (controller.signal.aborted) return;
        this.cleanup();
      }
      if (this.current?.controller === controller) this.status = "음성 완료";
    } catch {
      if (this.current?.controller === controller) {
        this.status = this.remoteSpeech
          ? "OpenAI 음성 사용 불가 · 자막 확인 / 화면에서 음성 재생 활성화"
          : "기기 한국어 음성 사용 불가 · 로컬 음성 설치/재생 권한 및 자막 확인";
        if (
          this.remoteSpeech &&
          this.localFallback &&
          !controller.signal.aborted
        ) {
          try {
            this.cleanup();
            await this.playLocal(message.text, controller.signal);
            if (this.current?.controller === controller)
              this.status = "기기 음성 완료";
          } catch {
            if (this.current?.controller === controller)
              this.status = "기기 한국어 음성 사용 불가 · 자막 확인";
          }
        }
      }
    } finally {
      if (this.current?.controller === controller) {
        this.cleanup();
        this.current = undefined;
        this.changed();
        this.queue = this.queue.filter(
          (item) => performance.now() - item.at < 15000,
        );
        const next = this.queue.sort((a, b) => b.priority - a.priority).shift();
        if (next) void this.play(next);
      }
    }
  }
  private async playLocal(text: string, signal: AbortSignal) {
    const synthesis =
      typeof window !== "undefined" ? window.speechSynthesis : undefined;
    const voices = synthesis?.getVoices() ?? [];
    const isLocalKorean = (v: SpeechSynthesisVoice) =>
      v.localService && v.lang.toLowerCase().startsWith("ko");
    let voice = voices.find(isLocalKorean);
    // Browser voice discovery can be asynchronous; never wait indefinitely or
    // substitute a cloud voice. Cancellation removes the listener immediately.
    if (synthesis && !voices.length && synthesis.addEventListener) {
      signal.throwIfAborted();
      this.status = "기기 음성 목록 로딩 중 (최대 1.5초)";
      this.changed();
      voice = await new Promise<SpeechSynthesisVoice | undefined>(
        (resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout>;
          const finish = (found?: SpeechSynthesisVoice, error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            synthesis.removeEventListener("voiceschanged", check);
            signal.removeEventListener("abort", aborted);
            if (error) reject(error);
            else resolve(found);
          };
          const check = () => {
            const found = synthesis.getVoices().find(isLocalKorean);
            if (found) finish(found);
          };
          const aborted = () => finish(undefined, Error("cancelled"));
          synthesis.addEventListener("voiceschanged", check);
          signal.addEventListener("abort", aborted, { once: true });
          timer = setTimeout(() => finish(), 1500);
          check();
        },
      );
    }
    if (!synthesis || !voice || typeof SpeechSynthesisUtterance === "undefined")
      throw Error("local voice unavailable");
    for (const part of speechChunks(text, 1000)) {
      signal.throwIfAborted();
      this.status = "기기 음성 재생 중";
      this.changed();
      const utterance = new SpeechSynthesisUtterance(part);
      utterance.lang = "ko-KR";
      utterance.voice = voice;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          utterance.onend = null;
          utterance.onerror = null;
          signal.removeEventListener("abort", aborted);
          this.release = undefined;
          if (error) reject(error);
          else resolve();
        };
        const aborted = () => finish(Error("cancelled"));
        this.release = () => finish();
        utterance.onend = () => finish();
        utterance.onerror = () => finish(Error("local playback failed"));
        signal.addEventListener("abort", aborted, { once: true });
        timer = setTimeout(() => {
          synthesis.cancel();
          finish(Error("local playback timeout"));
        }, 120000);
        try {
          synthesis.speak(utterance);
        } catch {
          finish(Error("local playback failed"));
        }
      });
    }
  }
  private cleanup() {
    this.audio?.pause();
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.onloadedmetadata = null;
      this.audio.ondurationchange = null;
      this.audio.removeAttribute?.("src");
      this.audio.load?.();
    }
    this.audio = undefined;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
    this.release?.();
    this.release = undefined;
  }
  cancel() {
    this.current?.controller.abort();
    this.current = undefined;
    this.cleanup();
    this.status = "음성 대기";
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  }
  clear() {
    this.queue = [];
    this.cancel();
    this.recent.clear();
  }
}

import type { OpenAITransport } from "./openai";
export type Priority = 0 | 1 | 2 | 3; // guidance, recognition, fault, obstacle
interface Message {
  text: string;
  priority: Priority;
  at: number;
}
export class FeedbackManager {
  private output?: HTMLAudioElement;
  /** Call only in a real click/submit gesture; browsers may still require a retry. */
  enableAudio() {
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
    let networkTimer: ReturnType<typeof setTimeout> | undefined;
    let playbackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.status = "OpenAI AI 음성 생성 중";
      this.changed();
      const blob = await Promise.race([
        this.ai.speech(message.text, controller.signal),
        new Promise<never>((_, reject) => {
          networkTimer = setTimeout(() => {
            reject(Error("음성 생성 시간 초과"));
            controller.abort();
          }, 15000);
        }),
      ]);
      clearTimeout(networkTimer);
      if (controller.signal.aborted) return;
      const url = (this.url = URL.createObjectURL(blob));
      const audio = (this.audio = this.output ??= new Audio());
      audio.src = url;
      this.status = "OpenAI AI 음성 재생 중";
      this.changed();
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        audio.onended = () => resolve();
        audio.onerror = () => reject(Error("오디오 재생 실패"));
        const startedAt = performance.now();
        // Metadata-free playback retains the bounded 60s fallback. A finite
        // duration extends it for long OCR, but never beyond 15 minutes total.
        const updateWatchdog = () => {
          clearTimeout(playbackTimer);
          const elapsed = performance.now() - startedAt;
          const durationMs =
            Number.isFinite(audio.duration) && audio.duration > 0
              ? Math.max(0, audio.duration - (audio.currentTime || 0)) * 1000 +
                15000
              : 60000;
          const remaining = Math.max(
            0,
            Math.min(900000 - elapsed, Math.max(60000, durationMs)),
          );
          playbackTimer = setTimeout(
            () => reject(Error("오디오 재생 시간 초과")),
            remaining,
          );
        };
        audio.onloadedmetadata = updateWatchdog;
        audio.ondurationchange = updateWatchdog;
        playbackTimer = setTimeout(
          () => reject(Error("오디오 메타데이터/재생 시간 초과")),
          60000,
        );
        void audio.play().catch(reject);
      });
      if (this.current?.controller === controller) this.status = "음성 완료";
    } catch {
      if (this.current?.controller === controller) {
        this.status =
          "OpenAI 음성 사용 불가 · 자막 확인 / 화면에서 음성 재생 활성화";
        if (
          this.localFallback &&
          typeof window !== "undefined" &&
          "speechSynthesis" in window
        ) {
          const voice = window.speechSynthesis
            .getVoices()
            .find((v) => v.localService && v.lang.startsWith("ko"));
          if (voice) {
            const u = new SpeechSynthesisUtterance(message.text);
            u.lang = "ko-KR";
            u.voice = voice;
            window.speechSynthesis.speak(u);
            this.status = "기기 음성 대체 사용 중";
          }
        }
      }
    } finally {
      clearTimeout(networkTimer);
      clearTimeout(playbackTimer);
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
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  }
  clear() {
    this.queue = [];
    this.cancel();
    this.recent.clear();
  }
}

import { it, expect, vi, afterEach } from "vitest";
import { FeedbackManager } from "../src/core/feedback";
import type { OpenAITransport } from "../src/core/openai";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("preempts lower priority, aborts pending request, rejects late audio without leaking URLs", async () => {
  const pending: Array<{ signal: AbortSignal; resolve: (b: Blob) => void }> =
    [];
  const ai = {
    speech: vi.fn(
      (_t: string, signal: AbortSignal) =>
        new Promise<Blob>((resolve) => pending.push({ signal, resolve })),
    ),
  };
  const urls = vi.spyOn(URL, "createObjectURL");
  const caption = vi.fn();
  const f = new FeedbackManager(ai as unknown as OpenAITransport, caption);
  f.remoteSpeech = true;
  f.say("읽기", 1);
  f.say("장애물", 3);
  expect(pending[0].signal.aborted).toBe(true);
  pending[0].resolve(new Blob(["late"]));
  await Promise.resolve();
  expect(urls).not.toHaveBeenCalled();
  expect(caption).toHaveBeenLastCalledWith("장애물");
  f.clear();
  urls.mockRestore();
});
it("watchdogs hung audio and revokes URLs, allows only localService fallback voices", async () => {
  vi.useFakeTimers();
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  class AudioMock {
    onended: any;
    onerror: any;
    pause = vi.fn();
    play = vi.fn(async () => {});
  }
  vi.stubGlobal("Audio", AudioMock);
  const speak = vi.fn();
  vi.stubGlobal("window", {
    speechSynthesis: {
      cancel: vi.fn(),
      speak,
      getVoices: () => [
        { localService: false, lang: "ko-KR" },
        { localService: true, lang: "ko-KR", name: "local" },
      ],
    },
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      voice: any;
      lang = "";
      constructor(public text: string) {}
    },
  );
  const ai = { speech: vi.fn(async () => new Blob(["audio"])) };
  const f = new FeedbackManager(ai as unknown as OpenAITransport, vi.fn());
  f.localFallback = true;
  f.remoteSpeech = true;
  f.say("test", 1);
  await vi.advanceTimersByTimeAsync(61000);
  expect(revoke).toHaveBeenCalled();
  expect(f.status).toContain("기기 음성");
  expect(speak.mock.calls[0][0].voice.localService).toBe(true);
  f.clear();
  revoke.mockRestore();
});
it("uses loaded duration for speech longer than sixty seconds and still cleans up at ended", async () => {
  vi.useFakeTimers();
  const audioInstances: any[] = [];
  class AudioMock {
    duration = 120;
    currentTime = 0;
    onloadedmetadata: any;
    ondurationchange: any;
    onended: any;
    onerror: any;
    pause = vi.fn();
    play = vi.fn(async () => {});
    constructor() {
      audioInstances.push(this);
    }
  }
  vi.stubGlobal("Audio", AudioMock);
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const ai = { speech: vi.fn(async () => new Blob(["long audio"])) };
  const f = new FeedbackManager(ai as unknown as OpenAITransport, vi.fn());
  f.remoteSpeech = true;
  f.say("긴 글 읽기", 1);
  await vi.advanceTimersByTimeAsync(0);
  const audio = audioInstances[0];
  audio.onloadedmetadata?.();
  await vi.advanceTimersByTimeAsync(61000);
  expect(revoke).not.toHaveBeenCalled();
  expect(audio.pause).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(59000);
  audio.onended();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.status).toBe("음성 완료");
  expect(revoke).toHaveBeenCalledTimes(1);
  f.clear();
  revoke.mockRestore();
});
it("drains a live lower-priority item when the higher-priority queued item expired", async () => {
  vi.useFakeTimers();
  const audioInstances: any[] = [];
  class AudioMock {
    onended: any;
    onerror: any;
    pause = vi.fn();
    play = vi.fn(async () => {});
    constructor() {
      audioInstances.push(this);
    }
  }
  vi.stubGlobal("Audio", AudioMock);
  const ai = { speech: vi.fn(async () => new Blob(["audio"])) };
  const f = new FeedbackManager(ai as unknown as OpenAITransport, vi.fn());
  f.remoteSpeech = true;
  f.say("현재 경고", 3);
  await vi.advanceTimersByTimeAsync(0);
  f.say("만료된 고장 안내", 2);
  await vi.advanceTimersByTimeAsync(16000);
  f.say("살아있는 인식 결과", 1);
  audioInstances[0].onended();
  await vi.advanceTimersByTimeAsync(0);
  expect(ai.speech).toHaveBeenLastCalledWith(
    "살아있는 인식 결과",
    expect.any(AbortSignal),
  );
  f.clear();
});

import { afterEach, expect, it, vi } from "vitest";
import { FeedbackManager } from "../src/core/feedback";
import type { OpenAITransport } from "../src/core/openai";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup(local = true) {
  const utterances: any[] = [];
  const cancel = vi.fn();
  vi.stubGlobal("window", {
    speechSynthesis: {
      cancel,
      resume: vi.fn(),
      getVoices: () => [
        { localService: false, lang: "ko-KR" },
        ...(local ? [{ localService: true, lang: "ko-KR" }] : []),
      ],
      speak: vi.fn((u) => utterances.push(u)),
    },
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      constructor(public text: string) {}
    },
  );
  const speech = vi.fn(async () => new Blob());
  const caption = vi.fn();
  const f = new FeedbackManager(
    { speech } as unknown as OpenAITransport,
    caption,
  );
  return { f, speech, caption, utterances, cancel };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
it.each(["arrival", "cancel", "timeout"])(
  "bounds initial empty voice loading and cleans listeners: %s",
  async (scenario) => {
    vi.useFakeTimers();
    const h = setup();
    const target = new EventTarget();
    const synthesis = window.speechSynthesis;
    const voices = vi.spyOn(synthesis, "getVoices").mockReturnValue([]);
    const add = vi.fn(target.addEventListener.bind(target));
    const remove = vi.fn(target.removeEventListener.bind(target));
    Object.assign(synthesis, {
      addEventListener: add,
      removeEventListener: remove,
    });
    h.f.say("음성 로딩 회귀", 1);
    try {
      expect(add).toHaveBeenCalledWith("voiceschanged", expect.any(Function));
      expect(h.utterances).toEqual([]);
      if (scenario === "cancel") h.f.clear();
      if (scenario === "timeout") await vi.advanceTimersByTimeAsync(1500);
      voices.mockReturnValue([{ localService: true, lang: "ko-KR" }] as any);
      target.dispatchEvent(new Event("voiceschanged"));
      await flush();
      if (scenario === "arrival") {
        expect(h.utterances).toHaveLength(1);
        h.utterances[0].onend();
        await flush();
        expect(h.f.status).toBe("기기 음성 완료");
      } else {
        expect(h.utterances).toEqual([]);
        if (scenario === "timeout")
          expect(h.f.status).toContain("기기 한국어 음성 사용 불가");
      }
      expect(remove).toHaveBeenCalledWith(
        "voiceschanged",
        add.mock.calls[0][1],
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(h.speech).not.toHaveBeenCalled();
    } finally {
      h.f.clear();
    }
  },
);
it("defaults to local Korean voice without calling remote speech or truncating long OCR", async () => {
  const h = setup();
  const text = "긴 글씨 😀\n".repeat(900);
  h.f.say(text, 1);
  let spoken = "";
  try {
    while (h.utterances.length) {
      const u = h.utterances.shift()!;
      expect(u.voice.localService).toBe(true);
      expect(u.lang).toBe("ko-KR");
      expect(u.text.length).toBeLessThanOrEqual(1000);
      spoken += u.text;
      u.onend();
      await flush();
    }
    expect(spoken).toBe(text);
    expect(h.caption).toHaveBeenCalledWith(text);
    expect(h.f.status).toBe("기기 음성 완료");
    expect(h.speech).not.toHaveBeenCalled();
  } finally {
    h.f.clear();
  }
});
it("does not silently use a remote browser voice or OpenAI when local voice is unavailable", async () => {
  const h = setup(false);
  h.f.say("안내");
  await flush();
  expect(h.utterances).toEqual([]);
  expect(h.speech).not.toHaveBeenCalled();
  expect(h.f.status).toContain("기기 한국어 음성 사용 불가");
  h.f.clear();
});
it("preemption cancels local chunks and late end cannot resume an obsolete result", async () => {
  const h = setup();
  h.f.say("가".repeat(3000), 1);
  const old = h.utterances.shift();
  h.f.say("장애물", 3);
  const warning = h.utterances.shift();
  old.onend?.();
  await flush();
  expect(warning.text).toBe("장애물");
  expect(h.utterances).toEqual([]);
  expect(h.speech).not.toHaveBeenCalled();
  h.f.clear();
});
it("remote opt-in reads every chunk <=4000 chars without silently slicing the result", async () => {
  const h = setup();
  const audios: any[] = [];
  vi.stubGlobal(
    "Audio",
    class {
      onended: any;
      pause() {}
      play() {
        audios.push(this);
        return Promise.resolve();
      }
    },
  );
  h.f.remoteSpeech = true;
  const text = "문".repeat(8500);
  h.f.say(text, 1);
  try {
    await flush();
    for (let i = 0; i < 3; i++) {
      audios[i].onended();
      await flush();
    }
    expect(h.speech.mock.calls.map((call: any) => call[0]).join("")).toBe(text);
    expect(
      h.speech.mock.calls.every((call: any) => call[0].length <= 4000),
    ).toBe(true);
  } finally {
    h.f.clear();
  }
});

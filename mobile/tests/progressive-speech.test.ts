import { afterEach, expect, it, vi } from "vitest";
import { FeedbackManager } from "../src/core/feedback";
import type { OpenAITransport } from "../src/core/openai";

class AudioMock {
  src = "";
  currentTime = 0;
  duration = NaN;
  onended: any;
  onerror: any;
  onplaying: any;
  onloadedmetadata: any;
  ondurationchange: any;
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  play = vi.fn(async () => {});
}
class BufferMock extends EventTarget {
  updating = false;
  appendBuffer = vi.fn(() => {
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  });
  abort = vi.fn();
}
class MediaMock extends EventTarget {
  static isTypeSupported = vi.fn(() => true);
  readyState = "open";
  buffer = new BufferMock();
  addSourceBuffer = vi.fn(() => this.buffer);
  endOfStream = vi.fn();
}
function setup(supported = true) {
  const audio = new AudioMock(),
    media: MediaMock[] = [],
    revoked: string[] = [];
  vi.stubGlobal("Audio", function () {
    return audio;
  });
  vi.stubGlobal("MediaSource", MediaMock);
  MediaMock.isTypeSupported.mockReturnValue(supported);
  vi.spyOn(URL, "createObjectURL").mockImplementation((object: any) => {
    if (object instanceof MediaMock) {
      media.push(object);
      queueMicrotask(() => object.dispatchEvent(new Event("sourceopen")));
    }
    return `blob:test-${media.length}-${object instanceof Blob ? "buffered" : "mse"}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revoked.push(url);
  });
  let emit!: (b: Uint8Array) => Promise<void>, finish!: (b: Blob) => void;
  let requestSignal!: AbortSignal;
  const speech = vi.fn(
    (
      _text: string,
      signal: AbortSignal,
      consume?: (b: Uint8Array) => Promise<void>,
    ) => {
      requestSignal = signal;
      emit = consume ?? (async () => {});
      return new Promise<Blob>((resolve) => {
        finish = resolve;
      });
    },
  );
  const manager = new FeedbackManager(
    { speech } as unknown as OpenAITransport,
    vi.fn(),
  );
  manager.remoteSpeech = true;
  manager.say("테스트", 1);
  return {
    audio,
    media,
    revoked,
    speech,
    manager,
    emit: (b = new Uint8Array([1, 2])) => emit(b),
    finish: () =>
      finish(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" })),
    signal: () => requestSignal,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("an ended predecessor cannot clean up a synchronously preempting successor", async () => {
  const s = setup();
  await s.emit();
  s.finish();
  await vi.waitFor(() => expect(s.media[0].endOfStream).toHaveBeenCalled());
  s.audio.onended();
  s.manager.say("다음 경고", 3);
  await s.emit();
  try {
    expect(s.audio.onended).toBeTypeOf("function");
    expect(s.manager.status).toBe("OpenAI AI 음성 재생 중");
  } finally {
    s.manager.clear();
    s.finish();
  }
});

it.each(["unsupported", "absent"])(
  "%s MSE waits for EOF and plays one buffered request",
  async (mode) => {
    const s = setup(false);
    if (mode === "absent") vi.stubGlobal("MediaSource", undefined);
    try {
      await s.emit();
      expect(s.audio.play).not.toHaveBeenCalled();
      s.finish();
      await vi.waitFor(() => expect(s.audio.play).toHaveBeenCalledTimes(1));
      expect(s.audio.src).toContain("buffered");
      s.audio.onended();
      await vi.waitFor(() => expect(s.manager.status).toBe("음성 완료"));
      expect(s.speech).toHaveBeenCalledTimes(1);
      expect(s.revoked).toHaveLength(1);
    } finally {
      s.manager.clear();
    }
  },
);

it("does not replay or refetch after audible playback fails", async () => {
  const s = setup();
  await s.emit();
  s.audio.currentTime = 0.25;
  s.audio.onplaying();
  s.media[0].buffer.dispatchEvent(new Event("error"));
  await vi.waitFor(() => expect(s.manager.status).toContain("사용 불가"));
  expect(s.signal().aborted).toBe(true);
  expect(s.revoked).toHaveLength(1);
  s.finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(s.speech).toHaveBeenCalledTimes(1);
  expect(s.audio.play).toHaveBeenCalledTimes(1);
  s.manager.clear();
});

it("autoplay rejection cancels network and releases the MSE URL without buffered retry", async () => {
  const s = setup();
  s.audio.play.mockRejectedValueOnce(
    new DOMException("gesture required", "NotAllowedError"),
  );
  await s.emit();
  await vi.waitFor(() => expect(s.manager.status).toContain("사용 불가"));
  expect(s.signal().aborted).toBe(true);
  expect(s.revoked).toHaveLength(1);
  expect(s.speech).toHaveBeenCalledTimes(1);
  s.finish();
  s.manager.clear();
});

it("sourceopen cancellation releases pending listeners and URL", async () => {
  const s = setup();
  vi.mocked(URL.createObjectURL).mockImplementation(() => "blob:never-opened");
  const append = s.emit().catch((error) => error);
  await vi.waitFor(() => expect(s.media).toHaveLength(0));
  s.manager.clear();
  expect(s.signal().aborted).toBe(true);
  expect(s.revoked).toContain("blob:never-opened");
  await append;
  s.finish();
});

it("cancellation immediately releases a stalled request and cannot detach its successor", async () => {
  const s = setup();
  await s.emit();
  const firstUrl = s.audio.src;
  s.manager.clear();
  expect(s.signal().aborted).toBe(true);
  expect(s.revoked).toContain(firstUrl);
  expect(s.manager.status).toBe("음성 대기");
  const pauses = s.audio.pause.mock.calls.length;
  s.audio.src = "blob:successor";
  s.finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(s.audio.src).toBe("blob:successor");
  expect(s.audio.pause).toHaveBeenCalledTimes(pauses);
});

it("falls back to the complete SAME request on pre-play append failure", async () => {
  const s = setup();

  const emit = s.emit();
  await vi.waitFor(() => expect(s.media).toHaveLength(1));
  await emit;
  // No playing event/currentTime yet: an asynchronous parser failure is safe
  // to recover using the bytes still being collected from this same response.
  s.media[0].buffer.dispatchEvent(new Event("error"));
  await s.emit(new Uint8Array([3]));
  s.finish();
  try {
    await vi.waitFor(() => expect(s.audio.src).toContain("buffered"), {
      timeout: 300,
    });
    expect(s.speech).toHaveBeenCalledTimes(1);
    s.audio.onended();
    await vi.waitFor(() => expect(s.manager.status).toBe("음성 완료"));
  } finally {
    s.manager.clear();
  }
});

it("feature-detected MPEG MSE starts playback before speech EOF", async () => {
  const s = setup();
  try {
    await s.emit();
    await vi.waitFor(() => expect(s.audio.play).toHaveBeenCalledTimes(1), {
      timeout: 300,
    });
    expect(s.media[0].buffer.appendBuffer).toHaveBeenCalledTimes(1);
    expect(s.media[0].endOfStream).not.toHaveBeenCalled();
    s.finish();
    await vi.waitFor(() =>
      expect(s.media[0].endOfStream).toHaveBeenCalledTimes(1),
    );
    s.audio.onended();
    await vi.waitFor(() => expect(s.manager.status).toBe("음성 완료"));
    expect(s.revoked).toHaveLength(1);
    expect(s.speech).toHaveBeenCalledTimes(1);
  } finally {
    s.manager.clear();
    s.finish();
  }
});

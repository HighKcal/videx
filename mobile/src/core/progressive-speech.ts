import type { OpenAITransport } from "./openai";

// One append at a time; listeners are installed before the action (including
// synchronous exceptions), and removed on every completion/cancellation path.
function mediaEvent(
  target: EventTarget,
  event: string,
  signal: AbortSignal,
  action: () => void,
) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      target.removeEventListener(event, ready);
      target.removeEventListener("error", failed);
      target.removeEventListener("sourceclose", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const failed = () => finish(Error("MSE failed"));
    const aborted = () => finish(signal.reason);
    target.addEventListener(event, ready, { once: true });
    target.addEventListener("error", failed, { once: true });
    target.addEventListener("sourceclose", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    try {
      signal.throwIfAborted();
      action();
    } catch (error) {
      finish(error);
    }
  });
}

export async function playRemoteSpeech(
  ai: OpenAITransport,
  text: string,
  audio: HTMLAudioElement,
  parent: AbortSignal,
  playing: () => void,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let url: string | undefined,
    media: MediaSource | undefined,
    buffer: SourceBuffer | undefined;
  let appended = false,
    started = false,
    audible = false,
    mseFailed = false;
  let networkTimer: ReturnType<typeof setTimeout> | undefined;
  let playbackTimer: ReturnType<typeof setTimeout> | undefined;
  let settle!: () => void, fail!: (error: unknown) => void;
  const ended = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A playback error may precede the network completion. Handle immediately,
  // while preserving the rejection for the eventual await below.
  void ended.catch(() => {});
  const fatal = (error: unknown) => {
    fail(error);
    controller.abort(error);
  };
  let disposed = false,
    playGeneration = 0;
  const detach = () => {
    playGeneration++;
    audio.pause();
    audio.removeAttribute?.("src");
    audio.load?.();
    if (url) {
      URL.revokeObjectURL(url);
      url = undefined;
    }
  };
  const mseFailure = () => {
    if (signal.aborted || mseFailed) return;
    if (audible || audio.currentTime > 0) {
      fatal(Error("MSE playback failed"));
      return;
    }
    mseFailed = true;
    started = false;
    clearTimeout(playbackTimer);
    detach();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(networkTimer);
    clearTimeout(playbackTimer);
    buffer?.removeEventListener("error", mseFailure);
    media?.removeEventListener("sourceclose", mseFailure);
    audio.onended = null;
    audio.onerror = null;
    audio.onplaying = null;
    audio.onloadedmetadata = null;
    audio.ondurationchange = null;
    if (buffer?.updating && media?.readyState === "open") {
      try {
        buffer.abort();
      } catch {}
    }
    detach();
  };
  // Dispose synchronously so a late predecessor cannot detach its successor.
  const aborted = () => {
    fail(signal.reason);
    dispose();
  };
  signal.addEventListener("abort", aborted, { once: true });
  const start = () => {
    if (started) return;
    signal.throwIfAborted();
    started = true;
    playing();
    const startedAt = performance.now();
    const watchdog = () => {
      clearTimeout(playbackTimer);
      const durationMs =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.max(0, audio.duration - (audio.currentTime || 0)) * 1000 +
            15000
          : 60000;
      playbackTimer = setTimeout(
        () => fatal(Error("오디오 재생 시간 초과")),
        Math.max(
          0,
          Math.min(
            900000 - (performance.now() - startedAt),
            Math.max(60000, durationMs),
          ),
        ),
      );
    };
    audio.onloadedmetadata = watchdog;
    audio.ondurationchange = watchdog;
    watchdog();
    const generation = playGeneration;
    void audio.play().catch((error) => {
      if (generation === playGeneration && !signal.aborted) fatal(error);
    });
  };
  audio.onended = () => settle();
  audio.onplaying = () => {
    audible = true;
  };
  audio.onerror = () => {
    if (media && !mseFailed) mseFailure();
    else fatal(Error("오디오 재생 실패"));
  };
  try {
    signal.throwIfAborted();
    networkTimer = setTimeout(() => fatal(Error("음성 생성 시간 초과")), 15000);
    const request = ai.speech(text, signal, async (bytes) => {
      signal.throwIfAborted();
      if (mseFailed) return;
      try {
        if (!media) {
          if (
            typeof MediaSource === "undefined" ||
            !MediaSource.isTypeSupported("audio/mpeg")
          )
            return;
          media = new MediaSource();
          media.addEventListener("sourceclose", mseFailure);
          await mediaEvent(media, "sourceopen", signal, () => {
            url = URL.createObjectURL(media!);
            audio.src = url;
          });
          buffer = media.addSourceBuffer("audio/mpeg");
          buffer.addEventListener("error", mseFailure);
        }
        await mediaEvent(buffer!, "updateend", signal, () =>
          buffer!.appendBuffer(new Uint8Array(bytes)),
        );
        if (mseFailed) return;
        appended = true;
        start();
      } catch {
        signal.throwIfAborted();
        mseFailure();
        signal.throwIfAborted();
      }
    });
    const blob = await new Promise<Blob>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        cleanup();
        reject(signal.reason);
      }
      request.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
    clearTimeout(networkTimer);
    signal.throwIfAborted();
    if (appended && !mseFailed) {
      try {
        media!.endOfStream();
      } catch {
        mseFailure();
      }
      signal.throwIfAborted();
    }
    if (!appended || mseFailed) {
      if (url) detach();
      url = URL.createObjectURL(blob);
      audio.src = url;
      start();
    }
    await ended;
  } finally {
    controller.abort();
    signal.removeEventListener("abort", aborted);
    dispose();
  }
}

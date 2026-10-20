import { it, expect, vi } from "vitest";
import { OpenAITransport } from "../src/core/openai";
it("defaults to authenticated same-origin vision with only selected image and kind", async () => {
  const fetcher = vi.fn(async () => Response.json({ text: "서버 결과" }));
  const ai = new OpenAITransport(fetcher as typeof fetch);
  ai.configure("test-server-token", true, false);
  const signal = new AbortController().signal;
  const image = "data:image/jpeg;base64,/9j/2Q==";
  expect(await ai.vision(image, "object", signal)).toBe("서버 결과");
  const [url, options] = fetcher.mock.calls[0] as any;
  expect(url).toBe("/api/vision");
  expect(JSON.parse(options.body)).toEqual({ image, kind: "object" });
  expect(options.headers.Authorization).toBe("Bearer test-server-token");
  expect(options.signal).toBe(signal);
  expect(options).toMatchObject({
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "same-origin",
  });
});
it("sends only consented text to server speech and rejects non-MPEG responses", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response("not audio", { headers: { "Content-Type": "text/html" } }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  ai.configure("test-token", false, true);
  await expect(ai.speech("안녕", new AbortController().signal)).rejects.toThrow(
    "음성 응답",
  );
  const [url, options] = fetcher.mock.calls[0] as any;
  expect(url).toBe("/api/speech");
  expect(JSON.parse(options.body)).toEqual({ text: "안녕" });
});
it("fails closed without token or per-kind consent and clears session credentials", async () => {
  const fetcher = vi.fn(async () => Response.json({ text: "ok" }));
  const ai = new OpenAITransport(fetcher as typeof fetch);
  const image = "data:image/jpeg;base64,/9j/2Q==";
  const signal = new AbortController().signal;
  for (const [token, imageConsent, speechConsent] of [
    ["", true, true],
    ["token", false, false],
  ] as const) {
    ai.configure(token, imageConsent, speechConsent);
    await expect(ai.vision(image, "ocr", signal)).rejects.toThrow();
    await expect(ai.speech("text", signal)).rejects.toThrow();
  }
  ai.configure("token", true, true);
  ai.clear();
  await expect(ai.vision(image, "ocr", signal)).rejects.toThrow();
  await expect(ai.speech("text", signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("never falls back to direct on server failure or aborted requests and hides error bodies", async () => {
  const fetcher = vi.fn(
    async () => new Response("PRIVATE_UPSTREAM_DETAILS", { status: 503 }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  ai.configure("token", true, true);
  await expect(ai.speech("text", new AbortController().signal)).rejects.toThrow(
    /^서버 사용 불가 \(503\)$/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((fetcher.mock.calls[0] as any)[0]).toBe("/api/speech");
  const abort = new AbortController();
  abort.abort();
  await expect(ai.speech("text", abort.signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("accepts MPEG speech and rejects a late response after abort without another provider call", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  ai.configure("test-token", true, true);
  const audio = await ai.speech("hello", new AbortController().signal);
  expect(audio.type).toBe("audio/mpeg");
  expect(audio.size).toBe(3);
  const abort = new AbortController();
  fetcher.mockImplementationOnce(async () => {
    abort.abort();
    return Response.json({ text: "late" });
  });
  await expect(
    ai.vision("data:image/jpeg;base64,/9j/2Q==", "ocr", abort.signal),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("uses safe generic errors for malformed server JSON and null results", async () => {
  const fetcher = vi.fn(async () => new Response("PRIVATE_BROKEN_JSON"));
  const ai = new OpenAITransport(fetcher as typeof fetch);
  ai.configure("token", true, false);
  const image = "data:image/jpeg;base64,/9j/2Q==";
  await expect(
    ai.vision(image, "ocr", new AbortController().signal),
  ).rejects.toThrow(/^인식 응답 형식이 올바르지 않습니다$/);
  fetcher.mockImplementationOnce(async () => Response.json(null));
  await expect(
    ai.vision(image, "ocr", new AbortController().signal),
  ).rejects.toThrow(/^인식 결과가 비어 있습니다$/);
});

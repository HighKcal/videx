import { it, expect, vi } from "vitest";
import { OpenAITransport } from "../src/core/openai";

const image = "data:image/jpeg;base64,/9j/2Q==";
const signal = () => new AbortController().signal;

it("only explicit healthy demo discovery permits tokenless requests and omits Authorization", async () => {
  const fetcher = vi.fn(async (url: any) =>
    url === "/api/health"
      ? Response.json({ ready: true, authRequired: false })
      : Response.json({ text: "demo result" }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  expect(await ai.refreshHealth(signal())).toBe(false);
  ai.configure("ignored-in-demo", true, false);
  expect(await ai.vision(image, "ocr", signal())).toBe("demo result");
  const [healthUrl, healthOptions] = fetcher.mock.calls[0] as any;
  expect(healthUrl).toBe("/api/health");
  expect(healthOptions).toMatchObject({
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  const [url, options] = fetcher.mock.calls[1] as any;
  expect(url).toBe("/api/vision");
  expect(new Headers(options.headers).has("Authorization")).toBe(false);
  expect(JSON.parse(options.body)).toEqual({ image, kind: "ocr" });
});
it("fails closed for absent, malformed, unavailable and old health responses", async () => {
  for (const health of [
    null,
    {},
    { ready: true },
    { authRequired: false },
    { ready: true, authRequired: "false" },
    { ready: "false", authRequired: false },
    { ready: true, authRequired: true },
  ]) {
    const fetcher = vi.fn(async () => Response.json(health));
    const ai = new OpenAITransport(fetcher as typeof fetch);
    expect(await ai.refreshHealth(signal())).toBe(true);
    ai.configure("", true, true);
    await expect(ai.vision(image, "ocr", signal())).rejects.toThrow();
    await expect(ai.speech("text", signal())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  for (const response of [
    () => new Response("broken json"),
    () =>
      new Response(JSON.stringify({ ready: true, authRequired: false }), {
        headers: { "content-type": "text/html" },
      }),
    () => new Response("offline", { status: 503 }),
    () => {
      throw Error("network unavailable");
    },
  ]) {
    const ai = new OpenAITransport(
      vi.fn(async () => response()) as typeof fetch,
    );
    expect(await ai.refreshHealth(signal())).toBe(true);
    ai.configure("", true, true);
    await expect(ai.speech("text", signal())).rejects.toThrow();
  }
});
it("retains independent consent gates in demo and still requires a direct BYOK key", async () => {
  const fetcher = vi.fn(async (url: any) =>
    url === "/api/health"
      ? Response.json({ ready: true, authRequired: false })
      : new Response("audio", { headers: { "content-type": "audio/mpeg" } }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  await ai.refreshHealth(signal());
  ai.configure("", false, true);
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
    /^전송 동의가 필요합니다$/,
  );
  expect((await ai.speech("text", signal())).type).toBe("audio/mpeg");
  expect(
    new Headers((fetcher.mock.calls[1] as any)[1].headers).has("authorization"),
  ).toBe(false);
  ai.configure("", true, false);
  await expect(ai.speech("text", signal())).rejects.toThrow();
  ai.configure("", true, true, "direct");
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow();
  await expect(ai.speech("text", signal())).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("reverts to auth-required on refresh and ignores an older late demo confirmation", async () => {
  let resolveOld!: (response: Response) => void;
  const fetcher = vi.fn(async () =>
    Response.json({ ready: true, authRequired: false }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  expect(await ai.refreshHealth(signal())).toBe(false);
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const older = ai.refreshHealth(signal());
  ai.configure("", true, true);
  await expect(ai.speech("text", signal())).rejects.toThrow();
  fetcher.mockResolvedValueOnce(
    Response.json({ ready: true, authRequired: true }),
  );
  expect(await ai.refreshHealth(signal())).toBe(true);
  resolveOld(Response.json({ ready: true, authRequired: false }));
  expect(await older).toBe(true);
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow();
});
it("does not accept an aborted demo discovery", async () => {
  const abort = new AbortController();
  const ai = new OpenAITransport(
    vi.fn(async () => {
      abort.abort();
      return Response.json({ ready: true, authRequired: false });
    }) as typeof fetch,
  );
  expect(await ai.refreshHealth(abort.signal)).toBe(true);
});
it("keeps explicit demo authentication separate from backend readiness", async () => {
  const fetcher = vi.fn(async (url: any) =>
    url === "/api/health"
      ? Response.json({ ready: false, authRequired: false })
      : Response.json({ error: "Service unavailable" }, { status: 503 }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  expect(await ai.refreshHealth(signal())).toBe(false);
  ai.configure("", true, true);
  await expect(ai.speech("text", signal())).rejects.toThrow(
    "서버 사용 불가 (503)",
  );
  expect(
    new Headers((fetcher.mock.calls[1] as any)[1].headers).has("authorization"),
  ).toBe(false);
});

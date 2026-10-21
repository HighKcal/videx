import { it, expect, vi } from "vitest";
import { OpenAITransport } from "../src/core/openai";

const image = "data:image/jpeg;base64,/9j/2Q==";
const signal = () => new AbortController().signal;
const operatorError =
  "운영자 설정 오류 · VIDEX_DEMO_MODE=true 및 서버 설정을 확인하세요";

it("preserves bounded main OCR empty/long text and rejects over-budget output without slicing", async () => {
  const { ai, fetcher } = await setup(() => Response.json({ text: "" }));
  expect(await ai.vision(image, "ocr", signal())).toBe("");
  const text = "가나다\n".repeat(16384);
  fetcher.mockResolvedValueOnce(Response.json({ text }));
  expect(await ai.vision(image, "ocr", signal())).toBe(text);
  fetcher.mockResolvedValueOnce(Response.json({ text: text + "x" }));
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
    /너무 큽니다/,
  );
  fetcher.mockResolvedValueOnce(Response.json({ text: "x".repeat(101) }));
  await expect(ai.vision(image, "object", signal())).rejects.toThrow();
  fetcher.mockResolvedValueOnce(Response.json({ text: "😀".repeat(100) }));
  expect(await ai.vision(image, "object", signal())).toBe("😀".repeat(100));
  fetcher.mockResolvedValueOnce(new Response(" ".repeat(1048577)));
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
    /너무 큽니다/,
  );
});

async function setup(response: () => Promise<Response> | Response) {
  const fetcher = vi.fn(async (url: any) =>
    url === "/api/health"
      ? Response.json({ ready: true, authRequired: false })
      : response(),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  await ai.refreshHealth(signal());
  ai.configure(true, true);
  fetcher.mockClear();
  return { ai, fetcher };
}

it("sends only consented text anonymously and rejects non-MPEG responses", async () => {
  const { ai, fetcher } = await setup(() => new Response("PRIVATE_NOT_AUDIO"));
  const requestSignal = signal();
  await expect(ai.speech("안녕", requestSignal)).rejects.toThrow(
    /^음성 응답 형식이 올바르지 않습니다$/,
  );
  const [url, options] = fetcher.mock.calls[0] as any;
  expect(url).toBe("/api/speech");
  expect(JSON.parse(options.body)).toEqual({ text: "안녕" });
  expect(options.signal).toBe(requestSignal);
  expect([...new Headers(options.headers).keys()]).toEqual(["content-type"]);
  expect(options).toMatchObject({
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "same-origin",
  });
});

it("fails closed before discovery and requires independent consents after discovery, including clear", async () => {
  const { ai, fetcher } = await setup(() => Response.json({ text: "ok" }));
  for (const [imageConsent, speechConsent] of [
    [false, true],
    [true, false],
    [false, false],
  ] as const) {
    ai.configure(imageConsent, speechConsent);
    if (!imageConsent)
      await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
        /^전송 동의가 필요합니다$/,
      );
    if (!speechConsent)
      await expect(ai.speech("text", signal())).rejects.toThrow(
        /^전송 동의가 필요합니다$/,
      );
  }
  ai.configure(true, true);
  ai.clear();
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
    /^전송 동의가 필요합니다$/,
  );
  await expect(ai.speech("text", signal())).rejects.toThrow(
    /^전송 동의가 필요합니다$/,
  );
  expect(fetcher).not.toHaveBeenCalled();
  const unknown = new OpenAITransport(fetcher as typeof fetch);
  unknown.configure(true, true);
  await expect(unknown.vision(image, "ocr", signal())).rejects.toThrow(
    operatorError,
  );
  await expect(unknown.speech("text", signal())).rejects.toThrow(operatorError);
  expect(fetcher).not.toHaveBeenCalled();
});

it("never falls back on server failure or pre-aborted requests and hides response bodies", async () => {
  const { ai, fetcher } = await setup(
    () => new Response("PRIVATE_UPSTREAM_DETAILS", { status: 503 }),
  );
  await expect(ai.speech("text", signal())).rejects.toThrow(
    /^서버 사용 불가 \(503\)$/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/speech");
  const abort = new AbortController();
  abort.abort();
  await expect(ai.speech("text", abort.signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("accepts MPEG speech and rejects late responses after abort without fallback", async () => {
  const { ai, fetcher } = await setup(
    () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      }),
  );
  const audio = await ai.speech("hello", signal());
  expect(audio.type).toBe("audio/mpeg");
  expect(audio.size).toBe(3);
  const abort = new AbortController();
  fetcher.mockImplementationOnce(async () => {
    abort.abort();
    return Response.json({ text: "late" });
  });
  await expect(ai.vision(image, "ocr", abort.signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("uses generic errors for malformed server JSON and invalid results", async () => {
  const { ai, fetcher } = await setup(
    () => new Response("PRIVATE_BROKEN_JSON"),
  );
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
    /^인식 응답 형식이 올바르지 않습니다$/,
  );
  for (const body of [
    null,
    {},
    { text: null },
    { text: 42 },
    {
      output: [{ content: [{ type: "output_text", text: "provider format" }] }],
    },
  ]) {
    fetcher.mockResolvedValueOnce(Response.json(body));
    await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
      /^인식 결과가 비어 있습니다$/,
    );
  }
});

it("enforces JPEG input, vision result, speech input and audio size bounds", async () => {
  const { ai, fetcher } = await setup(() =>
    Response.json({ text: "a".repeat(4001) }),
  );
  for (const invalid of [
    "data:image/png;base64,AAAA",
    "data:image/jpeg;base64,?",
    "data:image/jpeg;base64," + "A".repeat(8_000_000),
  ]) {
    await expect(ai.vision(invalid, "ocr", signal())).rejects.toThrow(
      /^선택한 JPEG가 올바르지 않습니다$/,
    );
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(await ai.vision(image, "ocr", signal())).toBe("a".repeat(4001));
  fetcher.mockResolvedValueOnce(
    new Response("audio", {
      headers: { "content-type": "Audio/MPEG; charset=binary" },
    }),
  );
  await expect(ai.speech("b".repeat(4001), signal())).rejects.toThrow(/4000/);
  await ai.speech("b".repeat(4000), signal());
  expect(JSON.parse((fetcher.mock.calls[1] as any)[1].body)).toEqual({
    text: "b".repeat(4000),
  });
  fetcher.mockResolvedValueOnce(
    new Response(new Uint8Array(10_000_001), {
      headers: { "content-type": "audio/mpeg" },
    }),
  );
  await expect(ai.speech("text", signal())).rejects.toThrow(
    /^음성 응답이 너무 큽니다$/,
  );
});

it("hides speech body stream errors and preserves abort during body reads", async () => {
  const response = new Response("audio", {
    headers: { "content-type": "audio/mpeg" },
  });
  vi.spyOn(response, "blob").mockRejectedValueOnce(
    Error("PRIVATE_STREAM_DETAILS"),
  );
  const { ai, fetcher } = await setup(() => response);
  await expect(ai.speech("text", signal())).rejects.toThrow(
    /^음성 응답 형식이 올바르지 않습니다$/,
  );
  const abort = new AbortController();
  const late = new Response("audio", {
    headers: { "content-type": "audio/mpeg" },
  });
  vi.spyOn(late, "blob").mockImplementationOnce(async () => {
    abort.abort();
    return new Blob(["late"]);
  });
  fetcher.mockResolvedValueOnce(late);
  await expect(ai.speech("text", abort.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("hides network exception secrets without retrying or using a provider endpoint", async () => {
  const { ai, fetcher } = await setup(() => {
    throw Error("PRIVATE_NETWORK_DETAILS");
  });
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
    /^서버 사용 불가$/,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/vision");
});

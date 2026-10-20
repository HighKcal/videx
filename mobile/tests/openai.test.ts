import { it, expect, vi } from "vitest";
import { OpenAITransport } from "../src/core/openai";
it("requires explicit consent and session key, sends only selected image directly and store false", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "읽은 글씨" }] }],
        }),
        { status: 200 },
      ),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  await expect(
    ai.vision(
      "data:image/jpeg;base64,/9j/2Q==",
      "ocr",
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  ai.configure("user-session-key", true, true, "direct");
  expect(
    await ai.vision(
      "data:image/jpeg;base64,/9j/2Q==",
      "ocr",
      new AbortController().signal,
    ),
  ).toBe("읽은 글씨");
  const [url, options] = fetcher.mock.calls[0] as any;
  expect(url).toBe("https://api.openai.com/v1/responses");
  expect(options.referrerPolicy).toBe("no-referrer");
  expect(JSON.parse(options.body).store).toBe(false);
  expect(JSON.parse(options.body).input[0].content[1].image_url).toContain(
    "data:image/jpeg",
  );
});
it("TTS sends text only and uses corrected model; handles API errors without exposing response secrets", async () => {
  const fetcher = vi.fn(
    async () => new Response("secret error", { status: 401 }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  ai.configure("session", true, true, "direct");
  await expect(ai.speech("안녕", new AbortController().signal)).rejects.toThrow(
    "401",
  );
  const [url, options] = fetcher.mock.calls[0] as any;
  expect(url).toBe("https://api.openai.com/v1/audio/speech");
  expect(JSON.parse(options.body)).toMatchObject({
    model: "gpt-4o-mini-tts",
    input: "안녕",
  });
  expect(options.body).not.toContain("image");
  ai.clear();
  await expect(
    ai.speech("안녕", new AbortController().signal),
  ).rejects.toThrow();
});

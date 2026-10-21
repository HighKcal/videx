import { it, expect, vi } from "vitest";
import { OpenAITransport } from "../src/core/openai";

const image = "data:image/jpeg;base64,/9j/2Q==";
const signal = () => new AbortController().signal;

it("sends only the selected image anonymously to same-origin after explicit demo health and consent", async () => {
  const fetcher = vi.fn(async (url: any) =>
    url === "/api/health"
      ? Response.json({ ready: true, authRequired: false })
      : Response.json({ text: "읽은 글씨" }),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  ai.configure(true, false);
  await expect(ai.vision(image, "ocr", signal())).rejects.toThrow(
    "운영자 설정 오류 · VIDEX_DEMO_MODE=true 및 서버 설정을 확인하세요",
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(await ai.refreshHealth(signal())).toBe(false);
  expect(await ai.vision(image, "ocr", signal())).toBe("읽은 글씨");
  const [url, options] = fetcher.mock.calls[1] as any;
  expect(url).toBe("/api/vision");
  expect(JSON.parse(options.body)).toEqual({ image, kind: "ocr" });
  expect([...new Headers(options.headers).keys()]).toEqual(["content-type"]);
  expect(options).toMatchObject({
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "same-origin",
  });
  await expect(ai.speech("안녕", signal())).rejects.toThrow(
    /^전송 동의가 필요합니다$/,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

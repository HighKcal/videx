import { test, expect } from "@playwright/test";
import {
  installUsb,
  mp3,
  observeAudio,
  expectLegacyWrites,
} from "./cdc-fixtures";
import { startBackend, closeServer, providerKey } from "./backend-fixture";

test.describe("default legacy browser transport", () => {
  test("real Node demo + legacy CDC physical short/long -> OCR/front-back/TTS, no credentials", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const upstream: Array<{
      url: string;
      body: any;
      authorization: string | null;
    }> = [];
    const runtime = await startBackend(async (url, options) => {
      const body = JSON.parse(String(options?.body)),
        endpoint = String(url);
      upstream.push({
        url: endpoint,
        body,
        authorization: new Headers(options?.headers).get("authorization"),
      });
      if (endpoint === "https://api.openai.com/v1/chat/completions")
        return Response.json({
          choices: [
            {
              message: {
                content: body.response_format
                  ? JSON.stringify({ text: "실제 글씨 결과" })
                  : "실제 앞뒷면 결과",
              },
            },
          ],
        });
      if (endpoint === "https://api.openai.com/v1/audio/speech")
        return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
      throw Error("Real upstream networking is forbidden");
    });
    const requests: any[] = [],
      origins: Array<string | undefined> = [];
    runtime.server.on("request", (req) => {
      if (req.method === "POST") {
        origins.push(req.headers.origin);
        expect(req.headers.authorization).toBeUndefined();
      }
    });
    page.on("request", (request) => {
      if (request.method() === "POST")
        requests.push({
          url: request.url(),
          body: request.postDataJSON(),
          authorization: request.headers().authorization,
        });
    });
    try {
      await installUsb(page);
      await observeAudio(page);
      const response = await page.goto(runtime.origin);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toContain(
        "connect-src 'self';",
      );
      await page
        .getByRole("button", { name: "VIDEX 진단 및 설정 열기" })
        .click();
      await expect(page.getByTestId("server-setup")).toContainText("데모 모드");
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
      expect(upstream).toHaveLength(0);
      await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
      await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
      expect(await page.evaluate(() => (window as any).usbGesture)).toBe(true);

      await expect(page.getByTestId("input-frame")).toContainText("320×240");
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as any).usbWrites.some((w: any) => w.raw === 0),
          ),
        )
        .toBe(true);
      await page.evaluate(() => (window as any).usbButton("button_long"));
      await expect(
        page.getByRole("button", { name: "글씨 읽기", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("input-frame")).toContainText("640×480");
      await page.waitForTimeout(180); // Allow the observed-dimension promise to settle; no wire ACK.
      await page.getByRole("button", { name: "메인 화면으로" }).click();
      await page.evaluate(() => (window as any).usbButton("button_short"));
      await expect(page.getByRole("status")).toContainText("동의가 필요");
      expect(requests).toHaveLength(0);
      expect(upstream).toHaveLength(0);
      await page
        .getByRole("button", { name: "VIDEX 진단 및 설정 열기" })
        .click();
      await page.getByLabel("선택 사진 전송 동의").check();
      await page.getByLabel("텍스트 OpenAI AI 음성 전송 동의").check();
      await page
        .getByRole("button", { name: "음성 재생 활성화", exact: true })
        .click();
      await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
      await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
      await expect(page.getByTestId("input-frame")).toContainText("640×480");
      await expect(page.getByTestId("speech-state")).toHaveText("음성 완료");
      await page.waitForTimeout(180);
      await page.getByRole("button", { name: "메인 화면으로" }).click();
      const ended = await page.evaluate(
        () => (window as any).audioEvidence.ended,
      );
      const resultSpeech = page.waitForResponse(
        (r) =>
          r.url() === runtime.origin + "/api/speech" &&
          r.request().postDataJSON().text === "실제 글씨 결과",
      );
      await page.evaluate(() => (window as any).usbButton("button_short"));
      await expect(page.getByRole("status")).toHaveText("실제 글씨 결과");
      expect((await resultSpeech).status()).toBe(200);
      expect((await resultSpeech).headers()["content-type"]).toBe("audio/mpeg");
      await expect
        .poll(() => page.evaluate(() => (window as any).audioEvidence.ended))
        .toBeGreaterThan(ended);
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).audioEvidence.bytes.at(-1)),
        )
        .toEqual(Array.from(mp3));
      await page.evaluate(() => (window as any).usbButton("button_long"));
      await expect(page.getByRole("status")).toContainText("앞면");
      await page.waitForTimeout(180);
      await page.evaluate(() => (window as any).usbButton("button_short"));
      await expect(page.getByRole("status")).toContainText("뒷면");
      const oldFrame = await page.evaluate(() => {
        (window as any).usbBack = true;
        return (window as any).usbFrameId;
      });
      await expect
        .poll(() => page.evaluate(() => (window as any).usbFrameId))
        .toBeGreaterThan(oldFrame + 1);
      await page.evaluate(() => (window as any).usbButton("button_short"));
      await expect(page.getByRole("status")).toHaveText(
        "인식된 제품은 실제 앞뒷면 결과입니다.",
      );
      expect(requests.filter((r) => r.url.endsWith("/vision"))).toHaveLength(2);
      for (const request of requests) {
        expect(request.url.startsWith(runtime.origin + "/api/")).toBe(true);
        expect(request.authorization).toBeUndefined();
        expect(Object.keys(request.body).sort()).toEqual(
          request.url.endsWith("/vision") ? ["image", "kind"] : ["text"],
        );
      }
      expect(origins.length).toBeGreaterThan(2);
      expect(origins.every((origin) => origin === runtime.origin)).toBe(true);
      expect(
        upstream.every((r) => r.authorization === `Bearer ${providerKey}`),
      ).toBe(true);
      expect(JSON.stringify(requests)).not.toContain(providerKey);
      const writes = await page.evaluate(() => (window as any).usbWrites);
      expect(writes.some((w: any) => w.raw === 1)).toBe(true);
      await expectLegacyWrites(page);
      await page
        .getByRole("button", { name: "VIDEX 진단 및 설정 열기" })
        .click();
      await expect(page.getByTestId("vision-runtime")).toHaveText("wasm");
      await expect
        .poll(async () =>
          Number(await page.getByTestId("processed").textContent()),
        )
        .toBeGreaterThan(0);
      await page
        .getByRole("button", { name: "전송 동의 철회 및 세션 삭제" })
        .click();
      const before = requests.length;
      await page.getByRole("button", { name: "메인 화면으로" }).click();
      await page.getByRole("button", { name: "현재 기능 실행" }).click();
      await page.waitForTimeout(150);
      expect(requests).toHaveLength(before);
      expect(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
      ).toBe(0);
    } finally {
      await page.close();
      await closeServer(runtime.server);
    }
  });
});

test("real auth-required Node is an operator error, never a key prompt or provider call", async ({
  page,
}) => {
  let calls = 0;
  const runtime = await startBackend(
    async () => {
      calls++;
      throw Error("must not call");
    },
    undefined,
    false,
  );
  try {
    await installUsb(page);
    await page.goto(runtime.origin);
    await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
    await expect(page.getByTestId("server-setup")).toContainText(
      "운영자 설정 오류",
    );
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await page.getByLabel("텍스트 OpenAI AI 음성 전송 동의").check();
    await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
    await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
    expect(calls).toBe(0);
  } finally {
    await page.close();
    await closeServer(runtime.server);
  }
});

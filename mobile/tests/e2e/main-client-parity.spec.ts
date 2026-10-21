import { test, expect } from "@playwright/test";
import { installUsb, observeFrames, expectLegacyWrites } from "./cdc-fixtures";

test("main manual OCR accepts a flat 640x480 frame, preserves long/empty text and uses local speech by default", async ({
  page,
}) => {
  const longText = "문서 원문\n".repeat(900);
  let images = 0,
    remoteSpeech = 0;
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ready: true, authRequired: false } }),
  );
  await page.route("**/api/vision", (route) => {
    images++;
    return route.fulfill({ json: { text: images === 1 ? longText : "" } });
  });
  await page.route("**/api/speech", (route) => {
    remoteSpeech++;
    return route.abort();
  });
  await installUsb(page);
  await page.addInitScript(() => {
    const w = window as any;
    w.localSpeech = [];
    w.SpeechSynthesisUtterance = class {
      constructor(public text: string) {}
    };
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        cancel() {},
        resume() {},
        getVoices: () => [
          { lang: "ko-KR", localService: true, name: "synthetic-local" },
        ],
        speak(u: SpeechSynthesisUtterance) {
          w.localSpeech.push(u.text);
          queueMicrotask(() =>
            u.onend?.(new Event("end") as SpeechSynthesisEvent),
          );
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(page.getByTestId("server-setup")).toContainText("데모 모드");
  await page.evaluate(() => {
    (window as any).usbFlat = true;
  });
  await page.getByLabel("선택 사진 전송 동의", { exact: true }).check();
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await page.getByRole("button", { name: "글씨 읽기", exact: true }).click();
  await expect(page.getByTestId("input-frame")).toContainText("640×480");
  await observeFrames(page, 2);
  await page.getByRole("button", { name: "메인 화면으로" }).click();
  await page.evaluate(() => (window as any).usbButton("button_short"));
  await expect(page.getByRole("status")).toHaveText(longText);
  await expect.poll(() => images).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).localSpeech
          .join("")
          .includes("문서 원문\n".repeat(900)),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).usbButton("button_short"));
  await expect(page.getByRole("status")).toHaveText("인식된 글자가 없습니다.");
  expect(images).toBe(2);
  expect(remoteSpeech).toBe(0);
  await expectLegacyWrites(page);
});

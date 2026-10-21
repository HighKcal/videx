import { test, expect } from "@playwright/test";
import { installUsb, observeFrames, expectLegacyWrites } from "./cdc-fixtures";

// Authored for the lead's frozen-source run; this worker does not launch E2E servers.
test("button diagnostics distinguish wire level, accepted events and app dispatch without consent/upload", async ({
  page,
}) => {
  let uploads = 0;
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ready: true, authRequired: false } }),
  );
  await page.route("**/api/vision", (route) => {
    uploads++;
    return route.fulfill({ status: 500, json: { error: "Unexpected upload" } });
  });
  await installUsb(page);
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  const panel = page.getByRole("region", { name: "물리 버튼 진단 (LEFT)" });
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("button-availability")).toContainText(
    "프레임 없음",
  );
  await page.evaluate(() => {
    (window as any).usbVideo = false;
  });
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
  await expect(page.getByTestId("button-availability")).toContainText(
    "프레임 없음",
  );
  await page.evaluate(() => {
    (window as any).usbVideo = true;
  });
  await expect(page.getByTestId("button-level")).toHaveText("놓음");
  await expect(page.getByTestId("button-metadata")).toContainText(
    "valid=1 · classified=1",
  );
  await expect(page.getByTestId("button-decision")).toContainText(
    "반복 상태 무시",
  );
  await page.evaluate(() => {
    (window as any).usbLegacyState = { pressed: true, result: 0 };
  });
  await expect(page.getByTestId("button-level")).toHaveText("눌림");
  await expect(page.getByTestId("button-short-count")).toHaveText("0");
  await expect(page.getByTestId("button-long-count")).toHaveText("0");
  await page.evaluate(() => {
    (window as any).usbLegacyState = { pressed: false, result: 1 };
  });
  await expect(page.getByTestId("button-short-count")).toHaveText("1");
  await expect(page.getByTestId("button-dispatch")).toContainText(
    "SHORT → 촬영/실행 요청",
  );
  await page.evaluate(() => (window as any).usbButton("button_long"));
  await expect(page.getByTestId("button-long-count")).toHaveText("1");
  await expect(page.getByTestId("button-dispatch")).toContainText(
    "LONG → 모드 순환 요청",
  );
  await expect(page.getByTestId("button-app-state")).toContainText(
    "현재 모드: ocr",
  );
  await expect(page.getByTestId("input-frame")).toContainText("640×480");
  await page.evaluate(() => (window as any).usbButton("button_short"));
  await expect(page.getByTestId("button-short-count")).toHaveText("2");
  await expect(page.getByTestId("button-app-state")).toContainText("동의");
  await observeFrames(page);
  await expect(page.getByTestId("button-short-count")).toHaveText("2");
  await expect(page.getByTestId("button-last-event")).toContainText("SHORT");
  await expect(page.getByTestId("button-firmware-result")).toContainText(
    "SHORT (1)",
  );
  await expect(page.getByTestId("button-received")).toContainText("ms");
  expect(uploads).toBe(0);
  await expectLegacyWrites(page);

  await page.evaluate(() => {
    (window as any).usbLegacyState = { pressed: true, result: 1 };
  });
  await expect(page.getByTestId("button-level")).toHaveText("눌림");
  await page.evaluate(() => {
    (window as any).usbVideo = false;
  });
  await expect(page.getByTestId("button-availability")).toContainText(
    "수신 지연",
  );
  await expect(page.getByTestId("button-level")).toHaveText("알 수 없음");
  await page.evaluate(() => (window as any).usbUnplug());
  await expect(page.getByTestId("button-availability")).toContainText(
    "연결 끊김",
  );
  await expect(page.getByTestId("button-level")).toHaveText("알 수 없음");
  await page
    .getByRole("button", { name: "USB 연결 종료 및 세션 삭제" })
    .click();
  await expect(page.getByTestId("button-short-count")).toHaveText("0");
  await expect(page.getByTestId("button-last-event")).toHaveText("없음");
  expect(uploads).toBe(0);
});

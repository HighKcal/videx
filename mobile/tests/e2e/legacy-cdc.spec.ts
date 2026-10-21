import { test, expect } from "@playwright/test";
import { installUsb, observeFrames, expectLegacyWrites } from "./cdc-fixtures";

test("legacy CAM2 flags/buttons work without a USB2 probe and use raw mode bytes", async ({
  page,
}) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ready: true, authRequired: false } }),
  );
  const vision: Array<{ image: string; kind: string }> = [];
  await page.route("**/api/vision", async (route) => {
    vision.push(route.request().postDataJSON());
    await route.fulfill({
      json: { text: `LEGACY_CAPTURE_RESULT_${vision.length}` },
    });
  });
  await installUsb(page);
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(page.getByTestId("server-setup")).toContainText("데모 모드");
  await page.getByLabel("선택 사진 전송 동의").check();
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
  await expect(page.getByTestId("input-frame")).toContainText("320×240");
  await expect
    .poll(() => page.evaluate(() => (window as any).usbWrites))
    .toContainEqual({ raw: 0 });

  // Fixture sends installed-firmware CAM2 frame flags/result: classified,
  // valid+released (6), valid+pressed (7), and repeated SHORT/LONG result 1/2.
  // It never sends a USB2 connected control record.
  await page.evaluate(() => (window as any).usbButton("button_long"));
  await expect(
    page.getByRole("button", { name: "글씨 읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("input-frame")).toContainText("640×480");
  await expect
    .poll(() => page.evaluate(() => (window as any).usbWrites))
    .toContainEqual({ raw: 1 });

  await page.getByRole("button", { name: "메인 화면으로" }).click();
  await page.evaluate(() => (window as any).usbButton("button_short"));
  await expect(page.getByRole("status")).toHaveText("LEGACY_CAPTURE_RESULT_1");
  await expect.poll(() => vision.length).toBe(1);
  expect(vision[0].kind).toBe("ocr");
  expect(vision[0].image).toMatch(/^data:image\/jpeg;base64,/);

  // Persistent SHORT on later released frames must not request more photos.
  await observeFrames(page);
  expect(vision).toHaveLength(1);
  await page.evaluate(() => (window as any).usbButton("button_short"));
  await expect(page.getByRole("status")).toHaveText("LEGACY_CAPTURE_RESULT_2");
  await observeFrames(page);
  expect(vision).toHaveLength(2);

  // Consecutive LONGs have identical LAST results but distinct physical edges.
  await page.evaluate(() => (window as any).usbButton("button_long"));
  await expect(page.getByRole("status")).toContainText("앞면");
  await observeFrames(page);
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(
    page.getByRole("button", { name: "물체 인식", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => (window as any).usbButton("button_long"));
  await expect(
    page.getByRole("button", { name: "보행 감지", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("input-frame")).toContainText("320×240");
  await observeFrames(page);
  await expect(
    page.getByRole("button", { name: "보행 감지", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(vision).toHaveLength(2);
  await expectLegacyWrites(page);
});

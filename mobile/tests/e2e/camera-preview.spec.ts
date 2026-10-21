import { test, expect } from "@playwright/test";
import { installUsb, observeFrames, expectLegacyWrites } from "./cdc-fixtures";

// Lead runs this against frozen source; no server is started by this worker.
test("live LEFT preview draws native oriented pixels, clears stale/disconnected images and never uploads", async ({
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
  await page.addInitScript(() => {
    (window as any).previewDraws = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args: any[]
    ) {
      if (
        (this.canvas as HTMLCanvasElement).dataset?.testid ===
        "camera-preview-canvas"
      )
        (window as any).previewDraws++;
      return (draw as any).apply(this, args);
    } as typeof draw;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  const preview = page.getByRole("region", {
    name: "실시간 LEFT 카메라 미리보기",
  });
  const canvas = page.getByTestId("camera-preview-canvas");
  const status = page.getByTestId("camera-preview-status");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("마지막 OCR 촬영 사진과는 다릅니다");
  await expect(status).toContainText("연결 끊김");
  const positions = await page.evaluate(() => ({
    preview: document
      .querySelector('[data-testid="camera-preview"]')!
      .getBoundingClientRect().top,
    buttons: document
      .querySelector('[data-testid="button-diagnostics"]')!
      .getBoundingClientRect().top,
  }));
  expect(positions.preview).toBeLessThan(positions.buttons);
  await page.evaluate(() => {
    (window as any).usbVideo = false;
  });
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
  await expect(status).toContainText("프레임 없음");
  await page.evaluate(() => {
    (window as any).usbVideo = true;
  });
  await expect(status).toContainText("실시간 영상 표시 중");
  await expect(canvas).toHaveAttribute("width", "240");
  await expect(canvas).toHaveAttribute("height", "320");
  await expect(page.getByTestId("camera-preview-metadata")).toContainText(
    "실제 수신 320×240",
  );
  expect(
    await canvas.evaluate((node: HTMLCanvasElement) => {
      const pixels = node
        .getContext("2d")!
        .getImageData(0, 0, node.width, node.height).data;
      return pixels.some((value, index) => index % 4 !== 3 && value > 0);
    }),
  ).toBe(true);
  await page
    .getByRole("combobox", { name: /카메라 회전/ })
    .selectOption("none");
  await expect(canvas).toHaveAttribute("width", "320");
  await expect(canvas).toHaveAttribute("height", "240");
  await page.getByRole("button", { name: "글씨 읽기", exact: true }).click();
  await expect(canvas).toHaveAttribute("width", "640");
  await expect(canvas).toHaveAttribute("height", "480");
  await page
    .getByRole("combobox", { name: /카메라 회전/ })
    .selectOption("cw90");
  await expect(canvas).toHaveAttribute("width", "480");
  await expect(canvas).toHaveAttribute("height", "640");
  const ratio = await canvas.evaluate((node: HTMLCanvasElement) => {
    const box = node.getBoundingClientRect();
    return box.width / box.height;
  });
  expect(ratio).toBeCloseTo(480 / 640, 2);
  await page.getByRole("button", { name: "메인 화면으로" }).click();
  await expect(canvas).toHaveCount(0);
  const draws = await page.evaluate(() => (window as any).previewDraws);
  await observeFrames(page);
  expect(await page.evaluate(() => (window as any).previewDraws)).toBe(draws);
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(status).toContainText("실시간 영상 표시 중");
  await page.evaluate(() => {
    (window as any).usbVideo = false;
  });
  await expect(status).toContainText("수신 지연");
  await expect(canvas).toHaveAttribute("width", "0");
  await expect(canvas).toHaveAttribute("height", "0");
  await expect(canvas).toBeHidden();
  await page.evaluate(() => {
    (window as any).usbVideo = true;
  });
  await expect(status).toContainText("실시간 영상 표시 중");
  await page.evaluate(() => (window as any).usbUnplug());
  await expect(status).toContainText("연결 끊김");
  await expect(canvas).toHaveAttribute("width", "0");
  await expect(canvas).toHaveAttribute("height", "0");
  await expect(canvas).toBeHidden();
  expect(uploads).toBe(0);
  await expectLegacyWrites(page);
});

import { test, expect } from "@playwright/test";
import { installUsb, observeFrames, expectLegacyWrites } from "./cdc-fixtures";

test("legacy has no independent no-JPEG button channel and does not replay missed edges", async ({
  page,
}) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ready: true, authRequired: false } }),
  );
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await installUsb(page);
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
  await observeFrames(page);
  await page.evaluate(() => {
    const w = window as any;
    w.usbVideo = false;
    w.usbLegacyState = { pressed: true, result: 2 };
  });
  // Historical controls ride LEFT JPEG metadata: no independent delivery or
  // event IDs exist. CDC2 guarantees are an explicit-opt-in unit-test concern.
  await page.waitForTimeout(350);
  await expect(
    page.getByRole("button", { name: "보행 감지", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    const w = window as any;
    w.usbLegacyState = { pressed: false, result: 2 };
    w.usbVideo = true;
  });
  await observeFrames(page);
  await expect(
    page.getByRole("button", { name: "보행 감지", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => (window as any).usbButton("button_long"));
  await expect(
    page.getByRole("button", { name: "글씨 읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("input-frame")).toContainText("640×480");
  await page.getByRole("button", { name: "메인 화면으로" }).click();
  await page.evaluate(() => (window as any).usbButton("button_short"));
  await expect(page.getByRole("status")).toContainText("동의가 필요");
  expect(posts).toEqual([]);
  await expectLegacyWrites(page);
});

for (const held of [false, true]) {
  test(`legacy reconnect baselines stale LAST result while ${held ? "held" : "released"}`, async ({
    page,
  }) => {
    await page.route("**/api/health", (route) =>
      route.fulfill({ json: { ready: true, authRequired: false } }),
    );
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(request.url());
    });
    await installUsb(page);
    await page.goto("/");
    await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
    await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
    await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
    await observeFrames(page);
    await page.evaluate(() => (window as any).usbUnplug());
    await expect(page.getByTestId("connection")).toContainText("USB 장치 분리");
    await page.evaluate((pressed) => {
      (window as any).usbLegacyState = { pressed, result: 2 };
    }, held);
    await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
    await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
    await observeFrames(page);
    await page.evaluate(() => {
      (window as any).usbLegacyState = { pressed: false, result: 2 };
    });
    await observeFrames(page);
    await expect(
      page.getByRole("button", { name: "보행 감지", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    // Same LAST value, this time with a complete new press/release.
    await page.evaluate(() => (window as any).usbButton("button_long"));
    await expect(
      page.getByRole("button", { name: "글씨 읽기", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await observeFrames(page);
    await expect(
      page.getByRole("button", { name: "글씨 읽기", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(posts).toEqual([]);
    await expectLegacyWrites(page);
  });
}

test("legacy video stall clears an armed press and baselines recovery without replay", async ({
  page,
}) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ready: true, authRequired: false } }),
  );
  await installUsb(page);
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
  await observeFrames(page, 2);
  await page.evaluate(() => {
    (window as any).usbLegacyState = { pressed: true, result: 2 };
  });
  await observeFrames(page, 2);
  await page.evaluate(() => {
    (window as any).usbVideo = false;
  });
  await expect(page.getByTestId("connection")).toContainText("UNKNOWN");
  await expect(page.getByTestId("input-frame")).toHaveText("영상 대기");
  await page.evaluate(() => {
    const w = window as any;
    w.usbLegacyState = { pressed: false, result: 2 };
    w.usbVideo = true;
  });
  await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
  await observeFrames(page);
  await expect(
    page.getByRole("button", { name: "보행 감지", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => (window as any).usbButton("button_long"));
  await expect(
    page.getByRole("button", { name: "글씨 읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectLegacyWrites(page);
});

for (const cancellation of [
  "mode change",
  "consent withdrawal",
  "unplug/reconnect",
  "capture restart",
] as const) {
  test(`legacy ${cancellation} ignores a delayed same-origin OCR result`, async ({
    page,
  }) => {
    await page.route("**/api/health", (route) =>
      route.fulfill({ json: { ready: true, authRequired: false } }),
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed!: () => void;
    const responseCompleted = new Promise<void>((resolve) => {
      completed = resolve;
    });
    let images = 0;
    await page.route("**/api/vision", async (route) => {
      images++;
      if (images > 1) {
        await route.fulfill({ json: { text: "FRESH_LEGACY_RESULT" } });
        return;
      }
      await pending;
      await route
        .fulfill({ json: { text: "LATE_PRIVATE_RESULT" } })
        .catch(() => {});
      completed();
    });
    await installUsb(page);
    try {
      await page.goto("/");
      await page
        .getByRole("button", { name: "VIDEX 진단 및 설정 열기" })
        .click();
      await page.getByLabel("선택 사진 전송 동의").check();
      await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
      await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
      await page
        .getByRole("button", { name: "글씨 읽기", exact: true })
        .click();
      await expect(page.getByTestId("input-frame")).toContainText("640×480");
      await observeFrames(page, 2);
      await page.getByRole("button", { name: "메인 화면으로" }).click();
      await page.evaluate(() => (window as any).usbButton("button_short"));
      await expect.poll(() => images).toBe(1);
      if (cancellation === "mode change") {
        await page.evaluate(() => (window as any).usbButton("button_long"));
        await expect(page.getByRole("status")).toContainText("앞면");
      } else {
        await page
          .getByRole("button", { name: "VIDEX 진단 및 설정 열기" })
          .click();
        if (cancellation === "consent withdrawal") {
          await page
            .getByRole("button", { name: "전송 동의 철회 및 세션 삭제" })
            .click();
          await expect(page.getByTestId("connection")).toHaveText(
            "DISCONNECTED",
          );
        } else if (cancellation === "unplug/reconnect") {
          await page.evaluate(() => (window as any).usbUnplug());
          await expect(page.getByTestId("connection")).toContainText(
            "USB 장치 분리",
          );
          await page.getByLabel("선택 사진 전송 동의").check();
          await page
            .getByRole("button", { name: "USB 장치 선택 및 연결" })
            .click();
          await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
          await expect(page.getByTestId("input-frame")).toContainText(
            "640×480",
          );
          await observeFrames(page, 2);
        } else {
          await page
            .getByRole("button", { name: "촬영 취소 및 다시 시작" })
            .click();
        }
        await page.getByRole("button", { name: "메인 화면으로" }).click();
      }
      release();
      await responseCompleted;
      if (cancellation !== "consent withdrawal") await observeFrames(page);
      else await page.waitForTimeout(150);
      await expect(page.getByRole("status")).not.toContainText(
        "LATE_PRIVATE_RESULT",
      );
      const canRecapture =
        cancellation === "unplug/reconnect" ||
        cancellation === "capture restart";
      if (canRecapture) {
        await page.evaluate(() => (window as any).usbButton("button_short"));
        await expect(page.getByRole("status")).toHaveText(
          "FRESH_LEGACY_RESULT",
        );
        expect(images).toBe(2);
      }
      await page
        .getByRole("button", { name: "VIDEX 진단 및 설정 열기" })
        .click();
      await expectLegacyWrites(page);
      await page
        .getByRole("button", { name: "전송 동의 철회 및 세션 삭제" })
        .click();
      await expect(page.getByTestId("connection")).toHaveText("DISCONNECTED");
      await page.getByRole("button", { name: "메인 화면으로" }).click();
      await page.getByRole("button", { name: "현재 기능 실행" }).click();
      await page.waitForTimeout(150);
      expect(images).toBe(canRecapture ? 2 : 1);
      await expect(page.getByRole("status")).not.toContainText(
        "LATE_PRIVATE_RESULT",
      );
    } finally {
      release();
    }
  });
}

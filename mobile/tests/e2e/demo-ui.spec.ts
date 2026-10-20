import { test, expect } from "@playwright/test";

test("health discovery is fail-closed, demo hides only server token, and refreshes on setup not on capture screen", async ({
  page,
}) => {
  let health: unknown = { ready: true, authRequired: false };
  let healthCalls = 0;
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await page.route("**/api/health", async (route) => {
    healthCalls++;
    await route.fulfill({ json: health });
  });
  await page.goto("/");
  await expect.poll(() => healthCalls).toBe(1);
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(page.getByLabel("서버 접근 토큰")).toHaveCount(0);
  await expect(page.getByText("데모 모드", { exact: false })).toBeVisible();
  await expect.poll(() => healthCalls).toBe(2);
  await page.getByLabel("AI 전송 경로").selectOption("direct");
  await expect(page.getByLabel("OpenAI 세션 API 키")).toBeVisible();
  await page.getByLabel("AI 전송 경로").selectOption("server");
  await expect(page.getByLabel("서버 접근 토큰")).toHaveCount(0);
  await page.getByRole("button", { name: "메인 화면으로" }).click();
  await expect(
    page.getByRole("button", { name: "현재 기능 실행" }),
  ).toBeVisible();
  // Closing settings must not invalidate confirmed demo right before capture.
  expect(healthCalls).toBe(2);
  health = { ready: true }; // Old/malformed server cannot silently enable demo.
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect.poll(() => healthCalls).toBe(3);
  await expect(page.getByLabel("서버 접근 토큰")).toBeVisible();
  await expect(page.getByText("데모 모드", { exact: false })).toHaveCount(0);
  expect(posts).toEqual([]);
});

test("pending/unavailable health never blocks USB chooser gesture and makes no paid request", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/health", async (route) => {
    await pending;
    await route
      .fulfill({ status: 503, json: { error: "unavailable" } })
      .catch(() => {});
  });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        requestDevice: async () => {
          (window as any).demoUsbGesture = navigator.userActivation.isActive;
          throw new DOMException("cancelled", "NotFoundError");
        },
        addEventListener() {},
        removeEventListener() {},
      },
    }),
  );
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
    await expect(page.getByLabel("서버 접근 토큰")).toBeVisible();
    await page.getByLabel("연결 방식").selectOption("usb");
    await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
    await expect(page.getByTestId("connection")).toContainText("USB 선택 취소");
    expect(await page.evaluate(() => (window as any).demoUsbGesture)).toBe(
      true,
    );
    expect(posts).toEqual([]);
  } finally {
    release();
  }
});

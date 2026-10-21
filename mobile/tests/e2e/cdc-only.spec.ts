import { test, expect } from "@playwright/test";

for (const health of [
  { ready: true, authRequired: true },
  { ready: false, authRequired: false },
  { ready: true },
]) {
  test(`CDC-only without credential prompts: operator setup for ${JSON.stringify(health)}`, async ({
    page,
  }) => {
    await page.route("**/api/health", (route) =>
      route.fulfill({ json: health }),
    );
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    await page.goto("/");
    await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
    await expect(
      page.locator(
        'input[type="password"],input[name="apiKey"],input[name="pairing"]',
      ),
    ).toHaveCount(0);
    await expect(page.getByLabel("연결 방식")).toHaveCount(0);
    await expect(page.getByLabel("S3 USB 펌웨어")).toHaveCount(0);
    await expect(page.getByLabel("AI 전송 경로")).toHaveCount(0);
    await expect(
      page.getByText("운영자 설정 오류", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "USB 장치 선택 및 연결" }),
    ).toBeVisible();
    expect(posts).toEqual([]);
  });
}
test("pending health retains CDC click activation and never flashes key or token input", async ({
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
          (window as any).chooserGesture = navigator.userActivation.isActive;
          throw new DOMException("cancelled", "NotFoundError");
        },
        addEventListener() {},
        removeEventListener() {},
      },
    }),
  );
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
    await expect(page.getByTestId("connection")).toContainText("USB 선택 취소");
    expect(await page.evaluate(() => (window as any).chooserGesture)).toBe(
      true,
    );
    await expect(page.getByTestId("server-setup")).toHaveText(
      "서버 상태 확인 중",
    );
    await expect(
      page.getByText("운영자 설정 오류", { exact: false }),
    ).toHaveCount(0);
  } finally {
    release();
  }
});

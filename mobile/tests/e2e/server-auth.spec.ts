import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ready: true, authRequired: true } }),
  );
});

test("server default keeps credentials out of storage, clears form on apply and never retries direct on failure", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("https://api.openai.com/**", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await page.route("**/api/speech", async (route) => {
    requests.push(route.request().url());
    expect(route.request().headers().authorization).toBe(
      "Bearer mock-access-token",
    );
    expect(Object.keys(route.request().postDataJSON())).toEqual(["text"]);
    await route.fulfill({
      status: 401,
      json: { error: "PRIVATE_ERROR_NOT_FOR_UI" },
    });
  });
  await page.routeWebSocket("wss://videx.local/ws", (ws) =>
    ws.onMessage((raw) => {
      if (typeof raw === "string" && JSON.parse(raw).type === "authenticate")
        ws.send(JSON.stringify({ type: "connected", epoch: 1 }));
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(page.getByLabel("AI 전송 경로")).toHaveValue("server");
  await expect(page.getByLabel("OpenAI 세션 API 키")).toHaveCount(0);
  await page.getByLabel("장치 페어링 토큰").fill("mock-pair");
  await page.getByLabel("서버 접근 토큰").fill("mock-access-token");
  await page.getByLabel("텍스트 OpenAI AI 음성 전송 동의").check();
  await page.getByRole("button", { name: "설정 적용 및 연결" }).click();
  await expect(page.getByLabel("서버 접근 토큰")).toHaveValue("");
  await expect(page.getByTestId("speech-state")).toHaveText(
    "OpenAI 음성 사용 불가 · 자막 확인 / 화면에서 음성 재생 활성화",
  );
  await expect(page.locator("body")).not.toContainText(
    "PRIVATE_ERROR_NOT_FOR_UI",
  );
  expect(requests).toHaveLength(1);
  expect(requests.every((url) => url.endsWith("/api/speech"))).toBe(true);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  await page
    .getByRole("button", { name: "전송 동의 철회 및 세션 삭제" })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(page.getByLabel("서버 접근 토큰")).toHaveValue("");
  await expect(page.getByTestId("connection")).toHaveText("DISCONNECTED");
});

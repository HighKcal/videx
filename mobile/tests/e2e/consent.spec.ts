import { test, expect } from "@playwright/test";
test("no image POST before consent or after withdrawal; delayed vision never overwrites new mode/disconnected state", async ({
  page,
}) => {
  let socket: any;
  let seq = 0,
    event = 0;
  const posts: any[] = [];
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/**", async (route) => {
    if (route.request().url().endsWith("/health")) {
      await route.fulfill({ json: { ready: true, authRequired: true } });
      return;
    }
    posts.push(route.request().postDataJSON());
    await waiting;
    await route
      .fulfill({
        json: { text: "LATE_PRIVATE_RESULT" },
      })
      .catch(() => {});
  });
  await page.routeWebSocket("wss://videx.local/ws", (ws) => {
    socket = ws;
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      const m = JSON.parse(message);
      if (m.type === "authenticate")
        ws.send(JSON.stringify({ type: "connected", epoch: 22 }));
      if (m.type === "resolution")
        ws.send(
          JSON.stringify({
            type: "resolution_applied",
            request_id: m.request_id,
            mode: m.mode,
            width: m.mode === 2 ? 1280 : 320,
            height: m.mode === 2 ? 1024 : 240,
          }),
        );
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  const configure = async (consent: boolean) => {
    await page.getByLabel("장치 페어링 토큰").fill("mock-pair");
    await page.getByLabel("서버 접근 토큰").fill("mock-server-token");
    if (consent) await page.getByLabel("선택 사진 전송 동의").check();
    await page.getByRole("button", { name: "설정 적용 및 연결" }).click();
    await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
  };
  await configure(false);
  await page.getByRole("button", { name: "글씨 읽기", exact: true }).click();
  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 1280;
      c.height = 1024;
      const x = c.getContext("2d")!;
      x.fillStyle = "#888";
      x.fillRect(0, 0, 1280, 1024);
      for (let i = 0; i < 1280; i += 12) {
        x.fillStyle = i % 24 ? "#333" : "#ddd";
        x.fillRect(i, 50, 6, 950);
      }
      return c.toDataURL("image/jpeg", 0.9).split(",")[1];
    }),
    "base64",
  );
  const frame = () => {
    const a = Buffer.alloc(52 + jpeg.length);
    a.write("VDX2");
    a.writeUInt16LE(1, 4);
    a.writeUInt16LE(52, 6);
    a.writeUInt32LE(22, 8);
    a.writeUInt32LE(++seq, 12);
    a.write("CAM2", 24);
    a.writeUInt32LE(seq, 32);
    a.writeUInt32LE(jpeg.length, 36);
    a.writeUInt16LE(1280, 40);
    a.writeUInt16LE(1024, 42);
    jpeg.copy(a, 52);
    socket.send(a);
  };
  const press = () =>
    socket.send(
      JSON.stringify({ type: "button_short", epoch: 22, event_id: ++event }),
    );
  frame();
  await page.waitForTimeout(150);
  press();
  await expect(page.getByRole("status")).toContainText("동의가 필요");
  expect(posts).toHaveLength(0);
  await configure(true);
  frame();
  await page.waitForTimeout(150);
  press();
  await expect.poll(() => posts.length).toBe(1);
  await page.getByRole("button", { name: "물체 인식", exact: true }).click();
  release!();
  await page.waitForTimeout(150);
  await expect(page.getByRole("status")).not.toContainText(
    "LATE_PRIVATE_RESULT",
  );
  await page
    .getByRole("button", { name: "전송 동의 철회 및 세션 삭제" })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("DISCONNECTED");
  const before = posts.length;
  await page.getByRole("button", { name: "메인 화면으로" }).click();
  await page.getByRole("button", { name: "현재 기능 실행" }).click();
  await page.waitForTimeout(150);
  expect(posts).toHaveLength(before);
  await expect(page.getByRole("status")).not.toContainText(
    "LATE_PRIVATE_RESULT",
  );
});

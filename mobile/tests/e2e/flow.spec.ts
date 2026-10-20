import { test, expect } from "@playwright/test";
test("paired S3 -> physical buttons -> selected OCR/front+back -> server vision/TTS, continued worker walking, disconnect UNKNOWN", async ({
  page,
}) => {
  const requests: { url: string; body: any }[] = [];
  const outbound: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") outbound.push(r.url());
  });
  await page.route("**/api/**", async (route) => {
    const r = route.request();
    if (r.url().endsWith("/health")) {
      await route.fulfill({ json: { ready: true, authRequired: true } });
      return;
    }
    const body = r.postDataJSON();
    expect(r.headers().authorization).toBe("Bearer mock-server-token");
    requests.push({ url: r.url(), body });
    if (r.url().endsWith("/vision"))
      await route.fulfill({
        json: {
          text:
            body.kind === "object" ? "제품 앞뒷면 결과" : "선택한 글씨 결과",
        },
      });
    else await route.fulfill({ status: 503, body: "mock TTS outage" });
  });
  await page.routeWebSocket("wss://videx.local/ws", (ws) => {
    ws.onMessage(async (message) => {
      if (typeof message !== "string") return;
      const m = JSON.parse(message);
      if (m.type === "authenticate") {
        expect(m.token).toBe("mock-pair");
        ws.send(JSON.stringify({ type: "connected", epoch: 19 }));
      }
      if (m.type === "resolution") {
        ws.send(
          JSON.stringify({
            type: "resolution_applied",
            request_id: m.request_id,
            mode: m.mode,
            width: m.mode === 2 ? 1280 : 320,
            height: m.mode === 2 ? 1024 : 240,
          }),
        );
      }
    });
    (globalThis as any).s3 = ws;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await page.getByLabel("장치 페어링 토큰").fill("mock-pair");
  await page.getByLabel("서버 접근 토큰").fill("mock-server-token");
  await page.getByLabel("선택 사진 전송 동의").check();
  await page.getByLabel("텍스트 OpenAI AI 음성 전송 동의").check();
  await page.getByRole("button", { name: "설정 적용 및 연결" }).click();
  await expect(page.getByTestId("connection")).toContainText("CONNECTED");
  const frame = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 1024;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#888";
    ctx.fillRect(0, 0, c.width, c.height);
    for (let x = 0; x < 1280; x += 12) {
      ctx.fillStyle = x % 24 === 0 ? "#333" : "#ddd";
      ctx.fillRect(x, 200, 6, 650);
    }
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  let sequence = 0,
    event = 0;
  const sendFrame = (b64 = frame) => {
    const jpeg = Buffer.from(b64, "base64");
    const a = Buffer.alloc(52 + jpeg.length);
    a.write("VDX2");
    a.writeUInt16LE(1, 4);
    a.writeUInt16LE(52, 6);
    a.writeUInt32LE(19, 8);
    a.writeUInt32LE(++sequence, 12);
    a.write("CAM2", 24);
    a.writeUInt32LE(sequence, 32);
    a.writeUInt32LE(jpeg.length, 36);
    a.writeUInt16LE(1280, 40);
    a.writeUInt16LE(1024, 42);
    jpeg.copy(a, 52);
    (globalThis as any).s3.send(a);
  };
  const button = (type: string) =>
    (globalThis as any).s3.send(
      JSON.stringify({ type, epoch: 19, event_id: ++event }),
    );
  await page.getByRole("button", { name: "메인 화면으로" }).click();
  button("button_long");
  await expect(page.getByRole("status")).toContainText("글씨");
  sendFrame();
  await page.waitForTimeout(250);
  button("button_short");
  await expect(page.getByRole("status")).toContainText("선택한 글씨 결과");
  expect(requests.filter((r) => r.url.endsWith("/vision"))).toHaveLength(1);
  button("button_long");
  await expect(page.getByRole("status")).toContainText("앞면");
  sendFrame();
  await page.waitForTimeout(200);
  button("button_short");
  await expect(page.getByRole("status")).toContainText("뒷면");
  const back = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 1024;
    const x = c.getContext("2d")!;
    x.fillStyle = "#999";
    x.fillRect(0, 0, 1280, 1024);
    for (let i = 0; i < 1024; i += 10) {
      x.fillStyle = i % 20 ? "#222" : "#eee";
      x.fillRect(200, i, 800, 5);
    }
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  });
  sendFrame(back);
  await page.waitForTimeout(200);
  button("button_short");
  await expect(page.getByRole("status")).toContainText("제품 앞뒷면 결과");
  expect(requests.filter((r) => r.url.endsWith("/vision"))).toHaveLength(2);
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(page.getByTestId("processed")).not.toHaveText("0");
  await expect(page.getByTestId("vision-runtime")).toHaveText("wasm");
  await expect(page.getByTestId("speech-state")).toContainText("사용 불가");
  expect(
    outbound.every((url) => url.startsWith("http://127.0.0.1:4173/api/")),
  ).toBe(true);
  for (const r of requests.filter((r) => r.url.endsWith("/speech"))) {
    expect(Object.keys(r.body)).toEqual(["text"]);
    expect(typeof r.body.text).toBe("string");
  }
  for (const r of requests.filter((r) => r.url.endsWith("/vision"))) {
    expect(Object.keys(r.body).sort()).toEqual(["image", "kind"]);
    expect(r.body.image).toMatch(/^data:image\/jpeg;base64,/);
  }
  (globalThis as any).s3.close();
  await expect(page.getByTestId("connection")).toContainText("UNKNOWN");
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
});

import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ready: true, authRequired: true } }),
  );
});

test("production CSP is exact, static-only service worker survives offline without caching user data", async ({
  page,
  context,
}) => {
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain(
    "script-src 'self' 'wasm-unsafe-eval'",
  );
  expect(response?.headers()["content-security-policy"]).toContain(
    "wss://videx.local",
  );
  expect(response?.headers()["content-security-policy"]).not.toMatch(
    /wss:[ ;]/,
  );
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const violations = await page.evaluate(async () => {
    const blocked: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      blocked.push(e.blockedURI),
    );
    for (const url of [
      "https://not-allowed.example/image",
      "wss://not-allowed.example/ws",
    ]) {
      try {
        if (url.startsWith("https"))
          await fetch(url, { method: "POST", body: "private-image" });
        else new WebSocket(url);
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
    return blocked;
  });
  expect(violations.length).toBeGreaterThanOrEqual(2);
  await page.evaluate(async () => {
    await fetch("/session-image.jpg").catch(() => {});
    await fetch("/recognition-result.json", {
      method: "POST",
      body: "private-text",
    }).catch(() => {});
  });
  const cached = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      result.push(...(await cache.keys()).map((r) => new URL(r.url).pathname));
    }
    return result;
  });
  expect(cached).toContain("/index.html");
  expect(cached.some((p) => p.includes("walking.worker"))).toBe(true);
  expect(cached.some((p) => p.endsWith(".wasm"))).toBe(true);
  expect(
    cached.every(
      (p) =>
        ["/", "/index.html", "/icon.svg", "/manifest.webmanifest"].includes(
          p,
        ) || /^\/assets\/.+\.(js|css|wasm)$/.test(p),
    ),
  ).toBe(true);
  expect(cached.some((p) => /session|recognition|openai|\.jpe?g/.test(p))).toBe(
    false,
  );
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "현재 기능 실행" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
});

test("real HTMLAudio plays mocked OpenAI waveform, ends and revokes memory URL without a paid call", async ({
  page,
}) => {
  const wav = Buffer.alloc(44 + 3200);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(3200, 40);
  for (let i = 0; i < 1600; i++)
    wav.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / 16000) * 2000),
      44 + i * 2,
    );
  await page.addInitScript(() => {
    const RealAudio = window.Audio;
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    (window as any).audioEvidence = { ended: 0, created: 0, revoked: 0 };
    window.Audio = function () {
      const audio = new RealAudio();
      audio.addEventListener("ended", () => {
        (window as any).audioEvidence.ended++;
      });
      return audio;
    } as any;
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob && blob.type.startsWith("audio/"))
        (window as any).audioEvidence.created++;
      return create(blob);
    };
    URL.revokeObjectURL = (url) => {
      (window as any).audioEvidence.revoked++;
      revoke(url);
    };
  });
  const bodies: any[] = [];
  await page.route("https://api.openai.com/v1/audio/speech", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "audio/wav", body: wav });
  });
  await page.routeWebSocket("wss://videx.local/ws", (ws) =>
    ws.onMessage((message) => {
      if (
        typeof message === "string" &&
        JSON.parse(message).type === "authenticate"
      )
        ws.send(JSON.stringify({ type: "connected", epoch: 1 }));
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await page.getByLabel("장치 페어링 토큰").fill("mock-pair");
  await page.getByLabel("AI 전송 경로").selectOption("direct");
  await page.getByLabel("OpenAI 세션 API 키").fill("mock-key");
  await page.getByLabel("텍스트 OpenAI AI 음성 전송 동의").check();
  await page
    .getByRole("button", { name: "음성 재생 활성화", exact: true })
    .click();
  await page.getByRole("button", { name: "설정 적용 및 연결" }).click();
  await expect(page.getByTestId("speech-state")).toHaveText("음성 완료");
  const evidence = await page.evaluate(() => (window as any).audioEvidence);
  expect(evidence.ended).toBeGreaterThan(0);
  expect(evidence.revoked).toBe(evidence.created);
  expect(bodies[0]).toMatchObject({
    model: "gpt-4o-mini-tts",
    input: "장치가 연결되었습니다.",
  });
});

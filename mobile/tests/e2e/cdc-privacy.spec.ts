import { test, expect } from "@playwright/test";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startBackend, closeServer } from "./backend-fixture";
import { installUsb } from "./cdc-fixtures";

test("same-origin-only CSP and static offline cache never store user API data", async ({
  page,
  context,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: route.request().url().endsWith("health") ? 200 : 400,
      json: route.request().url().endsWith("health")
        ? { ready: true, authRequired: false }
        : { error: "invalid" },
    }),
  );
  const response = await page.goto("/");
  const policy = response?.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("connect-src 'self';");
  expect(policy).not.toMatch(/api\.openai\.com|wss:\/\//);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const violations = await page.evaluate(async () => {
    const blocked: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      blocked.push(event.blockedURI),
    );
    for (const url of [
      "https://api.openai.com/v1/chat/completions",
      "https://not-allowed.example/image",
      "wss://not-allowed.example/ws",
    ]) {
      try {
        if (url.startsWith("wss")) new WebSocket(url);
        else await fetch(url, { method: "POST", body: "private" });
      } catch {}
    }
    await new Promise((done) => setTimeout(done, 100));
    await fetch("/api/vision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "private", kind: "ocr" }),
    });
    return blocked;
  });
  expect(violations.length).toBeGreaterThanOrEqual(3);
  const cached = await page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys())
      paths.push(
        ...(await (await caches.open(name)).keys()).map(
          (request) => new URL(request.url).pathname,
        ),
      );
    return paths;
  });
  expect(cached).toContain("/index.html");
  expect(cached.some((path) => path.includes("walking.worker"))).toBe(true);
  expect(cached.some((path) => path.endsWith(".wasm"))).toBe(true);
  expect(
    cached.every(
      (path) =>
        ["/", "/index.html", "/icon.svg", "/manifest.webmanifest"].includes(
          path,
        ) || /^\/assets\/.+\.(js|css|wasm)$/.test(path),
    ),
  ).toBe(true);
  expect(
    cached.some((path) => /\/api\/|session|recognition|\.jpe?g/.test(path)),
  ).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "현재 기능 실행" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
});

test("a real updated service worker waits and never reloads an unsaved front-side capture", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // Isolate update fixtures from dist served by the user's live Node process.
  const isolated = await mkdtemp(join(resolve("tests"), ".sw-build-"));
  await cp(resolve("dist"), isolated, { recursive: true });
  const runtime = await startBackend(async () => {
    throw Error("No provider call without consent");
  }, isolated);
  try {
    await installUsb(page);
    await page.goto(runtime.origin);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
    await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
    await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
    await page.getByRole("button", { name: "물체 인식", exact: true }).click();
    await expect(page.getByTestId("input-frame")).toContainText("640×480");
    await page.waitForTimeout(180);
    await page.getByRole("button", { name: "메인 화면으로" }).click();
    await page.getByRole("button", { name: "현재 기능 실행" }).click();
    await expect(page.getByRole("status")).toContainText("뒷면");
    await page.evaluate(() => {
      (window as any).updateEvidence = {
        marker: "unsaved-capture",
        changed: 0,
      };
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => (window as any).updateEvidence.changed++,
      );
    });
    await appendFile(
      join(isolated, "sw.js"),
      "\n// deterministic integration update fixture\n",
    );
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await page.waitForFunction(
      async () => !!(await navigator.serviceWorker.getRegistration())?.waiting,
    );
    expect(await page.evaluate(() => (window as any).updateEvidence)).toEqual({
      marker: "unsaved-capture",
      changed: 0,
    });
    await expect(page.getByRole("status")).toContainText("뒷면");
    expect(page.url()).toBe(runtime.origin + "/");
  } finally {
    await page.close();
    await closeServer(runtime.server);
    await rm(isolated, { recursive: true, force: true });
  }
});

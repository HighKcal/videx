import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ready: true, authRequired: true } }),
  );
});
test("USB is explicit, needs no pairing token and reports unsupported without network video", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "usb", {
      value: undefined,
      configurable: true,
    }),
  );
  const external: string[] = [];
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:4173") &&
      !r.url().startsWith("blob:")
    )
      external.push(r.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await page.getByLabel("연결 방식").selectOption("usb");
  await expect(page.getByLabel("장치 페어링 토큰")).not.toBeVisible();
  await expect(
    page.getByText("v2 USB 미러는 읽기 전용", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await expect(page.getByTestId("connection")).toContainText("WebUSB 미지원");
  expect(external).toEqual([]);
});
test("real CAM2 parsing and JPEG worker processing through a simulated USB boundary; legacy commands and unplug", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let id = 0,
      mode = 0,
      closed = false,
      disconnect: (event: any) => void;
    (window as any).usbWrites = [];
    const d = {
      vendorId: 0x303a,
      productId: 0x1001,
      configuration: {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [
              {
                alternateSetting: 0,
                interfaceClass: 2,
                interfaceSubclass: 2,
                endpoints: [],
              },
            ],
          },
          {
            interfaceNumber: 1,
            alternates: [
              {
                alternateSetting: 0,
                interfaceClass: 10,
                interfaceSubclass: 0,
                endpoints: [
                  { direction: "in", type: "bulk", endpointNumber: 1 },
                  { direction: "out", type: "bulk", endpointNumber: 1 },
                ],
              },
            ],
          },
        ],
      },
      async open() {
        closed = false;
      },
      async close() {
        closed = true;
      },
      async claimInterface() {},
      async selectAlternateInterface() {},
      async controlTransferOut() {
        return { status: "ok" };
      },
      async transferOut(_ep: number, bytes: Uint8Array) {
        mode = bytes[0];
        (window as any).usbWrites.push(mode);
        return { status: "ok", bytesWritten: bytes.length };
      },
      async transferIn() {
        await new Promise((r) => setTimeout(r, 100));
        if (closed) throw Error("closed");
        const canvas = document.createElement("canvas");
        canvas.width = mode === 2 ? 1280 : 320;
        canvas.height = mode === 2 ? 1024 : 240;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#888";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const jpeg = Uint8Array.from(
          atob(canvas.toDataURL("image/jpeg").split(",")[1]),
          (c) => c.charCodeAt(0),
        );
        const bytes = new Uint8Array(28 + jpeg.length),
          v = new DataView(bytes.buffer);
        bytes.set([
          67,
          65,
          77,
          50,
          0,
          (window as any).usbPressed ? 7 : 6,
          (window as any).usbResult || 0,
          0,
        ]);
        v.setUint32(8, ++id, true);
        v.setUint32(12, jpeg.length, true);
        v.setUint16(16, canvas.width, true);
        v.setUint16(18, canvas.height, true);
        v.setBigUint64(20, BigInt(id * 100000), true);
        bytes.set(jpeg, 28);
        return { status: "ok", data: v };
      },
    };
    (window as any).unplug = () => disconnect({ device: d });
    Object.defineProperty(navigator, "usb", {
      value: {
        requestDevice: async () => d,
        addEventListener(_t: string, f: any) {
          disconnect = f;
        },
        removeEventListener() {},
      },
      configurable: true,
    });
  });
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await page.getByLabel("연결 방식").selectOption("usb");
  await page.getByLabel("S3 USB 펌웨어").selectOption("legacy");
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
  await expect
    .poll(async () => Number(await page.getByTestId("processed").textContent()))
    .toBeGreaterThan(0);
  await page.evaluate(() => ((window as any).usbPressed = true));
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    (window as any).usbPressed = false;
    (window as any).usbResult = 2;
  });
  await expect(
    page.getByRole("button", { name: "글씨 읽기", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate(() => (window as any).usbWrites))
    .toContain(2);
  await page.evaluate(() => (window as any).unplug());
  await expect(page.getByTestId("connection")).toContainText("USB 장치 분리");
  expect(posts).toEqual([]);
});
test("chooser is invoked during click activation; cancellation is actionable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "usb", {
      value: {
        requestDevice: async () => {
          (window as any).usbGesture = navigator.userActivation.isActive;
          throw new DOMException("cancelled", "NotFoundError");
        },
        addEventListener() {},
        removeEventListener() {},
      },
      configurable: true,
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
  await page.getByLabel("연결 방식").selectOption("usb");
  await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
  await expect(page.getByTestId("connection")).toContainText("USB 선택 취소");
  expect(await page.evaluate(() => (window as any).usbGesture)).toBe(true);
});

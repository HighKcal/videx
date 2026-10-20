import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
// Backend peer owns this JS module; no frontend declaration or implementation shim.
// @ts-expect-error Backend ESM intentionally has no TypeScript declaration.
import { createVidexServer } from "../../server/server.mjs";

const accessToken = "synthetic-integration-access-token-32-plus";
const providerKey = "synthetic-provider-key-never-in-browser";
const result = "실제 서버 경계를 통과한 글씨 결과";
// Valid short MP3 generated locally with ffmpeg, not a provider recording.
const mp3 = Buffer.from(
  "//MYxAAAAANIAAAAAExBTUU0LjEgKGFscGhhIDApVVVVVVVV//MYxBcAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxC4AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxEUAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
  "base64",
);

async function close(server: Server) {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

// Config is snapshotted by the backend factory. Discover an OS-selected port
// before constructing it, then retry only EADDRINUSE if another process wins.
async function start(fetcher: typeof fetch, demo = false) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw Error("No TCP port");
    const origin = `http://127.0.0.1:${address.port}`;
    await close(reservation);
    const server: Server = createVidexServer({
      env: {
        OPENAI_API_KEY: providerKey,
        ...(demo
          ? { VIDEX_DEMO_MODE: "true" }
          : { VIDEX_ACCESS_TOKEN: accessToken }),
        VIDEX_ALLOWED_ORIGINS: origin,
      },
      fetcher,
      distDir: resolve("dist"),
    });
    try {
      server.listen(address.port, "127.0.0.1");
      await once(server, "listening");
      return { server, origin };
    } catch (error) {
      await close(server);
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw Error("Could not bind an ephemeral integration port");
}

for (const demo of [false, true]) {
  test(`built UI -> real Node API -> injected upstream: ${demo ? "tokenless demo" : "separate tokens"}, OCR and playable TTS`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const upstream: Array<{
      url: string;
      body: any;
      authorization: string | null;
    }> = [];
    const { server, origin } = await start(async (url, options) => {
      const endpoint = String(url);
      const authorization = new Headers(options?.headers).get("authorization");
      const body = JSON.parse(String(options?.body));
      upstream.push({ url: endpoint, body, authorization });
      if (endpoint === "https://api.openai.com/v1/responses")
        return Response.json({
          output: [{ content: [{ type: "output_text", text: result }] }],
        });
      if (endpoint === "https://api.openai.com/v1/audio/speech")
        return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
      throw Error("Unexpected upstream endpoint; real networking is forbidden");
    }, demo);
    try {
      const origins: Array<string | undefined> = [];
      server.on("request", (req) => {
        if (req.method === "POST") origins.push(req.headers.origin);
      });
      const requests: Array<{
        url: string;
        body: any;
        authorization: string | undefined;
      }> = [];
      page.on("request", (request) => {
        if (request.method() === "POST")
          requests.push({
            url: request.url(),
            body: request.postDataJSON(),
            authorization: request.headers().authorization,
          });
      });
      // Simulate only the hardware boundary, never HTTP/API responses.
      await page.addInitScript(() => {
        let closed = false,
          mode = 0,
          id = 0;
        const audioEvidence = { ended: 0, mpeg: [] as number[][] };
        (window as any).integrationAudio = audioEvidence;
        const mpegUrls = new Set<string>();
        const createObjectURL = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
          const url = createObjectURL(blob);
          if (blob instanceof Blob && blob.type === "audio/mpeg") {
            mpegUrls.add(url);
            void blob
              .arrayBuffer()
              .then((bytes) =>
                audioEvidence.mpeg.push(Array.from(new Uint8Array(bytes))),
              );
          }
          return url;
        };
        const RealAudio = window.Audio;
        window.Audio = function () {
          const audio = new RealAudio();
          audio.addEventListener("ended", () => {
            if (mpegUrls.has(audio.src)) audioEvidence.ended++;
          });
          return audio;
        } as any;
        const device = {
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
          async transferOut(_endpoint: number, bytes: Uint8Array) {
            mode = bytes[0];
            return { status: "ok", bytesWritten: bytes.length };
          },
          async transferIn() {
            await new Promise((done) => setTimeout(done, 80));
            if (closed) throw Error("closed");
            const canvas = document.createElement("canvas");
            canvas.width = mode === 2 ? 1280 : 320;
            canvas.height = mode === 2 ? 1024 : 240;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#888";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            for (let x = 0; x < canvas.width; x += 12) {
              ctx.fillStyle = x % 24 ? "#333" : "#ddd";
              ctx.fillRect(x, 20, 6, canvas.height - 40);
            }
            const jpeg = Uint8Array.from(
              atob(canvas.toDataURL("image/jpeg", 0.9).split(",")[1]),
              (c) => c.charCodeAt(0),
            );
            const bytes = new Uint8Array(28 + jpeg.length),
              view = new DataView(bytes.buffer);
            bytes.set([67, 65, 77, 50, 0, 6, 0, 0]);
            view.setUint32(8, ++id, true);
            view.setUint32(12, jpeg.length, true);
            view.setUint16(16, canvas.width, true);
            view.setUint16(18, canvas.height, true);
            view.setBigUint64(20, BigInt(id * 100000), true);
            bytes.set(jpeg, 28);
            return { status: "ok", data: view };
          },
        };
        Object.defineProperty(navigator, "usb", {
          configurable: true,
          value: {
            requestDevice: async () => {
              (window as any).integrationUsbGesture =
                navigator.userActivation.isActive;
              return device;
            },
            addEventListener() {},
            removeEventListener() {},
          },
        });
      });
      const documentResponse = await page.goto(origin);
      expect(documentResponse?.status()).toBe(200);
      expect(documentResponse?.headers()["content-type"]).toContain(
        "text/html",
      );
      await page
        .getByRole("button", { name: "VIDEX 진단 및 설정 열기" })
        .click();
      await expect(page.getByLabel("AI 전송 경로")).toHaveValue("server");
      await expect(page.getByLabel("OpenAI 세션 API 키")).toHaveCount(0);
      if (demo) {
        await expect(page.getByLabel("서버 접근 토큰")).toHaveCount(0);
        await expect(
          page.getByText("데모 모드", { exact: false }),
        ).toBeVisible();
      }
      expect(upstream).toHaveLength(0);
      expect(requests).toHaveLength(0);
      await page.getByLabel("연결 방식").selectOption("usb");
      await page.getByLabel("S3 USB 펌웨어").selectOption("legacy");
      await page
        .getByRole("button", { name: "음성 재생 활성화", exact: true })
        .click();
      if (!demo) {
        // Wrong access credentials must be rejected before reaching upstream.
        // The actual provider credential is never entered in the browser.
        await page
          .getByLabel("서버 접근 토큰")
          .fill("synthetic-wrong-access-token");
        await page.getByLabel("텍스트 OpenAI AI 음성 전송 동의").check();
        const unauthorized = page.waitForResponse(
          (r) => r.url() === origin + "/api/speech" && r.status() === 401,
        );
        await page
          .getByRole("button", { name: "USB 장치 선택 및 연결" })
          .click();
        await unauthorized;
        expect(upstream).toHaveLength(0);
        requests.length = 0;
        await page
          .getByRole("button", { name: "연결 종료 및 메모리 키 삭제" })
          .click();
        await page.getByLabel("서버 접근 토큰").fill(accessToken);
      } else {
        // Demo removes authentication, never the independent consent gates.
        await page
          .getByRole("button", { name: "USB 장치 선택 및 연결" })
          .click();
        await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
        await expect(page.getByTestId("speech-state")).toContainText(
          "사용 불가",
        );
        expect(upstream).toHaveLength(0);
        expect(requests).toHaveLength(0);
        await page
          .getByRole("button", { name: "연결 종료 및 메모리 키 삭제" })
          .click();
      }
      await page.getByLabel("선택 사진 전송 동의").check();
      await page.getByLabel("텍스트 OpenAI AI 음성 전송 동의").check();
      const authenticated = page.waitForResponse(
        (r) => r.url() === origin + "/api/speech",
      );
      await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
      expect((await authenticated).status()).toBe(200);
      expect(
        await page.evaluate(() => (window as any).integrationUsbGesture),
      ).toBe(true);
      await expect(page.getByTestId("connection")).toHaveText("CONNECTED");
      await expect(page.getByTestId("speech-state")).toHaveText("음성 완료");
      await page
        .getByRole("button", { name: "글씨 읽기", exact: true })
        .click();
      await expect(page.getByTestId("input-frame")).toContainText("1280×1024");
      await expect(page.getByTestId("speech-state")).toHaveText("음성 완료");
      const endedBefore = await page.evaluate(
        () => (window as any).integrationAudio.ended,
      );
      const blobsBefore = await page.evaluate(
        () => (window as any).integrationAudio.mpeg.length,
      );
      await page.getByRole("button", { name: "메인 화면으로" }).click();
      const visionResponse = page.waitForResponse(
        (r) => r.url() === origin + "/api/vision" && r.status() === 200,
      );
      const speechResponse = page.waitForResponse(
        (r) =>
          r.url() === origin + "/api/speech" &&
          r.status() === 200 &&
          r.request().postDataJSON().text === result,
      );
      await page.getByRole("button", { name: "현재 기능 실행" }).click();
      expect(await (await visionResponse).json()).toEqual({ text: result });
      await expect(page.getByRole("status")).toHaveText(result);
      const speech = await speechResponse;
      expect(speech.headers()["content-type"]).toBe("audio/mpeg");
      // Observe the actual Blob consumed by the real client, not CDP's response
      // body cache (which may discard no-store audio after it is consumed).
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).integrationAudio.mpeg.length),
        )
        .toBeGreaterThan(blobsBefore);
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).integrationAudio.mpeg.at(-1)),
        )
        .toEqual(Array.from(mp3));
      await expect
        .poll(() => page.evaluate(() => (window as any).integrationAudio.ended))
        .toBeGreaterThan(endedBefore);
      const vision = upstream.filter((r) => r.url.endsWith("/responses"));
      expect(vision).toHaveLength(1);
      expect(vision[0].body).toMatchObject({
        model: "gpt-4.1-mini",
        store: false,
      });
      expect(vision[0].body.input[0].content[1].image_url).toMatch(
        /^data:image\/jpeg;base64,/,
      );
      expect(
        upstream.some(
          (r) => r.url.endsWith("/audio/speech") && r.body.input === result,
        ),
      ).toBe(true);
      expect(
        upstream.every((r) => r.authorization === `Bearer ${providerKey}`),
      ).toBe(true);
      expect(
        requests.every(
          (r) =>
            r.url.startsWith(origin + "/api/") &&
            (demo
              ? r.authorization === undefined
              : r.authorization === `Bearer ${accessToken}`),
        ),
      ).toBe(true);
      for (const request of requests)
        expect(Object.keys(request.body).sort()).toEqual(
          request.url.endsWith("/vision") ? ["image", "kind"] : ["text"],
        );
      expect(JSON.stringify(requests)).not.toContain(providerKey);
      expect(origins.length).toBeGreaterThanOrEqual(demo ? 2 : 3);
      expect(origins.every((value) => value === origin)).toBe(true);
      expect(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
      ).toBe(0);
    } finally {
      await page.close();
      await close(server);
    }
  });
}

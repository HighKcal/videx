import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startBackend, closeServer } from "./backend-fixture";
import { installUsb } from "./cdc-fixtures";

test("native Chrome consent revocation stops playback and cancels the same pending upstream", async ({
  page,
}, testInfo) => {
  const mp3 = execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-ac",
    "1",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "-write_xing",
    "0",
    "-f",
    "mp3",
    "pipe:1",
  ]);
  let cancelled = false,
    observed: AbortSignal | null | undefined,
    calls = 0;
  const { server, origin } = await startBackend(async (_url, options) => {
    calls++;
    observed = options?.signal;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(mp3.subarray(0, 16384)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "audio/mpeg" } },
    );
  });
  try {
    await installUsb(page);
    await page.addInitScript(() => {
      const w = window as any;
      w.ttsUrls = [];
      w.ttsRevoked = [];
      const create = URL.createObjectURL.bind(URL),
        revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = create(object);
        w.ttsUrls.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        w.ttsRevoked.push(url);
        revoke(url);
      };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        w.ttsAudio = this;
        return play.call(this);
      };
    });
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(origin);
    await page.getByRole("button", { name: "VIDEX 진단 및 설정 열기" }).click();
    await expect(page.getByTestId("server-setup")).toContainText("데모 모드");
    await page
      .getByLabel("텍스트 OpenAI AI 음성 전송 동의", { exact: true })
      .check();
    await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).ttsAudio?.currentTime ?? 0),
      )
      .toBeGreaterThan(0.1);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    await page.screenshot({
      path: testInfo.outputPath("narrow-enlarged-streaming.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "전송 동의 철회 및 세션 삭제" })
      .click();
    await expect.poll(() => cancelled).toBe(true);
    expect(observed?.aborted).toBe(true);
    const audio = await page.evaluate(() => {
      const w = window as any;
      return {
        paused: w.ttsAudio.paused,
        src: w.ttsAudio.getAttribute("src"),
        urls: w.ttsUrls,
        revoked: w.ttsRevoked,
      };
    });
    expect(audio.paused).toBe(true);
    expect(audio.src).toBeNull();
    await expect(page.getByTestId("speech-state")).toHaveText("음성 대기");
    expect(audio.revoked).toEqual(audio.urls);
    expect(calls).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath("narrow-enlarged-revoked.png"),
      fullPage: true,
    });
    console.log(
      "TTS_NATIVE_REVOKED " +
        JSON.stringify({
          calls,
          cancelled,
          upstreamAborted: observed?.aborted,
          ...audio,
        }),
    );
  } finally {
    await page.close();
    await closeServer(server);
  }
});

test("native Chrome MP3 currentTime advances before paced upstream EOF, unlike buffered baseline", async ({
  browser,
}, testInfo) => {
  test.setTimeout(45000);
  const mp3 = execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=4",
    "-ac",
    "1",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "-write_xing",
    "0",
    "-f",
    "mp3",
    "pipe:1",
  ]);
  expect(mp3.length).toBeGreaterThan(30000);
  const measurements: any[] = [];
  for (const buffered of [false, true]) {
    let calls = 0,
      upstreamStart = 0,
      upstreamEnd = 0;
    const { server, origin } = await startBackend(
      async (_endpoint, options) => {
        calls++;
        const payload = JSON.parse(String(options?.body));
        expect(payload).toMatchObject({
          model: "gpt-4o-mini-tts",
          voice: "coral",
          response_format: "mp3",
        });
        upstreamStart = Date.now();
        let offset = 0;
        return new Response(
          new ReadableStream({
            async pull(c) {
              await delay(250, undefined, {
                signal: options?.signal ?? undefined,
              });
              if (offset >= mp3.length) {
                upstreamEnd = Date.now();
                c.close();
                return;
              }
              const end = Math.min(mp3.length, offset + 4096);
              c.enqueue(new Uint8Array(mp3.subarray(offset, end)));
              offset = end;
            },
          }),
          { headers: { "content-type": "audio/mpeg" } },
        );
      },
    );
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await installUsb(page);
      await page.addInitScript(
        ({ buffered }) => {
          const w = window as any;
          w.ttsObservations = [];
          // Observe, never replace Audio or native decoding/playback. Keep the
          // original native play() result and timeupdate/currentTime events.
          const nativePlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function () {
            const media = this;
            const record = {
              called: Date.now(),
              playing: 0,
              firstAdvance: 0,
              currentTime: 0,
              ended: 0,
              source: media.src,
            };
            w.ttsObservations.push(record);
            media.addEventListener("playing", () => {
              record.playing ||= Date.now();
            });
            media.addEventListener("timeupdate", () => {
              if (media.currentTime > 0.05) {
                record.firstAdvance ||= Date.now();
                record.currentTime = media.currentTime;
              }
            });
            media.addEventListener("ended", () => {
              record.ended = Date.now();
            });
            w.ttsAudio = media;
            return nativePlay.call(media);
          };
          if (buffered) MediaSource.isTypeSupported = () => false;
        },
        { buffered },
      );
      // No request is ever allowed to leave this isolated backend origin.
      await page.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort(),
      );
      await page.goto(origin);
      await page
        .getByRole("button", { name: "VIDEX 진단 및 설정 열기" })
        .click();
      await expect(page.getByTestId("server-setup")).toContainText("데모 모드");
      expect(
        await page.evaluate(() => typeof MediaSource !== "undefined"),
      ).toBe(true);
      if (!buffered)
        expect(
          await page.evaluate(() => MediaSource.isTypeSupported("audio/mpeg")),
        ).toBe(true);
      await page
        .getByLabel("텍스트 OpenAI AI 음성 전송 동의", { exact: true })
        .check();
      await page.getByRole("button", { name: "USB 장치 선택 및 연결" }).click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as any).ttsObservations.some(
              (r: any) => r.firstAdvance > 0,
            ),
          ),
        )
        .toBe(true);
      const first = await page.evaluate(() =>
        (window as any).ttsObservations.find((r: any) => r.firstAdvance > 0),
      );
      const currentTimeBeforeEnd = await page.evaluate(
        () => (window as any).ttsAudio.currentTime,
      );
      if (!buffered) {
        expect(upstreamEnd).toBe(0);
        expect(currentTimeBeforeEnd).toBeGreaterThan(0.05);
      }
      await expect.poll(() => upstreamEnd).toBeGreaterThan(0);
      await expect(page.getByTestId("speech-state")).toHaveText("음성 완료", {
        timeout: 12000,
      });
      const final = await page.evaluate(() =>
        (window as any).ttsObservations.find((r: any) => r.firstAdvance > 0),
      );
      if (buffered)
        expect(first.firstAdvance).toBeGreaterThanOrEqual(upstreamEnd);
      else expect(first.firstAdvance).toBeLessThan(upstreamEnd - 500);
      expect(calls).toBe(1);
      expect(errors).toEqual([]);
      const measurement = {
        mode: buffered ? "buffered-baseline" : "progressive-mse",
        mp3Bytes: mp3.length,
        calls,
        upstreamStart,
        upstreamEnd,
        firstPlaying: first.playing,
        firstAdvance: first.firstAdvance,
        playbackEnded: final.ended,
        startMs: first.firstAdvance - upstreamStart,
        upstreamEndMs: upstreamEnd - upstreamStart,
        currentTimeAtFirstObservation: currentTimeBeforeEnd,
        chrome: browser.version(),
      };
      measurements.push(measurement);
      console.log("TTS_MEASUREMENT " + JSON.stringify(measurement));
      await page.screenshot({
        path: testInfo.outputPath(`${measurement.mode}.png`),
        fullPage: true,
      });
    } finally {
      await context.close();
      await closeServer(server);
    }
  }
  const result = JSON.stringify(measurements, null, 2) + "\n";
  await testInfo.attach("tts-measurements", {
    body: result,
    contentType: "application/json",
  });
  await mkdir("../docs/v2/tts-streaming-logs", { recursive: true });
  await writeFile(
    "../docs/v2/tts-streaming-logs/chrome-measurements.json",
    result,
  );
});

import { expect, type Page } from "@playwright/test";

// The shipped UI has no CDC2 opt-in. Model only the unmodified CAM2 board;
// never manufacture a connected/ACK record to hide unsafe host probing.
export async function installUsb(page: Page) {
  await page.addInitScript(() => {
    let closed = false,
      ioGeneration = 0,
      mode = 0,
      frameId = 0;
    let disconnect = (_event: any) => {};
    const edges: Array<{
      pressed: boolean;
      result: number;
      done?: () => void;
    }> = [];
    const w = window as any;
    w.usbVideo = true;
    w.usbApplyMode = true;
    w.usbWrites = [];
    w.usbWriteBytes = [];
    w.usbGesture = false;
    w.usbFrameId = 0;
    // USB reopen does not reset the board's physical level or LAST result.
    w.usbLegacyState = { pressed: false, result: 0 };
    w.usbButton = (type: "button_short" | "button_long") =>
      new Promise<void>((done) => {
        const previous = edges.at(-1)?.result ?? w.usbLegacyState.result;
        const result = type === "button_short" ? 1 : 2;
        // LAST result survives into the next press. Firmware LONG can become
        // classified while held; host action still occurs only on release.
        edges.push(
          { pressed: true, result: previous },
          { pressed: true, result: previous },
          { pressed: true, result: type === "button_long" ? result : previous },
          { pressed: false, result },
          { pressed: false, result, done },
        );
      });
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
        ioGeneration++;
      },
      async close() {
        closed = true;
        ioGeneration++;
      },
      async claimInterface() {},
      async selectAlternateInterface() {},
      async controlTransferOut() {
        return { status: "ok" };
      },
      async transferOut(_endpoint: number, bytes: Uint8Array) {
        w.usbWriteBytes.push(Array.from(bytes));
        w.usbWrites.push(
          bytes.length === 1 ? { raw: bytes[0] } : { bytes: Array.from(bytes) },
        );
        // f7f0ea4 usb_command_task examines EVERY byte, also accepting ASCII
        // digits. A multi-byte USB2 probe is not ignored atomically by it.
        for (const byte of bytes) {
          const value = byte >= 48 && byte <= 50 ? byte - 48 : byte;
          if (value <= 2 && w.usbApplyMode) mode = value;
        }
        return { status: "ok", bytesWritten: bytes.length };
      },
      async transferIn() {
        const generation = ioGeneration;
        await new Promise((done) => setTimeout(done, 70));
        if (closed || generation !== ioGeneration) throw Error("closed");
        let bytes: Uint8Array | undefined;
        if (w.usbVideo) {
          const edge = edges.shift();
          if (edge)
            w.usbLegacyState = { pressed: edge.pressed, result: edge.result };
          const canvas = document.createElement("canvas");
          canvas.width = [320, 640, 1280][mode] ?? 320;
          canvas.height = [240, 480, 1024][mode] ?? 240;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = w.usbBack ? "#444" : "#888";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          for (let x = 0; !w.usbFlat && x < canvas.width; x += 12) {
            ctx.fillStyle = x % 24 ? "#333" : "#ddd";
            ctx.fillRect(x, 20, 6, canvas.height - 40);
          }
          const jpeg = Uint8Array.from(
            atob(canvas.toDataURL("image/jpeg", 0.9).split(",")[1]),
            (c) => c.charCodeAt(0),
          );
          bytes = new Uint8Array(28 + jpeg.length);
          const view = new DataView(bytes.buffer);
          bytes.set([
            67,
            65,
            77,
            50,
            0,
            w.usbLegacyState.pressed ? 7 : 6,
            w.usbLegacyState.result,
            0,
          ]);
          view.setUint32(8, ++frameId, true);
          view.setUint32(12, jpeg.length, true);
          w.usbFrameId = frameId;
          view.setUint16(16, canvas.width, true);
          view.setUint16(18, canvas.height, true);
          view.setBigUint64(20, BigInt(frameId * 100000), true);
          bytes.set(jpeg, 28);
          edge?.done?.();
        }
        bytes ??= new Uint8Array();
        return {
          status: "ok",
          data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        };
      },
    };
    w.usbUnplug = () => disconnect({ device });
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        requestDevice: async () => {
          w.usbGesture = navigator.userActivation.isActive;
          return device;
        },
        addEventListener(_type: string, listener: any) {
          disconnect = listener;
        },
        removeEventListener() {},
      },
    });
  });
}

// Wait on actual input progress, not a sleep that might miss a repeated result.
export async function observeFrames(page: Page, count = 5) {
  const before = await page.evaluate(
    () => (window as any).usbFrameId as number,
  );
  await page.waitForFunction(
    (target) => (window as any).usbFrameId >= target,
    before + count,
  );
}

export async function expectLegacyWrites(page: Page) {
  const writes: number[][] = await page.evaluate(
    () => (window as any).usbWriteBytes,
  );
  expect(writes.length).toBeGreaterThan(0);
  expect(
    writes.every((bytes) => bytes.length === 1 && [0, 1, 2].includes(bytes[0])),
  ).toBe(true);
}

export const mp3 = Buffer.from(
  "//MYxAAAAANIAAAAAExBTUU0LjEgKGFscGhhIDApVVVVVVVV//MYxBcAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxC4AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MYxEUAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
  "base64",
);
export async function observeAudio(page: Page) {
  await page.addInitScript(() => {
    // This byte-identity fixture observes complete Blob URLs. Exercise the
    // unsupported-MSE path here; tts-streaming.spec.ts proves native MSE with
    // a longer valid paced MP3 and unmodified Audio decoding/playback.
    MediaSource.isTypeSupported = () => false;
    const w = window as any;
    w.audioEvidence = {
      ended: 0,
      bytes: [] as number[][],
      created: 0,
      revoked: 0,
    };
    const urls = new Set<string>();
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      if (blob instanceof Blob && blob.type === "audio/mpeg") {
        urls.add(url);
        w.audioEvidence.created++;
        void blob
          .arrayBuffer()
          .then((bytes) =>
            w.audioEvidence.bytes.push(Array.from(new Uint8Array(bytes))),
          );
      }
      return url;
    };
    URL.revokeObjectURL = (url) => {
      if (urls.has(url)) w.audioEvidence.revoked++;
      revoke(url);
    };
    const RealAudio = window.Audio;
    window.Audio = function () {
      const audio = new RealAudio();
      audio.addEventListener("ended", () => {
        if (urls.has(audio.src)) w.audioEvidence.ended++;
      });
      return audio;
    } as any;
  });
}

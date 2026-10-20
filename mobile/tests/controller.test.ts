import { it, expect, vi, afterEach } from "vitest";
import type { ModuleHost } from "../src/modules/builtins";
import type { VidexModule } from "../src/core/modules";
const testState = vi.hoisted(() => ({ sources: [] as any[] }));
vi.mock("../src/core/source", () => ({
  S3FrameSource: class {
    frame: any;
    control: any;
    state: any;
    acks: Array<{
      mode: number;
      resolve: () => void;
      reject: (e: Error) => void;
    }> = [];
    constructor(_config: any, frame: any, control: any, state: any) {
      Object.assign(this, { frame, control, state, config: _config });
      testState.sources.push(this);
    }
    start() {
      this.state("CONNECTING");
    }
    stop() {
      this.state("UNKNOWN");
    }
    resolution(mode: number) {
      return new Promise<void>((resolve, reject) =>
        this.acks.push({ mode, resolve, reject }),
      );
    }
  },
}));
vi.mock("../src/core/usb-source", async () => {
  const { S3FrameSource } = await import("../src/core/source");
  return { UsbFrameSource: S3FrameSource };
});
vi.mock("../src/core/scheduler", () => ({
  WalkingScheduler: class {
    processed = 0;
    dropped = 0;
    state = "UNKNOWN";
    reset = vi.fn();
    dispose = vi.fn();
    setRotation = vi.fn();
    submit = vi.fn();
  },
}));
import { AppController } from "../src/core/controller";
afterEach(() => {
  testState.sources = [];
  vi.restoreAllMocks();
});
it("USB configuration selects the CDC profile, preserves useful mode error and invalidates on disconnect", async () => {
  const c = new AppController();
  vi.spyOn(c.feedback, "say").mockImplementation(() => {});
  c.configure(
    { transport: "usb", profile: "v2-mirror" },
    "",
    false,
    false,
    false,
  );
  const source = testState.sources[0];
  expect(source.config).toBe("v2-mirror");
  source.state("CONNECTED");
  source.acks[0].reject(Error("v2 USB 미러는 읽기 전용입니다"));
  await Promise.resolve();
  expect(c.state.error).toContain("읽기 전용");
  source.frame({
    epoch: 1,
    frameId: 7,
    width: 320,
    height: 240,
    receivedAt: performance.now(),
  });
  expect(c.state.input).toContain("320×240");
  c.disconnect();
  expect(c.state.connection).toBe("DISCONNECTED");
  expect(c.state.input).toBe("영상 대기");
  c.dispose();
});
it("actual reviewed adapter hooks extend UI/core without mode branches; stale and reconnect ignore old ACK generation", async () => {
  let host!: ModuleHost;
  const onShort = vi.fn(async () => {}),
    onFrame = vi.fn(),
    cancel = vi.fn();
  const module: VidexModule = {
    manifest: {
      id: "extension",
      label: "확장 기능",
      color: "#123456",
      kind: "on-demand",
      source: "s3",
      permissions: ["s3-frames"],
      priority: "normal",
      frame: { resolutionMode: 1 },
    },
    async init() {},
    async activate() {},
    async deactivate() {},
    async dispose() {},
    onShort,
    onFrame,
    cancel,
  };
  const c = new AppController((h) => {
    host = h;
    return [module];
  });
  vi.spyOn(c.feedback, "say").mockImplementation(() => {});
  await c.select("extension");
  c.configure(
    { url: "wss://videx.local/ws", host: "videx.local", token: "mock" },
    "mock",
    true,
    true,
    false,
  );
  const s = testState.sources[0];
  s.state("CONNECTED");
  expect(s.acks[0].mode).toBe(1);
  s.state("UNKNOWN · 영상 지연");
  s.acks[0].resolve();
  await Promise.resolve();
  expect(host.ready()).toBe(false);
  s.state("CONNECTED");
  s.acks[1].resolve();
  await Promise.resolve();
  expect(host.ready()).toBe(true);
  s.frame({ epoch: 7, receivedAt: performance.now() });
  await c.capture();
  expect(onFrame).toHaveBeenCalled();
  expect(onShort).toHaveBeenCalled();
  c.cancelCapture();
  expect(host.ready()).toBe(false);
  s.state("UNKNOWN");
  s.state("CONNECTED");
  s.acks[2].resolve();
  await Promise.resolve();
  expect(host.ready()).toBe(false);
  s.acks[3].resolve();
  await Promise.resolve();
  expect(host.ready()).toBe(true);
  s.frame({ epoch: 7, receivedAt: performance.now() });
  s.frame({ epoch: 8, receivedAt: performance.now() });
  expect(cancel).toHaveBeenCalled();
  expect(host.ready()).toBe(false);
  c.dispose();
});

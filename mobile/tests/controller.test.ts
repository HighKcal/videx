import { it, expect, vi, afterEach } from "vitest";
import type { ModuleHost } from "../src/modules/builtins";
import type { VidexModule } from "../src/core/modules";
const testState = vi.hoisted(() => ({ sources: [] as any[] }));
vi.mock("../src/core/usb-source", () => ({
  UsbFrameSource: class {
    frame: any;
    control: any;
    state: any;
    diagnostics: any;
    acks: Array<{
      mode: number;
      resolve: () => void;
      reject: (e: Error) => void;
    }> = [];
    constructor(
      frame: any,
      control: any,
      state: any,
      _usb?: any,
      _protocol?: any,
      diagnostics?: any,
    ) {
      Object.assign(this, { frame, control, state, diagnostics });
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
it("reuses the latest recognition frame for preview and invalidates it on rotation, mode and disconnect", async () => {
  const c = new AppController();
  vi.spyOn(c.feedback, "say").mockImplementation(() => {});
  c.configure(false, false, false);
  const source = testState.sources[0];
  try {
    expect(c.preview().frame).toBeUndefined();
    source.state("CONNECTED");
    const first = {
      epoch: 1,
      frameId: 1,
      width: 320,
      height: 240,
      receivedAt: performance.now(),
    };
    source.frame(first);
    expect(c.preview().frame).toBe(first);
    const version = c.preview().version;
    c.setRotation("none");
    expect(c.preview()).toMatchObject({ rotation: "none", frame: undefined });
    expect(c.preview().version).not.toBe(version);
    const next = { ...first, frameId: 2 };
    source.frame(next);
    expect(c.preview().frame).toBe(next);
    const selection = c.select("ocr");
    expect(c.preview().frame).toBeUndefined();
    source.state("UNKNOWN · USB 영상 지연");
    expect(c.preview().frame).toBeUndefined();
    source.acks.forEach((ack: any) => ack.resolve());
    await selection;
    c.disconnect();
    expect(c.preview()).toMatchObject({
      connection: "DISCONNECTED",
      frame: undefined,
    });
  } finally {
    c.dispose();
  }
});
it("surfaces local diagnostics and button dispatch intent without claiming capture success, then clears session", async () => {
  const c = new AppController();
  vi.spyOn(c.feedback, "say").mockImplementation(() => {});
  c.configure(false, false, false);
  const source = testState.sources[0];
  const cycle = vi.spyOn(c, "cycle").mockResolvedValue();
  const capture = vi.spyOn(c, "capture").mockResolvedValue();
  try {
    expect(source.diagnostics).toBeTypeOf("function");
    const diagnostics = {
      availability: "live",
      frameId: 42,
      receivedAt: 123,
      rawFlags: 7,
      valid: true,
      classified: true,
      pressed: "pressed",
      result: 2,
      decision: "press",
      shortCount: 0,
      longCount: 0,
      lastEvent: null,
    };
    source.diagnostics(diagnostics);
    expect(c.state.button).toEqual(diagnostics);
    expect(c.state.buttonDispatch).toBeNull();
    c.state.error = "선택 사진 전송 동의 필요";
    source.control({ type: "button_short" });
    expect(capture).toHaveBeenCalledOnce();
    expect(c.state.buttonDispatch).toMatchObject({
      type: "button_short",
      mode: "walking",
      at: expect.any(Number),
    });
    expect(c.state.error).toBe("선택 사진 전송 동의 필요");
    expect(c.state.session).toBe("idle");
    source.control({ type: "button_long" });
    expect(cycle).toHaveBeenCalledOnce();
    expect(c.state.buttonDispatch).toMatchObject({
      type: "button_long",
      mode: "walking",
    });
    const dispatch = c.state.buttonDispatch;
    await c.capture();
    await c.cycle();
    expect(c.state.buttonDispatch).toBe(dispatch);
    expect(c.state.button).toEqual(diagnostics);
    source.diagnostics({
      ...diagnostics,
      availability: "stale",
      pressed: "unknown",
    });
    expect(c.state.button?.pressed).toBe("unknown");
    c.disconnect();
    expect(c.state.button).toBeNull();
    expect(c.state.buttonDispatch).toBeNull();
  } finally {
    c.dispose();
  }
});
afterEach(() => {
  testState.sources = [];
  vi.restoreAllMocks();
});
it("configuration is CDC-only without credentials or profiles, preserves mode errors and invalidates on disconnect", async () => {
  const c = new AppController();
  vi.spyOn(c.feedback, "say").mockImplementation(() => {});
  c.configure(false, false, false);
  const source = testState.sources[0];
  expect(source.frame).toBeTypeOf("function");
  source.state("CONNECTED");
  source.acks[0].reject(Error("USB 실제 해상도 확인 시간 초과"));
  await Promise.resolve();
  expect(c.state.error).toContain("실제 해상도");
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
  c.configure(true, true, false);
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
it("commits CDC without a second mode command caused by a pre-hello frame", () => {
  const c = new AppController();
  vi.spyOn(c.feedback, "say").mockImplementation(() => {});
  c.configure(false, false, false);
  const source = testState.sources[0];
  source.frame({
    epoch: 1,
    frameId: 1,
    width: 320,
    height: 240,
    receivedAt: performance.now(),
  });
  source.state("CONNECTED");
  source.frame({
    epoch: 2,
    frameId: 2,
    width: 320,
    height: 240,
    receivedAt: performance.now(),
  });
  expect(source.acks).toHaveLength(1);
  c.dispose();
});

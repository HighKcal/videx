import { afterEach, expect, it, vi } from "vitest";
import { AppController } from "../src/core/controller";
import { packet } from "./fixtures";
import { parseFrame } from "../src/core/wire";

let controller: AppController;
class TestWorker {
  static latest: TestWorker;
  onmessage!: (event: { data: unknown }) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    TestWorker.latest = this;
  }
  result(state: string) {
    this.onmessage({
      data: {
        type: "result",
        generation: 0,
        receivedAt: performance.now(),
        result: { state, reason: `diagnostic ${state}`, total: 1, central: 1 },
      },
    });
  }
}
function setup() {
  vi.stubGlobal("Worker", TestWorker);
  controller = new AppController();
  // Keep real feedback priority/cancellation logic; only replace the network.
  const speech = vi.spyOn(controller.ai, "speech").mockImplementation(
    (_text, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("cancelled")));
      }),
  );
  controller.state.configured = true;
  return { c: controller, worker: TestWorker.latest, speech };
}
afterEach(() => {
  controller?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["WARNING", "UNKNOWN"])(
  "returning to walking announces current %s even after a recent identical announcement",
  async (state) => {
    const { c, worker, speech } = setup();
    await c.select("walking");
    worker.result("MONITORING");
    worker.result(state);
    const text =
      state === "WARNING"
        ? "앞에 장애물 후보가 있어요. 조심하세요!"
        : "보행 감지를 확인할 수 없습니다.";
    expect(c.state.caption).toBe(text);
    await c.select("object");
    worker.result(state);
    speech.mockClear();
    await c.select("walking");
    expect(c.state.caption).toBe(text);
    expect(
      speech.mock.calls.filter(([message]) => message === text),
    ).toHaveLength(1);
    worker.result(state);
    expect(
      speech.mock.calls.filter(([message]) => message === text),
    ).toHaveLength(1);
  },
);

it.each(["object", "ocr"])(
  "%s selection silences late results immediately and throughout activation",
  async (mode) => {
    const { c, worker, speech } = setup();
    await c.select("walking");
    worker.result("WARNING");
    const warningSignal = speech.mock.lastCall![1];
    let release!: () => void;
    const activating = vi
      .spyOn(c.registry.get(mode)!, "activate")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    const selection = c.select(mode);
    expect(warningSignal.aborted).toBe(true);
    speech.mockClear();
    worker.result("UNKNOWN");
    expect(speech).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(activating).toHaveBeenCalled());
    worker.result("WARNING");
    expect(speech).not.toHaveBeenCalled();
    release();
    await selection;
    expect(c.state.mode).toBe(mode);
    expect(c.state.caption).toBe(c.registry.get(mode)!.activationCaption);
  },
);

it.each(["object", "ocr"])(
  "%s keeps recognition feedback while continuous walking updates diagnostics",
  async (mode) => {
    const { c, worker, speech } = setup();
    await c.select(mode);
    c.feedback.say("인식 결과", 1);
    const signal = speech.mock.lastCall![1];
    speech.mockClear();
    c.registry.frame(parseFrame(packet(7, 1), performance.now()));
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "frame" }),
      expect.any(Array),
    );
    for (const state of ["WARNING", "UNKNOWN"]) {
      worker.result(state);
      expect(c.state.walking).toBe(state);
      expect(c.state.reason).toBe(`diagnostic ${state}`);
      expect(c.state.caption).toBe("인식 결과");
      expect(signal.aborted).toBe(false);
      expect(speech).not.toHaveBeenCalled();
    }
    expect(c.state.processed).toBe(2);
  },
);

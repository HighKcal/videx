import { it, expect, vi } from "vitest";
import { WalkingScheduler } from "../src/core/scheduler";
import { frame } from "./frame-fixture";
it("continues walking with latest-only bounded queue, ignores old worker generation and fails UNKNOWN on timeout", () => {
  vi.useFakeTimers();
  const workers: any[] = [];
  class WorkerMock {
    onmessage: any;
    onerror: any;
    sent: any[] = [];
    terminate = vi.fn();
    constructor() {
      workers.push(this);
    }
    postMessage(data: any) {
      this.sent.push(data);
    }
  }
  vi.stubGlobal("Worker", WorkerMock);
  try {
    const output = vi.fn(),
      scheduler = new WalkingScheduler(output),
      worker = workers[0];
    scheduler.submit(frame(7, 1));
    scheduler.submit(frame(7, 2));
    scheduler.submit(frame(7, 3));
    expect(worker.sent).toHaveLength(1);
    expect(scheduler.dropped).toBe(2);
    worker.onmessage({ data: { generation: 0, type: "ready" } });
    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[1].rotation).toBe("cw90");
    scheduler.reset();
    worker.onmessage({
      data: { generation: 0, type: "result", result: { state: "WARNING" } },
    });
    expect(scheduler.state).toBe("UNKNOWN");
    scheduler.submit(frame(7, 4));
    vi.advanceTimersByTime(6000);
    expect(worker.terminate).toHaveBeenCalled();
    expect(output.mock.calls.at(-1)?.[0].state).toBe("UNKNOWN");
    scheduler.dispose();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

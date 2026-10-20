import { it, expect, vi } from "vitest";
import { S3FrameSource, validateEndpoint } from "../src/core/source";
import { packet } from "./fixtures";
class Socket {
  readyState = 1;
  binaryType = "";
  onopen: any;
  onmessage: any;
  onclose: any;
  onerror: any;
  sent: string[] = [];
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
  message(data: any) {
    this.onmessage({ data });
  }
}
it("only exact local provisioned wss endpoint", () => {
  expect(validateEndpoint("wss://videx.local/ws", "videx.local")).toBe(
    "wss://videx.local/ws",
  );
  for (const url of [
    "ws://videx.local/ws",
    "wss://evil.local/ws",
    "wss://videx.local/other",
    "wss://a:b@videx.local/ws",
  ])
    expect(() => validateEndpoint(url, "videx.local")).toThrow();
});
it("authenticates before frames, drops stale epoch and duplicates and retains controls", async () => {
  const sock = new Socket();
  const frames: any[] = [];
  const controls: any[] = [];
  const s = new S3FrameSource(
    { url: "wss://videx.local/ws", host: "videx.local", token: "test-pairing" },
    (f) => frames.push(f),
    (e) => controls.push(e),
    () => {},
    () => sock as any,
  );
  s.start();
  sock.onopen();
  expect(JSON.parse(sock.sent[0]).type).toBe("authenticate");
  sock.message(packet());
  expect(frames).toHaveLength(0);
  sock.message(JSON.stringify({ type: "connected", epoch: 7 }));
  sock.message(packet());
  sock.message(packet());
  sock.message(packet(6, 2));
  sock.message(JSON.stringify({ type: "button_short", epoch: 7, event_id: 1 }));
  await Promise.resolve();
  expect(frames).toHaveLength(1);
  expect(controls.some((e) => e.type === "button_short")).toBe(true);
  s.stop();
});
it("matches resolution ACK to request and observed dimensions; rejects pending on disconnect", async () => {
  const sock = new Socket();
  const s = new S3FrameSource(
    { url: "wss://videx.local/ws", host: "videx.local", token: "test" },
    () => {},
    () => {},
    () => {},
    () => sock as any,
  );
  s.start();
  sock.onopen();
  sock.message(JSON.stringify({ type: "connected", epoch: 7 }));
  const ack = s.resolution(1);
  const request = JSON.parse(sock.sent[1]);
  sock.message(
    JSON.stringify({
      type: "resolution_applied",
      request_id: request.request_id,
      mode: 1,
      width: 320,
      height: 240,
    }),
  );
  await expect(ack).rejects.toThrow();
  const pending = s.resolution(2);
  s.stop();
  await expect(pending).rejects.toThrow();
});
it("recovers stale status once, authenticates reconnect and ignores old generation/epoch/event duplicates", async () => {
  vi.useFakeTimers();
  try {
    const sockets: Socket[] = [],
      states: string[] = [],
      events: any[] = [],
      frames: any[] = [];
    const s = new S3FrameSource(
      { url: "wss://videx.local/ws", host: "videx.local", token: "test" },
      (f) => frames.push(f),
      (e) => events.push(e),
      (v) => states.push(v),
      () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as any;
      },
    );
    s.start();
    const one = sockets[0];
    one.onopen();
    one.message(JSON.stringify({ type: "connected", epoch: 7 }));
    one.message(packet(7, 1));
    await vi.advanceTimersByTimeAsync(2600);
    expect(states.filter((s) => s.includes("영상 지연"))).toHaveLength(1);
    one.message(packet(7, 2));
    await Promise.resolve();
    expect(states.at(-1)).toBe("CONNECTED");
    one.message(
      JSON.stringify({ type: "button_short", epoch: 7, event_id: 2 }),
    );
    one.message(
      JSON.stringify({ type: "button_short", epoch: 7, event_id: 2 }),
    );
    await Promise.resolve();
    expect(events.filter((e) => e.type === "button_short")).toHaveLength(1);
    one.onclose();
    await vi.advanceTimersByTimeAsync(500);
    const two = sockets[1];
    two.onopen();
    expect(JSON.parse(two.sent[0]).type).toBe("authenticate");
    two.message(JSON.stringify({ type: "connected", epoch: 8 }));
    one.message(packet(7, 100));
    two.message(packet(7, 100));
    two.message(packet(8, 1));
    two.message(
      JSON.stringify({ type: "button_short", epoch: 7, event_id: 3 }),
    );
    two.message(
      JSON.stringify({ type: "button_short", epoch: 8, event_id: 1 }),
    );
    await Promise.resolve();
    expect(frames.at(-1).epoch).toBe(8);
    expect(events.filter((e) => e.type === "button_short")).toHaveLength(2);
    s.stop();
  } finally {
    vi.useRealTimers();
  }
});
it("fails closed on reliable control overload rather than dropping events silently", async () => {
  const sock = new Socket(),
    states: string[] = [];
  const s = new S3FrameSource(
    { url: "wss://videx.local/ws", host: "videx.local", token: "test" },
    () => {},
    () => {},
    (v) => states.push(v),
    () => sock as any,
  );
  s.start();
  sock.onopen();
  sock.message(JSON.stringify({ type: "connected", epoch: 7 }));
  await Promise.resolve();
  for (let i = 0; i < 34; i++)
    sock.message(
      JSON.stringify({ type: "button_short", epoch: 7, event_id: i }),
    );
  expect(states.at(-1)).toContain("UNKNOWN");
  expect(sock.readyState).toBe(3);
  s.stop();
});

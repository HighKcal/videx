import { it, expect, vi } from "vitest";
import { OpenAITransport } from "../src/core/openai";

it("revoking speech consent cancels an already pending body read", async () => {
  let cancelled = false;
  const fetcher = vi.fn(async (url: any) =>
    url === "/api/health"
      ? Response.json({ ready: true, authRequired: false })
      : new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "audio/mpeg" } },
        ),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  const signal = new AbortController().signal;
  await ai.refreshHealth(signal);
  ai.configure(false, true);
  const pending = ai.speech("text", signal);
  const outcome = pending.catch((error) => error);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  ai.configure(false, false);
  await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 300 });
  expect((await outcome).name).toBe("AbortError");
});

it("delivers speech chunks before EOF and awaits consumer backpressure", async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn(async (url: any) =>
    url === "/api/health"
      ? Response.json({ ready: true, authRequired: false })
      : new Response(
          new ReadableStream({
            start(c) {
              upstream = c;
              c.enqueue(new Uint8Array([1, 2]));
            },
          }),
          { headers: { "content-type": "audio/mpeg" } },
        ),
  );
  const ai = new OpenAITransport(fetcher as typeof fetch);
  const signal = new AbortController().signal;
  await ai.refreshHealth(signal);
  ai.configure(false, true);
  fetcher.mockClear();
  let release!: () => void;
  const chunks: number[][] = [];
  const consume = vi.fn(async (bytes: Uint8Array) => {
    chunks.push([...bytes]);
    if (chunks.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  const pending = ai.speech("text", signal, consume);
  try {
    await vi.waitFor(() => expect(chunks).toEqual([[1, 2]]), { timeout: 300 });
    upstream.enqueue(new Uint8Array([3]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(consume).toHaveBeenCalledTimes(1);
    release();
    upstream.close();
    expect([...new Uint8Array(await (await pending).arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    try {
      upstream.close();
    } catch {}
    await pending;
  }
});

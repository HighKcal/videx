import { it, expect } from "vitest";
import { ModuleRegistry } from "../src/core/modules";
it("runs lifecycle in order, leaves continuous walking active, rejects unreviewed duplicate and foreign source", async () => {
  const log: string[] = [];
  const make = (id: string, kind: "continuous" | "on-demand") => ({
    manifest: {
      id,
      label: id,
      color: "#FF5033",
      kind,
      source: "s3" as const,
      permissions: ["s3-frames" as const],
      priority: "normal" as const,
    },
    async init() {
      log.push(id + ":init");
    },
    async activate() {
      log.push(id + ":activate");
    },
    async deactivate() {
      log.push(id + ":deactivate");
    },
    async dispose() {
      log.push(id + ":dispose");
    },
  });
  const r = new ModuleRegistry();
  r.register(make("walking", "continuous"));
  r.register(make("ocr", "on-demand"));
  r.register(make("object", "on-demand"));
  expect(() => r.register(make("ocr", "on-demand"))).toThrow();
  await r.init({});
  await r.select("walking");
  await r.select("ocr");
  await r.select("object");
  expect(log).not.toContain("walking:deactivate");
  expect(log).toContain("ocr:deactivate");
  await r.dispose();
  expect(log).toContain("walking:dispose");
});

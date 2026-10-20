import { expect, it, vi } from "vitest";
import { builtInModules, type ModuleHost } from "../src/modules/builtins";
it("walking short press reports a warning as a warning, not unavailable", async () => {
  const say = vi.fn();
  const host = { walking: { state: "WARNING" }, say } as unknown as ModuleHost;
  await builtInModules(host)[0].onShort!();
  expect(say.mock.lastCall![0]).toContain("장애물");
});

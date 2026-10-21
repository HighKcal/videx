import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships no credential fields, WSS selector, BYOK or firmware-profile selector", () => {
  const ui = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  expect(ui).not.toMatch(
    /type="password"|name="apiKey"|name="pairing"|BYOK|UsbProfile|AIMode|deployment\.deviceHost/,
  );
  expect(ui).toContain("USB 장치 선택 및 연결");
  expect(ui).toContain("VIDEX_DEMO_MODE=true");
});
it("CSP permits only same-origin connections in HTML and built preview policy", () => {
  for (const path of ["../index.html", "../vite.config.ts"]) {
    const content = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(content).toContain("connect-src 'self';");
    expect(content).not.toMatch(/api\.openai\.com|wss:\/\//);
  }
});

import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
const port = Number(process.env.VIDEX_TTS_E2E_PORT || 14373);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8787)
  throw Error("Invalid isolated test port");
export default defineConfig(base, {
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: "node tests/e2e/tts-isolated-server.mjs",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});

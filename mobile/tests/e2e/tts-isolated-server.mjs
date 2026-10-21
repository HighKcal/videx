import { createVidexServer } from "../../server/server.mjs";
const port = Number(process.env.VIDEX_TTS_E2E_PORT || 14373);
// Explicitly empty config: never read ambient credentials, use Vite's 8787
// proxy, or make a provider call. API fixtures run on their own ephemeral ports.
const server = createVidexServer({
  env: {},
  fetcher: () => {
    throw Error("No upstream allowed");
  },
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Isolated static runner ready on ${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });

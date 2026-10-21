import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
// @ts-expect-error Backend peer intentionally exports untyped ESM.
import { createVidexServer } from "../../server/server.mjs";

export const providerKey = "synthetic-provider-key-server-only";
export async function closeServer(server: Server) {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}
export async function startBackend(
  fetcher: typeof fetch,
  distDir = resolve("dist"),
  demo = true,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw Error("No TCP port");
    const origin = `http://127.0.0.1:${address.port}`;
    await closeServer(reservation);
    const server: Server = createVidexServer({
      env: {
        OPENAI_API_KEY: providerKey,
        VIDEX_ALLOWED_ORIGINS: origin,
        ...(demo
          ? { VIDEX_DEMO_MODE: "true" }
          : {
              VIDEX_ACCESS_TOKEN: "synthetic-auth-required-server-token-32plus",
            }),
      },
      fetcher,
      distDir,
    });
    try {
      server.listen(address.port, "127.0.0.1");
      await once(server, "listening");
      return { server, origin };
    } catch (error) {
      await closeServer(server);
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw Error("Could not bind ephemeral test server");
}

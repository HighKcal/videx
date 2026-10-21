import { defineConfig } from "vitest/config";
import { createHash } from "node:crypto";
const csp = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`;
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], maxWorkers: 1 },
  server: {
    host: "127.0.0.1",
    allowedHosts: [".vt.ssammwu.info"],
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  preview: {
    allowedHosts: [".vt.ssammwu.info"],
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  plugins: [
    {
      name: "videx-static-only-pwa",
      transformIndexHtml(html) {
        return html.replace(/content="default-src[^"]+"/, `content="${csp}"`);
      },
      configurePreviewServer(server) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader(
            "Content-Security-Policy",
            csp + "; frame-ancestors 'none'",
          );
          next();
        });
      },
      generateBundle(_options, bundle) {
        const assets = [
          "/",
          "/index.html",
          "/icon.svg",
          "/manifest.webmanifest",
          ...Object.keys(bundle)
            .filter((p) => /\.(js|css|wasm)$/.test(p))
            .map((p) => "/" + p),
        ];
        const version = createHash("sha256")
          .update(JSON.stringify(assets))
          .digest("hex")
          .slice(0, 16);
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: `const CACHE='videx-static-${version}';const STATIC=${JSON.stringify(assets)};self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)));});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('videx-static-')&&k!==CACHE).map(k=>caches.delete(k)))));});self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.search||!STATIC.includes(u.pathname))return;e.respondWith(caches.open(CACHE).then(c=>c.match(u.pathname,{ignoreVary:true})).then(hit=>hit||fetch(e.request)));});`,
        });
        this.emitFile({
          type: "asset",
          fileName: "_headers",
          source: `/*\n  Content-Security-Policy: ${csp}; frame-ancestors 'none'\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`,
        });
      },
    },
  ],
});

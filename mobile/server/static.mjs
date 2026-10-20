import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'], ['.webmanifest', 'application/manifest+json'],
  ['.png', 'image/png'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);
const ROOT_FILES = new Set(['index.html', 'sw.js', 'icon.svg', 'manifest.webmanifest']);

// Serve only reviewed public build paths; never SPA-fallback API requests to HTML.
export async function serveStatic(req, res, distDir) {
  const raw = req.url?.split('?')[0] ?? '';
  if (!raw.startsWith('/') || raw.includes('\\') || raw.includes('%') || raw.includes('\0')) return false;
  const parts = (raw === '/' ? '/index.html' : raw).slice(1).split('/');
  if (parts.some(part => !part || part.startsWith('.') || !/^[a-zA-Z0-9_@.-]+$/.test(part))) return false;
  if (!(parts.length === 1 && ROOT_FILES.has(parts[0])) && !(parts[0] === 'assets' && parts.length > 1)) return false;
  const type = TYPES.get(extname(parts.at(-1)));
  if (!type) return false;
  let handle;
  try {
    const root = resolve(distDir);
    if (await realpath(root) !== root || (await lstat(root)).isSymbolicLink()) return false;
    let path = root;
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) return false;
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    const current = await lstat(path);
    if (!info.isFile() || info.size > 32_000_000 || await realpath(path) !== path || info.dev !== current.dev || info.ino !== current.ino) return false;
    res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else {
      const stream = handle.createReadStream();
      handle = undefined; // Stream owns and closes the descriptor, including on disconnect.
      stream.on('error', () => res.destroy());
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    }
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Serves https://ftgames.xyz/* from a local checkout of the FT Games site with GitHub Pages behaviour, so the
// tests use the exact production URLs (and the exact absolute links inside the game pages).
//
//   /foo/  -> /foo/index.html     /foo -> /foo.html, or a 301 to /foo/ for a folder     404 otherwise
//   every response has Access-Control-Allow-Origin: * and no X-Frame-Options, like GitHub Pages.
//
// Options: bytesPerSecond simulates one shared connection of that speed; offline makes every request fail.
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary', '.md': 'text/markdown', '.xml': 'application/xml', '.txt': 'text/plain',
  '.mp4': 'video/mp4', '.track': 'application/octet-stream',
};

function resolvePath(root, urlPath) {
  const clean = decodeURIComponent(urlPath);
  const fsPath = path.normalize(path.join(root, clean));
  if (!fsPath.startsWith(root)) return { status: 403 };
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  if (clean.endsWith('/')) {
    const index = path.join(fsPath, 'index.html');
    return isFile(index) ? { status: 200, file: index } : { status: 404 };
  }
  if (isFile(fsPath)) return { status: 200, file: fsPath };
  if (isFile(fsPath + '.html')) return { status: 200, file: fsPath + '.html' };
  if (isDir(fsPath)) return { status: 301, location: clean + '/' };
  return { status: 404 };
}

async function install(context, root, options = {}) {
  root = path.resolve(root);
  const stats = { requests: [], notFound: [], external: [], bytes: 0 };
  let linkFreeAt = 0; // simulated shared connection
  await context.route(/^https:\/\/ftgames\.xyz\//, async (route) => {
    const url = new URL(route.request().url());
    if (options.offline) return route.abort('internetdisconnected');
    const r = resolvePath(root, url.pathname);
    const headers = { 'access-control-allow-origin': '*', 'cache-control': 'max-age=600' };
    stats.requests.push({ path: url.pathname, at: Date.now() });
    if (r.status === 301) return route.fulfill({ status: 301, headers: { ...headers, location: 'https://ftgames.xyz' + r.location + url.search } });
    if (r.status !== 200) {
      stats.notFound.push(url.pathname);
      return route.fulfill({ status: 404, headers: { ...headers, 'content-type': 'text/html' }, body: '<!doctype html><title>404</title><h1>404</h1>' });
    }
    const body = fs.readFileSync(r.file);
    stats.bytes += body.length;
    if (options.bytesPerSecond) {
      const now = Date.now();
      const start = Math.max(now, linkFreeAt);
      linkFreeAt = start + (body.length / options.bytesPerSecond) * 1000 + 15;
      await new Promise((resolve) => setTimeout(resolve, linkFreeAt - now));
    }
    return route.fulfill({ status: 200, headers: { ...headers, 'content-type': TYPES[path.extname(r.file).toLowerCase()] || 'application/octet-stream' }, body });
  });
  // The test machine has no internet: stub the two external hosts the arcade frames, abort everything else.
  await context.route(/^https:\/\/arcade\.makecode\.com\/---run/, (route) => {
    if (options.offline) return route.abort('internetdisconnected');
    stats.requests.push({ path: route.request().url(), at: Date.now() });
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>MakeCode stub</title><body style="background:#4b2c83;color:#fff;font:20px sans-serif"><p id="stub">MakeCode Arcade player (test stub) for ' + new URL(route.request().url()).searchParams.get('id') + '</p></body>' });
  });
  await context.route((url) => {
    const u = typeof url === 'string' ? new URL(url) : url;
    return /^(https?|wss?):$/.test(u.protocol) && u.hostname !== 'ftgames.xyz' && !(u.hostname === 'arcade.makecode.com' && u.pathname.startsWith('/---run'));
  }, (route) => {
    stats.external.push(route.request().url().slice(0, 140));
    return route.abort('internetdisconnected');
  });
  return stats;
}

module.exports = { install, resolvePath };

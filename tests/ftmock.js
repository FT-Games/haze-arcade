// Network for the tests.
//
// By default https://raw.githubusercontent.com/FT-Games/ftgames/main/* is served from a local checkout of the FT
// Games repository with the headers GitHub really sends (HTML, JavaScript, CSS and JSON as text/plain with nosniff,
// images and audio with their types, everything else as application/octet-stream, CORS for everyone). With
// { real: true } the tests use GitHub itself instead (through the session's proxy).
//
// Every request to the ftgames.xyz website is refused and recorded: the arcade must never need it.
// arcade.makecode.com's player is replaced by a stub, and other sites are unreachable, as in the sandbox.
const fs = require('fs');
const path = require('path');

const RAW = 'https://raw.githubusercontent.com/FT-Games/ftgames/main/';
const GITHUB_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
  '.html': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8', '.track': 'text/plain; charset=utf-8',
};
const GITHUB_HEADERS = {
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'deny',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'cache-control': 'max-age=300',
};

async function install(context, root, options = {}) {
  root = path.resolve(root);
  const stats = { github: [], site: [], external: [], notFound: [], gamesHtml: 0 };
  let linkFreeAt = 0;

  await context.route((url) => /(^|\.)ftgames\.xyz$/i.test(url.hostname), (route) => {
    stats.site.push(route.request().url());
    return route.abort('blockedbyclient');
  });

  if (!options.real) {
    await context.route((url) => url.href.startsWith(RAW), async (route) => {
      const url = new URL(route.request().url());
      const rel = decodeURIComponent(url.pathname.slice('/FT-Games/ftgames/main/'.length));
      stats.github.push(rel);
      if (rel === 'games.html') stats.gamesHtml++;
      if (options.offline) return route.abort('internetdisconnected');
      if (options.gamesHtml && rel === 'games.html') {
        return route.fulfill({ status: 200, headers: { ...GITHUB_HEADERS, 'content-type': 'text/plain; charset=utf-8' }, body: options.gamesHtml });
      }
      const file = path.normalize(path.join(root, rel));
      let body = null;
      try {
        if (file.startsWith(root + path.sep) && fs.statSync(file).isFile()) body = fs.readFileSync(file);
      } catch (e) { /* missing */ }
      if (!body) {
        stats.notFound.push(rel);
        return route.fulfill({ status: 404, headers: { ...GITHUB_HEADERS, 'content-type': 'text/plain; charset=utf-8' }, body: '404: Not Found' });
      }
      if (options.bytesPerSecond) {
        const now = Date.now();
        linkFreeAt = Math.max(now, linkFreeAt) + (body.length / options.bytesPerSecond) * 1000 + 10;
        await new Promise((resolve) => setTimeout(resolve, linkFreeAt - now));
      }
      const type = GITHUB_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return route.fulfill({ status: 200, headers: { ...GITHUB_HEADERS, 'content-type': type }, body });
    });
  } else {
    // Real GitHub: only record what goes there.
    context.on('request', (request) => {
      const url = request.url();
      if (url.startsWith(RAW)) {
        stats.github.push(url.slice(RAW.length));
        if (url === RAW + 'games.html') stats.gamesHtml++;
      }
    });
  }

  await context.route((url) => url.hostname === 'arcade.makecode.com' && url.pathname.startsWith('/---run'), (route) => {
    if (options.offline) return route.abort('internetdisconnected');
    const id = new URL(route.request().url()).searchParams.get('id');
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>MakeCode stub</title><body style="background:#4b2c83;color:#fff;font:20px sans-serif"><p id="stub">MakeCode Arcade player (test stub) for ' + id + '</p></body>' });
  });
  if (!options.real) {
    await context.route((url) => /^(https?|wss?):$/.test(url.protocol) && url.hostname !== 'raw.githubusercontent.com' && !/(^|\.)ftgames\.xyz$/i.test(url.hostname) && url.hostname !== 'arcade.makecode.com', (route) => {
      stats.external.push(route.request().url().slice(0, 140));
      return route.abort('internetdisconnected');
    });
  }
  return stats;
}

module.exports = { install, RAW };

// Haze Arcade loading screen for games the arcade opens in a PhantomHaze tab instead of its own page.
// Polytrack is one: it checks its 3D models with crypto.subtle, which only exists on secure pages, and an
// extension page (an opaque NavigateToString document) can never give its frames one.
// PhantomHaze runs this on ftgames.xyz pages once they have loaded; it only acts on pages the arcade opened
// (they carry #haze-arcade), shows the loading screen until the game is ready, then holds it like the arcade does.
(() => {
  if (location.hash !== '#haze-arcade' || document.getElementById('haze-arcade-tab-loader')) return;
  try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* keep the hash */ }

  const settings = (typeof phantomHazeExtension === 'object' && phantomHazeExtension && phantomHazeExtension.settings) || {};
  const holdSeconds = Number.isFinite(Number(settings.holdSeconds)) ? Number(settings.holdSeconds) : 5;
  const holdMs = Math.min(Math.max(holdSeconds, 0), 30) * 1000;
  const fontData = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
  try {
    document.fonts.add(new FontFace('HazeNeon', fontData('@@FONT_NEON@@')));
    document.fonts.add(new FontFace('HazePixel', fontData('@@FONT_PIXEL@@')));
  } catch (e) { /* the screen still works with fallback fonts */ }

  const host = document.createElement('div');
  host.id = 'haze-arcade-tab-loader';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;transition:opacity .45s ease;';
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .ld { position: absolute; inset: 0; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px;
      background: radial-gradient(ellipse at 50% 36%, #2c0b52 0%, #12031f 44%, #05010c 78%); font-family: "Segoe UI", system-ui, sans-serif; color: #fff; }
    .sun { position: absolute; left: 50%; top: 9%; width: min(52vmin, 460px); aspect-ratio: 1; transform: translateX(-50%); border-radius: 50%; opacity: .26;
      background: linear-gradient(180deg, #ffe14d 0%, #ff8a3d 38%, #ff2bd6 78%);
      -webkit-mask-image: linear-gradient(180deg, #000 0 52%, transparent 52% 56%, #000 56% 63%, transparent 63% 68%, #000 68% 74%, transparent 74% 80%, #000 80% 85%, transparent 85% 91%, #000 91%);
      mask-image: linear-gradient(180deg, #000 0 52%, transparent 52% 56%, #000 56% 63%, transparent 63% 68%, #000 68% 74%, transparent 74% 80%, #000 80% 85%, transparent 85% 91%, #000 91%); }
    .floor { position: absolute; left: -50%; right: -50%; bottom: -8%; height: 52%; opacity: .5;
      background-image: linear-gradient(rgba(255, 43, 214, .6) 2px, transparent 2px), linear-gradient(90deg, rgba(255, 43, 214, .6) 2px, transparent 2px);
      background-size: 64px 64px; transform: perspective(300px) rotateX(64deg); transform-origin: 50% 0;
      -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 40%); mask-image: linear-gradient(180deg, transparent 0%, #000 40%);
      animation: floor 1.1s linear infinite; }
    @keyframes floor { to { background-position: 0 64px; } }
    .scan { position: absolute; inset: 0; pointer-events: none;
      background: repeating-linear-gradient(180deg, rgba(0, 0, 0, .22) 0 1px, transparent 1px 3px), radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, .65) 100%); }
    .logo { position: relative; display: flex; flex-direction: column; align-items: center; margin-bottom: 8px; }
    .haze { font-family: "HazeNeon", "HazePixel", Impact, sans-serif; font-size: clamp(64px, 13vw, 172px); line-height: 1; color: #ffe9fb;
      text-shadow: 0 0 3px #fff, 0 0 10px #ff2bd6, 0 0 22px #ff2bd6, 0 0 46px #ff2bd6, 0 0 92px #ff2bd6; animation: flicker 7s infinite; }
    .arcade { font-family: "HazePixel", "Courier New", monospace; font-size: clamp(22px, 4.4vw, 56px); letter-spacing: .32em; margin-right: -.32em; margin-top: clamp(8px, 1.6vw, 20px);
      color: #e6fdff; text-shadow: 0 0 3px #fff, 0 0 10px #00e5ff, 0 0 22px #00e5ff, 0 0 46px #00e5ff; }
    @keyframes flicker { 0%, 15%, 17%, 19%, 61%, 63%, 100% { opacity: 1; } 16%, 18% { opacity: .45; } 62% { opacity: .7; } }
    .now { position: relative; font: 12px "HazePixel", monospace; letter-spacing: 3px; color: #ffe14d; text-shadow: 0 0 8px rgba(255, 225, 77, .7); }
    .title { position: relative; max-width: 90vw; text-align: center; line-height: 1.5; font: clamp(14px, 2vw, 20px) "HazePixel", monospace; text-shadow: 0 0 10px rgba(255, 255, 255, .45); }
    .bar { position: relative; width: min(440px, 80vw); height: 24px; padding: 3px; margin-top: 4px; border: 2px solid #00e5ff; border-radius: 4px; background: rgba(0, 0, 0, .35);
      box-shadow: 0 0 12px rgba(0, 229, 255, .55), inset 0 0 8px rgba(0, 229, 255, .25); box-sizing: border-box; }
    .fill { height: 100%; width: 0%; background: repeating-linear-gradient(90deg, #00e5ff 0 10px, transparent 10px 14px); filter: drop-shadow(0 0 4px rgba(0, 229, 255, .9)); transition: width .2s linear; }
    .status { position: relative; min-height: 14px; font: 12px "HazePixel", monospace; letter-spacing: 2px; text-align: center; line-height: 1.6; animation: blink 1.1s steps(2, start) infinite; }
    @keyframes blink { to { visibility: hidden; } }
    .tip { position: absolute; left: 0; right: 0; bottom: 22px; padding: 0 20px; text-align: center; font-size: 13px; color: #a998c7; }
    @media (prefers-reduced-motion: reduce) { .haze, .floor, .status { animation: none; } }
  `);
  root.adoptedStyleSheets = [sheet];
  const screen = document.createElement('div');
  screen.className = 'ld';
  screen.setAttribute('role', 'status');
  for (const cls of ['sun', 'floor']) {
    const part = document.createElement('div');
    part.className = cls;
    screen.append(part);
  }
  const logo = document.createElement('div');
  logo.className = 'logo';
  const haze = document.createElement('div');
  haze.className = 'haze';
  haze.textContent = 'HAZE';
  const arcade = document.createElement('div');
  arcade.className = 'arcade';
  arcade.textContent = 'ARCADE';
  logo.append(haze, arcade);
  const now = document.createElement('div');
  now.className = 'now';
  now.textContent = 'NOW LOADING';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = (document.title || 'Game').replace(/\s*[-\u2013\u2014]\s*FT Games\s*$/i, '').toUpperCase();
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = 'fill';
  bar.append(fill);
  const status = document.createElement('div');
  status.className = 'status';
  status.textContent = 'LOADING...';
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.textContent = 'This game runs in its own PhantomHaze tab. Click Haze Arcade in the menu bar to go back to the arcade.';
  const scan = document.createElement('div');
  scan.className = 'scan';
  screen.append(logo, now, title, bar, status, tip, scan);
  root.append(screen);
  document.documentElement.append(host);

  // Polytrack shows its menu once its models and tracks are in; Scratch pages hide #loading once the project is in.
  const ready = () => {
    const menu = document.querySelector('.menu-ui');
    if (menu) return !menu.classList.contains('loading-screen');
    const loading = document.getElementById('loading');
    if (loading && document.getElementById('launch')) return loading.hidden;
    return true;
  };
  const started = performance.now();
  const finish = () => {
    host.style.opacity = '0';
    host.style.pointerEvents = 'none';
    setTimeout(() => host.remove(), 500);
  };
  const hold = (end) => {
    const left = end - performance.now();
    if (left <= 0) {
      finish();
      return;
    }
    const text = 'GET READY  ' + Math.ceil(left / 1000);
    if (status.textContent !== text) status.textContent = text;
    setTimeout(() => hold(end), Math.min(200, left));
  };
  const wait = () => {
    const elapsed = performance.now() - started;
    if (!ready() && elapsed < 45000) {
      fill.style.width = (95 * (1 - Math.exp(-elapsed / 2500))).toFixed(1) + '%';
      setTimeout(wait, 150);
      return;
    }
    fill.style.width = '100%';
    hold(performance.now() + holdMs);
  };
  wait();
})();

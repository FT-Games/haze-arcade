// End-to-end tests for the Haze Arcade page, run the way PhantomHaze shows it: the page HTML is opened as a data:
// URL (WebView2's NavigateToString gives the same opaque, non-secure origin), and the games are downloaded from the
// FT-Games/ftgames repository on GitHub - a local copy served with GitHub's exact headers, or GitHub itself.
//
//   node tests/arcade.test.js --ftgames ../ftgames --page tests/out/page-arcade.html
//        [--real] [--suite boot,games,nav,live,offline] [--only tetris,chess] [--shots dir]
//
// --page is the page PhantomHaze would render (tests/phext-check writes it from the .phext). --real uses GitHub itself
// through the session's HTTPS proxy. The long per-game run uses a copy of the page whose final loading phase is
// 0.3 s instead of 3 s; the real timing is checked by the boot and nav suites.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { install, RAW } = require('./ftmock');

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return pairs;
}, []));
const FTGAMES = path.resolve(args.ftgames || '../ftgames');
const REAL = args.real === 'true';
const PAGE = fs.readFileSync(args.page, 'utf8');
const FAST_PAGE = PAGE.replace('const EXTRA_MS = 3000;', 'const EXTRA_MS = 300;');
if (FAST_PAGE === PAGE) throw new Error('could not make the fast copy of the page (EXTRA_MS not found)');
const SUITES = (args.suite || 'boot,games,nav,live,offline').split(',');
const ONLY = args.only ? args.only.split(',') : null;
const SHOTS = args.shots ? path.resolve(args.shots) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const CATALOG = JSON.parse(PAGE.match(/<script type="application\/json" id="catalog">([\s\S]*?)<\/script>/)[1].replace(/<\\\//g, '</'));
const REPO = RAW.replace(/\/$/, '');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

// Records what the loading screen does, with timestamps.
function timelineScript() {
  if (window.top !== window) return;
  window.__timeline = [];
  const rec = (type, value) => window.__timeline.push({ t: performance.now(), type, value });
  document.addEventListener('DOMContentLoaded', () => {
    const loader = document.getElementById('loader');
    const status = document.getElementById('ldStatus');
    const fill = document.getElementById('ldFill');
    if (!loader) return;
    rec('status', status.textContent);
    rec('fill', parseFloat(fill.style.width) || 0);
    new MutationObserver(() => rec('loader', loader.classList.contains('out') ? 'out' : 'in')).observe(loader, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => rec('status', status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => rec('fill', parseFloat(fill.style.width) || 0)).observe(fill, { attributes: true, attributeFilter: ['style'] });
  });
}

let browser;
async function openArcade(html, mock = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 720 } });
  const stats = await install(context, FTGAMES, { real: REAL, ...mock });
  await context.addInitScript(timelineScript);
  const page = await context.newPage();
  const problems = { errors: [], frameErrors: [], popups: [] };
  page.on('pageerror', (error) => problems.errors.push(String(error.stack || error).slice(0, 300)));
  page.on('popup', (popup) => problems.popups.push(popup.url()));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = msg.location().url || '';
    const text = msg.text();
    if (/Failed to load resource|ERR_|net::|Failed to connect to server/.test(text)) return; // expected without internet
    (where.startsWith('data:') ? problems.errors : problems.frameErrors).push(text.slice(0, 200));
  });
  await page.goto('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  return { context, page, stats, problems };
}

const state = (page) => page.evaluate(() => window.__hazeArcade.state());
const timeline = (page) => page.evaluate(() => window.__timeline.slice());
const waitView = (page, view, timeout = 60000) => page.waitForFunction((v) => window.__hazeArcade && window.__hazeArcade.state().view === v, view, { timeout });
const loaderShown = (page) => page.evaluate(() => !document.getElementById('loader').classList.contains('out'));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

async function frameIn(page, hostId) {
  for (const f of page.mainFrame().childFrames()) {
    try {
      const handle = await f.frameElement();
      if (await handle.evaluate((e, id) => !!e.parentElement && e.parentElement.id === id, hostId)) return f;
    } catch (e) { /* detached */ }
  }
  return null;
}
const gameFrame = (page) => frameIn(page, 'frameHost');

async function clickCard(page, title) {
  await page.locator('#grid .card', { has: page.locator('.card-title', { hasText: title }) }).first().locator('.play').click();
}

function statusesSeen(tl) {
  return Array.from(new Set(tl.filter((e) => e.type === 'status').map((e) => e.value)));
}

// The last phase of a load: the bar keeps filling for ~3 s (never full before the end) while the screen says LOADING.
function checkFinish(name, tl, readyAt, expectedMs = 3000) {
  const out = tl.find((e) => e.type === 'loader' && e.value === 'out' && e.t > readyAt);
  if (!out) {
    check(name, false, 'loading screen never closed');
    return;
  }
  const fills = tl.filter((e) => e.type === 'fill' && e.t > readyAt - 1 && e.t <= out.t + 1);
  const early = fills.filter((e) => e.t < out.t - 300 && e.value >= 99.95);
  const tail = fills.filter((e) => e.t >= out.t - expectedMs + 200);
  const rising = tail.every((e, i) => i === 0 || e.value >= tail[i - 1].value);
  const last = fills.length ? fills[fills.length - 1].value : -1;
  const waited = out.t - readyAt;
  const ok = waited >= expectedMs - 150 && waited <= expectedMs + 900 && early.length === 0 && rising && last >= 99.9 && tail.length >= 10;
  check(name, ok, `closed ${Math.round(waited)} ms after loading finished, bar ${tail.length ? tail[0].value.toFixed(0) : '?'}% -> ${last.toFixed(0)}%, full early: ${early.length}`);
}

// ------------------------------------------------------------------ boot: the games page and its loading screen
async function suiteBoot() {
  const { context, page, stats, problems } = await openArcade(PAGE);
  await page.waitForTimeout(800);
  check('boot: loading screen is up while the games page loads', await loaderShown(page));
  const logo = await page.evaluate(() => [document.querySelector('.ld-haze').textContent, document.querySelector('.ld-arcade').textContent].join(' '));
  check('boot: loading screen says "HAZE ARCADE"', logo === 'HAZE ARCADE', logo);
  check('boot: neon and pixel fonts are embedded and loaded', await page.evaluate(() => document.fonts.check('40px HazeNeon') && document.fonts.check('16px HazePixel')));
  await shot(page, '01-loading-screen');
  await waitView(page, 'home', 60000);
  const tl = await timeline(page);
  const imagesDone = await page.evaluate(() => Array.from(document.querySelectorAll('#grid img')).every((img) => img.complete && img.naturalWidth > 0));
  check('boot: every thumbnail had loaded before the reveal', imagesDone);
  // Everything is in when the bar first reaches 80% (live list fetched, thumbnails decoded).
  const ready = tl.find((e) => e.type === 'fill' && e.value >= 79.9);
  checkFinish('boot: after loading, keeps loading 3 s with the bar still filling', tl, ready ? ready.t : 0);
  const statuses = statusesSeen(tl);
  check('boot: the screen only ever says LOADING... (no GET READY)', statuses.length === 1 && statuses[0] === 'LOADING...', statuses.join(' | '));
  check('boot: read the game list from GitHub', stats.gamesHtml === 1, `${stats.gamesHtml} request(s)`);
  const cards = await page.$$eval('#grid .card', (nodes) => nodes.map((n) => n.querySelector('.card-title').textContent));
  const expected = CATALOG.games.map((g) => g.title);
  check('home: every card of the FT Games games page, in order', JSON.stringify(cards) === JSON.stringify(expected), `${cards.length} cards`);
  check('home: game count excludes the suggestion box', (await page.textContent('#count')) === `(${expected.length - 1})`);
  await shot(page, '02-games-page');
  await page.fill('#search', 'tetris');
  let visible = await page.$$eval('#grid .card:not([hidden]) .card-title', (n) => n.map((x) => x.textContent));
  check('home: search', visible.length === 1 && visible[0] === 'Tetris', visible.join(', '));
  await page.fill('#search', '');
  await page.selectOption('#genre', 'Planes');
  visible = await page.$$eval('#grid .card:not([hidden]) .card-title', (n) => n.map((x) => x.textContent));
  check('home: genre filter', visible.length === CATALOG.games.filter((g) => g.genre === 'Planes').length, visible.join(', '));
  await page.selectOption('#genre', '');
  await page.selectOption('#difficulty', 'Hard');
  visible = await page.$$eval('#grid .card:not([hidden]) .card-title', (n) => n.map((x) => x.textContent));
  check('home: difficulty filter', visible.length === CATALOG.games.filter((g) => g.difficulty === 'Hard').length, visible.join(', '));
  await page.fill('#search', 'zzzz-no-such-game');
  check('home: "no games match" message', await page.isVisible('#empty'));
  await page.fill('#search', '');
  await page.selectOption('#difficulty', '');
  await page.locator('#grid .card', { has: page.locator('.card-title', { hasText: 'Chess' }) }).locator('.fav').click();
  await page.locator('#grid .card', { has: page.locator('.card-title', { hasText: 'Polytrack' }) }).locator('.fav').click();
  const favs = await page.$$eval('#favGrid .card-title', (n) => n.map((x) => x.textContent));
  check('home: favourites', favs.join(',') === 'Chess,Polytrack' && await page.isVisible('#favSection'), favs.join(', '));
  await page.locator('#favGrid .card', { has: page.locator('.card-title', { hasText: 'Chess' }) }).locator('.fav').click();
  check('home: un-starring removes a favourite', (await page.$$eval('#favGrid .card-title', (n) => n.length)) === 1);
  check('boot: nothing requested from ftgames.xyz', stats.site.length === 0, stats.site.slice(0, 3).join(', '));
  check('boot: no errors in the arcade page', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ every game
async function homeElement(frame) {
  return frame.evaluate(() => {
    const el = document.getElementById('homeButton') || document.querySelector('a[href*="ftgames.xyz/games"], a[href="/games"], a[href="/"]');
    if (!el) return null;
    el.setAttribute('data-test-home', '1');
    return true;
  }).catch(() => null);
}

async function playGame(page, g, problems) {
  const info = {};
  const t0 = Date.now();
  await clickCard(page, g.title);
  if (g.kind === 'external') return info;
  try {
    await waitView(page, 'game', REAL ? 300000 : 120000);
  } catch (e) {
    info.error = 'never reached the game: ' + (await page.textContent('#ldStatus')) + ' ' + (await page.textContent('#ldDetail'));
    return info;
  }
  info.ms = Date.now() - t0;
  const frame = await gameFrame(page);
  if (!frame) {
    info.error = 'no game frame';
    return info;
  }
  if (g.kind === 'makecode') {
    info.url = frame.url() === g.url;
    info.running = await frame.evaluate(() => !!document.getElementById('stub')).catch(() => false);
  } else {
    const doc = await frame.evaluate(() => ({ url: location.href, base: document.baseURI, shim: !!window.__hazeShimmed })).catch((e) => ({ err: e.message }));
    const dir = REPO + '/' + g.file.replace(/[^/]*$/, '');
    info.url = doc.url === 'about:srcdoc' && doc.base === dir && doc.shim;
    if (!info.url) info.doc = doc;
    if (g.tw) {
      info.project = await frame.evaluate(() => document.getElementById('loading').hidden && document.getElementById('error').hidden);
      if (await frame.evaluate(() => !document.getElementById('launch').hidden)) await frame.click('#launch', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      info.running = await frame.evaluate(() => !!(window.vm && window.vm.runtime) && document.getElementById('launch').hidden && document.getElementById('error').hidden);
    } else if (g.id === 'polytrack') {
      info.running = await frame.evaluate(() => !!document.querySelector('.menu-ui') && !document.querySelector('.menu-ui.loading-screen') && !/unexpected error/i.test(document.body.innerText));
    } else if (g.id === 'chess') {
      info.running = await frame.evaluate(() => document.querySelectorAll('#app *').length > 20);
    } else if (g.id === 'idle-gacha-roller') {
      info.running = await frame.evaluate(() => /Money/.test(document.body.innerText));
    } else if (g.id === 'minecraft-classic') {
      info.running = await frame.isVisible('#promptOverlay');
    } else if (g.id === '2d-platformer') {
      info.running = await frame.evaluate(() => Array.from(document.images).filter((i) => /step\d\.png$/.test(i.src)).every((i) => i.complete && i.naturalWidth > 0) && document.images.length >= 2);
    } else if (g.id === 'suggestion-box') {
      info.running = await frame.evaluate(() => !!document.querySelector('iframe[src*="forms.office.com"]'));
    } else {
      info.running = await frame.evaluate(() => document.readyState === 'complete');
    }
  }
  await shot(page, 'game-' + g.id);
  if (g.instructions) {
    await frame.click('#instructionsButton', { timeout: 5000 });
    await page.waitForFunction(() => !document.getElementById('instr').hidden && document.getElementById('instrWait').hidden, null, { timeout: 60000 }).catch(() => {});
    const instr = await frameIn(page, 'instrHost');
    const text = instr ? await instr.evaluate(() => ({ base: document.baseURI, len: document.body.innerText.trim().length, broken: Array.from(document.images).filter((i) => !i.complete || !i.naturalWidth).map((i) => i.src) })).catch(() => null) : null;
    info.instructions = !!text && text.len > 20 && text.base === REPO + '/' + g.instructions.replace(/[^/]*$/, '') && text.broken.length === 0;
    if (!info.instructions) info.instrDetail = text;
    await shot(page, 'instructions-' + g.id);
    await page.click('#instrClose');
    info.instructionsClosed = await page.isHidden('#instr');
  }
  if (g.tabButton) {
    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    const visible = await page.isVisible('#tabBtn');
    if (visible) await page.click('#tabBtn');
    const popup = await popupPromise;
    info.tab = visible && !!popup;
    if (popup) await popup.close();
    problems.popups.splice(0);
  }
  const t1 = Date.now();
  if (g.kind !== 'makecode' && await homeElement(frame)) {
    info.homeOwn = true;
    info.overlayHidden = await page.isHidden('#homeBtn');
    await frame.click('[data-test-home]');
  } else {
    info.homeOwn = false;
    await page.click('#homeBtn');
  }
  try {
    await waitView(page, 'home', 30000);
    info.home = !(await gameFrame(page));
  } catch (e) {
    info.home = false;
  }
  info.backMs = Date.now() - t1;
  return info;
}

async function suiteGames() {
  const { context, page, stats, problems } = await openArcade(FAST_PAGE);
  await waitView(page, 'home', 60000);
  for (const g of CATALOG.games.filter((x) => !ONLY || ONLY.includes(x.id))) {
    problems.frameErrors.splice(0);
    const info = await playGame(page, g, problems);
    const ok = !info.error && info.url && info.running && info.home && (!g.tw || info.project) &&
      info.instructions !== false && info.instructionsClosed !== false && info.tab !== false && info.overlayHidden !== false;
    const detail = { ms: info.ms, url: info.url, running: info.running, project: info.project, instructions: info.instructions, tab: info.tab, home: info.home, own: info.homeOwn, err: info.error, doc: info.doc, instr: info.instrDetail };
    if (problems.frameErrors.length) detail.frameErrors = problems.frameErrors.slice(0, 3);
    check(`game: ${g.title}`, ok, JSON.stringify(detail));
  }
  check('games: nothing requested from ftgames.xyz', stats.site.length === 0, stats.site.slice(0, 5).join(', '));
  check('games: no errors in the arcade page', problems.errors.length === 0, problems.errors.join(' | '));
  check('games: every file asked of GitHub exists', stats.notFound.length === 0, stats.notFound.slice(0, 5).join(', '));
  await context.close();
}

// ------------------------------------------------------------------ navigation, timing and special cases
async function suiteNav() {
  const { context, page, stats, problems } = await openArcade(PAGE);
  await waitView(page, 'home', 60000);

  // Loading screen: keeps loading 3 s after the game has loaded.
  await clickCard(page, 'Minesweeper');
  await page.waitForTimeout(300);
  check('game load: loading screen names the game', (await page.textContent('#ldTitle')) === 'MINESWEEPER');
  await shot(page, '03-loading-a-game');
  let readyAt = null;
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const f = await gameFrame(page);
    if (f) {
      const done = await f.evaluate(() => { const l = document.getElementById('loading'); return !!l && l.hidden; }).catch(() => false);
      if (done) {
        readyAt = await page.evaluate(() => performance.now());
        break;
      }
    }
    await page.waitForTimeout(40);
  }
  await waitView(page, 'game', 60000);
  let tl = await timeline(page);
  checkFinish('game load: keeps loading 3 s after the game has loaded, bar still filling', tl, readyAt || 0);
  const statuses = statusesSeen(tl);
  check('game load: the screen only ever says LOADING...', statuses.every((s) => s === 'LOADING...'), statuses.join(' | '));

  // The game's own Home button.
  let frame = await gameFrame(page);
  const mark = await page.evaluate(() => performance.now());
  await frame.click('#homeButton');
  await waitView(page, 'home', 30000);
  tl = await timeline(page);
  const homeFill = tl.find((e) => e.type === 'fill' && e.t > mark && e.value >= 79.9);
  checkFinish('back to games: keeps loading 3 s too', tl, homeFill ? homeFill.t : mark);
  check('back to games: the game is gone', !(await gameFrame(page)));

  // A game leaving its page some other way (not caught by the compatibility layer): no network trip either way.
  await clickCard(page, 'Retro Pong');
  await waitView(page, 'game', 120000);
  frame = await gameFrame(page);
  await frame.evaluate(() => { setTimeout(() => location.replace('https://example.org/'), 0); });
  await waitView(page, 'home', 30000).then(() => check('game: leaving the page any other way also comes back to the games page', true), () => check('game: leaving the page any other way also comes back to the games page', false));

  // crypto.subtle.digest is only on secure pages; the compatibility layer's SHA-256 must match the real one.
  await clickCard(page, 'Retro Pong');
  await waitView(page, 'game', 120000);
  frame = await gameFrame(page);
  const sample = (n) => Array.from({ length: n }, (_, i) => (i * 7 + 13) % 251);
  const digests = await frame.evaluate(async (lengths) => {
    const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
    const out = [];
    for (const n of lengths) {
      const data = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7 + 13) % 251));
      out.push(hex(await crypto.subtle.digest('SHA-256', data)));
    }
    out.push(hex(await crypto.subtle.digest({ name: 'SHA-256' }, new Float32Array([1.5, -2, 3.25]).buffer)));
    return { out, secure: isSecureContext };
  }, [0, 3, 55, 56, 64, 1000, 100003]);
  const nodeCrypto = require('crypto');
  const expected = [0, 3, 55, 56, 64, 1000, 100003].map((n) => nodeCrypto.createHash('sha256').update(Buffer.from(sample(n))).digest('hex'));
  expected.push(nodeCrypto.createHash('sha256').update(Buffer.from(new Float32Array([1.5, -2, 3.25]).buffer)).digest('hex'));
  check('compatibility: SHA-256 stand-in matches the real thing', JSON.stringify(digests.out) === JSON.stringify(expected), `${digests.out.length} digests, secure page: ${digests.secure}`);
  // A link to another website inside a game opens in a new tab and the game stays.
  const linkPopup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await frame.evaluate(() => { const a = document.createElement('a'); a.href = 'https://example.org/'; a.textContent = 'x'; a.id = 'testExternal'; a.style.cssText = 'position:fixed;left:200px;top:200px;z-index:99999999'; document.body.append(a); });
  await frame.click('#testExternal');
  const linkTab = await linkPopup;
  await page.waitForTimeout(300);
  check('links: another website opens in a new tab, the game stays', !!linkTab && (await state(page)).view === 'game', linkTab && linkTab.url());
  if (linkTab) await linkTab.close();
  await frame.click('#homeButton');
  await waitView(page, 'home', 30000);

  // A game reloading itself stays (Idle Gacha's reset does location.reload()).
  await clickCard(page, 'Idle Gacha Roller');
  await waitView(page, 'game', 120000);
  frame = await gameFrame(page);
  await frame.evaluate(() => location.reload());
  await page.waitForTimeout(2500);
  frame = await gameFrame(page);
  const reloaded = frame && await frame.evaluate(() => !!window.__hazeShimmed && /Money/.test(document.body.innerText)).catch(() => false);
  check('game: a game reloading itself stays in the game', (await state(page)).view === 'game' && reloaded);
  // Idle Gacha's "Export save" downloads a file with a link click; that must not leave the game.
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await frame.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /export/i.test(x.textContent)); if (b) b.click(); else throw new Error('no export button'); }).catch((e) => console.log('   (export button: ' + e.message + ')'));
  const download = await downloadPromise;
  await page.waitForTimeout(500);
  check('idle gacha: Export save downloads the save and stays in the game', !!download && (await state(page)).view === 'game', download ? download.suggestedFilename() : 'no download');
  // Saves survive going home and back (storage kept for the session).
  frame = await gameFrame(page);
  if (frame) {
    await frame.evaluate(() => localStorage.setItem('hazeTestKey', 'kept'));
    await frame.click('#homeButton');
    await waitView(page, 'home', 30000);
  } else {
    await waitView(page, 'home', 30000).catch(() => {});
  }
  await clickCard(page, 'Idle Gacha Roller');
  await waitView(page, 'game', 120000);
  frame = await gameFrame(page);
  check('storage: a game\'s saves last for the session', (await frame.evaluate(() => localStorage.getItem('hazeTestKey'))) === 'kept');
  await frame.click('#homeButton');
  await waitView(page, 'home', 30000);

  // Minecraft Classic's buttons.
  await clickCard(page, 'Minecraft Classic');
  await waitView(page, 'game', 120000);
  frame = await gameFrame(page);
  await frame.click('#cancelBtn');
  await waitView(page, 'home', 30000).then(() => check('minecraft: "Back to safety" returns to the games page', true), () => check('minecraft: "Back to safety" returns to the games page', false));
  await clickCard(page, 'Minecraft Classic');
  await waitView(page, 'game', 120000);
  frame = await gameFrame(page);
  await frame.click('#okBtn');
  await page.waitForTimeout(800);
  check('minecraft: "Continue" loads classic.minecraft.net inside the game', await frame.evaluate(() => /^https:\/\/classic\.minecraft\.net\/?$/.test(document.getElementById('gameFrame').src)));
  await frame.click('#homeButton');
  await waitView(page, 'home', 30000);

  // 2D Platformer: PLAY opens Google's game in a new window (a PhantomHaze tab).
  await clickCard(page, '2D Platformer');
  await waitView(page, 'game', 120000);
  frame = await gameFrame(page);
  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await frame.click('a.play-button');
  const popup = await popupPromise;
  check('2d platformer: PLAY opens a new window (a PhantomHaze tab)', !!popup && (await state(page)).view === 'game', popup && popup.url());
  if (popup) await popup.close();
  await frame.click('#homeButton');
  await waitView(page, 'home', 30000);

  // Retro Pong's Instructions button does nothing on the site; here it opens the instructions.
  await clickCard(page, 'Retro Pong');
  await waitView(page, 'game', 120000);
  frame = await gameFrame(page);
  await frame.click('#instructionsButton');
  await page.waitForFunction(() => document.getElementById('instrWait').hidden, null, { timeout: 30000 }).catch(() => {});
  check('retro pong: Instructions opens its instructions page', !!(await frameIn(page, 'instrHost')));
  await page.keyboard.press('Escape');
  check('instructions: Escape closes the panel', await page.isHidden('#instr'));
  await frame.click('#homeButton');
  await waitView(page, 'home', 30000);

  // Polytrack: start a race (physics worker, WebAssembly, WebGL textures from GitHub).
  await clickCard(page, 'Polytrack');
  await waitView(page, 'game', 240000);
  frame = await gameFrame(page);
  await frame.getByText('Play', { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
  const track = await frame.getByText('Summer 1', { exact: true }).first().click({ timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(1500);
  await page.mouse.click(975, 665); // the track's Play button
  await page.waitForTimeout(3000);
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(3000);
  await page.keyboard.up('ArrowUp');
  await shot(page, '04-polytrack-race');
  const race = await frame.evaluate(() => ({ error: /unexpected error/i.test(document.body.innerText), hud: /km\/h/.test(document.body.innerText) }));
  check('polytrack: a race runs (physics worker, WebAssembly, textures)', track && race.hud && !race.error, JSON.stringify(race));
  await frame.click('#homeButton');
  await waitView(page, 'home', 30000);

  // Cancelling a game that is still loading.
  await clickCard(page, 'Brain Test');
  await page.waitForTimeout(500);
  await page.click('#ldBack');
  await waitView(page, 'home', 30000);
  check('loading: "Back to games" cancels a game that is still loading', !(await gameFrame(page)));
  check('nav: nothing requested from ftgames.xyz', stats.site.length === 0, stats.site.slice(0, 5).join(', '));
  check('nav: no errors in the arcade page', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ games added to the repository later
async function suiteLive() {
  if (REAL) return;
  const gamesHtml = fs.readFileSync(path.join(FTGAMES, 'games.html'), 'utf8').replace(
    '<a class="game-card" href="/suggestion_box">',
    '<a class="game-card" href="/frogger"><img class="game-card-thumbnail" src="thumbnails/does-not-exist.png" alt="x"><div class="game-card-content"><h2 class="game-card-title">Frogger (new)</h2><p class="game-card-description">A brand new game.</p><div class="game-card-tags"><span class="game-tag game-tag-genre">Genre: Arcade</span><span class="game-tag game-tag-difficulty">Difficulty: Easy</span></div></div></a>\n' +
    '<a class="game-card" href="/farming_sim_19/index"><img class="game-card-thumbnail" src="thumbnails/tetris-thumbnail.png" alt="x"><div class="game-card-content"><h2 class="game-card-title">Farm Copy (new)</h2><p class="game-card-description">No Home button.</p></div></a>\n' +
    '<a class="game-card" href="/suggestion_box">');
  const { context, page, stats, problems } = await openArcade(FAST_PAGE, { gamesHtml });
  await waitView(page, 'home', 60000);
  const titles = await page.$$eval('#grid .card-title', (n) => n.map((x) => x.textContent));
  check('live list: a game added to the repository shows up without updating the extension', titles.includes('Frogger (new)'), `${titles.length} cards`);
  check('live list: a missing thumbnail falls back to a drawn card', (await page.locator('#grid .card', { has: page.locator('.card-title', { hasText: 'Frogger (new)' }) }).locator('.ph').count()) === 1);
  check('live list: a new card\'s thumbnail loads from GitHub', await page.locator('#grid .card', { has: page.locator('.card-title', { hasText: 'Farm Copy (new)' }) }).locator('img').evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false));
  // Frogger is in the repository but not on the site, and its page has no Home button of its own.
  await clickCard(page, 'Frogger (new)');
  await waitView(page, 'game', 120000);
  const frame = await gameFrame(page);
  check('live list: the new game plays', await frame.evaluate(() => document.getElementById('loading').hidden && document.getElementById('error').hidden));
  const froggerHome = await page.isVisible('#homeBtn');
  check('live list: a new game without a Home button of its own gets the arcade\'s (Frogger)', froggerHome);
  if (froggerHome) await page.click('#homeBtn');
  await waitView(page, 'home', 30000);
  // A new game without a Home button of its own still gets the arcade's.
  await clickCard(page, 'Farm Copy (new)');
  await waitView(page, 'game', 120000);
  const overlay = await page.isVisible('#homeBtn');
  check('live list: a new game without a Home button gets the arcade\'s (Farming Sim page)', overlay);
  if (overlay) await page.click('#homeBtn');
  await waitView(page, 'home', 30000).catch(() => {});
  check('live list: no errors', problems.errors.length === 0, problems.errors.join(' | '));
  check('live list: nothing requested from ftgames.xyz', stats.site.length === 0);
  await context.close();
}

// ------------------------------------------------------------------ no internet
async function suiteOffline() {
  if (REAL) return;
  const { context, page, problems } = await openArcade(FAST_PAGE, { offline: true });
  await waitView(page, 'home', 60000);
  check('offline: the games page still opens from the built-in list', (await page.$$eval('#grid .card', (n) => n.length)) === CATALOG.games.length);
  check('offline: the page explains that games need the internet', await page.isVisible('#notice'), await page.textContent('#notice'));
  await clickCard(page, 'Tetris');
  await page.waitForFunction(() => document.getElementById('ldStatus').classList.contains('error'), null, { timeout: 60000 });
  check('offline: launching a game says it can\'t reach GitHub, with Retry and Back', (await page.textContent('#ldStatus')).includes("CAN'T REACH GITHUB") && await page.isVisible('#ldRetry') && await page.isVisible('#ldBack'));
  await shot(page, '05-offline-game');
  await page.click('#ldBack');
  await waitView(page, 'home', 30000);
  check('offline: Back returns to the games page', !(await gameFrame(page)));
  check('offline: no errors in the arcade page', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

(async () => {
  browser = await chromium.launch(REAL ? { proxy: { server: process.env.HTTPS_PROXY } } : {});
  const suites = { boot: suiteBoot, games: suiteGames, nav: suiteNav, live: suiteLive, offline: suiteOffline };
  for (const name of SUITES) {
    console.log(`\n== ${name}${REAL ? ' (real GitHub)' : ''}`);
    try {
      await suites[name]();
    } catch (error) {
      check(`suite ${name} crashed`, false, String(error.stack || error).split('\n').slice(0, 4).join(' / '));
    }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();

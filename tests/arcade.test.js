// End-to-end tests for the Haze Arcade page, run the way PhantomHaze shows it: the page HTML is opened as a
// data: URL (WebView2's NavigateToString gives the same opaque origin), and https://ftgames.xyz is served from a
// local checkout of the FT Games site (see ftmock.js).
//
//   node tests/arcade.test.js --ftgames ../ftgames --page out/page-arcade.html [--fast-page out/fast.html]
//                             [--suite boot,games,nav,live,offline,settings,speed] [--only tetris,chess] [--shots dir]
//
// --page should be the page PhantomHaze would render (tests/phext-check writes it from the .phext);
// --fast-page is the same page built with a 1 second hold, used for the long per-game run.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { install } = require('./ftmock');

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return pairs;
}, []));
const FTGAMES = path.resolve(args.ftgames || '../ftgames');
const PAGE = fs.readFileSync(args.page, 'utf8');
const FAST_PAGE = args['fast-page'] ? fs.readFileSync(args['fast-page'], 'utf8') : null;
const TAB_SCRIPT = args['tab-script'] ? fs.readFileSync(args['tab-script'], 'utf8') : null;
const SUITES = (args.suite || 'boot,games,nav,live,offline,settings,tab').split(',');
const ONLY = args.only ? args.only.split(',') : null;
const SHOTS = args.shots ? path.resolve(args.shots) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const CATALOG = JSON.parse(PAGE.match(/<script type="application\/json" id="catalog">([\s\S]*?)<\/script>/)[1].replace(/<\\\//g, '</'));
const SERVER = 'https://ftgames.xyz';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

// Records what the loading screen does, with timestamps, so hold times can be measured exactly.
function timelineScript() {
  if (window.top !== window) return;
  window.__timeline = [];
  const rec = (type, value) => window.__timeline.push({ t: performance.now(), type, value });
  document.addEventListener('DOMContentLoaded', () => {
    const loader = document.getElementById('loader');
    const status = document.getElementById('ldStatus');
    if (!loader || !status) return;
    new MutationObserver(() => rec('loader', loader.classList.contains('out') ? 'out' : 'in')).observe(loader, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => rec('status', status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
  });
  document.addEventListener('load', (event) => {
    if (event.target && event.target.tagName === 'IFRAME') rec('frameload', event.target.src);
  }, true);
}

async function openArcade(browser, html, mockOptions = {}, contextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 720 }, ...contextOptions });
  const stats = await install(context, FTGAMES, mockOptions);
  if (mockOptions.gamesHtml) {
    await context.route(/^https:\/\/ftgames\.xyz\/games(\.html)?$/, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html', 'access-control-allow-origin': '*' }, body: mockOptions.gamesHtml }));
  }
  await context.addInitScript(timelineScript);
  const page = await context.newPage();
  const problems = { errors: [], popups: [] };
  page.on('pageerror', (error) => problems.errors.push(String(error).slice(0, 200)));
  page.on('popup', (popup) => problems.popups.push(popup.url()));
  page.on('console', (msg) => {
    // Only the arcade page itself; blocked frame navigations and failed requests are expected in some tests.
    const fromArcade = (msg.location().url || '').startsWith('data:');
    const expected = /violates the following Content Security Policy directive: "frame-src|Failed to load resource/.test(msg.text());
    if (msg.type() === 'error' && fromArcade && !expected) problems.errors.push('console: ' + msg.text().slice(0, 200));
  });
  await page.goto('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  return { context, page, stats, problems };
}

const state = (page) => page.evaluate(() => window.__hazeArcade.state());
const timeline = (page) => page.evaluate(() => window.__timeline.slice());
const waitView = (page, view, timeout = 60000) => page.waitForFunction((v) => window.__hazeArcade && window.__hazeArcade.state().view === v, view, { timeout });
const loaderShown = (page) => page.evaluate(() => !document.getElementById('loader').classList.contains('out'));
// The frame of the iframe that sits in the game player (#frameHost), if there is one.
async function gameFrame(page) {
  for (const f of page.mainFrame().childFrames()) {
    try {
      const handle = await f.frameElement();
      if (await handle.evaluate((e) => !!e.parentElement && e.parentElement.id === 'frameHost')) return f;
    } catch (e) { /* detached */ }
  }
  return null;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

async function clickCard(page, title) {
  const card = page.locator('#grid .card', { has: page.locator('.card-title', { hasText: title }) }).first();
  await card.locator('.play').click();
}

function holdAfter(tl, fromType, matcher, after = -1) {
  const from = tl.find((e) => e.t > after && e.type === fromType && (!matcher || matcher(e.value)));
  const out = from && tl.find((e) => e.type === 'loader' && e.value === 'out' && e.t > from.t);
  return from && out ? out.t - from.t : null;
}

// ------------------------------------------------------------------ boot: the games page and its loading screen
async function suiteBoot(browser) {
  const { context, page, stats, problems } = await openArcade(browser, PAGE);
  await page.waitForTimeout(1200);
  check('boot: loading screen is up while the games page loads', await loaderShown(page));
  const logo = await page.evaluate(() => [document.querySelector('.ld-haze').textContent, document.querySelector('.ld-arcade').textContent].join(' '));
  check('boot: loading screen says "HAZE ARCADE"', logo === 'HAZE ARCADE', logo);
  const fonts = await page.evaluate(() => document.fonts.check('40px HazeNeon') && document.fonts.check('16px HazePixel'));
  check('boot: neon and pixel fonts are embedded and loaded', fonts);
  await shot(page, '01-loading-screen');
  await waitView(page, 'home', 40000);
  const tl = await timeline(page);
  const ready = tl.find((e) => e.type === 'status' && /GET READY/.test(e.value));
  const out = tl.find((e) => e.type === 'loader' && e.value === 'out');
  const held = ready && out ? out.t - ready.t : -1;
  check('boot: loading screen stays 5 s after everything has loaded', held >= 4950 && held < 6000, `held ${Math.round(held)} ms`);
  const imagesDone = await page.evaluate(() => Array.from(document.querySelectorAll('#grid img')).every((img) => img.complete && img.naturalWidth > 0));
  check('boot: every thumbnail had loaded before the reveal', imagesDone);
  check('boot: checked ftgames.xyz for new games', stats.requests.some((r) => r.path === '/games.html'));
  const cards = await page.$$eval('#grid .card', (nodes) => nodes.map((n) => n.querySelector('.card-title').textContent));
  const expected = CATALOG.games.map((g) => g.title);
  check('home: shows every card of the FT Games games page, in order', JSON.stringify(cards) === JSON.stringify(expected), `${cards.length} cards`);
  const count = await page.textContent('#count');
  check('home: game count excludes the suggestion box', count === `(${expected.length - 1})`, count);
  await page.waitForTimeout(500);
  await shot(page, '02-games-page');

  await page.fill('#search', 'tetris');
  let visible = await page.$$eval('#grid .card:not([hidden]) .card-title', (n) => n.map((x) => x.textContent));
  check('home: search filters the games', visible.length === 1 && visible[0] === 'Tetris', visible.join(', '));
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
  check('home: favourites section lists starred games', favs.join(',') === 'Chess,Polytrack' && await page.isVisible('#favSection'), favs.join(', '));
  await page.locator('#favGrid .card', { has: page.locator('.card-title', { hasText: 'Chess' }) }).locator('.fav').click();
  check('home: un-starring removes a favourite', (await page.$$eval('#favGrid .card-title', (n) => n.length)) === 1);
  await page.waitForTimeout(400);
  await shot(page, '03-favourites');
  check('boot: no page errors', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ every game
// What PhantomHaze does with a tab the arcade opens: load the page, then run the extension's web.script in it.
async function runTab(popup, g) {
  const info = {};
  await popup.waitForLoadState('load');
  info.secure = await popup.evaluate(() => isSecureContext);
  if (TAB_SCRIPT) {
    info.injected = (await popup.evaluate((code) => (0, eval)(code), TAB_SCRIPT)) !== null;
    await popup.waitForTimeout(400);
    info.overlay = await popup.evaluate(() => !!document.getElementById('haze-arcade-tab-loader'));
    info.hashRemoved = !(await popup.evaluate(() => location.hash));
    await shot(popup, 'tab-loading-' + g.id);
    const t0 = Date.now();
    await popup.waitForFunction(() => !document.getElementById('haze-arcade-tab-loader'), null, { timeout: 90000 });
    info.overlayMs = Date.now() - t0;
  }
  if (g.id === 'polytrack') {
    info.running = await popup.evaluate(() => !!document.querySelector('.menu-ui') && !document.querySelector('.menu-ui.loading-screen') && !/unexpected error/i.test(document.body.innerText));
  }
  await shot(popup, 'tab-' + g.id);
  return info;
}

async function playGame(page, g, problems) {
  const info = { id: g.id, title: g.title };
  const t0 = Date.now();
  if (g.open === 'tab') {
    const popupPromise = page.waitForEvent('popup', { timeout: 10000 });
    await clickCard(page, g.title);
    const popup = await popupPromise;
    info.frameUrl = popup.url();
    info.urlOk = popup.url() === SERVER + g.url + '#haze-arcade';
    Object.assign(info, await runTab(popup, g));
    info.toast = await page.isVisible('#toast');
    info.stayedHome = (await state(page)).view === 'home';
    info.frameRemoved = true;
    await popup.close();
    problems.popups.splice(0);
    return info;
  }
  await clickCard(page, g.title);
  await page.waitForTimeout(300);
  const nowTitle = await page.textContent('#ldTitle');
  info.loaderTitle = nowTitle;
  try {
    await waitView(page, 'game', 90000);
  } catch (e) {
    info.error = 'never reached the game view: ' + (await page.textContent('#ldStatus'));
    return info;
  }
  info.revealMs = Date.now() - t0;
  const frame = (await gameFrame(page));
  info.frameUrl = frame && frame.url();
  const expectedUrl = g.kind === 'makecode' ? g.url : SERVER + g.url;
  info.urlOk = info.frameUrl === expectedUrl;

  if (g.lazyBytes) {
    // TurboWarp-packaged Scratch game: wait until the project has loaded, then press the green flag screen.
    try {
      await frame.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 30000 });
      info.projectLoaded = await frame.evaluate(() => document.getElementById('error').hidden === true);
      // Some games start by themselves; the others wait on TurboWarp's green flag screen.
      if (await frame.evaluate(() => !document.getElementById('launch').hidden)) await frame.click('#launch', { timeout: 5000 });
      await page.waitForTimeout(1500);
      info.running = await frame.evaluate(() => !!(window.vm && window.vm.runtime && document.getElementById('launch').hidden && document.getElementById('error').hidden));
    } catch (e) {
      info.error = 'scratch: ' + e.message.split('\n')[0];
    }
  } else if (g.id === 'polytrack') {
    await page.waitForTimeout(6000);
    info.running = await frame.evaluate(() => !!document.querySelector('#screen') && !document.querySelector('.error-screen, #error-screen'));
  } else if (g.id === 'chess') {
    info.running = await frame.evaluate(() => document.querySelectorAll('#app *').length > 20);
  } else if (g.id === 'idle-gacha-roller') {
    info.running = await frame.evaluate(() => document.body.innerText.length > 100);
  } else if (g.kind === 'makecode') {
    info.running = await frame.evaluate(() => !!document.getElementById('stub'));
  } else {
    info.running = await frame.evaluate(() => document.readyState === 'complete' && document.body.children.length > 0);
  }

  // The arcade's copies of the page's Home / Instructions buttons must sit exactly on top of the originals.
  if (g.buttons && g.buttons.home) {
    const rects = await frame.evaluate(() => {
      const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); };
      return { home: r('homeButton'), instr: r('instructionsButton'), scroll: document.documentElement.scrollHeight > innerHeight };
    });
    const mine = await page.evaluate(() => {
      const r = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); };
      return { home: r('homeBtn'), instr: r('instrBtn') };
    });
    const covers = (a, b) => a && b && a[0] <= b[0] && a[1] <= b[1] && a[0] + a[2] >= b[0] + b[2] && a[1] + a[3] >= b[1] + b[3];
    info.homeCovered = covers(mine.home, rects.home);
    info.instrCovered = rects.instr ? covers(mine.instr, rects.instr) : null;
    info.rects = { theirs: rects, mine };
  }
  if (g.tabButton) {
    const r = await page.evaluate(() => ['homeBtn', 'tabBtn'].map((id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return e.hidden ? null : [b.left, b.right]; }));
    info.tabButton = !!r[1] && r[1][1] <= r[0][0] - 4;
    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    await page.click('#tabBtn');
    const popup = await popupPromise;
    info.tabButton = info.tabButton && !!popup;
    if (popup) await popup.close();
    problems.popups.splice(0);
  }
  await shot(page, 'game-' + g.id);
  if (g.instructions) {
    await page.click('#instrBtn');
    await page.waitForTimeout(1200);
    const instr = page.frames().find((f) => f.url() === SERVER + g.instructions);
    info.instructions = !!instr && (await instr.evaluate(() => document.body.innerText.trim().length)) > 20;
    await shot(page, 'instructions-' + g.id);
    await page.click('#instrClose');
    info.instructionsClosed = await page.isHidden('#instr');
  }
  const t1 = Date.now();
  await page.click('#homeBtn');
  await waitView(page, 'home', 30000);
  info.backMs = Date.now() - t1;
  info.frameRemoved = !(await gameFrame(page));
  info.errors = problems.errors.splice(0);
  return info;
}

async function suiteGames(browser) {
  const html = FAST_PAGE || PAGE;
  const { context, page, problems } = await openArcade(browser, html);
  await waitView(page, 'home', 40000);
  const games = CATALOG.games.filter((g) => !ONLY || ONLY.includes(g.id));
  for (const g of games) {
    const info = await playGame(page, g, problems);
    const ok = !info.error && info.urlOk && info.running !== false && info.homeCovered !== false && info.instrCovered !== false &&
      info.instructions !== false && info.frameRemoved && (g.lazyBytes ? info.projectLoaded : true) && info.tabButton !== false &&
      (g.open !== 'tab' || (info.secure && info.toast && info.stayedHome && (!TAB_SCRIPT || (info.overlay && info.hashRemoved))));
    check(`game: ${g.title}${g.open === 'tab' ? ' (opens in a PhantomHaze tab)' : ''}`, ok, JSON.stringify({ reveal: info.revealMs, url: info.urlOk, running: info.running, project: info.projectLoaded, home: info.homeCovered, instr: info.instrCovered, instructions: info.instructions, tabBtn: info.tabButton, back: info.backMs, secure: info.secure, overlay: info.overlay, overlayMs: info.overlayMs, err: info.error, rects: (info.homeCovered === false || info.instrCovered === false) ? info.rects : undefined }));
  }
  check('games: no errors in the arcade page', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ navigation rules inside games
async function suiteNav(browser) {
  const { context, page, problems } = await openArcade(browser, PAGE);
  await waitView(page, 'home', 40000);

  // 1. Loading screen hold after a game has loaded (real 5 s setting).
  await clickCard(page, 'Minesweeper');
  await page.waitForTimeout(400);
  check('game load: loading screen shows the game name', (await page.textContent('#ldTitle')) === 'MINESWEEPER');
  await shot(page, '04-loading-a-game');
  await waitView(page, 'game', 60000);
  let tl = await timeline(page);
  const loadedAt = tl.find((e) => e.type === 'frameload' && e.value.endsWith('/minesweeper/'));
  const held = holdAfter(tl, 'status', (v) => /GET READY\s+5/.test(v), loadedAt ? loadedAt.t : -1);
  const sinceLoad = holdAfter(tl, 'frameload', (v) => v.endsWith('/minesweeper/'));
  check('game load: loading screen stays 5 s after the game has loaded', held >= 4950 && held < 6000 && sinceLoad >= held, `hold ${Math.round(held)} ms, since frame load ${Math.round(sinceLoad)} ms`);
  const hit = await page.evaluate(() => { const b = document.getElementById('homeBtn').getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return e && e.id; });
  check('game: the arcade Home button is what gets clicked at the game\'s Home spot', hit === 'homeBtn', hit);

  // 2. The game page's own Home link (as if clicked in full screen) is caught and brings the player back.
  let frame = (await gameFrame(page));
  await frame.evaluate(() => document.getElementById('homeButton').click());
  await page.waitForTimeout(700);
  check('game: the page\'s own Home link goes back to the games page, not ftgames.xyz', (await state(page)).view !== 'game' && await loaderShown(page));
  await waitView(page, 'home', 30000);
  check('game: back on the games page, game frame removed', !(await gameFrame(page)));
  tl = await timeline(page);
  const homeHold = tl.filter((e) => e.type === 'status' && /GET READY\s+5/.test(e.value)).pop();
  const homeOut = homeHold && tl.find((e) => e.type === 'loader' && e.value === 'out' && e.t > homeHold.t);
  check('back to games: loading screen holds 5 s again', homeOut && homeOut.t - homeHold.t >= 4950, homeOut ? `${Math.round(homeOut.t - homeHold.t)} ms` : 'no hold');

  // 3. A game reloading itself is fine (Idle Gacha resets with location.reload()).
  await clickCard(page, 'Idle Gacha Roller');
  await waitView(page, 'game', 60000);
  frame = (await gameFrame(page));
  await frame.evaluate(() => location.reload());
  await page.waitForTimeout(2500);
  check('game: a game reloading itself stays in the game', (await state(page)).view === 'game' && (await gameFrame(page)) && (await gameFrame(page)).url().endsWith('/idle_gacha_roller/'));
  await page.click('#homeBtn');
  await waitView(page, 'home', 30000);

  // 4. Minecraft Classic's "Back to safety" leaves the wrapper page: the arcade takes the player home.
  await clickCard(page, 'Minecraft Classic');
  await waitView(page, 'game', 60000);
  frame = (await gameFrame(page));
  check('minecraft: privacy notice from the FT Games page is shown', await frame.isVisible('#promptOverlay'));
  await frame.click('#cancelBtn');
  await page.waitForTimeout(700);
  check('minecraft: "Back to safety" returns to the arcade games page', (await state(page)).view !== 'game');
  await waitView(page, 'home', 30000);
  await clickCard(page, 'Minecraft Classic');
  await waitView(page, 'game', 60000);
  frame = (await gameFrame(page));
  await frame.click('#okBtn');
  await page.waitForTimeout(1000);
  const inner = page.frames().find((f) => f.parentFrame() === frame);
  check('minecraft: "Continue" loads classic.minecraft.net inside the game', !!inner && /classic\.minecraft\.net|chrome-error/.test(inner.url()), inner && inner.url());
  await page.click('#homeBtn');
  await waitView(page, 'home', 30000);

  // 5. The 2D Platformer card is FT Games' how-to page; its PLAY link opens Google's game as a new window,
  //    which PhantomHaze turns into a new protected tab.
  await clickCard(page, '2D Platformer');
  await waitView(page, 'game', 60000);
  frame = (await gameFrame(page));
  // FT Games' analytics consent bar sits over the bottom of the page until it is answered, as on the site.
  if (await frame.isVisible('#ga-consent-decline')) await frame.click('#ga-consent-decline');
  const popup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await frame.click('a.play-button');
  const p = await popup;
  check('2d platformer: PLAY opens a new window (a new PhantomHaze tab)', !!p, p && p.url());
  if (p) await p.close();
  check('2d platformer: the arcade stays on the game page', (await state(page)).view === 'game');
  await page.click('#homeBtn');
  await waitView(page, 'home', 30000);

  // 6. Instructions open inside the arcade instead of a popup window.
  await clickCard(page, 'Retro Pong');
  await waitView(page, 'game', 60000);
  await page.click('#instrBtn');
  await page.waitForTimeout(1000);
  check('retro pong: Instructions (dead on the site) now opens its instructions page', !!page.frames().find((f) => f.url() === SERVER + '/retro_pong/instructions.html'));
  await page.keyboard.press('Escape');
  check('instructions: Escape closes the panel', await page.isHidden('#instr'));
  await page.click('#homeBtn');
  await waitView(page, 'home', 30000);

  // 7. Leaving a game while it is still loading.
  await clickCard(page, 'Brain Test');
  await page.waitForTimeout(800);
  await page.click('#ldBack');
  await waitView(page, 'home', 30000);
  check('loading: "Back to games" cancels a game that is still loading', !(await gameFrame(page)));
  check('nav: no popups other than 2D Platformer\'s PLAY', problems.popups.length === 1, problems.popups.join(', '));
  check('nav: no errors in the arcade page', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ games added to the site later
async function suiteLive(browser) {
  const gamesHtml = fs.readFileSync(path.join(FTGAMES, 'games.html'), 'utf8').replace(
    '<a class="game-card" href="/suggestion_box">',
    '<a class="game-card" href="/frogger"><img class="game-card-thumbnail" src="thumbnails/does-not-exist.png" alt="x"><div class="game-card-content"><h2 class="game-card-title">Frogger (new)</h2><p class="game-card-description">A brand new game.</p><div class="game-card-tags"><span class="game-tag game-tag-genre">Genre: Arcade</span><span class="game-tag game-tag-difficulty">Difficulty: Easy</span></div></div></a>\n<a class="game-card" href="/suggestion_box">');
  const { context, page, problems } = await openArcade(browser, FAST_PAGE || PAGE, { gamesHtml });
  await waitView(page, 'home', 40000);
  const titles = await page.$$eval('#grid .card-title', (n) => n.map((x) => x.textContent));
  check('live list: a game added to ftgames.xyz shows up without updating the extension', titles.includes('Frogger (new)'), `${titles.length} cards`);
  check('live list: a missing thumbnail falls back to a drawn card', await page.locator('#grid .card', { has: page.locator('.card-title', { hasText: 'Frogger (new)' }) }).locator('.ph').count() === 1);
  await clickCard(page, 'Frogger (new)');
  await waitView(page, 'game', 60000);
  const frame = (await gameFrame(page));
  check('live list: the new game plays inside the arcade', frame && frame.url() === SERVER + '/frogger/');
  await frame.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 30000 }).catch(() => {});
  check('live list: the new game\'s project loads', await frame.evaluate(() => document.getElementById('error').hidden && document.getElementById('loading').hidden));
  const covered = await page.evaluate(() => !document.getElementById('homeBtn').hidden);
  check('live list: the new game gets the Home button', covered);
  await page.click('#homeBtn');
  await waitView(page, 'home', 30000);
  check('live list: no errors', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ no internet
async function suiteOffline(browser) {
  const { context, page, problems } = await openArcade(browser, FAST_PAGE || PAGE, { offline: true });
  await waitView(page, 'home', 40000);
  check('offline: the games page still opens from the built-in list', (await page.$$eval('#grid .card', (n) => n.length)) === CATALOG.games.length);
  check('offline: the page explains that games need the internet', await page.isVisible('#notice'), await page.textContent('#notice'));
  await shot(page, '05-offline-games-page');
  await clickCard(page, 'Tetris');
  await page.waitForFunction(() => document.getElementById('ldStatus').classList.contains('error'), null, { timeout: 30000 });
  check('offline: launching a game shows "can\'t reach" with Retry and Back', (await page.textContent('#ldStatus')).includes("CAN'T REACH") && await page.isVisible('#ldRetry') && await page.isVisible('#ldBack'));
  await shot(page, '06-offline-game');
  await page.click('#ldBack');
  await waitView(page, 'home', 30000);
  check('offline: Back returns to the games page', !(await gameFrame(page)));
  check('offline: no errors in the arcade page', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ extension settings
async function suiteSettings(browser) {
  const variant = (pairs) => PAGE
    .replace(/<meta name="haze-hold" content="[^"]*">/, `<meta name="haze-hold" content="${pairs.hold ?? '5'}">`)
    .replace(/<meta name="haze-live" content="[^"]*">/, `<meta name="haze-live" content="${pairs.live ?? 'true'}">`)
    .replace(/<meta name="haze-server" content="[^"]*">/, `<meta name="haze-server" content="${pairs.server ?? 'https://ftgames.xyz'}">`);
  let s = await openArcade(browser, variant({ hold: '0', live: 'false' }));
  await waitView(s.page, 'home', 20000);
  let tl = await timeline(s.page);
  const out = tl.find((e) => e.type === 'loader' && e.value === 'out');
  check('settings: hold 0 shows the games page as soon as it has loaded', out && out.t < 3000, out && `${Math.round(out.t)} ms after start`);
  check('settings: "check for new games" off makes no request for games.html', !s.stats.requests.some((r) => r.path === '/games.html'));
  await s.context.close();

  s = await openArcade(browser, variant({ hold: '1', server: 'javascript:alert(1)' }));
  await waitView(s.page, 'home', 20000);
  check('settings: an invalid website address falls back to https://ftgames.xyz', (await state(s.page)).server === 'https://ftgames.xyz');
  await s.context.close();

  s = await openArcade(browser, variant({ hold: '1', server: 'https://ftgames.xyz/some/path/' }));
  await waitView(s.page, 'home', 20000);
  check('settings: a website address with a path is reduced to its origin', (await state(s.page)).server === 'https://ftgames.xyz');
  await s.context.close();

  s = await openArcade(browser, variant({ hold: '99' }));
  await s.page.waitForTimeout(500);
  check('settings: hold is capped at 30 seconds', (await state(s.page)).holdMs === 30000);
  await s.context.close();
}

// ------------------------------------------------------------------ loading estimate on a slow connection
async function suiteSpeed(browser) {
  const speed = Number(args.bps || 4e6);
  const { context, page } = await openArcade(browser, FAST_PAGE || PAGE, { bytesPerSecond: speed });
  await waitView(page, 'home', 60000);
  for (const id of (args.games || 'tetris,brain-test,space-invaders').split(',')) {
    const g = CATALOG.games.find((x) => x.id === id);
    const start = Date.now();
    await clickCard(page, g.title);
    await page.waitForFunction(() => document.querySelector('#stage iframe'), null, { timeout: 10000 });
    let frame = null;
    while (!frame) { frame = (await gameFrame(page)); await page.waitForTimeout(50); }
    const projectAt = frame.waitForFunction(() => document.getElementById('loading') && document.getElementById('loading').hidden === true, null, { timeout: 120000, polling: 100 }).then(() => Date.now());
    await waitView(page, 'game', 120000);
    const revealAt = Date.now();
    const loaded = await projectAt;
    check(`speed ${(speed / 1e6).toFixed(1)} MB/s: ${g.title} is loaded before the loading screen goes`, loaded <= revealAt + 250,
      `project loaded at ${loaded - start} ms, loading screen gone at ${revealAt - start} ms`);
    await page.click('#homeBtn');
    await waitView(page, 'home', 60000);
  }
  await context.close();
}

// ------------------------------------------------------------------ games opened in a PhantomHaze tab
async function suiteTab(browser) {
  if (!TAB_SCRIPT) {
    check('tab: --tab-script given', false, 'run tests/phext-check to build it');
    return;
  }
  const { context, page, problems } = await openArcade(browser, PAGE);
  await waitView(page, 'home', 40000);
  const g = CATALOG.games.find((x) => x.id === 'polytrack');
  check('tab: Polytrack card says it opens in a tab', (await page.locator('#grid .card', { has: page.locator('.card-title', { hasText: 'Polytrack' }) }).locator('.badge').textContent()).includes('OPENS IN TAB'));
  const popupPromise = page.waitForEvent('popup', { timeout: 10000 });
  await clickCard(page, 'Polytrack');
  const popup = await popupPromise;
  await popup.waitForLoadState('load');
  await popup.evaluate((code) => (0, eval)(code), TAB_SCRIPT);
  await popup.waitForTimeout(300);
  const logo = await popup.evaluate(() => !!document.getElementById('haze-arcade-tab-loader'));
  check('tab: the Haze Arcade loading screen covers the game in its tab', logo);
  const started = Date.now();
  const readyAt = popup.waitForFunction(() => document.querySelector('.menu-ui') && !document.querySelector('.menu-ui.loading-screen'), null, { timeout: 60000, polling: 100 }).then(() => Date.now());
  await popup.waitForFunction(() => !document.getElementById('haze-arcade-tab-loader'), null, { timeout: 90000, polling: 100 });
  const goneAt = Date.now();
  const ready = await readyAt;
  check('tab: it stays 5 s after Polytrack has loaded, then goes', goneAt - ready >= 4900 && goneAt - ready < 7000, `game ready after ${ready - started} ms, screen gone ${goneAt - ready} ms later`);
  check('tab: Polytrack runs in the tab (secure page)', await popup.evaluate(() => isSecureContext && !/unexpected error/i.test(document.body.innerText)));
  const plain = await context.newPage();
  await plain.goto(SERVER + '/polytrack/');
  await plain.evaluate((code) => (0, eval)(code), TAB_SCRIPT);
  check('tab: ftgames.xyz pages the arcade did not open are left alone', !(await plain.evaluate(() => !!document.getElementById('haze-arcade-tab-loader'))));
  check('tab: no errors in the arcade page', problems.errors.length === 0, problems.errors.join(' | '));
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  const suites = { boot: suiteBoot, games: suiteGames, nav: suiteNav, live: suiteLive, offline: suiteOffline, settings: suiteSettings, speed: suiteSpeed, tab: suiteTab };
  for (const name of SUITES) {
    console.log(`\n== ${name}`);
    try {
      await suites[name](browser);
    } catch (error) {
      check(`suite ${name} crashed`, false, String(error.stack || error).split('\n').slice(0, 4).join(' / '));
    }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();

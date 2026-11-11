// Haze Arcade: the games page, the loading screen and the game player.
//
// Every game is downloaded from the FT-Games/ftgames repository on GitHub (raw.githubusercontent.com), never from
// the ftgames.xyz website, and built into a frame of its own:
//   - GitHub serves HTML, JavaScript and CSS as text/plain, which browsers refuse to run, so the arcade downloads
//     the page and its scripts itself and hands the scripts to the page as blob: copies;
//   - the page gets a <base> pointing at its folder on GitHub, so pictures, sounds, fonts and data load from there;
//   - Scratch (TurboWarp) games get their whole project downloaded first, which also drives the loading bar;
//   - a small compatibility layer (gameShim) stands in for what an extension page cannot give its frames:
//     storage, cookies, crypto.subtle, a clipboard, and real addresses for scripts and workers.
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const $ = (id) => document.getElementById(id);
  const REPO = 'https://raw.githubusercontent.com/FT-Games/ftgames/main';
  const SITE = /^(?:https?:)?\/\/(?:www\.)?ftgames\.xyz(?=[/?#]|$)/i;
  const MAKECODE = 'https://arcade.makecode.com/';
  const EXTRA_MS = 3000; // the loading screen keeps on loading this long once everything is in
  const CACHE_BYTES = 220 * 1024 * 1024; // downloaded games kept for the PhantomHaze session
  const PARALLEL = 8;
  // Games share the arcade's origin (so the compatibility layer can work) but may not navigate this page.
  const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups ' +
    'allow-popups-to-escape-sandbox allow-downloads allow-orientation-lock allow-presentation';
  const ALLOW = 'autoplay; fullscreen; gamepad; clipboard-read; clipboard-write; screen-wake-lock';
  const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;
  const TIPS = [
    'TIP: Click the \u2606 on a game to add it to your favourites.',
    'TIP: The Home button at the top right of a game brings you back here.',
    'TIP: Click inside a game once it starts so it gets your keyboard.',
    'TIP: Most games have an Instructions button at the top left.',
    'TIP: Search by name, or filter by genre and difficulty.',
  ];

  // ---------------------------------------------------------------- helpers
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const stripPrefix = (text, prefix) => (text.toLowerCase().startsWith(prefix.toLowerCase()) ? text.slice(prefix.length).trim() : text);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const withTimeout = (promise, ms) => Promise.race([promise, sleep(ms).then(() => { throw new Error('timeout'); })]);
  const isRepo = (url) => url.startsWith(REPO + '/');

  let seq = 0; // every navigation gets a number; a newer one cancels what an older one still had to do
  const begin = () => ++seq;
  const alive = (n) => n === seq;

  // ---------------------------------------------------------------- downloads from GitHub
  // url -> { promise, blob, loaded, size, urls (blob: copies by type), used }
  const files = new Map();
  let cachedBytes = 0;
  let active = 0;
  const waiting = [];
  const acquire = () => (active < PARALLEL ? (active++, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else active--;
  };

  // Downloads one file, retrying network errors and busy responses (429, 5xx) with growing pauses.
  async function download(url, entry) {
    let failure = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep([0, 700, 2000, 5000][attempt]);
      await acquire();
      try {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) {
          failure = Object.assign(new Error('HTTP ' + response.status + ' for ' + url), { status: response.status });
          if (response.status === 429 || response.status >= 500) continue;
          throw failure;
        }
        const reader = response.body.getReader();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          entry.loaded += value.length;
        }
        return new Blob(chunks, { type: (response.headers.get('content-type') || '').split(';')[0].trim() });
      } catch (error) {
        entry.loaded = 0;
        if (error === failure && failure.status && failure.status !== 429 && failure.status < 500) throw error;
        failure = error;
      } finally {
        release();
      }
    }
    throw failure || new Error('Could not download ' + url);
  }

  function fetchFile(url, job) {
    let entry = files.get(url);
    if (!entry) {
      entry = { blob: null, loaded: 0, size: 0, urls: new Map(), used: 0 };
      entry.promise = download(url, entry).then((blob) => {
        entry.blob = blob;
        entry.size = blob.size;
        entry.loaded = blob.size;
        cachedBytes += blob.size;
        return blob;
      }, (error) => {
        files.delete(url);
        throw error;
      });
      files.set(url, entry);
    }
    entry.used = performance.now();
    if (job) job.urls.add(url);
    return entry.promise;
  }

  const fetchText = (url, job) => fetchFile(url, job).then((blob) => blob.text());

  // The only synchronous path: a script a game asks for that was not downloaded beforehand.
  function fetchSync(url) {
    const known = files.get(url);
    if (known && known.blob) return known.blob;
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send();
      if (xhr.status !== 200) return null;
      const blob = new Blob([xhr.responseText], { type: 'text/javascript' });
      files.set(url, { blob, loaded: blob.size, size: blob.size, urls: new Map(), used: performance.now(), promise: Promise.resolve(blob) });
      cachedBytes += blob.size;
      return blob;
    } catch (e) {
      return null;
    }
  }

  // A blob: address for a downloaded file, made once per type and reused for the session.
  function blobUrl(url, type) {
    const entry = files.get(url);
    if (!entry || !entry.blob) return '';
    const key = type || '';
    if (!entry.urls.has(key)) entry.urls.set(key, URL.createObjectURL(type ? new Blob([entry.blob], { type }) : entry.blob));
    entry.used = performance.now();
    return entry.urls.get(key);
  }

  // Keeps the downloads under CACHE_BYTES, dropping the files used longest ago (never the ones in `keep`).
  function trimCache(keep) {
    if (cachedBytes <= CACHE_BYTES) return;
    const old = Array.from(files.entries()).filter(([url, entry]) => entry.blob && !keep.has(url)).sort((a, b) => a[1].used - b[1].used);
    for (const [url, entry] of old) {
      if (cachedBytes <= CACHE_BYTES * 0.8) break;
      for (const copy of entry.urls.values()) URL.revokeObjectURL(copy);
      files.delete(url);
      cachedBytes -= entry.size;
    }
  }

  // The files one load needs, for the loading bar.
  function newJob(total) {
    return {
      urls: new Set(),
      total: total || 0,
      progress() {
        let loaded = 0;
        let done = 0;
        for (const url of this.urls) {
          const entry = files.get(url);
          if (entry) {
            loaded += entry.loaded;
            if (entry.blob) done++;
          }
        }
        if (this.total > 0) return clamp(loaded / this.total, 0, 1);
        return this.urls.size ? done / this.urls.size : 0;
      },
    };
  }

  // ---------------------------------------------------------------- catalogue
  function hrefKey(href) {
    return String(href || '').trim().replace(SITE, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  }

  function prepare(game) {
    const g = Object.assign({ buttons: { home: false, instr: false }, instructions: null, bytes: 0 }, game);
    g.key = hrefKey(g.href);
    g.uid = g.id || g.key;
    g.isGame = g.isGame !== false;
    if (g.kind === 'ft') {
      g.files = g.files || [g.file];
      g.instructionsUrl = g.instructions ? REPO + '/' + g.instructions : '';
    } else if (g.kind === 'makecode') {
      g.pageUrl = g.url;
    } else {
      g.pageUrl = g.href;
    }
    return g;
  }

  const SNAPSHOT = (() => {
    try {
      return JSON.parse($('catalog').textContent).games.map(prepare);
    } catch (e) {
      return [];
    }
  })();

  // Reads the cards of games.html in the repository, so games FT Games adds later show up by themselves.
  async function fetchLiveCards() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(REPO + '/games.html', { mode: 'cors', credentials: 'omit', cache: 'no-cache', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      return Array.from(doc.querySelectorAll('a.game-card')).map((a) => {
        const pick = (selector) => tidy((a.querySelector(selector) || {}).textContent);
        const img = a.querySelector('img.game-card-thumbnail');
        return {
          href: (a.getAttribute('href') || '').trim(),
          title: pick('.game-card-title'),
          description: pick('.game-card-description'),
          genre: stripPrefix(pick('.game-tag-genre'), 'Genre:'),
          difficulty: stripPrefix(pick('.game-tag-difficulty'), 'Difficulty:'),
          thumb: img ? (img.getAttribute('src') || '').trim() : '',
        };
      }).filter((card) => card.href && card.title);
    } finally {
      clearTimeout(timer);
    }
  }

  function fromLiveCard(card) {
    const base = { title: card.title, description: card.description, genre: card.genre, difficulty: card.difficulty, href: card.href };
    let game = null;
    if (card.href.startsWith(MAKECODE)) {
      const id = card.href.slice(MAKECODE.length).replace(/\/+$/, '');
      if (/^[A-Za-z0-9_-]+$/.test(id)) game = Object.assign(base, { kind: 'makecode', url: MAKECODE + '---run?id=' + id, tabUrl: card.href, tabButton: true });
    } else if (/^\/(?!\/)/.test(card.href) || SITE.test(card.href)) {
      const parts = card.href.replace(SITE, '').split(/[?#]/)[0].split('/').filter(Boolean);
      if (parts.length && parts.every((p) => SAFE_SEGMENT.test(p))) {
        const rel = parts.join('/');
        game = Object.assign(base, { kind: 'ft', files: parts.length > 1 ? [rel + '.html', rel + '/index.html'] : [rel + '/index.html', rel + '.html'], buttons: { home: true, instr: true } });
      }
    } else if (/^https?:\/\//i.test(card.href)) {
      game = Object.assign(base, { kind: 'external' });
    }
    if (!game) return null;
    if (card.thumb && !/^[a-z][a-z0-9+.-]*:/i.test(card.thumb)) {
      try {
        const url = new URL(card.thumb.replace(/^\/(?!\/)/, ''), REPO + '/games.html');
        if (isRepo(url.href)) game.thumb = url.href;
      } catch (e) { /* no picture */ }
    }
    if (hrefKey(card.href) === '/suggestion_box') game.isGame = false;
    return prepare(game);
  }

  function mergeLive(cards) {
    if (!Array.isArray(cards) || cards.length < Math.min(5, Math.ceil(SNAPSHOT.length / 2))) return null;
    const known = new Map(SNAPSHOT.map((g) => [g.key, g]));
    const seen = new Set();
    const merged = [];
    for (const card of cards) {
      const key = hrefKey(card.href);
      if (seen.has(key)) continue;
      seen.add(key);
      const snapshot = known.get(key);
      if (snapshot) {
        merged.push(Object.assign({}, snapshot, {
          title: card.title || snapshot.title,
          description: card.description || snapshot.description,
          genre: card.genre || snapshot.genre,
          difficulty: card.difficulty || snapshot.difficulty,
        }));
      } else {
        const fresh = fromLiveCard(card);
        if (fresh) merged.push(fresh);
      }
    }
    return merged.length ? merged : null;
  }

  // ---------------------------------------------------------------- loading screen
  const loader = {
    max: 0,
    show(now, title, options) {
      const opts = options || {};
      $('ldNow').textContent = now;
      $('ldTitle').textContent = title;
      $('ldDetail').hidden = true;
      $('ldActions').hidden = !opts.cancel;
      $('ldRetry').hidden = true;
      $('ldBack').hidden = !opts.cancel;
      $('ldBar').hidden = false;
      this.max = 0;
      $('ldFill').style.width = '0%';
      this.status('LOADING...');
      $('ldTip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
      $('loader').classList.remove('out');
    },
    // The bar only ever moves forward while a load is shown.
    progress(value) {
      this.max = Math.max(this.max, clamp(value, 0, 1));
      $('ldFill').style.width = (this.max * 100).toFixed(1) + '%';
    },
    status(text) {
      const node = $('ldStatus');
      if (node.textContent !== text) node.textContent = text;
      node.classList.add('blink');
      node.classList.remove('error');
    },
    error(title, detail, onRetry) {
      const node = $('ldStatus');
      node.textContent = title;
      node.classList.remove('blink');
      node.classList.add('error');
      $('ldDetail').textContent = detail;
      $('ldDetail').hidden = false;
      $('ldBar').hidden = true;
      $('ldActions').hidden = false;
      $('ldRetry').hidden = !onRetry;
      $('ldBack').hidden = false;
      retryAction = onRetry || null;
    },
    hide() {
      $('loader').classList.add('out');
    },
    visible() {
      return !$('loader').classList.contains('out');
    },
  };
  let retryAction = null;

  // Moves the bar from `from` to `to` as source() goes from 0 to 1, until `until` settles (or the run is cancelled).
  async function drive(n, from, to, source, until) {
    let settled = false;
    until.then(() => { settled = true; }, () => { settled = true; });
    while (!settled && alive(n)) {
      loader.progress(from + (to - from) * clamp(source(), 0, 1));
      await sleep(100);
    }
  }

  const creep = (ms) => {
    const start = performance.now();
    return () => 1 - Math.exp(-(performance.now() - start) / ms);
  };

  // The last few seconds: the bar keeps filling and the screen still says LOADING, then it opens.
  async function finishLoading(n) {
    const from = loader.max;
    const start = performance.now();
    while (alive(n)) {
      const t = Math.min((performance.now() - start) / EXTRA_MS, 1);
      loader.progress(from + (1 - from) * t);
      if (t >= 1) return;
      await sleep(60);
    }
  }

  function waitForImages(root, ms) {
    const images = Array.from(root.querySelectorAll('img'));
    const state = { fraction: images.length ? 0 : 1 };
    let finished = 0;
    state.done = withTimeout(Promise.all(images.map((img) => {
      const ready = img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
      return ready.then(() => (img.decode ? img.decode().catch(() => {}) : null)).then(() => {
        state.fraction = ++finished / images.length;
      });
    })), ms).catch(() => {});
    return state;
  }

  // ---------------------------------------------------------------- building a game's page from GitHub
  // A URL from a game page; anything on the ftgames.xyz website is taken from the repository instead.
  function resolveUrl(value, base) {
    const v = String(value || '').trim();
    if (SITE.test(v)) return REPO + (v.replace(SITE, '') || '/');
    if (/^\/(?!\/)/.test(v)) return REPO + v;
    try {
      return new URL(v, base).href;
    } catch (e) {
      return v;
    }
  }

  // ftgames.xyz page addresses ("/tetris/instructions") as files in the repository.
  function repoPage(url) {
    let path = String(url).replace(SITE, '').replace(/[?#].*$/, '');
    if (isRepo(path)) return path;
    path = path.replace(/^\/+/, '');
    if (!path || path.endsWith('/')) path += 'index.html';
    else if (!/\.[a-z0-9]+$/i.test(path)) path += '.html';
    return REPO + '/' + path;
  }

  function rebaseCss(css, url) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, value) => (/^(data:|blob:|#)/i.test(value) ? match : 'url(' + quote + resolveUrl(value, url) + quote + ')'));
  }

  function patchInlineScript(code) {
    return code
      // Leaving the page is the arcade's job: the frame has nowhere useful to go.
      .replace(/(?<![\w$.])(?:(?:window|self|document)\.)?location\.href\s*=(?!=)/g, '__hazeNav.href =')
      .replace(/(?<![\w$.])(?:(?:window|self|document)\.)?location\.(assign|replace)\s*\(/g, '__hazeNav.$1(')
      // TurboWarp pages: the project and its assets come from the copies already downloaded.
      .replace(/new URL\(\s*(['"]\.\/assets\/['"][^,()]*?),\s*location\s*\)\.href/g, '__hazeAsset($1)')
      .replace(/(\.open\(\s*['"]GET['"]\s*,\s*)(['"]\.\/assets\/project\.json['"])/g, '$1__hazeAsset($2)');
  }

  // Every costume, sound and font a Scratch project uses (they sit next to project.json in assets/).
  function assetNames(projectJson) {
    const names = new Set();
    const visit = (value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (typeof value.md5ext === 'string') names.add(value.md5ext);
      else if (typeof value.assetId === 'string' && typeof value.dataFormat === 'string') names.add(value.assetId + '.' + value.dataFormat);
      Object.values(value).forEach(visit);
    };
    visit(JSON.parse(projectJson));
    return Array.from(names).filter((name) => /^[A-Za-z0-9._-]+$/.test(name));
  }

  async function buildDocument(pageUrl, options, job) {
    const base = pageUrl.replace(/[^/]*$/, '');
    const html = await fetchText(pageUrl, job);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const node of doc.querySelectorAll('base, meta[http-equiv]')) {
      if (node.tagName === 'BASE' || /content-security-policy/i.test(node.getAttribute('http-equiv') || '')) node.remove();
    }
    const waits = [];
    for (const link of doc.querySelectorAll('link')) {
      const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
      const href = link.getAttribute('href');
      if (!href || rel.some((r) => /icon|manifest|preconnect|dns-prefetch|prefetch|modulepreload/.test(r)) || (rel.includes('preload') && link.getAttribute('as') !== 'font')) {
        link.remove();
        continue;
      }
      const url = resolveUrl(href, base);
      if (rel.includes('stylesheet') && isRepo(url)) {
        waits.push(fetchText(url, job).then((css) => {
          const style = doc.createElement('style');
          style.textContent = rebaseCss(css, url);
          link.replaceWith(style);
        }));
      } else {
        link.setAttribute('href', url);
      }
    }
    for (const script of doc.querySelectorAll('script[src]')) {
      const url = resolveUrl(script.getAttribute('src'), base);
      if (/\/analytics-consent\.js$/i.test(url)) {
        script.remove(); // the website's analytics banner has no place in the arcade
        continue;
      }
      if (!isRepo(url)) continue;
      waits.push(fetchFile(url, job).then(() => {
        script.setAttribute('src', blobUrl(url, 'text/javascript'));
        script.setAttribute('data-haze-src', url);
      }));
    }
    for (const node of doc.querySelectorAll('img[src], audio[src], video[src], source[src], track[src], input[src]')) {
      const value = node.getAttribute('src');
      if (/^\/(?!\/)/.test(value) || SITE.test(value)) node.setAttribute('src', resolveUrl(value, base));
    }
    for (const script of doc.querySelectorAll('script:not([src])')) {
      const type = (script.getAttribute('type') || '').toLowerCase();
      if (!type || /javascript|ecmascript|module/.test(type)) script.textContent = patchInlineScript(script.textContent);
    }
    const tw = /Scaffolding/.test(html) && !!doc.querySelector('script[data-haze-src$="/script.js"], script[src="script.js"]');
    if (tw) {
      waits.push(fetchText(base + 'assets/project.json', job).then((json) => Promise.all(assetNames(json).map((name) => fetchFile(base + 'assets/' + name, job)))));
    }
    for (const path of options.prefetch || []) waits.push(fetchFile(REPO + '/' + path, job));
    await Promise.all(waits);
    const baseElement = doc.createElement('base');
    baseElement.setAttribute('href', base);
    const shim = doc.createElement('script');
    const config = { repo: REPO, mode: options.mode, instructions: options.instructions || '' };
    shim.textContent = '(' + gameShim + ')(' + JSON.stringify(config).replace(/</g, '\\x3c') + ');';
    doc.head.prepend(baseElement, shim);
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  // ---------------------------------------------------------------- inside every game (runs before its own scripts)
  // Serialised into each game page, so it may only use its argument and the page's own globals.
  function gameShim(C) {
    var W = window;
    var D = document;
    var B;
    try {
      B = W.parent.__hazeBridge;
    } catch (e) {
      B = null;
    }
    if (!B) return;
    W.__hazeShimmed = true;
    var define = function (target, name, descriptor) {
      try {
        descriptor.configurable = true;
        Object.defineProperty(target, name, descriptor);
      } catch (e) { /* keep the original */ }
    };
    var abs = function (url) {
      try {
        return new URL(String(url), D.baseURI).href;
      } catch (e) {
        return String(url);
      }
    };
    var isSite = function (url) {
      return /^https?:\/\/(www\.)?ftgames\.xyz(\/|$)/i.test(url) || url.indexOf(C.repo + '/') === 0;
    };

    // Storage and cookies: an extension page has none, so the arcade keeps them for the PhantomHaze session.
    var makeStorage = function (map) {
      var api = {
        getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
        setItem: function (k, v) { map.set(String(k), String(v)); },
        removeItem: function (k) { map.delete(String(k)); },
        clear: function () { map.clear(); },
        key: function (i) { var keys = Array.from(map.keys()); return i >= 0 && i < keys.length ? keys[i] : null; },
      };
      define(api, 'length', { get: function () { return map.size; } });
      return new Proxy(api, {
        get: function (t, p) { return typeof p === 'string' && !(p in t) ? (map.has(p) ? map.get(p) : undefined) : t[p]; },
        set: function (t, p, v) { if (typeof p === 'string' && !(p in t)) map.set(p, String(v)); else t[p] = v; return true; },
        has: function (t, p) { return p in t || map.has(String(p)); },
        deleteProperty: function (t, p) { map.delete(String(p)); return true; },
        ownKeys: function () { return Array.from(map.keys()); },
        getOwnPropertyDescriptor: function (t, p) {
          return map.has(String(p)) ? { value: map.get(String(p)), writable: true, enumerable: true, configurable: true } : undefined;
        },
      });
    };
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      var works = false;
      try { works = !!W[name] && W[name].length >= 0; } catch (e) { works = false; }
      if (!works) {
        var storage = makeStorage(B.storage(name));
        define(W, name, { enumerable: true, get: function () { return storage; } });
      }
    });
    var cookiesWork = false;
    try { D.cookie; cookiesWork = true; } catch (e) { cookiesWork = false; }
    if (!cookiesWork) {
      var jar = B.storage('cookies');
      define(D, 'cookie', {
        get: function () { var out = []; jar.forEach(function (v, k) { out.push(k + '=' + v); }); return out.join('; '); },
        set: function (text) {
          var parts = String(text).split(';');
          var eq = parts[0].indexOf('=');
          if (eq < 0) return;
          var key = parts[0].slice(0, eq).trim();
          var gone = parts.slice(1).some(function (p) {
            var m = /^\s*(expires|max-age)\s*=\s*(.*)$/i.exec(p);
            return !!m && (m[1].toLowerCase() === 'max-age' ? Number(m[2]) <= 0 : Date.parse(m[2]) < Date.now());
          });
          if (gone) jar.delete(key); else jar.set(key, parts[0].slice(eq + 1).trim());
        },
      });
    }

    // Things only secure pages get, which some games rely on (Polytrack checks its models with SHA-256).
    var sha256 = function (data) {
      var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      var K = [];
      var H = [];
      var primes = [];
      for (var c = 2; primes.length < 64; c++) {
        if (primes.every(function (p) { return c % p; })) primes.push(c);
      }
      primes.forEach(function (p, i) {
        K[i] = ((Math.cbrt(p) % 1) * 4294967296) | 0;
        if (i < 8) H[i] = ((Math.sqrt(p) % 1) * 4294967296) | 0;
      });
      var padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
      padded.set(bytes);
      padded[bytes.length] = 0x80;
      var view = new DataView(padded.buffer);
      var bits = bytes.length * 8;
      view.setUint32(padded.length - 8, Math.floor(bits / 4294967296));
      view.setUint32(padded.length - 4, bits >>> 0);
      var w = new Int32Array(64);
      var h = H.slice();
      for (var i = 0; i < padded.length; i += 64) {
        var j;
        for (j = 0; j < 16; j++) w[j] = view.getInt32(i + j * 4);
        for (j = 16; j < 64; j++) {
          var x = w[j - 15];
          var y = w[j - 2];
          var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
          var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
          w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
        }
        var a = h[0], b = h[1], cc = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (j = 0; j < 64; j++) {
          var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
          var t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[j] + w[j]) | 0;
          var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
          var t2 = (S0 + ((a & b) ^ (a & cc) ^ (b & cc))) | 0;
          hh = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + cc) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
      }
      var out = new DataView(new ArrayBuffer(32));
      for (var k = 0; k < 8; k++) out.setInt32(k * 4, h[k]);
      return out.buffer;
    };
    var cryptoObject = W.crypto;
    if (cryptoObject && !cryptoObject.subtle) {
      define(cryptoObject, 'subtle', {
        value: {
          digest: function (algorithm, data) {
            var name = String((algorithm && algorithm.name) || algorithm).toUpperCase();
            if (name !== 'SHA-256') return Promise.reject(new DOMException(name + ' is not available here', 'NotSupportedError'));
            try { return Promise.resolve(sha256(data)); } catch (e) { return Promise.reject(e); }
          },
        },
      });
    }
    if (cryptoObject && typeof cryptoObject.randomUUID !== 'function') {
      define(cryptoObject, 'randomUUID', {
        value: function () {
          var r = cryptoObject.getRandomValues(new Uint8Array(16));
          r[6] = (r[6] & 15) | 64;
          r[8] = (r[8] & 63) | 128;
          var hex = Array.from(r, function (n) { return (n + 256).toString(16).slice(1); }).join('');
          return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
        },
      });
    }
    if (!navigator.clipboard) {
      define(navigator, 'clipboard', {
        value: {
          writeText: function (text) {
            return new Promise(function (resolve, reject) {
              var area = D.createElement('textarea');
              area.value = String(text);
              area.style.cssText = 'position:fixed;left:-9999px;top:0';
              D.body.appendChild(area);
              area.select();
              var ok = false;
              try { ok = D.execCommand('copy'); } catch (e) { ok = false; }
              area.remove();
              if (ok) resolve(); else reject(new DOMException('Copy failed', 'NotAllowedError'));
            });
          },
          readText: function () { return Promise.reject(new DOMException('Reading the clipboard is not available here', 'NotAllowedError')); },
        },
      });
    }

    // Leaving the game (its Home button, "Back to safety", ...) takes the player back to the arcade's games page.
    var leave = function (url) {
      var text = String(url);
      if (/^\s*javascript:/i.test(text)) return;
      if (text.charAt(0) === '#') {
        location.hash = text;
        return;
      }
      B.leave(abs(text), C.mode);
    };
    var nav = { assign: leave, replace: leave, reload: function () { location.reload(); } };
    define(nav, 'href', { get: function () { return location.href; }, set: leave });
    W.__hazeNav = nav;
    W.__hazeAsset = function (path) { return B.asset(abs(path)); };
    D.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      var target = event.target && event.target.closest ? event.target.closest('a[href], #instructionsButton') : null;
      if (!target) return;
      if (target.id === 'instructionsButton' && C.instructions) {
        event.preventDefault();
        event.stopImmediatePropagation();
        B.instructions(C.instructions);
        return;
      }
      if (target.tagName !== 'A') return;
      var href = target.getAttribute('href') || '';
      if (!href || /^\s*(#|javascript:)/i.test(href)) return;
      var url = abs(href);
      if (/^_(blank|new)$/i.test(target.getAttribute('target') || '') && !isSite(url)) return; // PhantomHaze opens another site in a tab
      event.preventDefault();
      event.stopImmediatePropagation();
      leave(url);
    }, true);
    D.addEventListener('submit', function (event) { event.preventDefault(); }, true);
    var nativeOpen = W.open;
    W.open = function (url) {
      var target = url ? abs(url) : '';
      if (target && isSite(target)) {
        if (C.mode === 'game' && /instructions|rules/i.test(target)) B.instructions(C.instructions || B.repoPage(target));
        else leave(target);
        return null;
      }
      return nativeOpen.apply(W, arguments);
    };

    // Scripts run from blob: copies; bundles that work out their own address (webpack) must still see GitHub's.
    var currentScript = Object.getOwnPropertyDescriptor(Document.prototype, 'currentScript');
    if (currentScript && currentScript.get) {
      define(D, 'currentScript', {
        get: function () {
          var script = currentScript.get.call(D);
          var original = script && script.getAttribute && script.getAttribute('data-haze-src');
          if (!original) return script;
          return new Proxy(script, {
            get: function (target, prop) {
              if (prop === 'src') return original;
              var value = target[prop];
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      });
    }
    var srcProperty = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (srcProperty && srcProperty.set) {
      define(HTMLScriptElement.prototype, 'src', {
        enumerable: true,
        get: srcProperty.get,
        set: function (value) {
          var url = abs(value);
          var copy = url.indexOf(C.repo + '/') === 0 ? B.script(url) : '';
          if (copy) this.setAttribute('data-haze-src', url);
          srcProperty.set.call(this, copy || value);
        },
      });
    }
    // Pictures from GitHub are cross-origin here (they were same-origin on the website): ask for them with CORS,
    // which GitHub allows, so games can still draw them into WebGL textures and canvases.
    var imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (imageSrc && imageSrc.set) {
      define(HTMLImageElement.prototype, 'src', {
        enumerable: true,
        get: imageSrc.get,
        set: function (value) {
          if (this.getAttribute('crossorigin') === null && abs(value).indexOf(C.repo + '/') === 0) this.crossOrigin = 'anonymous';
          imageSrc.set.call(this, value);
        },
      });
    }
    var NativeWorker = W.Worker;
    if (NativeWorker) {
      var Worker = function (url, options) {
        var address = abs(url instanceof URL ? url.href : url);
        var copy = address.indexOf(C.repo + '/') === 0 ? B.worker(address) : '';
        return new NativeWorker(copy || url, options);
      };
      Worker.prototype = NativeWorker.prototype;
      define(W, 'Worker', { writable: true, value: Worker });
    }

    // Lets the arcade see when a page has stopped loading things.
    var pending = 0;
    W.__hazePending = function () { return pending; };
    var nativeFetch = W.fetch;
    W.fetch = function () {
      pending++;
      var done = function () { pending--; };
      var request = nativeFetch.apply(W, arguments);
      request.then(done, done);
      return request;
    };
    var nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      pending++;
      this.addEventListener('loadend', function () { pending--; }, { once: true });
      return nativeSend.apply(this, arguments);
    };
  }

  // Put in front of a game's worker scripts: they run from blob: copies, so their relative addresses are taken from
  // the worker's folder on GitHub (WebAssembly also gets the content type GitHub does not send).
  function workerShim(base, map) {
    var abs = function (url) {
      url = String(url);
      if (/^blob:/i.test(url) && !/^blob:[^/]*\/[0-9a-f-]{36}$/i.test(url)) url = url.replace(/^blob:[^/]*\//, '');
      try {
        return new URL(url, base).href;
      } catch (e) {
        return url;
      }
    };
    var nativeFetch = self.fetch;
    self.fetch = function (input, init) {
      if (typeof input !== 'string' && !(input instanceof URL)) return nativeFetch.call(self, input, init);
      var url = abs(input);
      var request = nativeFetch.call(self, url, init);
      if (!/\.wasm(?:[?#]|$)/i.test(url)) return request;
      return request.then(function (response) {
        if (!response.ok) return response;
        return response.arrayBuffer().then(function (bytes) {
          return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
        });
      });
    };
    var nativeImport = self.importScripts;
    self.importScripts = function () {
      for (var i = 0; i < arguments.length; i++) {
        var url = abs(arguments[i]);
        if (map[url]) {
          nativeImport.call(self, map[url]);
        } else if (/^https?:/i.test(url)) {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, false);
          xhr.send();
          nativeImport.call(self, URL.createObjectURL(new Blob([xhr.responseText], { type: 'text/javascript' })));
        } else {
          nativeImport.call(self, arguments[i]);
        }
      }
    };
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      arguments[1] = abs(url);
      return nativeOpen.apply(this, arguments);
    };
  }

  // What the game pages call (they share the arcade's origin).
  const sessionStores = new Map();
  Object.defineProperty(window, '__hazeBridge', {
    value: Object.freeze({
      storage(name) {
        if (!sessionStores.has(name)) sessionStores.set(name, new Map());
        return sessionStores.get(name);
      },
      asset(url) {
        return blobUrl(url) || url;
      },
      script(url) {
        if (!fetchSync(url)) return '';
        return blobUrl(url, 'text/javascript');
      },
      worker(url) {
        const blob = fetchSync(url);
        if (!blob) return '';
        const folder = url.replace(/[^/]*$/, '');
        const map = {};
        for (const [address, entry] of files) {
          if (entry.blob && address.startsWith(folder) && /\.js$/i.test(address)) map[address] = blobUrl(address, 'text/javascript');
        }
        const shim = '(' + workerShim + ')(' + JSON.stringify(folder) + ', ' + JSON.stringify(map) + ');\n';
        return URL.createObjectURL(new Blob([shim, blob], { type: 'text/javascript' }));
      },
      repoPage,
      instructions(url) {
        openInstructions(url);
      },
      leave(url, mode) {
        if (mode === 'instructions') closeInstructions(true);
        else if (view === 'game' || view === 'loading') goHome();
      },
    }),
  });

  // ---------------------------------------------------------------- games page
  let games = [];
  const favorites = new Set(); // kept for this PhantomHaze session (extension pages have no storage)
  let homeScroll = 0;

  function difficultyClass(value) {
    const v = value.toLowerCase();
    return v === 'easy' || v === 'medium' || v === 'hard' ? v : 'other';
  }

  function buildCard(g) {
    const card = el('div', 'card');
    card.dataset.id = g.uid;
    const play = el('button', 'play');
    play.type = 'button';
    play.title = g.kind === 'external' ? 'Opens in a new PhantomHaze tab' : 'Play ' + g.title;
    const thumb = el('div', 'thumb');
    if (g.thumb) {
      const img = el('img');
      img.alt = g.title + ' thumbnail';
      img.decoding = 'async';
      img.src = g.thumb;
      img.addEventListener('error', () => { img.remove(); thumb.prepend(el('div', 'ph', g.title)); }, { once: true });
      thumb.append(img);
    } else {
      thumb.append(el('div', 'ph', g.title));
    }
    if (g.kind === 'makecode') thumb.append(el('span', 'badge', 'MAKECODE'));
    if (g.kind === 'external') thumb.append(el('span', 'badge', 'OPENS IN TAB \u2197'));
    const body = el('div', 'card-body');
    body.append(el('div', 'card-title', g.title));
    if (g.description) {
      const desc = el('div', 'card-desc', g.description);
      desc.title = g.description;
      body.append(desc);
    }
    if (g.isGame && (g.genre || g.difficulty)) {
      const tags = el('div', 'tags');
      if (g.genre) tags.append(el('span', 'tag genre', g.genre));
      if (g.difficulty) tags.append(el('span', 'tag ' + difficultyClass(g.difficulty), g.difficulty));
      body.append(tags);
    }
    play.append(thumb, body);
    play.addEventListener('click', () => launch(g));
    card.append(play);
    if (g.isGame) {
      const star = el('button', 'fav');
      star.type = 'button';
      star.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFavorite(g, card);
      });
      card.append(star);
    }
    return card;
  }

  function updateStars() {
    document.querySelectorAll('.card').forEach((card) => {
      const star = card.querySelector('.fav');
      if (!star) return;
      const on = favorites.has(card.dataset.id);
      star.textContent = on ? '\u2605' : '\u2606';
      star.classList.toggle('on', on);
      star.setAttribute('aria-pressed', on ? 'true' : 'false');
      star.title = on ? 'Remove from favourites' : 'Add to favourites';
      star.setAttribute('aria-label', (on ? 'Remove ' : 'Add ') + card.querySelector('.card-title').textContent + (on ? ' from' : ' to') + ' favourites');
    });
  }

  function renderFavorites() {
    $('favGrid').replaceChildren(...games.filter((g) => favorites.has(g.uid)).map(buildCard));
    $('favSection').hidden = favorites.size === 0;
    $('favTip').hidden = favorites.size > 0;
    updateStars();
  }

  function toggleFavorite(g, card) {
    if (favorites.has(g.uid)) favorites.delete(g.uid); else favorites.add(g.uid);
    renderFavorites();
    if (favorites.has(g.uid) && card) {
      card.classList.remove('burst');
      void card.offsetWidth;
      card.classList.add('burst');
    }
  }

  function renderHome() {
    $('grid').replaceChildren(...games.map(buildCard));
    const real = games.filter((g) => g.isGame);
    $('count').textContent = '(' + real.length + ')';
    const genres = Array.from(new Set(real.map((g) => g.genre).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    const order = ['Easy', 'Medium', 'Hard'];
    const levels = Array.from(new Set(real.map((g) => g.difficulty).filter(Boolean)));
    const sortedLevels = order.filter((d) => levels.includes(d)).concat(levels.filter((d) => !order.includes(d)).sort());
    const fill = (select, values, label) => select.replaceChildren(new Option(label, ''), ...values.map((v) => new Option(v, v)));
    fill($('genre'), genres, 'All genres');
    fill($('difficulty'), sortedLevels, 'All difficulties');
    renderFavorites();
    applyFilters();
  }

  function applyFilters() {
    const query = $('search').value.trim().toLowerCase();
    const genre = $('genre').value;
    const level = $('difficulty').value;
    const filtering = Boolean(query || genre || level);
    let shown = 0;
    $('grid').querySelectorAll('.card').forEach((card, index) => {
      const g = games[index];
      let visible;
      if (!g.isGame) {
        visible = !filtering;
      } else {
        visible = (!query || (g.title + ' ' + g.description).toLowerCase().includes(query)) &&
          (!genre || g.genre === genre) && (!level || g.difficulty === level);
        if (visible) shown++;
      }
      card.hidden = !visible;
    });
    $('empty').hidden = shown > 0 || !filtering;
  }

  function showNotice(text) {
    $('notice').textContent = text;
    $('notice').hidden = false;
  }

  let toastTimer = 0;
  function showToast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 20000);
  }

  function setHomeActive(active) {
    const home = $('home');
    if (active) {
      home.classList.remove('away');
      home.inert = false;
      home.scrollTop = homeScroll;
    } else {
      if (!home.classList.contains('away')) homeScroll = home.scrollTop;
      home.classList.add('away');
      home.inert = true;
    }
  }

  // ---------------------------------------------------------------- game player
  let view = 'boot'; // boot | home | loading | game
  let current = null;
  let gameFrame = null;
  let instrFrame = null;

  function makeFrame(title) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('allow', ALLOW);
    frame.title = title;
    return frame;
  }

  function removeGameFrame() {
    if (gameFrame) gameFrame.remove();
    gameFrame = null;
  }

  function waitForLoad(frame, n, ms) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        resolve(value);
      };
      const poll = setInterval(() => { if (!alive(n)) finish(false); }, 250);
      frame.addEventListener('load', () => finish(true), { once: true });
      setTimeout(() => finish(false), ms);
    });
  }

  // Resolves once the game itself has finished loading: a Scratch project, Polytrack's tracks and models, or for
  // other pages the moment nothing is loading any more.
  async function gameReady(frame, n) {
    const start = performance.now();
    let quietSince = 0;
    while (alive(n) && performance.now() - start < 90000) {
      let w;
      let d;
      try {
        w = frame.contentWindow;
        d = w.document;
      } catch (e) {
        return;
      }
      if (!d) return;
      const loading = d.getElementById('loading');
      const error = d.getElementById('error');
      if (loading && (d.getElementById('launch') || error)) {
        if (loading.hidden || (error && !error.hidden)) return;
      } else if (d.querySelector('.menu-ui')) {
        if (!d.querySelector('.menu-ui.loading-screen')) return;
      } else {
        const busy = typeof w.__hazePending === 'function' ? w.__hazePending() : 0;
        const imagesDone = Array.from(d.images).every((img) => img.complete);
        if (d.readyState === 'complete' && !busy && imagesDone) {
          if (!quietSince) quietSince = performance.now();
          if (performance.now() - quietSince > 400) return;
        } else {
          quietSince = 0;
        }
      }
      await sleep(100);
    }
  }

  // If a game leaves its page some way the compatibility layer did not catch, go back to the games page.
  function watchFrame(frame) {
    frame.addEventListener('load', () => {
      if (frame !== gameFrame) return;
      let ours = false;
      try {
        ours = !!frame.contentWindow.__hazeShimmed;
      } catch (e) {
        ours = false;
      }
      if (!ours) goHome();
    });
  }

  function placeButtons(g, frame) {
    const ownHome = !!(g.buttons && g.buttons.home); // the page's own Home works (the compatibility layer catches it)
    $('homeBtn').hidden = ownHome;
    $('tabBtn').hidden = !g.tabButton;
    if (!g.tabButton) return;
    let right = 10 + (ownHome ? 0 : $('homeBtn').offsetWidth + 10);
    try {
      const d = frame && frame.contentDocument;
      const home = d && (d.getElementById('homeButton') || d.querySelector('a[href*="ftgames.xyz/games"], a[href="/games"], a[href="/"]'));
      if (home) right = Math.max(right, Math.round(window.innerWidth - home.getBoundingClientRect().left + 10));
    } catch (e) { /* keep the default spot */ }
    $('tabBtn').style.right = right + 'px';
  }

  async function reachable(url) {
    if (navigator.onLine === false) return false;
    try {
      await withTimeout(fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store' }), 15000);
      return true;
    } catch (e) {
      return e && e.message === 'timeout'; // a slow server is not an offline one
    }
  }

  // PhantomHaze turns window.open from an extension page into a new protected tab (and switches to Web View), but
  // only while the click that asked for it is fresh, so this runs straight from the click.
  function openTab(url, title) {
    window.open(url, '_blank');
    showToast((title || 'The page') + ' opened in a new PhantomHaze tab. Click Haze Arcade in the menu bar to come back here.');
  }

  async function buildGame(g, job) {
    let lastError = null;
    for (const file of g.files) {
      try {
        return await buildDocument(REPO + '/' + file, { mode: 'game', instructions: g.instructionsUrl, prefetch: g.prefetch }, job);
      } catch (error) {
        lastError = error;
        if (!(error && error.status === 404)) throw error;
      }
    }
    throw lastError || new Error('No page for ' + g.title);
  }

  async function launch(g) {
    if (g.kind === 'external') {
      openTab(g.pageUrl, g.title);
      return;
    }
    const n = begin();
    view = 'loading';
    current = g;
    loader.show('NOW LOADING', g.title.toUpperCase(), { cancel: true });
    await nextPaint();
    if (!alive(n)) return;
    closeInstructions(false);
    removeGameFrame();
    setHomeActive(false);
    const frame = makeFrame(g.title);

    if (g.kind === 'makecode') {
      // MakeCode Arcade games run on arcade.makecode.com, whose player is made to be embedded.
      $('stage').hidden = false;
      placeButtons(g, null);
      frame.src = g.pageUrl;
      gameFrame = frame;
      $('frameHost').append(frame);
      reachable(g.pageUrl).then((ok) => {
        if (!ok && alive(n) && view === 'loading') failLoad(n, g, 'MAKECODE ARCADE', 'arcade.makecode.com');
      });
      await drive(n, 0, 0.9, creep(2500), waitForLoad(frame, n, 45000));
    } else {
      const job = newJob(g.bytes);
      const building = buildGame(g, job);
      await drive(n, 0, 0.8, () => job.progress(), building);
      let html;
      try {
        html = await building;
      } catch (error) {
        if (alive(n)) failLoad(n, g, 'GITHUB', 'GitHub (raw.githubusercontent.com)');
        return;
      }
      if (!alive(n)) return;
      trimCache(job.urls);
      $('stage').hidden = false;
      frame.srcdoc = html;
      gameFrame = frame;
      $('frameHost').append(frame);
      await drive(n, 0.8, 0.86, creep(2000), waitForLoad(frame, n, 60000));
      if (!alive(n)) return;
      placeButtons(g, frame);
      watchFrame(frame);
      await drive(n, 0.86, 0.93, creep(3000), gameReady(frame, n));
    }
    if (!alive(n)) return;
    await finishLoading(n);
    if (!alive(n)) return;
    view = 'game';
    loader.hide();
    try { frame.focus(); } catch (e) { /* ignore */ }
  }

  function failLoad(n, g, where, host) {
    if (!alive(n)) return;
    const m = begin(); // stop the running load
    removeGameFrame();
    $('stage').hidden = true;
    loader.error("CAN'T REACH " + where,
      'Haze Arcade downloads its games from ' + host + ', so it needs an internet connection. Check your connection and try again.',
      () => { if (alive(m)) launch(g); });
  }

  async function goHome() {
    const n = begin();
    loader.show('LOADING', 'GAMES LIBRARY', { cancel: false });
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    await nextPaint();
    if (!alive(n)) return;
    closeInstructions(false);
    removeGameFrame();
    current = null;
    $('stage').hidden = true;
    setHomeActive(true);
    view = 'loading';
    const start = performance.now();
    await drive(n, 0, 0.8, () => (performance.now() - start) / 400, sleep(400));
    await finishLoading(n);
    if (!alive(n)) return;
    view = 'home';
    loader.hide();
  }

  // ---------------------------------------------------------------- instructions
  let instrSeq = 0;
  async function openInstructions(url) {
    if (!url) return;
    closeInstructions(false);
    const mine = ++instrSeq;
    $('instrTitle').textContent = (current ? current.title.toUpperCase() + ' - ' : '') + 'HOW TO PLAY';
    $('instrWait').textContent = 'LOADING...';
    $('instrWait').hidden = false;
    $('instr').hidden = false;
    $('instrClose').focus();
    try {
      const html = await buildDocument(url, { mode: 'instructions' }, newJob(0));
      if (mine !== instrSeq) return;
      const frame = makeFrame('Instructions');
      frame.addEventListener('load', () => { $('instrWait').hidden = true; }, { once: true });
      frame.srcdoc = html;
      instrFrame = frame;
      $('instrHost').append(frame);
    } catch (e) {
      if (mine === instrSeq) $('instrWait').textContent = "CAN'T LOAD THE INSTRUCTIONS";
    }
  }

  function closeInstructions(refocus) {
    instrSeq++;
    if (instrFrame) instrFrame.remove();
    instrFrame = null;
    $('instr').hidden = true;
    if (refocus && gameFrame) {
      try { gameFrame.focus(); } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- start
  async function boot() {
    const n = begin();
    loader.show('LOADING', 'GAMES LIBRARY', { cancel: false });
    let list = SNAPSHOT;
    let offline = false;
    const live = fetchLiveCards();
    await drive(n, 0, 0.35, creep(1500), live);
    try {
      list = mergeLive(await live) || SNAPSHOT;
    } catch (e) {
      offline = true;
    }
    if (!alive(n)) return;
    games = list;
    renderHome();
    if (offline) {
      showNotice("Couldn't reach GitHub just now, so this is the game list built into Haze Arcade. " +
        'Games are downloaded from the FT Games repository on GitHub, so they need an internet connection.');
    }
    const images = waitForImages($('grid'), 10000);
    await drive(n, 0.35, 0.8, () => images.fraction, images.done);
    if (document.fonts && document.fonts.ready) await withTimeout(document.fonts.ready, 3000).catch(() => {});
    if (!alive(n)) return;
    setHomeActive(true);
    await finishLoading(n);
    if (!alive(n)) return;
    view = 'home';
    loader.hide();
  }

  $('search').addEventListener('input', applyFilters);
  $('genre').addEventListener('change', applyFilters);
  $('difficulty').addEventListener('change', applyFilters);
  $('homeBtn').addEventListener('click', goHome);
  $('tabBtn').addEventListener('click', () => {
    if (current) openTab(current.tabUrl || current.pageUrl, current.title);
  });
  $('instrClose').addEventListener('click', () => closeInstructions(true));
  $('instr').addEventListener('click', (event) => { if (event.target === $('instr')) closeInstructions(true); });
  $('ldBack').addEventListener('click', goHome);
  $('ldRetry').addEventListener('click', () => { if (retryAction) retryAction(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('instr').hidden) closeInstructions(true);
  });

  window.addEventListener('error', () => {
    if (view === 'boot' && loader.visible()) {
      loader.error('SOMETHING WENT WRONG', 'Haze Arcade could not start. Try again, or reinstall the extension.', () => location.reload());
    }
  });

  // For automated tests only: lets them read the arcade's state (nothing here can change it).
  Object.defineProperty(window, '__hazeArcade', {
    value: Object.freeze({
      state: () => ({ view, game: current && current.uid, games: games.length, favorites: favorites.size, files: files.size, cachedBytes }),
    }),
  });

  boot();
})();

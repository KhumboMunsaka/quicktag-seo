// QuickTag content script: reads the page's SEO metadata and shows it in an on-page panel.
// It runs on every page but stays idle unless QuickTag has been switched on for the current site.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const alive = () => {
    try { return !!api.runtime?.id; } catch { return false; }
  };

  // Skip if already running here; replace an orphaned copy left behind by an extension reload.
  if (globalThis.__quicktag?.alive()) return;
  globalThis.__quicktag?.teardown();
  globalThis.__quicktag = { alive, teardown: () => hide() };

  const HOSTS_KEY = 'quicktag_hosts'; // { [hostname]: true } for sites where the panel is on
  const UI_KEY = 'quicktag_ui';
  const SETTINGS_KEY = 'quicktag_settings'; // written by the options page
  const COPY_FORMATS = {
    columns: { label: 'Copy as two columns', hint: 'Field names and values, for side-by-side checks.' },
    row: { label: 'Copy as one row', hint: 'One line per page. Paste each page under the last.' },
  };
  const SITE = location.hostname || location.protocol; // file: pages have no hostname
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const ICON_DIR = 'icons/ui/';
  const OG_KEYS = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:site_name'];
  const TWITTER_KEYS = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'];
  const MONO_VALUES = new Set(['og:type', 'twitter:card']);
  const MAX_HEADINGS = 300;
  const COPIED_MS = 1500;
  const ICON_RELS = ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed'];
  const MANIFEST_FIELDS = ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color'];
  // Default locations, only requested while the "Manifest & icons" section is open.
  const MANIFEST_GUESSES = ['/site.webmanifest', '/manifest.json', '/manifest.webmanifest'];
  const FAVICON_GUESS = '/favicon.ico';
  const INSTALL_SIZES = ['192x192', '512x512']; // Chrome needs both to offer installing the site
  const FETCH_TIMEOUT_MS = 15000;
  const MIME_FORMATS = {
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/jpg': 'JPEG',
    'image/gif': 'GIF',
    'image/webp': 'WebP',
    'image/avif': 'AVIF',
    'image/svg+xml': 'SVG',
    'image/x-icon': 'ICO',
    'image/vnd.microsoft.icon': 'ICO',
    'image/bmp': 'BMP',
  };

  let ui = { side: 'right', minimized: false, open: {} };
  let settings = { copyFormat: 'columns' };
  let shown = false;
  let host, shadow, panel, menu;
  let data = null;
  let shortcut = 'Alt+Shift+Q'; // replaced with the user's actual binding once the background replies
  let lastSig = '';
  let scrollTop = 0;
  let lastHref = location.href;
  let observer, pollTimer, refreshTimer, renderTimer;

  // ---------- storage ----------

  async function getStore(key, fallback) {
    try {
      return (await api.storage.local.get(key))[key] ?? fallback;
    } catch {
      return fallback;
    }
  }

  async function setStore(key, value) {
    try {
      await api.storage.local.set({ [key]: value });
    } catch {
      // Extension was reloaded; this copy of the script is orphaned.
    }
  }

  async function syncFromStorage() {
    ui = { ...ui, ...(await getStore(UI_KEY, {})) };
    settings = { ...settings, ...(await getStore(SETTINGS_KEY, {})) };
    const hosts = await getStore(HOSTS_KEY, {});
    if (hosts[SITE]) show();
    else hide();
  }

  async function setEnabled(on) {
    const hosts = await getStore(HOSTS_KEY, {});
    if (on) hosts[SITE] = true;
    else delete hosts[SITE];
    await setStore(HOSTS_KEY, hosts);
    if (on) show();
    else hide();
  }

  function saveUi(patch) {
    ui = { ...ui, ...patch };
    setStore(UI_KEY, ui);
    render();
  }

  async function fetchShortcut() {
    try {
      shortcut = (await api.runtime.sendMessage({ type: 'quicktag:get-shortcut' })) ?? shortcut;
    } catch {
      return;
    }
    render();
  }

  function openSettings() {
    closeMenu();
    try {
      api.runtime.sendMessage({ type: 'quicktag:open-settings' }).catch(() => {});
    } catch {}
  }

  // ---------- data collection ----------

  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const stripHash = (url) => url.split('#')[0];

  // Text of an element, treating <br> as a space and ignoring scripts/styles.
  function textOf(el) {
    let out = '';
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) out += child.data;
        else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.localName;
          if (tag === 'br') out += ' ';
          else if (tag !== 'script' && tag !== 'style' && tag !== 'template') walk(child);
        }
      }
    })(el);
    const text = clean(out);
    if (text) return text;
    const alts = Array.from(el.querySelectorAll('img[alt]'), (img) => clean(img.alt)).filter(Boolean);
    return alts.length ? `[image alt: ${alts.join(' / ')}]` : '';
  }

  function isVisible(el) {
    if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
    return el.getClientRects().length > 0;
  }

  // Returns a lookup of meta name/property (lowercased) -> list of content values.
  function readMetas() {
    const map = new Map();
    for (const m of document.querySelectorAll('meta[name], meta[property]')) {
      for (const k of new Set([m.getAttribute('name'), m.getAttribute('property')])) {
        if (!k) continue;
        const key = k.trim().toLowerCase();
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(clean(m.getAttribute('content')));
      }
    }
    return (key) => map.get(key) ?? [];
  }

  const relsOf = (l) => l.getAttribute('rel').toLowerCase().split(/\s+/).filter(Boolean);
  const linksWithRel = (rel) => $$('link[rel]').filter((l) => relsOf(l).includes(rel));

  function readStructuredData() {
    const types = new Map();
    const invalid = [];
    const add = (t) => types.set(t, (types.get(t) ?? 0) + 1);
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const t of [].concat(node['@type'] ?? [])) add(String(t));
      if (node['@graph']) walk(node['@graph']);
    };
    for (const s of $$('script[type]')) {
      if (s.type.trim().toLowerCase() !== 'application/ld+json') continue;
      try {
        walk(JSON.parse(s.textContent));
      } catch (err) {
        const type = s.textContent.match(/"@type"\s*:\s*"([^"]+)"/)?.[1] ?? 'JSON-LD';
        invalid.push({ type, message: err.message });
      }
    }
    const microdata = new Map();
    for (const el of $$('[itemscope][itemtype]')) {
      for (const t of el.getAttribute('itemtype').trim().split(/\s+/)) {
        const name = t.replace(/\/+$/, '').split('/').pop();
        if (name) microdata.set(name, (microdata.get(name) ?? 0) + 1);
      }
    }
    return { types: [...types], microdata: [...microdata], invalid };
  }

  function collect() {
    const meta = readMetas();
    const headings = $$('h1, h2, h3, h4, h5, h6').map((el) => ({
      level: Number(el.localName[1]),
      text: textOf(el),
      hidden: !isVisible(el),
    }));
    const titleCount = $$('title').filter((t) => t.namespaceURI === XHTML).length;
    return {
      url: location.href,
      title: titleCount ? document.title : null,
      titleCount,
      description: meta('description'),
      h1: headings.filter((x) => x.level === 1),
      headings,
      canonical: linksWithRel('canonical').map((l) => l.href),
      robots: meta('robots'),
      googlebot: meta('googlebot'),
      hreflang: linksWithRel('alternate')
        .filter((l) => l.hasAttribute('hreflang'))
        .map((l) => ({ lang: l.getAttribute('hreflang'), href: l.href })),
      og: OG_KEYS.map((k) => [k, meta(k)[0] ?? null]),
      twitter: TWITTER_KEYS.map((k) => [k, meta(k)[0] ?? null]),
      lang: document.documentElement.getAttribute('lang'),
      charset: document.characterSet,
      viewport: meta('viewport')[0] ?? null,
      schema: readStructuredData(),
      manifests: linksWithRel('manifest').map((l) => l.href),
      icons: $$('link[rel]')
        .filter((l) => relsOf(l).some((r) => ICON_RELS.includes(r)))
        .map((l) => ({
          label: relsOf(l).join(' '),
          url: l.getAttribute('href') ? l.href : null,
          sizes: l.getAttribute('sizes'),
          type: l.getAttribute('type'),
        })),
    };
  }

  // Status badges for each core field: [kind, text, tooltip?], kind = good | warning | error | critical.
  function assess(d, assets) {
    const length = (n, min, max) =>
      n ? [n >= min && n <= max ? 'good' : 'warning', `${n} chars`, `Recommended: ${min}–${max} characters`] : ['error', 'Empty'];

    const title = d.title === null ? [['error', 'Missing']] : [length(d.title.length, 30, 60)];
    if (d.titleCount > 1) title.push(['warning', `${d.titleCount} title tags`]);

    const description = d.description.length ? [length(d.description[0].length, 70, 160)] : [['error', 'Missing']];
    if (d.description.length > 1) description.push(['warning', `${d.description.length} tags`]);

    const n = d.h1.length;
    const h1 = [n === 1 ? ['good', '1 H1'] : n ? ['warning', `${n} H1s`, 'More than one H1 on this page'] : ['error', 'Missing']];

    let canonical;
    if (!d.canonical.length) canonical = [['warning', 'Missing']];
    else if (d.canonical.length > 1) canonical = [['error', `${d.canonical.length} tags`]];
    else if (stripHash(d.canonical[0]) === stripHash(d.url)) canonical = [['good', 'Self', 'Points to this URL']];
    else canonical = [['warning', 'Other URL', 'Points to a different URL than this page']];

    const directives = [...d.robots, ...d.googlebot].join(' ');
    const robots = [];
    if (/noindex|\bnone\b/i.test(directives)) robots.push(['critical', 'NOINDEX', 'Search engines are told not to index this page']);
    if (/nofollow|\bnone\b/i.test(directives)) robots.push(['error', 'NOFOLLOW', 'Search engines are told not to follow links']);
    if (!robots.length) robots.push(['good', 'Indexable']);

    // Not a core field, but broken JSON-LD counts towards the collapsed bar's issue total.
    const schema = d.schema.invalid.length ? [['error', `${d.schema.invalid.length} invalid`]] : [];

    return { title, description, h1, canonical, robots, schema, icons: assets.problems };
  }

  // ---------- manifest & icon checks ----------
  // The manifest and icon files are fetched from the site to compare what the tags declare with the
  // real files. Results are cached by URL for the life of the page, so re-renders never refetch.

  const checks = new Map(); // "kind url" -> result, or null while the request is in flight

  function cached(kind, url, run) {
    const key = `${kind} ${url}`;
    if (!checks.has(key)) {
      checks.set(key, null);
      run(url)
        .catch((err) => ({ ok: false, reason: "Couldn't check", detail: err.message }))
        .then((result) => {
          checks.set(key, result);
          renderSoon();
        });
    }
    return checks.get(key);
  }

  // Resolves to null if the request itself fails: offline, timed out, or another domain without CORS.
  async function fetchBytes(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
      // In Firefox content scripts the buffer belongs to the page, and subarray() on a view of it throws
      // "Permission denied". Copying into our own array avoids that.
      return { status: res.status, bytes: res.ok ? new Uint8Array(new Uint8Array(await res.arrayBuffer())) : null };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const str = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const tokens = (s) => (s ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const px = ([w, h]) => `${w}×${h}`;

  function resolveUrl(src, base) {
    try {
      return src ? new URL(src, base).href : null;
    } catch {
      return null;
    }
  }

  async function checkManifest(url) {
    const res = await fetchBytes(url);
    if (!res) {
      const offsite = new URL(url).origin !== location.origin;
      return {
        ok: false,
        reason: "Couldn't load",
        detail: offsite ? "The manifest is on another domain that doesn't allow it to be read (CORS)." : 'The request failed or timed out.',
      };
    }
    if (!res.bytes) return { ok: false, reason: `HTTP ${res.status}`, detail: `The server answered ${res.status} for the manifest.` };
    const text = new TextDecoder().decode(res.bytes);
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return /^\s*</.test(text)
        ? { ok: false, reason: 'Not JSON', detail: 'The server returned a web page instead of the manifest.' }
        : { ok: false, reason: 'Invalid JSON', detail: err.message };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { ok: false, reason: 'Invalid manifest', detail: 'The file must contain a JSON object.' };
    }
    return {
      ok: true,
      fields: MANIFEST_FIELDS.map((k) => [k, str(json[k])]),
      icons: (Array.isArray(json.icons) ? json.icons : []).map((i) => ({
        src: str(i?.src),
        sizes: str(i?.sizes),
        type: str(i?.type),
        purpose: str(i?.purpose),
      })),
    };
  }

  const isPng = (b, at) => b[at] === 0x89 && b[at + 1] === 0x50 && b[at + 2] === 0x4e && b[at + 3] === 0x47;

  // Identifies the format from the file's first bytes, so a mislabelled file can't fool the check.
  function sniff(bytes) {
    const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
    if (isPng(bytes, 0)) return 'PNG';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
    if (ascii(0, 4) === 'GIF8') return 'GIF';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'WebP';
    if (ascii(4, 8) === 'ftyp' && /avi[fs]/.test(ascii(8, 32))) return 'AVIF';
    if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'ICO';
    if (ascii(0, 2) === 'BM') return 'BMP';
    const head = new TextDecoder().decode(bytes.subarray(0, 4096));
    if (/^\s*<(!doctype\s+html|html|head|body)[\s>]/i.test(head)) return 'HTML';
    if (/<svg[\s>]/i.test(head)) return 'SVG';
    return null;
  }

  // Every image size inside a .ico file, from its directory. Embedded PNGs report their own size,
  // since the directory can only store sizes up to 256.
  function icoSizes(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = bytes.length >= 6 ? view.getUint16(4, true) : 0;
    const sizes = [];
    for (let i = 0, at = 6; i < count && at + 16 <= bytes.length; i++, at += 16) {
      const offset = view.getUint32(at + 12, true);
      sizes.push(
        isPng(bytes, offset) && offset + 24 <= bytes.length
          ? [view.getUint32(offset + 16), view.getUint32(offset + 20)]
          : [bytes[at] || 256, bytes[at + 1] || 256]
      );
    }
    return sizes;
  }

  // Fallback for files on another domain without CORS: an <img> still loads them and reports their
  // size, but not their real format or every size inside a .ico.
  function measureWithImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const done = (result) => {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, reason: 'Timed out' }), FETCH_TIMEOUT_MS);
      img.onload = () =>
        done(
          /\.svg([?#]|$)/i.test(url)
            ? { ok: true, format: 'SVG', sizes: [], partial: true }
            : { ok: true, format: null, sizes: [[img.naturalWidth, img.naturalHeight]], partial: true }
        );
      img.onerror = () => done({ ok: false, reason: "Couldn't load" });
      img.referrerPolicy = 'no-referrer';
      img.src = url;
    });
  }

  async function checkImage(url) {
    const res = await fetchBytes(url);
    if (!res) return measureWithImage(url);
    if (!res.bytes) return { ok: false, reason: `HTTP ${res.status}` };
    const format = sniff(res.bytes);
    if (format === 'HTML') return { ok: false, reason: 'Not an image', detail: 'the server returned a web page' };
    if (format === 'SVG') return { ok: true, format, sizes: [] };
    if (format === 'ICO') {
      const sizes = icoSizes(res.bytes);
      return sizes.length ? { ok: true, format, sizes } : { ok: false, reason: 'Corrupt .ico file' };
    }
    try {
      const bitmap = await createImageBitmap(new Blob([res.bytes]));
      const size = [bitmap.width, bitmap.height];
      bitmap.close();
      return { ok: true, format, sizes: [size] };
    } catch {
      return format ? { ok: false, reason: `Corrupt ${format} file` } : { ok: false, reason: 'Not an image' };
    }
  }

  // Compares an icon's declared sizes, type and purpose with the real file. `strict` is for manifest
  // icons, which need sizes; on <link> icons sizes are optional.
  function inspectIcon(icon, strict) {
    const row = { ...icon, actual: null, problem: null, badges: [] };
    const add = (...b) => row.badges.push(b);
    const result = icon.url ? cached('image', icon.url, checkImage) : null;
    if (!icon.url) add('error', 'No src', 'This icon has no valid file address');
    else if (!result) add('neutral', 'Checking…');
    else if (!result.ok) {
      row.problem = [result.reason, result.detail].filter(Boolean).join(': ');
      add('error', 'Broken', row.problem);
    } else {
      const vector = result.format === 'SVG';
      const actual = result.sizes.map(px);
      row.actual = vector ? 'SVG, scales to any size' : [actual.join(', '), result.format].filter(Boolean).join(' · ');
      const declared = tokens(icon.sizes);
      const fixed = declared.filter((t) => /^\d+x\d+$/.test(t)).map((t) => px(t.split('x').map(Number)));
      if (declared.some((t) => t !== 'any' && !/^\d+x\d+$/.test(t))) {
        add('warning', 'Invalid sizes', `"${icon.sizes}" isn't valid. Use width x height, e.g. 192x192.`);
      }
      if (strict && !declared.length) add('warning', 'No sizes', vector ? 'Add "sizes": "any"' : `Add "sizes": "${actual.join(' ').replace(/×/g, 'x')}"`);
      if (!vector) {
        if (strict && declared.includes('any')) add('warning', 'Sizes "any"', '"any" is for SVG icons, which scale. Give this image its real size.');
        const missing = fixed.filter((s) => !actual.includes(s));
        if (fixed.length && missing.length === fixed.length) {
          add('error', 'Wrong size', `Declared ${fixed.join(', ')}, but the file is ${actual.join(', ')}`);
        } else if (missing.length && !result.partial) {
          add('warning', 'Size mismatch', `Declared ${fixed.join(', ')}, but the file has no ${missing.join(', ')} image`);
        }
        if (result.sizes.some(([w, h]) => w !== h)) add('warning', 'Not square', `The file is ${actual.join(', ')}. Icons should be square.`);
      }
      const declaredFormat = icon.type && (MIME_FORMATS[icon.type.trim().toLowerCase()] ?? icon.type);
      if (declaredFormat && result.format && declaredFormat !== result.format) {
        add('warning', 'Wrong type', `Declared ${icon.type}, but the file is ${result.format}`);
      }
    }
    const purpose = tokens(icon.purpose);
    if (purpose.includes('any') && purpose.includes('maskable')) {
      add('warning', '"any maskable"', 'Use separate icons for "any" and "maskable": one image ends up too small or cropped in one of the two roles.');
    }
    if (!row.badges.length) add('good', 'OK');
    return row;
  }

  // state: none (no link; default locations not checked) | searching | absent | checking | error | ok
  function inspectManifest(links, probing) {
    const m = { url: links[0] ?? null, linked: links.length > 0, state: 'none', detail: null, fields: [], icons: [], badges: [] };
    const add = (...b) => m.badges.push(b);
    let result;
    if (m.linked) {
      result = cached('manifest', m.url, checkManifest);
      if (links.length > 1) add('warning', `${links.length} manifest links`, 'Browsers only use the first one');
    } else if (probing) {
      const guesses = MANIFEST_GUESSES.map((path) => {
        const url = new URL(path, location.origin).href;
        return { url, result: cached('manifest', url, checkManifest) };
      });
      if (guesses.some((g) => !g.result)) return { ...m, state: 'searching' };
      const hit = guesses.find((g) => g.result.ok);
      if (!hit) return { ...m, state: 'absent' };
      ({ url: m.url, result } = hit);
      add('warning', 'Not linked', 'Browsers only use a manifest that the page links to with <link rel="manifest">');
    } else {
      return m;
    }

    if (!result) {
      add('neutral', 'Checking…');
      return { ...m, state: 'checking' };
    }
    if (!result.ok) {
      add('error', result.reason, result.detail);
      return { ...m, state: 'error', detail: result.detail };
    }
    m.state = 'ok';
    m.fields = result.fields;
    m.icons = result.icons.map((i) => inspectIcon({ ...i, label: null, url: resolveUrl(i.src, m.url) }, true));
    if (!result.fields.some(([k, v]) => (k === 'name' || k === 'short_name') && v)) add('warning', 'No name', 'Add "name" or "short_name"');
    if (!result.icons.length) add('warning', 'No icons', 'The manifest has no "icons" list');
    for (const size of result.icons.length ? INSTALL_SIZES : []) {
      const covered = result.icons.some((i) => {
        const purpose = tokens(i.purpose);
        return (!purpose.length || purpose.includes('any')) && tokens(i.sizes).some((t) => t === size || t === 'any');
      });
      if (!covered) add('warning', `No ${size.replace('x', '×')} icon`, 'Chrome needs a 192×192 and a 512×512 icon (purpose "any") to offer installing the site');
    }
    if (!m.badges.length) add('good', 'Valid');
    return m;
  }

  // state: none | searching | absent (no icon link and no /favicon.ico) | found (the /favicon.ico fallback)
  function inspectPageIcons(icons, probing) {
    const page = { state: 'none', rows: icons.map((i) => inspectIcon(i, false)), badges: [] };
    if (!probing || icons.some((i) => tokens(i.label).includes('icon'))) return page;
    const url = new URL(FAVICON_GUESS, location.origin).href;
    const result = cached('image', url, checkImage);
    if (!result) return { ...page, state: 'searching' };
    if (!result.ok) return { ...page, state: 'absent', badges: [['warning', 'No favicon', `No <link rel="icon"> and nothing at ${FAVICON_GUESS}`]] };
    const row = { ...inspectIcon({ label: null, url, sizes: null, type: null }, false), implicit: true };
    row.badges.unshift(['neutral', 'Not linked', `No <link rel="icon">, so browsers fall back to ${FAVICON_GUESS}`]);
    return { ...page, state: 'found', rows: [...page.rows, row] };
  }

  function inspectAssets(d) {
    // Guessing default locations sends requests that may 404, so it only happens while the section is open.
    const probing = !!ui.open.icons && /^https?:$/.test(location.protocol);
    const manifest = inspectManifest(d.manifests, probing);
    const page = inspectPageIcons(d.icons, probing);
    const badges = [...manifest.badges, ...page.badges, ...[...manifest.icons, ...page.rows].flatMap((r) => r.badges)];
    return { manifest, page, problems: badges.filter(([k]) => k !== 'good' && k !== 'neutral') };
  }

  // ---------- rendering helpers ----------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    el.append(...kids.flat(Infinity).filter((kid) => kid != null && kid !== false));
    return el;
  }

  // Icons are the design's SVG files, shipped in icons/ui and rendered at their own size.
  function icon(file, cls) {
    let src = '';
    try {
      src = api.runtime.getURL(ICON_DIR + file);
    } catch {}
    return h('img', { class: cls ? `ico ${cls}` : 'ico', src, alt: '', draggable: 'false' });
  }

  const badge = ([kind, text, title]) => h('span', { class: `badge ${kind}`, title }, text);
  const dash = () => h('span', { class: 'dash' }, '—');

  // Let long URLs wrap after path separators rather than mid-word.
  const breakable = (s) => s.split(/(?<=[/?&=#])/).flatMap((part, i) => (i ? [h('wbr', {}), part] : [part]));

  const link = (url, cls, text = url) =>
    /^https?:/i.test(url)
      ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: cls, title: text === url ? null : url }, breakable(text))
      : h('span', { class: cls }, text);

  // A file address without the current site's origin, and data: URLs cut down to their type.
  function shortUrl(url) {
    if (/^data:/i.test(url)) return `${url.match(/^data:[^;,]*/i)[0]},…`;
    try {
      const u = new URL(url);
      return u.origin === location.origin ? u.pathname + u.search : url;
    } catch {
      return url;
    }
  }

  const iconButton = (file, title, onclick) =>
    h('button', { type: 'button', class: 'icon-btn', title, 'aria-label': title, onclick }, icon(file));

  // Hover-revealed copy icon plus the in-place "Copied ✓" confirmation; `target` gets the .copied state.
  function copyControls(text, what, target) {
    return [
      h(
        'button',
        { type: 'button', class: 'copy-btn', title: `Copy ${what}`, 'aria-label': `Copy ${what}`, onclick: () => copy(text, target()) },
        icon('copy.svg')
      ),
      h('span', { class: 'copied-note', role: 'status' }, 'Copied ✓'),
    ];
  }

  // A core field: label (click to copy), status badges, then the value.
  function field(label, copyText, statuses, ...content) {
    let el;
    const controls = copyText ? copyControls(copyText, label.toLowerCase(), () => el) : [];
    el = h(
      'div',
      { class: 'field' },
      h(
        'div',
        { class: 'field-head' },
        h(
          'div',
          { class: 'field-label' },
          h('span', { class: copyText ? 'label copyable' : 'label', onclick: copyText ? () => controls[0].click() : null }, label),
          controls
        ),
        h('div', { class: 'statuses' }, statuses.map(badge))
      ),
      content
    );
    return el;
  }

  // Character-length bar: shaded band = recommended range, thin line = current length.
  function meter(len, min, max, kind) {
    const scale = max * 1.5;
    const pct = (n) => `${Math.min(100, (n / scale) * 100)}%`;
    const range = h('div', { class: 'range' });
    range.style.left = pct(min);
    range.style.width = pct(max - min);
    const measured = h('div', { class: `measured ${kind}` });
    measured.style.width = pct(len);
    return h('div', { class: 'meter', title: `${len} characters (recommended ${min}–${max})` }, range, measured);
  }

  // A disclosure section whose open/closed state is remembered.
  function section(id, title, summary, ...content) {
    const det = h(
      'details',
      { class: 'sec' },
      h(
        'summary',
        {},
        icon('chevron-right.svg', 'when-closed'),
        icon('chevron-down-open.svg', 'when-open'),
        h('span', { class: 'sec-title' }, title),
        h('span', { class: 'sec-summary' }, summary)
      ),
      content
    );
    det.open = !!ui.open[id];
    det.addEventListener('toggle', () => {
      if (!!ui.open[id] !== det.open) saveUi({ open: { ...ui.open, [id]: det.open } });
    });
    return det;
  }

  const pair = (key, value, valueClass = 'val') =>
    h('div', { class: 'pair' }, h('span', { class: 'key' }, key), h('div', { class: valueClass }, value ?? dash()));

  const chips = (entries) =>
    entries.length ? h('div', { class: 'chips' }, entries.map(([t, n]) => badge(['neutral', n > 1 ? `${t} ×${n}` : t]))) : dash();

  function splitUrl(url) {
    try {
      const u = new URL(url);
      return u.host ? [`${u.protocol}//${u.host}`, u.pathname + u.search + u.hash] : ['', url];
    } catch {
      return ['', url];
    }
  }

  // ---------- panel ----------

  function issueSummary(a) {
    const kinds = Object.values(a).flat().map(([k]) => k);
    const errors = kinds.filter((k) => k === 'error' || k === 'critical').length;
    const warnings = kinds.filter((k) => k === 'warning').length;
    const total = errors + warnings;
    if (errors) return h('span', { class: 'issues error' }, `${total} issue${total > 1 ? 's' : ''}`);
    if (warnings) return h('span', { class: 'issues warning' }, `${warnings} warning${warnings > 1 ? 's' : ''}`);
    return h('span', { class: 'issues good' }, 'Looks good');
  }

  function header(a) {
    const toLeft = ui.side !== 'left';
    return h(
      'div',
      { class: 'head' },
      h('div', { class: 'mark', 'aria-hidden': 'true' }, 'QT'),
      h(
        'div',
        { class: 'identity' },
        h('div', { class: 'name-row' }, h('span', { class: 'name' }, 'QuickTag'), ui.minimized ? issueSummary(a) : null),
        h('span', { class: 'host', title: SITE }, SITE)
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'div',
          { class: 'copy-group' },
          h(
            'button',
            {
              type: 'button',
              class: 'copy-all',
              title: `${COPY_FORMATS[settings.copyFormat].label}: ${COPY_FORMATS[settings.copyFormat].hint}`,
              onclick: (e) => copy(exportText(settings.copyFormat), e.currentTarget),
            },
            h('span', { class: 'state idle' }, icon('copy.svg'), 'Copy'),
            h('span', { class: 'state done' }, icon('check.svg'), 'Copied ✓')
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'copy-caret',
              title: 'More copy options',
              'aria-label': 'More copy options',
              'aria-haspopup': 'menu',
              'aria-expanded': menu ? 'true' : 'false',
              onclick: () => (menu ? closeMenu() : openMenu()),
            },
            icon('chevron-down.svg')
          )
        ),
        iconButton(toLeft ? 'panel-left.svg' : 'panel-right.svg', toLeft ? 'Move to the left side' : 'Move to the right side', () =>
          saveUi({ side: toLeft ? 'left' : 'right' })
        ),
        ui.minimized
          ? iconButton('chevron-down.svg', 'Expand', () => saveUi({ minimized: false }))
          : iconButton('chevron-up.svg', 'Collapse', () => saveUi({ minimized: true })),
        iconButton('x.svg', `Turn off for ${SITE}`, () => setEnabled(false))
      )
    );
  }

  function iconRow(r) {
    const thumb = h('div', { class: 'icon-thumb' });
    if (r.url && r.actual) {
      // Only once the check has loaded it, so a broken file isn't requested again on every render.
      const img = h('img', { src: r.url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    }
    const declared = [r.label, `declared ${r.sizes || 'no sizes'}`, r.type, r.purpose && `purpose ${r.purpose}`].filter(Boolean).join(' · ');
    const bad = r.badges.some(([k]) => k === 'error');
    return h(
      'div',
      { class: 'icon-row' },
      thumb,
      h(
        'div',
        { class: 'icon-info' },
        h(
          'div',
          { class: 'icon-head' },
          r.url ? link(r.url, 'url-sm', shortUrl(r.url)) : h('span', { class: 'url-sm missing' }, r.src ?? '(no src)'),
          h('div', { class: 'statuses' }, r.badges.map(badge))
        ),
        r.implicit ? null : h('div', { class: 'icon-meta' }, declared),
        r.actual || r.problem ? h('div', { class: bad ? 'icon-meta bad' : 'icon-meta' }, r.actual ? `actual ${r.actual}` : r.problem) : null
      )
    );
  }

  function iconsSection(x) {
    const m = x.manifest;
    const p = x.page;
    const guesses = MANIFEST_GUESSES.join(', ');
    const count = m.icons.length + p.rows.length;
    const errors = x.problems.filter(([k]) => k !== 'warning').length;
    const total = x.problems.length;
    const summary = [
      ({ none: 'No manifest link', searching: 'Looking for a manifest', absent: 'No manifest' }[m.state] ?? (m.linked ? 'Manifest' : 'Unlinked manifest')) +
        ` · ${count} icon${count === 1 ? '' : 's'}`,
      total ? badge([errors ? 'error' : 'warning', `${total} ${errors ? 'issue' : 'warning'}${total > 1 ? 's' : ''}`]) : null,
    ];

    const manifestBody = {
      none: () => h('div', { class: 'empty' }, 'No manifest link on this page.'),
      searching: () => h('div', { class: 'empty' }, `No manifest link on this page. Looking for ${guesses}…`),
      absent: () => h('div', { class: 'empty' }, `No manifest link on this page, and no manifest at ${guesses}.`),
    }[m.state]?.() ?? [
      h('div', { class: 'file-row' }, link(m.url, 'url-sm', shortUrl(m.url)), h('div', { class: 'statuses' }, m.badges.map(badge))),
      m.detail ? h('div', { class: 'note error' }, m.detail) : null,
      m.fields.length ? h('div', { class: 'pairs flush' }, m.fields.map(([k, v]) => pair(k, v, k.endsWith('name') ? 'val' : 'val mono'))) : null,
      m.icons.length ? h('div', { class: 'icon-list' }, m.icons.map(iconRow)) : null,
    ];

    const pageNote = {
      none: p.rows.length ? null : 'No icon links on this page.',
      searching: `No icon link on this page. Looking for ${FAVICON_GUESS}…`,
      absent: `No icon link on this page, and nothing at ${FAVICON_GUESS}.`,
    }[p.state];

    return section(
      'icons',
      'Manifest & icons',
      summary,
      h(
        'div',
        { class: 'assets' },
        h('div', { class: 'group-title' }, 'MANIFEST'),
        manifestBody,
        h('div', { class: 'group-head' }, h('div', { class: 'group-title' }, 'FAVICON & TOUCH ICONS'), h('div', { class: 'statuses' }, p.badges.map(badge))),
        p.rows.length ? h('div', { class: 'icon-list' }, p.rows.map(iconRow)) : null,
        pageNote ? h('div', { class: 'empty' }, pageNote) : null
      )
    );
  }

  function body(d, a, assets) {
    // Page URL
    const [origin, rest] = splitUrl(d.url);
    let urlRow;
    urlRow = h(
      'div',
      { class: 'url-row' },
      h('div', { class: 'url-text' }, h('span', { class: 'origin' }, breakable(origin)), breakable(rest)),
      copyControls(d.url, 'URL', () => urlRow)
    );

    // Title
    const titleValue =
      d.title === null
        ? h('div', { class: 'v-title missing' }, 'No title tag found')
        : h('div', { class: d.title ? 'v-title' : 'v-title missing' }, d.title || 'Title tag is empty');

    // Meta description
    const descValue = d.description.length
      ? d.description.map((t) => h('div', { class: t ? 'v-body' : 'v-body missing' }, t || 'Description is empty'))
      : h('div', { class: 'v-body missing' }, 'No meta description found');

    // H1
    const h1Value = d.h1.length
      ? d.h1.map((x) =>
          x.hidden
            ? h('div', { class: 'hidden-row' }, h('span', { class: 'v-body missing' }, x.text || 'Empty H1'), badge(['neutral', 'hidden', 'Not visible on the page']))
            : h('div', { class: x.text ? 'v-body' : 'v-body missing' }, x.text || 'Empty H1')
        )
      : h('div', { class: 'v-body missing' }, 'No H1 heading found');

    // Canonical
    let canonValue;
    if (!d.canonical.length) canonValue = h('div', { class: 'v-body missing' }, 'No canonical tag found');
    else if (d.canonical.length === 1) canonValue = h('div', { class: 'v-url' }, link(d.canonical[0]));
    else {
      const conflicting = new Set(d.canonical.map(stripHash)).size > 1;
      canonValue = [
        d.canonical.map((c) => h('div', { class: 'v-url sm' }, link(c))),
        h('div', { class: 'note error' }, conflicting ? 'Conflicting targets. Keep one canonical tag.' : 'Duplicate canonical tags. Keep one.'),
      ];
    }

    // Meta robots
    const directives = [...d.robots, ...d.googlebot.map((g) => `googlebot: ${g}`)];
    const robotsValue = directives.length
      ? directives.map((r) => h('div', { class: 'v-mono' }, r))
      : h('div', { class: 'v-body missing' }, 'Not set (defaults to index, follow)');

    // Headings outline
    const levelCounts = [1, 2, 3, 4, 5, 6].map((lvl) => [lvl, d.headings.filter((x) => x.level === lvl).length]);
    const headingSummary = levelCounts
      .filter(([lvl, n]) => lvl === 1 || n)
      .map(([lvl, n]) => `H${lvl} ${n}`)
      .join(' · ');
    const outline = d.headings.length
      ? h(
          'div',
          { class: 'outline' },
          d.headings.slice(0, MAX_HEADINGS).map((x) =>
            h(
              'div',
              { class: `hd l${x.level}` },
              h('span', { class: x.level === 1 ? 'level h1' : 'level' }, `H${x.level}`),
              h('span', { class: x.hidden || !x.text ? 'hd-text muted' : 'hd-text' }, x.text || '(empty heading)'),
              x.hidden ? badge(['neutral', 'hidden', 'Not visible on the page']) : null
            )
          ),
          d.headings.length > MAX_HEADINGS ? h('div', { class: 'more' }, `…and ${d.headings.length - MAX_HEADINGS} more`) : null
        )
      : h('div', { class: 'empty' }, 'No headings on this page');

    // Social tags
    const socialPair = ([k, v]) => {
      if (!v) return pair(k, null);
      if (/^https?:/i.test(v) && (k.endsWith(':image') || k === 'og:url')) {
        if (k === 'og:url') return pair(k, link(v, 'url-sm'));
        const img = h('img', { class: 'thumb', src: v, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
        img.addEventListener('error', () => img.remove());
        return pair(k, h('div', { class: 'image-preview' }, img, link(v, 'url-sm')));
      }
      return pair(k, v, MONO_VALUES.has(k) ? 'val mono' : 'val');
    };
    const ogCount = d.og.filter(([, v]) => v).length;
    const twCount = d.twitter.filter(([, v]) => v).length;

    // Structured data
    const s = d.schema;
    const typeCount = s.types.length + s.microdata.length;

    return h(
      'div',
      { class: 'body' },
      urlRow,
      field('Title', d.title, a.title, titleValue, d.title ? meter(d.title.length, 30, 60, a.title[0][0]) : null),
      field(
        'Meta description',
        d.description.join('\n'),
        a.description,
        descValue,
        d.description[0] ? meter(d.description[0].length, 70, 160, a.description[0][0]) : null
      ),
      field('H1', d.h1.map((x) => x.text).join('\n'), a.h1, h1Value),
      field('Canonical', d.canonical.join('\n'), a.canonical, canonValue),
      field('Meta robots', [...d.robots, ...d.googlebot].join('\n'), a.robots, robotsValue),
      section('headings', 'Headings', headingSummary, outline),
      section(
        'social',
        'Social tags',
        `Open Graph ${ogCount}/${OG_KEYS.length} · Twitter ${twCount}/${TWITTER_KEYS.length}`,
        h('div', { class: 'pairs' }, d.og.map(socialPair), h('div', { class: 'group-label' }, 'TWITTER'), d.twitter.map(socialPair))
      ),
      section(
        'hreflang',
        'Hreflang',
        d.hreflang.length ? `${d.hreflang.length} alternate${d.hreflang.length > 1 ? 's' : ''}` : 'None',
        d.hreflang.length
          ? h(
              'div',
              { class: 'alts' },
              d.hreflang.map((x) => h('div', { class: 'alt' }, h('span', { class: 'alt-lang' }, `${x.lang} →`), link(x.href)))
            )
          : h('div', { class: 'empty' }, 'No hreflang tags')
      ),
      section(
        'schema',
        'Structured data',
        [typeCount ? `${typeCount} type${typeCount > 1 ? 's' : ''}` : 'None', s.invalid.length ? badge(['error', `${s.invalid.length} invalid`]) : null],
        h(
          'div',
          { class: 'schema' },
          h('div', { class: 'group-title' }, 'JSON-LD'),
          chips(s.types),
          s.invalid.map((x) =>
            h(
              'div',
              { class: 'invalid' },
              icon('circle-alert.svg'),
              h('div', { class: 'invalid-text' }, h('div', {}, `${x.type} · Invalid JSON`), h('div', {}, x.message))
            )
          ),
          h('div', { class: 'group-title' }, 'MICRODATA'),
          chips(s.microdata)
        )
      ),
      iconsSection(assets),
      section(
        'other',
        'Page info',
        d.lang || 'No lang',
        h(
          'div',
          { class: 'pairs mono tight' },
          pair('language', d.lang, 'val mono'),
          pair('charset', d.charset, 'val mono'),
          pair('viewport', d.viewport, 'val mono')
        )
      )
    );
  }

  function footer() {
    const keys = shortcut ? (shortcut.includes('+') ? shortcut.split('+') : [...shortcut]) : [];
    return h(
      'div',
      { class: 'foot' },
      h('div', { class: 'site-status' }, icon('enabled-dot.svg'), 'On for this site'),
      h(
        'div',
        { class: 'hint' },
        keys.length ? [keys.map((k) => h('kbd', {}, k.replace('MacCtrl', 'Ctrl'))), 'to hide'] : 'Click the toolbar icon to hide',
        h('span', { class: 'hint-sep', 'aria-hidden': 'true' }, '·'),
        h('button', { type: 'button', class: 'foot-link', title: 'Copy format and keyboard shortcut', onclick: openSettings }, 'Settings')
      )
    );
  }

  // ---------- copy menu ----------
  // Lives in the shadow root rather than the panel so the collapsed bar can't clip it.

  function openMenu() {
    closeMenu();
    const target = () => panel.querySelector('.copy-all');
    const item = (label, hint, onPick, isDefault) =>
      h(
        'button',
        { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => (closeMenu(true), onPick()) },
        h('span', { class: 'menu-label' }, label, isDefault ? h('span', { class: 'badge neutral' }, 'Default') : null),
        h('span', { class: 'menu-hint' }, hint)
      );
    const copyAs = (format) => () => copy(exportText(format), target());
    menu = h(
      'div',
      { class: 'menu', role: 'menu', 'aria-label': 'Copy options', onkeydown: onMenuKey },
      Object.entries(COPY_FORMATS).map(([format, f]) => item(f.label, f.hint, copyAs(format), settings.copyFormat === format)),
      item('Copy column headings', 'For one-row copies: paste once at the top of a new sheet.', copyAs('headings')),
      h('div', { class: 'menu-divider' }),
      item('Settings…', 'Default copy format and keyboard shortcut.', openSettings)
    );
    shadow.append(menu);
    positionMenu();
    panel.querySelector('.copy-caret')?.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutsidePointer, true);
    menu.querySelector('.menu-item').focus();
  }

  function positionMenu() {
    const caret = panel?.querySelector('.copy-caret');
    if (!menu || !caret) return;
    const r = caret.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - 280, innerWidth - 288))}px`;
  }

  function closeMenu(focusCaret) {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    const caret = panel?.querySelector('.copy-caret');
    caret?.setAttribute('aria-expanded', 'false');
    if (focusCaret) caret?.focus();
  }

  function onOutsidePointer(e) {
    const path = e.composedPath();
    if (path.includes(menu) || path.some((n) => n.classList?.contains('copy-caret'))) return;
    closeMenu();
  }

  function onMenuKey(e) {
    const items = [...menu.querySelectorAll('.menu-item')];
    const i = items.indexOf(shadow.activeElement);
    if (e.key === 'Escape') closeMenu(true);
    else if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function render(force) {
    if (!shown || !panel || !data) return;
    const assets = inspectAssets(data);
    const sig = JSON.stringify([data, assets, ui, settings, shortcut]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const a = assess(data, assets);
    panel.className = `qt ${ui.side === 'left' ? 'left' : 'right'}${ui.minimized ? ' min' : ''}`;
    panel.replaceChildren(header(a), ...(ui.minimized ? [] : [body(data, a, assets), footer()]));
    const scroller = panel.querySelector('.body');
    if (scroller) {
      scroller.scrollTop = scrollTop; // also restores the position after expanding from the collapsed bar
      scroller.addEventListener('scroll', () => (scrollTop = scroller.scrollTop));
    }
    positionMenu(); // the header was rebuilt, so re-anchor an open copy menu
  }

  function refresh() {
    if (!shown) return;
    data = collect();
    render();
  }

  // Throttled: at most one refresh every 300ms, however busy the page is.
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 300);
  }

  // Manifest and icon checks finish one by one; fold results that land together into one render.
  function renderSoon() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 50);
  }

  function mount() {
    if (host) {
      if (!host.isConnected) document.documentElement.append(host);
      return;
    }
    document.querySelectorAll('quicktag-root').forEach((el) => el.remove()); // left over from a reload
    host = document.createElement('quicktag-root');
    for (const [prop, value] of [
      ['all', 'initial'],
      ['display', 'block'],
      ['position', 'fixed'],
      ['top', '0'],
      ['left', '0'],
      ['width', '0'],
      ['height', '0'],
      ['z-index', '2147483647'],
    ]) {
      host.style.setProperty(prop, value, 'important');
    }
    shadow = host.attachShadow({ mode: 'open' });
    try {
      // Constructed sheets aren't blocked by a strict page Content-Security-Policy; <style> below is the fallback.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {}
    panel = h('div', { class: 'qt' });
    // Escape closes the panel, but only while focus is inside it, so it never hijacks the page's own Escape.
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (menu) closeMenu(true);
      else setEnabled(false);
    });
    shadow.append(h('style', {}, CSS), panel);
    document.documentElement.append(host);
  }

  function show() {
    if (shown) return;
    try {
      mount();
    } catch (err) {
      console.warn('QuickTag could not display on this page:', err);
      return;
    }
    shown = true;
    lastHref = location.href;
    refresh();
    fetchShortcut();
    observer ??= new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['content', 'href', 'rel', 'name', 'property', 'hreflang', 'lang'],
    });
    // Catch single-page-app URL changes and pages that wipe out our element.
    pollTimer = setInterval(() => {
      if (!alive()) return hide();
      if (location.href !== lastHref) {
        lastHref = location.href;
        scheduleRefresh();
      }
      if (!host.isConnected) document.documentElement.append(host);
    }, 700);
  }

  function hide() {
    closeMenu();
    shown = false;
    observer?.disconnect();
    clearInterval(pollTimer);
    clearTimeout(refreshTimer);
    clearTimeout(renderTimer);
    pollTimer = refreshTimer = renderTimer = null;
    host?.remove();
    lastSig = '';
    scrollTop = 0;
  }

  // ---------- copy ----------

  async function copy(text, el) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API is unavailable on http:// pages; fall back to execCommand.
      const ta = h('textarea', {});
      ta.value = text;
      shadow.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), COPIED_MS);
  }

  // e.g. "192x192: OK | 512x512: Wrong size (actual 500×500 · PNG) | 256x256: Broken (HTTP 404)"
  function iconsExport(rows) {
    const issuesOf = (r) => r.badges.filter(([k]) => k === 'error' || k === 'warning').map(([, t]) => t);
    return rows
      .map((r) => {
        const issues = issuesOf(r);
        const why = r.actual ? `actual ${r.actual}` : r.problem;
        const status = issues.length ? `${issues.join(', ')}${why ? ` (${why})` : ''}` : r.badges.at(-1)[1];
        return `${r.label ? `${r.label} ` : ''}${r.sizes || shortUrl(r.url ?? r.src ?? '')}: ${status}`;
      })
      .join(' | ');
  }

  function exportFields(d) {
    const { manifest: m, page } = inspectAssets(d);
    const manifestIssues = m.badges.filter(([k]) => k === 'error' || k === 'warning').map(([, t]) => t);
    return [
      ['URL', d.url],
      ['Title', d.title === '' ? '(empty)' : d.title],
      ['Title length', d.title?.length ?? 0],
      ['Meta description', d.description.join(' | ')],
      ['Description length', d.description[0]?.length ?? 0],
      ['H1', d.h1.map((x) => x.text).join(' | ')],
      ['H1 count', d.h1.length],
      ['Canonical', d.canonical.join(' | ')],
      ['Meta robots', [...d.robots, ...d.googlebot.map((g) => `googlebot: ${g}`)].join(' | ')],
      ['Lang', d.lang],
      ['Hreflang', d.hreflang.map((x) => `${x.lang}: ${x.href}`).join(' | ')],
      ...d.og,
      ...d.twitter,
      ['Structured data', [...d.schema.types, ...d.schema.microdata].map(([t]) => t).join(', ')],
      ['H2s', d.headings.filter((x) => x.level === 2).map((x) => x.text).join(' | ')],
      // Added later. Kept last so spreadsheets built from earlier one-row copies still line up.
      ['Manifest', m.url && `${m.url}${manifestIssues.length ? ` (${manifestIssues.join(', ')})` : ''}`],
      ['Manifest icons', iconsExport(m.icons)],
      ['Page icons', iconsExport(page.rows)],
    ];
  }

  // Tab-separated text for spreadsheets: 'row' = one line of values, 'headings' = one line of
  // field names, 'columns' = one "field<TAB>value" line per field. Missing values are written
  // as "(none)" so an absent tag can't be mistaken for a failed copy.
  function exportText(format) {
    const one = (v) => (v == null || v === '' ? '(none)' : String(v).replace(/[\t\r\n]+/g, ' '));
    const fields = exportFields(data);
    if (format === 'headings') return fields.map(([k]) => k).join('\t');
    if (format === 'row') return fields.map(([, v]) => one(v)).join('\t');
    return fields.map(([k, v]) => `${k}\t${one(v)}`).join('\n');
  }

  // ---------- wiring ----------

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'quicktag:toggle') return;
    sendResponse({ ok: true });
    ready.then(() => setEnabled(msg.forceOn || !shown));
  });

  // Keep every open tab of the same site in sync when the panel is switched on/off or rearranged.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[HOSTS_KEY]) {
      const on = !!changes[HOSTS_KEY].newValue?.[SITE];
      if (on !== shown) on ? show() : hide();
    }
    if (changes[UI_KEY]?.newValue && JSON.stringify(changes[UI_KEY].newValue) !== JSON.stringify(ui)) {
      ui = { ...ui, ...changes[UI_KEY].newValue };
      render();
    }
    if (changes[SETTINGS_KEY]) {
      settings = { ...settings, ...changes[SETTINGS_KEY].newValue };
      closeMenu();
      render();
    }
  });

  // The shortcut may have been changed in the settings page while this tab was in the background.
  document.addEventListener('visibilitychange', () => {
    if (shown && !document.hidden) fetchShortcut();
  });

  // Back/forward cache restores an old page as-is; re-check whether QuickTag should be on.
  addEventListener('pageshow', (e) => {
    if (e.persisted) syncFromStorage();
  });
  // Stylesheets may finish loading after document_end, which changes what's hidden.
  addEventListener('load', () => shown && scheduleRefresh());

  // Values from the QuickTag implementation tokens in the Figma file.
  const CSS = `
    :host {
      all: initial;
      --panel: #1c1d21;
      --elevated: #24262b;
      --hover: #2c2e35;
      --border: #383a43;
      --divider: #30323a;
      --track: #33363e;
      --range: #48513f;
      --text: #f2f3f5;
      --secondary: #b2b5bf;
      --muted: #858995;
      --accent: #a5b4fc;
      --on-critical: #fff;
      --good: #78d6a3;
      --good-subtle: #203b2d;
      --warning: #ebc078;
      --warning-subtle: #413522;
      --error: #ff9393;
      --error-subtle: #44292d;
      --critical: #d93842;
      --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      --mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    }
    .qt {
      position: fixed; top: 16px; right: 16px;
      width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px);
      display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box;
      background: var(--panel); color: var(--text);
      border: 1px solid var(--border); border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .32);
      font: 400 13px/19px var(--sans);
      text-align: left; color-scheme: dark; -webkit-font-smoothing: antialiased;
    }
    *, *::before, *::after { box-sizing: border-box; }
    .qt.left { right: auto; left: 16px; }
    .ico { display: block; flex: none; pointer-events: none; user-select: none; -webkit-user-select: none; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* header */
    .head {
      flex: none; display: flex; align-items: center; gap: 10px; height: 64px; padding: 0 14px;
      background: var(--elevated); border-bottom: 1px solid var(--divider);
    }
    .qt.min .head { border-bottom: 0; height: 62px; }
    .mark {
      flex: none; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;
      border-radius: 6px; background: var(--hover); border: 1px solid var(--border);
      color: var(--accent); font: 700 11px/1 var(--sans);
    }
    .identity { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .name-row { display: flex; align-items: center; gap: 8px; }
    .name { font: 600 15px/21px var(--sans); color: var(--text); white-space: nowrap; }
    .issues { font: 600 11px/16px var(--sans); white-space: nowrap; }
    .issues.good { color: var(--good); }
    .issues.warning { color: var(--warning); }
    .issues.error { color: var(--error); }
    .host { font: 400 10px/14px var(--sans); color: var(--secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { flex: none; display: flex; align-items: center; gap: 2px; }
    button {
      all: unset; box-sizing: border-box; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 6px; font-family: var(--sans); color: var(--text);
    }
    button:hover { background: var(--hover); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .icon-btn { width: 28px; height: 28px; }
    .copy-group {
      display: inline-flex; height: 28px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--elevated); overflow: hidden;
    }
    .copy-group button { height: 26px; border-radius: 0; }
    .copy-group button:focus-visible { outline-offset: -2px; }
    .copy-all { padding: 0 8px; font-size: 12px; font-weight: 600; line-height: 1; }
    .copy-caret { width: 22px; border-left: 1px solid var(--border); }
    .copy-caret[aria-expanded="true"] { background: var(--hover); }
    .copy-all .state { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .copy-all .done { display: none; color: var(--good); }
    .copy-all.copied .idle { display: none; }
    .copy-all.copied .done { display: inline-flex; }

    /* scrolling content */
    .body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .body::-webkit-scrollbar { width: 9px; }
    .body::-webkit-scrollbar-track { background: transparent; }
    .body::-webkit-scrollbar-thumb {
      background: var(--border); background-clip: padding-box; border: 3px solid transparent; border-radius: 6px;
    }
    @supports (-moz-appearance: none) {
      .body { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    }

    /* page URL and core fields */
    .url-row { display: flex; align-items: flex-start; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--divider); }
    .url-text {
      flex: 1; min-width: 0; font: 400 12px/18px var(--mono); color: var(--text);
      overflow-wrap: anywhere; user-select: text; -webkit-user-select: text;
    }
    .url-text .origin { color: var(--muted); }
    .field { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border-bottom: 1px solid var(--divider); }
    .url-row:hover, .url-row:focus-within, .field:hover, .field:focus-within { background: var(--hover); }
    .field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .field-label { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .label {
      font: 600 11px/16px var(--sans); letter-spacing: .7px; text-transform: uppercase;
      color: var(--secondary); white-space: nowrap;
    }
    .label.copyable { cursor: pointer; }
    .copy-btn { flex: none; width: 16px; height: 16px; border-radius: 4px; opacity: 0; }
    .copy-btn:hover { background: transparent; }
    .url-row:hover .copy-btn, .url-row:focus-within .copy-btn, .field:hover .copy-btn, .field:focus-within .copy-btn { opacity: 1; }
    .copied-note { display: none; font: 400 11px/16px var(--sans); color: var(--good); white-space: nowrap; }
    .copied .copy-btn { display: none; }
    .copied .copied-note { display: inline; }
    .statuses { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
    .badge {
      display: inline-flex; align-items: center; padding: 2px 6px; border-radius: 4px;
      font: 600 11px/16px var(--sans); white-space: nowrap;
    }
    .badge.good { background: var(--good-subtle); color: var(--good); }
    .badge.warning { background: var(--warning-subtle); color: var(--warning); }
    .badge.error { background: var(--error-subtle); color: var(--error); }
    .badge.critical { background: var(--critical); color: var(--on-critical); }
    .badge.neutral { background: var(--elevated); color: var(--secondary); }
    .v-title, .v-body, .v-mono, .v-url { overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
    .v-title { font: 600 15px/21px var(--sans); color: var(--text); }
    .v-body { font: 400 13px/19px var(--sans); color: var(--text); }
    .v-mono { font: 400 13px/19px var(--mono); color: var(--text); }
    .v-url { font: 400 13px/19px var(--mono); color: var(--accent); }
    .v-url.sm { font-size: 12px; line-height: 18px; }
    .missing { color: var(--muted); }
    .hidden-row { display: flex; align-items: center; gap: 8px; }
    .note { font: 400 11px/16px var(--sans); }
    .note.error { color: var(--error); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* character-length bar */
    .meter { position: relative; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; }
    .meter .range { position: absolute; top: 0; height: 4px; background: var(--range); }
    .meter .measured { position: absolute; left: 0; top: 1px; height: 2px; }
    .measured.good { background: var(--good); }
    .measured.warning { background: var(--warning); }

    /* disclosure sections */
    details.sec { border-bottom: 1px solid var(--divider); }
    summary {
      display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 16px;
      list-style: none; cursor: pointer; user-select: none; -webkit-user-select: none;
    }
    summary::-webkit-details-marker { display: none; }
    summary:hover { background: var(--hover); }
    details[open] > summary { background: var(--elevated); }
    details[open] > summary:hover { background: var(--hover); }
    summary:focus-visible { outline-offset: -2px; }
    details[open] > summary > .when-closed, details:not([open]) > summary > .when-open { display: none; }
    .sec-title { font: 600 13px/18px var(--sans); color: var(--text); white-space: nowrap; }
    .sec-summary {
      flex: 1; min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px;
      font: 400 11px/16px var(--sans); color: var(--secondary); white-space: nowrap; overflow: hidden;
    }
    .empty { padding: 8px 16px 12px; font: 400 12px/18px var(--sans); color: var(--muted); }

    /* headings outline */
    .outline { display: flex; flex-direction: column; gap: 4px; padding: 8px 16px 10px; }
    .hd { display: flex; align-items: center; gap: 8px; min-height: 26px; }
    .hd.l2 { padding-left: 16px; }
    .hd.l3 { padding-left: 32px; }
    .hd.l4 { padding-left: 48px; }
    .hd.l5 { padding-left: 64px; }
    .hd.l6 { padding-left: 80px; }
    .level {
      flex: none; padding: 1px 5px; border-radius: 4px; background: var(--elevated);
      color: var(--muted); font: 700 10px/14px var(--mono);
    }
    .level.h1 { background: var(--warning-subtle); color: var(--warning); }
    .hd-text { flex: 1; min-width: 0; font: 400 12px/18px var(--sans); color: var(--text); overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
    .hd-text.muted { color: var(--muted); }
    .more { padding-top: 4px; font: 400 11px/16px var(--sans); color: var(--muted); }

    /* key/value pairs */
    .pairs { display: flex; flex-direction: column; padding: 0 16px 16px; }
    .pairs.tight { padding-bottom: 12px; }
    .pair { display: flex; align-items: flex-start; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--divider); }
    .key { flex: none; width: 132px; font: 400 11px/17px var(--mono); color: var(--secondary); overflow-wrap: anywhere; }
    .val {
      flex: 1; min-width: 0; font: 400 12px/18px var(--sans); color: var(--text);
      overflow-wrap: anywhere; user-select: text; -webkit-user-select: text;
    }
    .val.mono { font-family: var(--mono); }
    .dash { color: var(--muted); }
    .image-preview { display: flex; flex-direction: column; gap: 8px; }
    .thumb { display: block; width: 120px; height: 64px; object-fit: cover; border-radius: 4px; background: var(--elevated); }
    .url-sm { font: 400 11px/17px var(--mono); }
    .group-label { display: flex; align-items: center; height: 36px; font: 600 10px/14px var(--sans); color: var(--muted); }

    /* hreflang */
    .alts { display: flex; flex-direction: column; padding: 0 16px 12px; }
    .alt { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-bottom: 1px solid var(--divider); }
    .alt-lang { font: 700 11px/16px var(--mono); color: var(--secondary); }
    .alt a { font: 400 12px/18px var(--mono); overflow-wrap: anywhere; }

    /* structured data */
    .schema { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
    .group-title { font: 600 10px/14px var(--sans); color: var(--muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .invalid { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; background: var(--error-subtle); }
    .invalid-text { flex: 1; min-width: 0; font: 400 11px/16px var(--mono); color: var(--error); overflow-wrap: anywhere; }

    /* manifest & icons */
    .assets { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
    .assets .empty { padding: 0; }
    .group-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .file-row, .icon-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .file-row > :first-child, .icon-head > :first-child { min-width: 0; overflow-wrap: anywhere; }
    .pairs.flush { padding: 0; }
    .icon-list { display: flex; flex-direction: column; }
    .icon-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--divider); }
    .icon-row:first-child { padding-top: 0; }
    .icon-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .icon-thumb {
      flex: none; display: flex; align-items: center; justify-content: center; width: 36px; height: 36px;
      border-radius: 4px; background: var(--elevated); overflow: hidden;
    }
    .icon-thumb img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
    .icon-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .icon-meta { font: 400 11px/16px var(--mono); color: var(--secondary); overflow-wrap: anywhere; }
    .icon-meta.bad { color: var(--error); }

    /* footer */
    .foot {
      flex: none; display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 16px;
      background: var(--elevated); border-top: 1px solid var(--divider);
    }
    .site-status { display: flex; align-items: center; gap: 6px; font: 400 11px/16px var(--sans); color: var(--good); white-space: nowrap; }
    .hint { display: flex; align-items: center; gap: 4px; font: 400 10px/14px var(--sans); color: var(--muted); white-space: nowrap; }
    kbd {
      padding: 1px 4px; border-radius: 4px; border: 1px solid var(--border); background: var(--panel);
      font: 400 10px/14px var(--sans); color: var(--secondary);
    }
    .hint-sep { margin: 0 2px; }
    .foot-link { padding: 1px 4px; border-radius: 4px; font: 600 11px/16px var(--sans); color: var(--accent); }

    /* copy menu (positioned against the caret button by script) */
    .menu {
      position: fixed; z-index: 1; width: 280px; padding: 4px;
      display: flex; flex-direction: column; gap: 2px;
      background: var(--elevated); border: 1px solid var(--border); border-radius: 6px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .32);
      font: 400 13px/19px var(--sans); color: var(--text); text-align: left; color-scheme: dark;
      -webkit-font-smoothing: antialiased;
    }
    .menu-item {
      display: flex; flex-direction: column; align-items: stretch; gap: 2px;
      padding: 8px 10px; border-radius: 4px;
    }
    .menu-item:hover, .menu-item:focus-visible { background: var(--hover); }
    .menu-item:focus-visible { outline-offset: -2px; }
    .menu-label { display: flex; align-items: center; gap: 8px; font: 600 12px/18px var(--sans); color: var(--text); }
    .menu-label .badge { padding: 0 6px; font-size: 10px; line-height: 16px; background: var(--hover); }
    .menu-hint { font: 400 11px/16px var(--sans); color: var(--secondary); }
    .menu-divider { height: 1px; margin: 2px 6px; background: var(--divider); }
    textarea { position: fixed; opacity: 0; pointer-events: none; }
  `;

  const ready = syncFromStorage();
})();

// Regenerates the store images in store/images/ from the pages in this folder, using the real Chrome
// build of QuickTag (run `node scripts/build.mjs` first). Needs Google Chrome and openssl on PATH
// (Git for Windows ships openssl). Run from the project root: node store/source/capture.mjs
//
// Screenshot 1 frames a real browser screenshot (screenshot-1-source.webp). The others are pages served
// over HTTPS as www.example.com (a domain reserved for examples), so the panel shows realistic URLs.
// Chrome is pointed at a local server and told to accept its throwaway certificate.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'store', 'images');
const EXT = join(ROOT, 'dist', 'chrome');
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 4443;
const HOSTS = ['www.example.com', 'staging.example.com', 'promo.example.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHOTS = [
  { file: 'screenshot-1-panel.png', page: 'frame.html', url: 'https://promo.example.com/' }, // QuickTag is off on this host
  { file: 'screenshot-2-problems.png', page: 'problems.html', url: 'https://staging.example.com/boots/trail-runner-2/' },
  {
    file: 'screenshot-3-outline.png',
    page: 'guide.html',
    url: 'https://www.example.com/guides/how-to-choose-hiking-boots/',
    open: { headings: true, schema: true },
    scrollToSections: true,
  },
  { file: 'screenshot-4-copy.png', page: 'copy.html', url: 'https://www.example.com/boots/trail-runner-2/', menu: true },
];

// ---------- throwaway HTTPS server ----------

const tmp = mkdtempSync(join(tmpdir(), 'quicktag-shots-'));
execFileSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=example.com',
    '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem')],
  { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
);
let currentPage = 'frame.html';
const ASSETS = {
  '/shot.css': [join(HERE, 'shot.css'), 'text/css'],
  '/screenshot-1-source.webp': [join(HERE, 'screenshot-1-source.webp'), 'image/webp'],
};
const server = https
  .createServer({ key: readFileSync(join(tmp, 'key.pem')), cert: readFileSync(join(tmp, 'cert.pem')) }, (req, res) => {
    const [file, type] = ASSETS[req.url.split('?')[0]] ?? [join(HERE, currentPage), 'text/html; charset=utf-8'];
    res.setHeader('Content-Type', type);
    res.end(readFileSync(file));
  })
  .listen(PORT);

// ---------- Chrome over the DevTools pipe ----------

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${join(tmp, 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--ignore-certificate-errors',
    `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${PORT}`).join(', ')}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
);
const [, , , toChrome, fromChrome] = chrome.stdio;
let id = 0;
const pending = new Map();
let buf = '';
fromChrome.on('data', (chunk) => {
  buf += chunk.toString();
  for (let i; (i = buf.indexOf('\0')) >= 0; ) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    toChrome.write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + '\0');
  });
const evaluate = async (sessionId, expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};
const attach = async (targetId) => (await send('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;

async function mouse(session, x, y, click) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, session);
  if (!click) return;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, session);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, session);
}

async function screenshot(session, file) {
  const shot = await send('Page.captureScreenshot', { format: 'png' }, session);
  writeFileSync(join(OUT, file), Buffer.from(shot.result.data, 'base64'));
  console.log(`saved store/images/${file}`);
}

try {
  mkdirSync(OUT, { recursive: true });
  const loaded = await send('Extensions.loadUnpacked', { path: EXT });
  if (loaded.error) throw new Error(`Could not load ${EXT}: ${loaded.error.message}. Run node scripts/build.mjs first.`);
  let sw;
  for (let i = 0; i < 40 && !sw; i++) {
    await sleep(250);
    sw = (await send('Target.getTargets')).result.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(loaded.result.id));
  }
  const s = await attach(sw.targetId);
  await sleep(300);
  await evaluate(s, `chrome.storage.local.set({ quicktag_hosts: { 'www.example.com': true, 'staging.example.com': true } })`);

  const p = await attach((await send('Target.createTarget', { url: 'about:blank' })).result.targetId);
  await send('Page.enable', {}, p);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, p);
  const qt = `document.querySelector('quicktag-root').shadowRoot`;
  const centre = async (selector) => {
    const r = await evaluate(p, `(() => { const r = ${qt}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    return r;
  };

  for (const shot of SHOTS) {
    await evaluate(s, `chrome.storage.local.set({ quicktag_ui: ${JSON.stringify({ side: 'right', minimized: false, open: shot.open ?? {} })} })`);
    currentPage = shot.page;
    await send('Page.navigate', { url: shot.url }, p);
    await sleep(1800);
    await mouse(p, 20, 790); // park the pointer away from the panel
    if (shot.scrollToSections) {
      await evaluate(p, `${qt}.querySelector('.body').scrollTop = ${qt}.querySelector('details').offsetTop - ${qt}.querySelector('.body').offsetTop`);
    }
    if (shot.menu) {
      await mouse(p, ...(await centre('.copy-caret')), true);
      await sleep(300);
      await mouse(p, ...(await centre('.menu .menu-item')));
    }
    await sleep(400);
    await screenshot(p, shot.file);
  }

  // Chrome Web Store small promo tile.
  await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 280, deviceScaleFactor: 1, mobile: false }, p);
  currentPage = 'promo.html';
  await send('Page.navigate', { url: 'https://promo.example.com/' }, p);
  await sleep(1000);
  await screenshot(p, 'promo-small-440x280.png');

  copyFileSync(join(ROOT, 'icons', 'icon128.png'), join(OUT, 'store-icon-128.png'));
  console.log('saved store/images/store-icon-128.png');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  server.close();
  await sleep(500);
  rmSync(tmp, { recursive: true, force: true });
}

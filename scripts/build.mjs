// Builds store-ready packages from the shared source:
//   dist/chrome/ + dist/quicktag-chrome-<version>.zip   (Chrome Web Store)
//   dist/firefox/ + dist/quicktag-firefox-<version>.xpi (addons.mozilla.org, or Install Add-on From File)
// manifest.json in the project root works in both browsers for local testing; each store gets a
// manifest with only the keys that browser understands. Run: node scripts/build.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PACKAGE_FILES = ['background.js', 'content.js', 'options.html', 'options.css', 'options.js'];
const PACKAGE_DIRS = ['icons'];

const source = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const targets = {
  chrome: {
    out: `quicktag-chrome-${source.version}.zip`,
    manifest: (m) => {
      delete m.background.scripts; // Chrome uses the service worker
      delete m.browser_specific_settings; // Firefox-only
      return m;
    },
  },
  firefox: {
    out: `quicktag-firefox-${source.version}.xpi`,
    manifest: (m) => {
      delete m.background.service_worker; // Firefox uses background.scripts
      return m;
    },
  },
};

// Store limits worth failing on early.
const problems = [];
if (source.description.length > 132) problems.push(`description is ${source.description.length} chars (Chrome max 132)`);
if (source.name.length > 45) problems.push(`name is ${source.name.length} chars (keep it short for store cards)`);
if (problems.length) {
  console.error(`Manifest problems:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

const files = [...PACKAGE_FILES.map((f) => join(ROOT, f)), ...PACKAGE_DIRS.flatMap((d) => listFiles(join(ROOT, d)))];
const toPosix = (p) => relative(ROOT, p).split('\\').join('/');

// ---------- minimal zip writer (deflate, no dependencies) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed date so builds are reproducible
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset (other fields stay 0)
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------- build ----------

rmSync(DIST, { recursive: true, force: true });
for (const [browser, target] of Object.entries(targets)) {
  const dir = join(DIST, browser);
  const manifest = target.manifest(structuredClone(source));
  const entries = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }];
  for (const file of files) entries.push({ name: toPosix(file), data: readFileSync(file) });

  for (const { name, data } of entries) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  const archive = zip(entries);
  writeFileSync(join(DIST, target.out), archive);
  console.log(`${browser.padEnd(8)} dist/${target.out}  (${entries.length} files, ${(archive.length / 1024).toFixed(1)} KB)`);
}

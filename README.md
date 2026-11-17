# QuickTag – SEO Meta Tag Checker

Press **Alt+Shift+Q** on any page to see its SEO metadata in a panel: title tag, meta description, H1s, canonical, meta robots, heading outline, Open Graph/Twitter tags, hreflang, structured data, and the web app manifest and icons.

Once you switch it on for a site, it **stays on as you browse that site**. Every page you open on that site shows the panel straight away. Press the shortcut again (or click ×) to switch it off for that site.

Works in Chrome (and Edge, Brave, etc.) and Firefox.

## Install

Keep this folder where it is. The browser loads the extension from here.

### Chrome / Edge / Brave

1. Go to `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `quicktag` folder.
4. Optional: click the puzzle-piece icon and pin QuickTag to the toolbar.

It stays installed after Chrome restarts. After you edit the code, click the reload icon on QuickTag's card.

### Firefox

**Quick (temporary, removed when Firefox closes):**
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.

**Permanent, with Firefox Developer Edition:**
1. In `about:config`, set `xpinstall.signatures.required` to `false`.
2. In `about:addons`, click the gear icon, choose **Install Add-on From File…**, and pick `dist/quicktag-firefox-1.0.0.xpi`.

After code changes, rebuild (see below) and repeat step 2.

**Permanent, with regular Firefox:** regular Firefox only installs signed add-ons. Publish it on addons.mozilla.org (see `store/STORE_LISTING.md`), or sign it privately: upload the `.xpi` at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/), choose "On your own", then install the signed file you get back.

## Building the store packages

```bash
node scripts/build.mjs
```

This writes one package per store into `dist/`:
- `dist/quicktag-chrome-1.0.0.zip`: upload to the Chrome Web Store.
- `dist/quicktag-firefox-1.0.0.xpi`: upload to addons.mozilla.org, or install it in Firefox Developer Edition.

`manifest.json` in this folder works in both browsers for local testing. Each package gets a copy with only the entries that browser understands. Bump `version` in `manifest.json` before uploading an update.

## Publishing

Everything for the store forms is in `store/`:
- `store/STORE_LISTING.md`: names, descriptions, permission explanations, privacy answers and reviewer notes, ready to paste.
- `store/images/`: the store icon, four 1280×800 screenshots and Chrome's 440×280 promo tile.
- `store/privacy-policy.html`: the privacy policy. Host it anywhere public (your website, GitHub Pages, Google Sites) and give the stores its address.

If the panel's look changes, regenerate the screenshots with `node scripts/build.mjs` followed by `node store/source/capture.mjs`. This needs Chrome, plus openssl, which comes with Git for Windows.

## Using it

| Action | How |
|---|---|
| Show/hide panel (for the whole site) | **Alt+Shift+Q** or click the toolbar icon |
| Copy everything | **Copy** button, in your default format (see below) |
| Copy in the other format, or the column headings | Arrow next to **Copy** |
| Copy one value | Click a field's label (TITLE, H1, etc.), or the copy icon that appears when you hover a field |
| Settings (copy format, shortcut) | **Settings** in the panel footer, the arrow menu, or right-click the toolbar icon → Options |
| Move the panel to the other side | Panel icon next to Copy |
| Collapse to just the header bar | Up-chevron. The collapsed bar still shows an issue count. |
| Switch off for this site | **×**, or **Esc** while the panel has focus |

The sections below the core fields (Headings, Social tags, Hreflang, Structured data, Manifest & icons, Page info) expand when clicked. QuickTag remembers which ones you left open. The bar under the title and description shows the length: the shaded band is the recommended range.

**Colour flags**

- **Title:** green at 30–60 characters, amber outside that range, red if missing or empty.
- **Description:** green at 70–160 characters, amber outside that range, red if missing.
- **H1:** red if there's none, amber if there's more than one. An H1 that isn't visible on the page is greyed out and tagged *hidden*.
- **Canonical:** green *Self* if it points to the current URL, amber *Other URL* if it points elsewhere, amber if it's missing, red if there's more than one canonical tag.
- **Robots:** red **NOINDEX** or **NOFOLLOW** when the page blocks indexing. This catches staging settings left on after a migration.

### Manifest & icons

This section downloads the page's web app manifest (`<link rel="manifest">`) and every icon it lists, plus the page's `<link rel="icon">` and `apple-touch-icon` files, and compares what each one declares with the real file.

- **Icons:** red **Wrong size** when the image isn't the size its `sizes` says (for example declared 512x512, actually 500×500), and red **Broken** when it doesn't load (404, or a web page instead of an image). Amber for: not square, `type` not matching the real format, a `.ico` missing one of its declared sizes, and `purpose: "any maskable"`. In the manifest, amber also for no `sizes`, or `"any"` on a bitmap.
- **Manifest:** red when it doesn't load or isn't valid JSON. Amber for more than one manifest link, no `name`/`short_name`, no icons, or no 192×192 or 512×512 icon (Chrome needs both to offer installing the site).
- Icon paths in the manifest are resolved against the manifest's address, the way browsers do it, and the panel shows the full resolved path.
- A `.ico` file can hold several sizes; QuickTag reads all of them.

Not every site links its files. While this section is open, QuickTag also looks at the usual places:
- `/site.webmanifest`, `/manifest.json` and `/manifest.webmanifest` if the page has no manifest link. A manifest found there is flagged **Not linked**, because browsers ignore it.
- `/favicon.ico` if the page has no `<link rel="icon">`. Browsers use this file by default, so it isn't an issue; it's only flagged **No favicon** if nothing is there either.

These guesses are only requested while the section is open, so browsing a site with the panel on doesn't send a stream of 404s to it. When they do 404, Chrome logs that in the page's DevTools console.

### Copying to a spreadsheet

There are two formats. Pick your default in Settings; the arrow next to **Copy** always offers both.

- **Two columns** (default; field name | value). Good for checking one old page against one new page: paste the old page into columns A–B and the new page into C–D, then read across.
- **One row per page** (best for building a list of many pages). Each page pastes as a single line. In a new sheet, choose **Copy column headings** from the arrow menu and paste it into row 1. Then on each page, choose **Copy as one row** and paste into the next empty row. Every row lines up under the same headings (URL, Title, Title length, Meta description, …).

The last three fields are **Manifest**, **Manifest icons** and **Page icons** (each icon's declared size and its result, e.g. `512x512: Wrong size (actual 500×500 · PNG)`). They were added after the others and come last so older sheets still line up; copy the column headings again to label them.

Missing tags are written as **(none)**. In two-column mode, numbers (lengths and counts) sit at the right edge of column B in Google Sheets; select column B and press Ctrl+Shift+L to left-align them.

**Migration tip:** keep one sheet for the old site and one for the new site, in the same page order. Or open the old and new pages in side-by-side windows with QuickTag on for both.

### Changing the shortcut

Open **Settings** (panel footer, or right-click the toolbar icon → Options).

- **Firefox:** click **Change shortcut** and press the new keys. **Reset** goes back to Alt+Shift+Q.
- **Chrome / Edge:** these browsers only allow shortcut changes on their own page. Settings has a button that opens it; find QuickTag, click the pencil, press the new keys.

Alt+Shift+Q isn't used by Chrome or Firefox. If another extension already uses it, the browser leaves QuickTag's shortcut blank and you can set one as above.

## Good to know

- **QuickTag shows the live page, after JavaScript has run.** On JavaScript-heavy sites this can differ from the raw HTML source. Single-page apps are tracked as you click around: the panel updates when the URL, title, meta tags or headings change.
- "Site" means the exact hostname, so `www.example.com` and `example.com` are switched on and off separately.
- Browsers don't let extensions run on their own pages (`chrome://`, `about:`, the Chrome Web Store, addons.mozilla.org) or in the built-in PDF viewer.
- QuickTag collects nothing and sends nothing anywhere. It only stores the sites you've switched it on for and your settings, in your browser's extension storage. The only requests it makes are to load the site's own manifest and icon files for the Manifest & icons check.
- A manifest on another domain that doesn't allow cross-origin reads (CORS) can't be checked; the panel says so. Icons on other domains are still measured, but QuickTag can't see their real format or every size inside a `.ico`.
- Chrome may show a warning about Firefox-only manifest keys (`browser_specific_settings`, `background.scripts`). You can ignore it.

## Files

- `manifest.json`: extension manifest (Manifest V3; one manifest works in both browsers)
- `background.js`: handles the shortcut and toolbar click, and messages the page
- `content.js`: reads the metadata and draws the panel (inside a Shadow DOM, so site CSS can't affect it)
- `options.html`, `options.css`, `options.js`: the Settings page
- `icons/`: toolbar and store icons
- `icons/ui/`: the panel's interface icons, exported from the Figma design
- `scripts/build.mjs`: builds the Chrome and Firefox store packages into `dist/`
- `test/icon_fixtures.py`: serves local test sites with deliberately broken manifests and icons (`python3 test/icon_fixtures.py`, then open `http://localhost:8701/`)
- `store/`: store listing text, images, privacy policy, and the sources for the images (`store/source/`)

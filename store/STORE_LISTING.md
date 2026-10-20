# QuickTag store listing kit

Everything to paste into the Chrome Web Store and Firefox Add-ons (AMO) submission forms.
Build the packages first with `node scripts/build.mjs`.

| What | File |
|---|---|
| Chrome package | `dist/quicktag-chrome-1.0.0.zip` |
| Firefox package | `dist/quicktag-firefox-1.0.0.xpi` |
| Store icon (128×128) | `store/images/store-icon-128.png` |
| Screenshots (1280×800) | `store/images/screenshot-1-panel.png` … `screenshot-4-copy.png` |
| Chrome small promo tile (440×280) | `store/images/promo-small-440x280.png` |
| Privacy policy page | `store/privacy-policy.html` (host it, then use its URL) |

---

## Shared text

### Name
```
QuickTag – SEO Meta Tag Checker
```

### Short description
Chrome takes this from the extension itself (123 of 132 characters):
```
Check any page's SEO tags with one shortcut: title, meta description, H1, canonical, robots, headings, hreflang and schema.
```

Firefox summary (up to 250 characters):
```
On-page SEO checker. Press Alt+Shift+Q to see a page's title tag, meta description, H1, canonical, meta robots, headings, hreflang, social tags and structured data, with colour-coded warnings. Built for site migrations and SEO audits.
```

### Full description
Use the same text for both stores.
```
QuickTag is an on-page SEO checker that shows a page's most important tags the moment you need them. Press Alt+Shift+Q, or click the toolbar icon, and a panel shows the title tag, meta description, H1, canonical URL, meta robots and more, with clear colour-coded warnings. No more digging through View Source or developer tools.

It's built for SEO specialists, content teams and developers who check pages all day: website migrations, redesigns, pre-launch QA, technical SEO audits and competitor research.

WHAT QUICKTAG CHECKS
• Title tag: the full text, its character count, and a length bar against the recommended 30–60 characters.
• Meta description: the full text, its character count, and a length bar against the recommended 70–160 characters.
• H1: every H1 on the page, with warnings for a missing H1 or more than one, and hidden H1s marked.
• Canonical URL: whether it points to the page itself or another URL, and warnings when it's missing or duplicated.
• Meta robots and googlebot: NOINDEX and NOFOLLOW are flagged in red, so a leftover staging setting can't slip through.
• Heading outline: every H1–H6 in page order, indented by level, with hidden headings marked.
• Social tags: Open Graph (og:title, og:description, og:image with a preview, og:url, og:type, og:site_name) and Twitter Card tags.
• Hreflang: every language and region alternate, with its URL.
• Structured data: JSON-LD and microdata types, with broken JSON-LD flagged along with the error message.
• Page info: the lang attribute, character set and viewport.

FAST BY DESIGN
• One shortcut: Alt+Shift+Q opens and closes the panel. You can change it in Settings.
• Stays on per site: switch QuickTag on for a website and it appears on every page you open there, so you can click through a site and check each page instantly.
• Live updates: on single-page apps, the panel refreshes as the URL, title, meta tags and headings change.
• Out of your way: move the panel to the left or right, collapse it to a slim bar that still shows the issue count, and open only the sections you need.

COPY RESULTS TO A SPREADSHEET
• Copy as two columns (the default): field names and values, ready to paste into Google Sheets or Excel. Paste the old page and the new page side by side to compare a migration.
• Copy as one row: one line per page, for building a list of pages to audit. Copy the column headings once, then paste each page underneath.
• Copy a single value: click any field's label, or the copy icon next to it.
• Missing tags are written as "(none)", so an empty cell is never mistaken for a failed copy.

PRIVATE BY DESIGN
QuickTag reads the page you're viewing inside your browser, and only on sites where you switch it on. It doesn't collect, store or send your browsing data anywhere: no accounts, no analytics, no tracking. The only things it saves are the list of sites you've switched it on for and your panel settings, kept in your browser.

HOW TO USE
1. Open any web page.
2. Press Alt+Shift+Q (Option+Shift+Q on a Mac), or click the QuickTag icon.
3. Read the results, or click Copy and paste them into your spreadsheet.
4. Press the shortcut again, or click ×, to switch QuickTag off for that site.

QuickTag shows the page as your browser renders it, after JavaScript has run. That's close to what search engines see when they render a page.
```

---

## Chrome Web Store

Developer Dashboard → **Add new item** → upload `dist/quicktag-chrome-1.0.0.zip`.

### Store listing tab
- **Description:** the full description above.
- **Category:** Developer Tools
- **Language:** English
- **Store icon:** `store/images/store-icon-128.png`
- **Screenshots:** the four `screenshot-*.png` files, in order.
- **Small promo tile:** `store/images/promo-small-440x280.png`
- **Marquee promo tile:** leave empty. It's optional and only used if Google features the extension.
- **Official URL / Homepage URL / Support URL:** your website or support page, if you have one.

### Privacy practices tab

**Single purpose description**
```
QuickTag shows the SEO metadata of the web page the user is viewing (title tag, meta description, headings, canonical URL, meta robots, hreflang, social tags and structured data) in an on-page panel, so the user can check it and copy it into a spreadsheet.
```

**Permission justifications**

storage
```
Remembers which websites the user has switched QuickTag on for, so the panel reappears on every page of that site. Also stores the panel layout (left or right side, collapsed or expanded, which sections are open) and the default copy format. Everything is kept locally with chrome.storage.local; nothing is synced or sent anywhere.
```

activeTab
```
When the user presses QuickTag's keyboard shortcut or clicks its toolbar icon on a tab that was already open before QuickTag was installed or updated, activeTab gives temporary access to that one tab so the panel can be shown there.
```

scripting
```
Used together with activeTab to add QuickTag's panel script to the current tab when the user invokes QuickTag on a tab where the script isn't loaded yet, for example a tab opened before installation.
```

Host permission (content script on all sites)
```
QuickTag's single purpose is to inspect the SEO tags of whatever page the user is viewing, on any website, so its content script must be able to run on all sites. The script reads the page's title, meta and link tags, headings and structured data locally to display them in the panel. It stays idle, only checking QuickTag's own on/off setting, until the user switches QuickTag on for that site. Page data is never sent anywhere.
```

**Are you using remote code?** No, I am not using remote code.

**Data usage:** leave every data type unticked. QuickTag only reads page content to display it in your own browser, and never sends it off your device. Then tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** the address where you host `store/privacy-policy.html`.

### Distribution tab
- **Visibility:** Public, or Unlisted if only people with the link should find it.
- **Regions:** All regions.

---

## Firefox Add-ons (addons.mozilla.org)

Developer Hub → **Submit a New Add-on** → **On this site** (listed) → upload `dist/quicktag-firefox-1.0.0.xpi`.

- **Platforms:** Firefox for desktop only. Untick Android, since QuickTag is driven by a keyboard shortcut.
- **Source code:** No. The package contains no minified, bundled or machine-generated code.
- **Name:** QuickTag – SEO Meta Tag Checker
- **Add-on URL:** `quicktag-seo` (or any free slug)
- **Summary:** the Firefox summary above.
- **Description:** the full description above.
- **Categories:** Web Development, Search Tools
- **Tags:** seo, meta tags, title tag, meta description, canonical, h1, hreflang, schema, site migration, seo audit
- **Support email / website:** yours.
- **License:** your choice. "All Rights Reserved" keeps the code yours; MIT lets others reuse it.
- **Privacy policy:** tick "This add-on has a privacy policy" and paste the text of `store/privacy-policy.html` (the section text, without the page title).
- **Screenshots:** the four `screenshot-*.png` files, with these captions:
  1. `QuickTag on a live website: title, description, H1, canonical and robots at a glance.`
  2. `Problems are flagged instantly: NOINDEX, missing description, duplicate H1s and canonical issues.`
  3. `Heading outline, social tags, hreflang and structured data, with broken JSON-LD flagged.`
  4. `Copy every tag into a spreadsheet to compare old and new pages during a migration.`

**Notes to reviewer**
```
QuickTag has no build step and no minified, bundled or third-party code; the files in the package are the source.

To test: open any website (for example https://www.mozilla.org/), then press Alt+Shift+Q or click the QuickTag toolbar button. A panel appears in the top-right corner showing the page's title tag, meta description, H1, canonical, robots and other SEO tags. Press the shortcut again or click × to turn it off for that site.

Settings (keyboard shortcut and default copy format) open from the "Settings" link in the panel footer, or from about:addons → QuickTag → Preferences.

The content script on all sites only reads QuickTag's own on/off setting until the user switches QuickTag on for a site. No data leaves the browser; data_collection_permissions is set to "none".
```

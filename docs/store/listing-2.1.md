# Chrome Web Store listing: version 2.1 (PDF viewer)

Draft for Oscar to review. Nothing here has been entered in the store yet.
Item: `lpoedmhdgkmngpgiodimgefgcglgcbpk`. This file lists only what changes
from `listing.md` (version 2.0); everything not mentioned here stays as it is
in that file.

## What changed against 2.0

- New: PDFs can be marked up, in the extension's own PDF viewer (Mozilla's pdf.js 6.5.438, bundled inside the package).
- New: a review prompt in the extension's window (2nd and 5th open, then every 5th; "Don't ask again" stops it). No network request; a star opens the store's review page.
- Manifest: `host_permissions` added for `http://*/*`, `https://*/*` and `file:///*`.
- Manifest: a second content script, `pdf-grab.js`, on http and https pages. It does nothing unless the tab is showing a PDF.
- Manifest: summary now says "web pages and PDFs".
- Permission warnings: unchanged. Chrome shows the same single warning as 2.0, "Read and change all your data on all websites" (checked with `chrome.management.getPermissionWarningsByManifest` on Chromium 158). Existing users should not be asked to re-approve.
- Storage: marks on a PDF are stored under the PDF's own identity, plus up to 20 addresses it was opened from. PDFs a site only gives to its own tab are cached on the device (newest 20) in the extension's Cache Storage.
- Package size: about 2.6 MB zipped (2.0 was 0.06 MB). Nearly all of it is pdf.js and its fonts, character maps and image decoders.
- Minimum Chrome: still 114. The PDF viewer needs Chrome 147 or later (confirmed against MDN browser-compat-data: Math.sumPrecise 147, Map.getOrInsertComputed 145); on older Chrome, PDFs stay in Chrome's own viewer and web pages work as before.

## 1. Store listing tab

### Summary (from `description` in manifest.json; 129 characters, limit 132)

```
Highlighter and notes for web pages and PDFs. Highlight, underline and annotate text. Auto-saved, with export to Markdown or PDF.
```

Name (from `name` in manifest.json): `Web Page Markup Tool: Highlighter & Notes`

### Description: superseded on 27 Nov 2026

The full rewritten description to paste is in `docs/store/description-2.1.txt`. The two blocks below are the earlier patch-style version and are kept for reference only.

### Description: new block to paste above the "2.0 Updates" block

Change the date to the day it goes live.

```
---
26/11/26 2.1 Updates
+ Mark up PDFs: click the extension's icon on a PDF and choose "Mark up this PDF"
+ Highlights, underlines and notes on PDFs work just like on web pages
+ Your marks stay with the PDF, even if you open it again from a different link or from your computer
+ Print or save the PDF with your marks on the original pages, and your notes listed at the end
+ Optional: always open PDFs in the markup viewer
```

### Description: line to replace further down

Replace:

```
Good to know: PDF files opened in Chrome's own viewer can't be marked up.
```

with:

```
Good to know: PDFs open in the extension's own PDF viewer, which needs Chrome 147 or newer (web pages work on older versions). Scanned PDFs (pictures of pages with no text) can be read and printed, but not marked up. To mark up PDFs saved on your computer, use "Open a file…" in the viewer, or switch on "Allow access to file URLs" for the extension in chrome://extensions.
```

Also in the description, "transforms any webpage into your personal canvas" can stay; it is still true.

### Screenshots

The five 2.0 screenshots still hold. There is no PDF screenshot yet. Adding one (the viewer with a highlight and a margin note) would show the new feature; not made in this round.

## 2. Privacy practices tab

### Single purpose (one change: "on any webpage" became "on any webpage or PDF")

```
This extension has a single purpose: to provide users with tools to permanently annotate and mark up web content.

It allows users to highlight text, underline text, and create persistent notes attached to selected text on any webpage or PDF. All markups are saved locally and automatically reappear when the user revisits a page, effectively turning the web into a personal, annotatable notebook.

The included export functions (copying text, downloading it as a file, saving as PDF) directly serve this single purpose by allowing users to collect and utilize their saved annotations.
```

### Permission justifications

**activeTab**: unchanged from 2.0.

**storage** (changed: PDFs and the review prompt)

```
The storage permission is essential for the core functionality of the extension. It is used to save the user's highlights, underlines, and notes locally on their device using chrome.storage.local. This allows the user's work to persist and automatically reappear when they revisit a previously marked-up page or PDF. For a PDF, the marks are stored under the PDF's own identity together with the addresses it was opened from, so they reappear when the same PDF is opened from another link. When a site only lets its own tab download a PDF, the PDF is kept in the extension's cache on the device (the 20 most recent) so the extension's PDF viewer can show it. The user's preferred highlight colour and the "always open PDFs in the viewer" setting are saved with chrome.storage.sync. The extension also stores how many times its popup was opened, to decide when to ask for a review.
```

**Host permission** (changed: now declared in host_permissions, adds file:///*, and covers the PDF viewer)

```
Host permission for http://*/*, https://*/* and file:///* is required to inject the extension's content scripts (content.js and its helper files, and pdf-grab.js) and stylesheet (styles.css) into webpages, so the user can select text and create highlights, underlines and notes, and so saved markups are redrawn when the page is revisited. The same access lets the extension's built-in PDF viewer open the PDF the user chooses to mark up, from the web or, if the user switches on "Allow access to file URLs", from their computer. pdf-grab.js runs only to detect that a tab is showing a PDF and, when the user asks, to pass that PDF to the viewer.
```

### Remote code

```
No, I am not using remote code.
```

pdf.js is bundled inside the package and pinned to version 6.5.438 (`vendor/pdfjs/VERSION.md`). `eval` is off (`isEvalSupported: false`), PDF JavaScript is not run and XFA forms are off. The only network request is fetching the PDF the user opens in the viewer, the same request Chrome makes to show it. The review prompt's stars open the store's review page in a new tab; nothing is sent.

### Data usage

Tick **none** of the data-collection boxes. The extension does not collect or transmit user data. Highlights and notes stay in `chrome.storage.local` on the user's device, including the addresses a PDF was opened from. PDFs handed over by a site's own tab are cached on the device only (Cache Storage, newest 20). The colour preference and the PDF auto-open setting are in `chrome.storage.sync`, which Chrome itself syncs if the user has sync switched on.

Tick all three certifications (no selling data, no unrelated use, no creditworthiness use).

## 3. Things a reviewer may ask about

**Why `file:///*`?** So the PDF viewer can open a PDF saved on the user's computer. Chrome still blocks it until the user switches on "Allow access to file URLs" for the extension; without that, the viewer says so and offers "Open a file…" (the user picks the file). It adds no install warning.

**Why a second content script on every http/https page?** `pdf-grab.js` checks `document.contentType === 'application/pdf'` and returns at once on every other page. On a PDF tab it answers the popup's "is this a PDF?" question and, only if the user turned on automatic opening or the viewer asks for it, passes the PDF to the extension's viewer.

**Third-party code.** pdf.js from Mozilla, npm package `pdfjs-dist` 6.5.438, Apache-2.0 licence included at `vendor/pdfjs/LICENSE`, decoder licences at `vendor/pdfjs/wasm/LICENSE_*`, checksums in `vendor/pdfjs/VERSION.md`. Files are the published minified build, unchanged.

**WebAssembly.** `vendor/pdfjs/wasm/` holds pdf.js's JPEG 2000, JBIG2 and colour-profile decoders, loaded from the package (no network). The QuickJS scripting engine pdf.js ships is not included.

**Package size jump** (0.06 MB to about 2.6 MB): pdf.js, its standard fonts and its character maps for Chinese, Japanese and Korean PDFs.

**Does it replace Chrome's PDF viewer?** No. Chrome's viewer stays the default. A PDF opens in the extension's viewer only when the user clicks "Mark up this PDF", or after the user switches on "Always open PDFs in the markup viewer" (off by default). The viewer has a link back to Chrome's viewer.

## 4. Before pressing "Submit for review"

- [ ] 2.0 has cleared review and is live (2.1 builds on it).
- [ ] Full browser test run is green, plus the PDF checks.
- [ ] Oscar has loaded the unpacked 2.1 in his own Chrome, marked up one real PDF from the web and one from his computer, and printed one on paper.
- [ ] Summary, 2.1 Updates block and the new "Good to know" line approved.
- [ ] Storage and host-permission justifications pasted.

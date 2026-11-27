Web Page Markup Tool
====================

A Chrome extension for highlighting, underlining and adding notes to text on any web page or PDF. Marks are saved on your own computer and are shown again when you return to the page.

[Get it from the Chrome Web Store](https://chromewebstore.google.com/detail/Web%20Page%20Markup%20Tool/lpoedmhdgkmngpgiodimgefgcglgcbpk?hl=en-GB)

What it does
------------

*   **Mark text.** Select text and a small toolbar appears: five highlight colours, underline, and add note.
*   **Notes belong to their words.** A note is attached to a highlight on the text you selected. Click the mark, or the small pin beside it, to read or edit the note.
*   **Change or remove a mark.** Click any mark to change its colour, switch between highlight and underline, or delete it. Delete has an Undo.
*   **Marks come back.** Each mark is remembered by its words, so it still shows after the site changes its layout. If the words are gone, the mark is listed as "not found" with its note intact; it is never drawn on the wrong text.
*   **Stays readable.** Marks are painted with the text and never move the page. Dark sites get a deeper shade so light text stays readable.
*   **Export.** From the extension's window: copy the page's marks as Markdown (notes included), download them as JSON, or print / save as PDF. In print, highlights keep their colour and notes are listed at the end of the document.
*   **Check this page.** The extension's window reports marks that could not be found, are hidden, or are hard to see.
*   **Keyboard.** `Alt+Shift+H` marks the selected text; `Alt+Shift+N` goes to the next note.
*   **PDFs.** On a PDF, click the extension's icon and choose "Mark up this PDF". It opens in the extension's own PDF viewer, where everything above works the same. Marks stay with the PDF itself, so they are still there if you open the same file from another link or from your computer. Print / save as PDF gives the original pages, at full quality, with your marks on them and the notes listed at the end.

Limits
------

*   PDFs open in the extension's own PDF viewer: click the extension's icon on a PDF and choose "Mark up this PDF", or switch on "Always open PDFs in the markup viewer". PDFs on your computer: use "Open a file…" in the viewer, or switch on "Allow access to file URLs" for the extension in chrome://extensions.
*   Scanned PDFs (pictures of pages, with no text) can be read and printed, but not marked up.
*   Print PDFs with the viewer's Print button or Ctrl+P. Chrome's own menu Print cannot prepare the pages and prints a notice instead.
*   A hyphenated word split across two lines of a PDF is saved joined up ("well-known" may be saved as "wellknown").
*   PDF forms are shown but cannot be filled in. Arabic text in some PDFs cannot be read by the viewer, so it cannot be marked.
*   Marking up PDFs needs Chrome 147 or later (web pages need Chrome 114 or later). On an older Chrome the extension still works on web pages and PDFs stay in Chrome's own viewer.
*   Text inside embedded frames, and text being typed into a form or editor, cannot be marked up.
*   Chrome does not allow extensions on its own pages or on the Chrome Web Store.

Privacy
-------

Highlights and notes are stored in Chrome on your computer (`chrome.storage.local`). Nothing is sent to a server. The preferred colour is kept in Chrome's synced settings.

PDFs: the viewer downloads the PDF you open from the site it is on, the same request Chrome makes to show it. If the site only gives the PDF to its own tab, the tab hands it to the viewer, and the PDF is kept in the extension's cache on your computer (the 20 most recent) so it can be shown again. Marks on a PDF are stored under the PDF's own identity, together with the addresses it was opened from. Nothing is sent anywhere else.

Permissions: `storage`, `activeTab`, host access to http, https and file pages (for the content script and to open PDFs), and content scripts on http and https pages.

How it is built
---------------

Plain JavaScript, HTML and CSS. No build step.

| File | Job |
|---|---|
| `manifest.json` | Extension definition (Manifest V3) |
| `content.js` | Runs on each page: toolbar, note card, painting and re-finding marks |
| `styles.css` | Page-level rules for the marks (CSS Custom Highlight API) and print |
| `ui/styles.js` | Styling for the toolbar, card, pins and toast, applied inside a sealed shadow root |
| `background.js` | The only place that saves data; also converts version 1 data |
| `lib/anchor.js` | Remembers a mark by its words and finds it again |
| `lib/url.js` | Stable page addresses (ignores `#fragments` and tracking parameters) |
| `lib/palette.js` | The five colours and contrast maths |
| `lib/migrate.js` | Version 1 to version 2 data conversion |
| `lib/review.js` | When the extension's window asks for a Chrome Web Store review |
| `popup.html`, `popup.js` | The extension's window |
| `viewer/viewer.html`, `viewer.js`, `viewer.css` | The PDF viewer page: opening a PDF, its identity, the scan check, the print copy |
| `viewer/host.js` | Lets `content.js` work on the PDF viewer's text (marked `// PDF:` in `content.js`) |
| `pdf-grab.js` | Runs on PDF tabs: answers "is this a PDF?", automatic opening, and hands the PDF over when the viewer cannot fetch it |
| `vendor/pdfjs/` | Mozilla's pdf.js 6.5.438, bundled and pinned (Apache-2.0; see `VERSION.md` and `LICENSE`) |

Testing
-------

*   `node --test tests/unit/` runs the unit tests for the `lib/` code.
*   `node tests/run.js` loads the extension in Chromium and runs the browser checks against the sites in `test-sites/`. See `tests/README.md`.
*   The PDF viewer's own checks are in `experiments/pdf-viewer/tests/` (`node experiments/pdf-viewer/tests/make-pdfs.js` once, then `WMT_EXT=. node experiments/pdf-viewer/tests/check.js`) until they move into `tests/`.

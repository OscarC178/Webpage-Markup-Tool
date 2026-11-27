# Browser checks for the Web Page Markup Tool (version 2)

These checks open a real Chromium browser with the extension loaded, mark up a set of test
web pages the way a person would (selecting text with the mouse, pressing the toolbar
buttons, typing a note), and record what worked and what did not, with a picture of each step.

## Run everything (one command)

From the repository folder:

```
npm test
```

(the same as `node tests/run.js`). It takes about 6 to 8 minutes (the PDF check is the longest part). No window appears: the browser
runs hidden. When it finishes it prints a table and the paths of the result files.

First time only, run `npm install` once (it fetches the one library the checks need).

## Run one site

```
node tests/run.js --site docs
```

Site names are the folder names in `test-sites/`, plus `plain-fixture`, the harness's own plain
page. `node tests/run.js --list` shows them all and what each check means. Several sites:
`--site docs,shop`. A one-site run only replaces that site's rows in the results; the other
sites keep their last results.

## Where the results land

Everything is in `tests/output/`:

| File | What it is |
|---|---|
| `review.html` | Open this first. One page with pictures of every site (before, highlighted, underlined, note, after reload, print) and each check's verdict beside them. Click a picture to enlarge it. |
| `results.md` | The site × check table, then the reason for every result in plain English. |
| `results.json` | The same data for programs. |
| `screenshots/<site>/` | One picture per check, named by check letter, e.g. `c-highlight.png`. |
| `print/` | Print output per site: `<site>-print.png` (print layout), `<site>.pdf` (what "Save as PDF" gives by default), `<site>-with-backgrounds.pdf` (with "Background graphics" ticked) and `<site>-before-markup*.pdf` (the untouched page, for comparison). |
| `baseline-v1/` | The record of the old extension (version 1), kept for comparison. Nothing writes to it; leave it alone. |

## Reading the table

- **PASS**: the extension did what was expected.
- **FAIL**: it did not; the reason says what happened instead.
- **GAP**: something the extension leaves alone on purpose (editable regions, web components). Recorded, not counted as a failure.
- **skip**: could not be run on that site, usually because an earlier step failed. The reason says why.
- **n/a**: the check does not apply to that site.
- **ERROR**: the test itself broke. This says nothing about the extension; re-run that site.

The command exits with code 0 when nothing failed, 1 when at least one check failed, 2 when the
runner could not start.

Many checks look at several pieces of text ("targets") on a page. A check passes only when every
target it could test passed, and the reason lists the ones that did not.

## The checks

| Letter | What it proves |
|---|---|
| a | The extension started on the page. |
| b | Selecting text shows the toolbar, on screen and not covered. |
| c, d | A highlight / an underline is painted on exactly the selected words (2 pixel limit), the screen really changed there, and it was saved. |
| e | "Add note" opens a note card; 30 typed characters stay in the same text box; the card says "Saved". |
| f | After a reload everything comes back on the right words, with the note. |
| g | Scrolling and resizing keep every markup on its text, and the note beside it (margin note top-aligned with its first line, or a label at its declared place). |
| h | Clicking marked words opens its card; the bin button deletes it; it stays gone after a reload. |
| i | The popup counts the markups correctly and "Copy as Markdown" copies them all, notes included. |
| j | The extension logged no errors (page script, popup and background worker). |
| k | Marking up moves nothing on the host page (0.5 pixel limit). |
| l | Text under a highlight stays readable (4.5:1) and the highlight can be seen. Measured from screenshot pixels. |
| m | The page's CSS does not restyle the extension's controls, and the extension does not restyle the page. |
| n | The note card, and the note on the page (margin note or label), are on screen, on top, show the note's text, and are clear of their own passage and of other page text. A last-resort label (place d) covering other words is recorded, not failed. |
| o | Print layout and a real saved PDF show the markups on the right words, with the note text. The page's own text in the PDF is word-for-word the same with markups as without (apart from the added note numbers and the notes list). |
| p | PDFs in the extension's own viewer, in ten steps (a to j, see below). |
| q | After deleting, "Undo" puts the markup back. |
| r | Markups still show when the same page is opened with a `#section` or a `?utm_…` tracking link. |
| s | Single-page app: markups stay with their own screen and return when you go back (no reload). |
| t | Data saved by version 1 comes back after the upgrade (highlight, underline, note), old data kept. |
| u | Keyboard only: select, move between buttons, Enter, Escape; typing a note does not trigger the page's shortcuts. |
| v | When the page itself rewrites marked words, the extension says "not found" and never marks other words. |
| x | Notes on the page: click opens the card, hover emphasis both ways, the note hides when its passage leaves an inner scroll box, the "Show notes on the page" switch turns notes into plain pins and back without a reload, two close notes never overlap. Also at a 400px-wide window. |
| y | The popup's "leave a review" panel shows on its 2nd, 5th, 10th and 15th opening only; "Remind me later" keeps asking, a star opens the store's review page in a new tab and stops it, and so does "Don't ask again". Uses its own fresh browser. |
| w | Words and icons on the see-through toolbar and note card keep 4.5:1 contrast over the darkest and lightest parts of the page, and the controls turn solid under "reduce transparency". |

Checks s, t, u, v, w, x and y only run where they make sense (s on `spa`; t, u and y on `plain-fixture`;
v on `feed` and `edge-cases`; w on `news-article`, `dark-dashboard` and `plain-fixture`; x on `news-article`, `docs` and `dark-dashboard`). Check x makes a few extra notes of its own and deletes them again.
Everywhere else they show n/a.

## Check (p): PDFs

Runs on the `pdf-document` site only, in its own browser. Each step has its own verdict and
evidence: look under "Check (p), step by step" in `results.md`, or in `review.html`.

| Step | What it proves |
|---|---|
| a | On Chrome's own PDF tab the popup offers "Mark up this PDF" and it opens the viewer. |
| b | Highlight, underline and note on page 1 and a later page; saved quotes have correct spaces across line ends. |
| c | After a reload all marks return on the right words, including on a page not drawn until scrolled to. |
| d | Through five zoom levels, marks stay within 3 pixels of their words and the note stays beside its passage. |
| e | The popup counts correctly, "Copy as Markdown" has every phrase and note, Source is the PDF's address. |
| f | Printing through the viewer gives a real PDF with the document's pages plus the notes page, the same text, marks on their words and no blank sheets. |
| g | A scanned PDF (no text) says it cannot be marked, and nothing breaks. |
| h | The same file under another address shows the same marks. |
| i | With a needed browser feature removed (a stand-in for an old Chrome), PDFs stay in Chrome's viewer, the popup explains why, and web pages still work. |
| j | The extension logged no errors during a to i. |

The PDFs used are the site's `sample.pdf` and those in `tests/fixtures/pdfs/`: two columns over
three pages, a document with a rotated page, 60 pages, and a scan. `node tests/make-pdfs.js`
makes them again (needs `qpdf`, `pdftoppm` and ImageMagick); you do not normally need to.

How it judges, so a result can be questioned:

- Where the words are comes from `pdftotext` reading the PDF file, not from the extension.
- On screen, "on its words" means each line's painted start, end and middle are within 3 pixels
  of where those words are on the page picture.
- The browser's print dialogue cannot be driven. The check presses the viewer's own print button
  (or Ctrl+P), records what is painted at the moment the viewer asks to print, then saves a PDF
  with "Background graphics" off. That PDF is compared with one printed before any marking.
- On paper, a highlight must cover at least 85% of each marked word's width on every line.
  Underlines are allowed the short breaks browsers leave around letter tails.
- The "old Chrome" is simulated; there is no real old Chrome on this machine.
- Chrome's menu Print, `file://` PDFs, "Open a file...", right-to-left text and forms are not covered.
- The viewer's element names are listed at the top of `tests/lib/pdf-viewer.js`.

## Other options

```
node tests/run.js --headed --jobs 1   # watch it happen in a real window, one site at a time
node tests/run.js --json              # print the results as JSON
node tests/run.js --self-test         # run only the harness's own plain page (tests/fixtures)
node tests/serve.js                   # just serve test-sites/ at http://127.0.0.1:4173
```

The `plain-fixture` row is the quick way to tell "the harness is broken" from "the extension is
broken": on that plain page every check that applies should pass.

## How the extension gets loaded

Chromium at `/usr/bin/chromium` (the system browser; do not run `playwright install`, there are no
downloads for this machine's processor) is started with a fresh throwaway profile and these flags:
`--headless=new --load-extension=<repo> --disable-extensions-except=<repo>`. "New headless" is the
full browser without a window, which is why extensions work in it.

The harness then finds the extension's background worker, reads the extension's id from it, and
switches on the extension's test mode (`wmt:testMode` in its storage) before any page opens. Test
mode lets the harness look inside the extension's controls, which are otherwise sealed.

## Things to know

- Text is selected with a real mouse drag wherever possible. When that cannot work (text under a
  fixed bar, for example) the selection is set in code instead, and the result says so.
- Markups are painted by the browser's highlight feature, not by adding elements to the page. The
  harness reads the list of painted ranges from the browser and also compares before and after
  pictures, so "painted" always means the pixels changed.
- The popup is opened as an ordinary tab and told which page it belongs to, because a test cannot
  click the real toolbar icon. Everything else in the popup is its own code.
- A test cannot press a browser-level shortcut (Alt+Shift+H). Check (u) sends the page the same
  message the browser would send. Chromium also only extends a selection with Shift+Arrow once
  one exists, so (u) starts with a double-clicked word and extends it from the keyboard.
- "Reduce transparency" is switched on through the browser's debugging channel, because the
  test library has no option for it.
- The PDF part of check (o) needs the default hidden mode and the `poppler` tools (`pdftotext`,
  `pdftoppm`), which are installed on this machine.
- The feed site has a ticker that changes every second. Results that depend on the exact moment
  (anything touching the ticker) can differ between runs.

## Changing the checks

- All of the extension's element names (toolbar, buttons, note card, pin, popup), its storage
  layout and its copy format are in one block at the top of `tests/lib/harness.js`. If the
  extension's interface is redesigned, change them there.
- The checks themselves are a list at the bottom of `tests/checks.js`; the comment at the top of
  that file shows how to add one. Pass marks (2 pixel alignment, 4.5:1 contrast and so on) are in
  `LIMITS` in the same file.
- Test sites are listed in `test-sites/sites.json`; adding an entry there is enough for it to be
  run. Extra facts some checks need (app screens for (s), self-changing text for (v), where to run
  (w)) are in `tests/site-extras.json`.
- `tests/fixtures/` holds the harness's own pages: `basic` (plain page), `dark` (plain dark page,
  for the dark look of the controls) and `migrate` (the page the version 1 data in check (t)
  points at).

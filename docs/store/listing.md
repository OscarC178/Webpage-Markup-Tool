# Chrome Web Store listing: version 2.0

Draft for Oscar to review. Nothing here has been entered in the store yet.
Item: `lpoedmhdgkmngpgiodimgefgcglgcbpk`.

## 1. Store listing tab

### Name

```
Web Page Markup Tool
```

### Summary (comes from `description` in manifest.json; 123 characters, limit 132)

```
Highlight, underline and add notes to any web page. Your marks are there when you come back, and export to Markdown or PDF.
```

### Description

Oscar's existing store text, edited only where version 2.0 changes the facts. Every change is listed under the block.

```
---
25/11/26 2.0 Updates
+ New look: pick from five highlight colours right where you select
+ Notes now attach to the text you select and show in the margin beside it
+ Highlights stay readable on dark websites
+ Print and Save as PDF keep your highlights in place and list your notes at the end
+ Copy your marks as Markdown or download them as a file, notes included
+ Marks are found again even when a site changes its layout
+ Keyboard shortcuts: Alt+Shift+H to mark, Alt+Shift+N for the next note
+ Asks for fewer permissions
+ Your existing highlights and notes carry over automatically
---
21/9/25 1.1 Updates
+ Inserted highlight and underline colour customisation
+ Tool now supports Single-Page Application websites (even more pages for you to annotate).
---


Turn the Web Into Your Personal Notebook

We've all been there. You're deep into an amazing article or critical piece of research, and you find a flash of brilliance—a perfect quote, a crucial statistic, a key idea. You promise yourself you'll remember it, but a dozen tabs later, that insight is gone.

What if the web wasn't just for reading, but for thinking? Introducing the Web Page Markup Tool—a simple, powerful extension that transforms any webpage into your personal canvas.

Engage Directly with Content
Effortlessly highlight what matters and underline key phrases to make them pop. Go beyond passive reading and start actively engaging with information. Have a sudden idea or question? Attach a note to any passage to capture your thoughts in the moment. It’s like having a conversation with the content itself.

Never Lose Your Work Again
Here’s where the magic happens: your work is automatically saved. When you return to a page tomorrow, next week, or next year, all your highlights, underlines, and notes will be waiting for you. If a page has changed and a passage is no longer there, your mark and its note are kept and listed for you, never lost.

Gather Your Research in Seconds
When you're ready to consolidate your findings, the toolbar menu makes it easy. Instantly copy all your marked text and notes to your clipboard, download them as a file, or save the entire annotated page as a PDF. Your scattered research from across the web now comes together seamlessly.

Private and Secure, Always
Work with complete peace of mind. Your markups and notes are your own. They are saved only on your local computer and are never collected or seen by anyone else. That's our promise.

Perfect for:

Students: Turning online articles and textbooks into powerful study guides by highlighting key concepts and adding notes for exams.

Researchers: Effortlessly collecting data, quotes, and sources from across the web and exporting them into a single, organized document.

Writers & Professionals: Gathering inspiration, annotating articles, and saving crucial information for reports, client work, or creative projects.

Curious Minds & Lifelong Learners: Building a personal knowledge base and ensuring that valuable insights from their reading are never forgotten.

Good to know: PDF files opened in Chrome's own viewer can't be marked up.

Stop just browsing. Start building your personal library of knowledge, one highlight at a time. Add the Markup Tool to Chrome today and never lose a thought again.
```

What changed from the current store text, and why:

| Change | Reason |
|---|---|
| Added the "2.0 Updates" block | New release. The date is today's; change it to the day it goes live. |
| "Internet Markup Tool" became "Web Page Markup Tool" | The extension's name in Chrome and on the store is Web Page Markup Tool. |
| "Drop a sticky note anywhere on the page" became "Attach a note to any passage" | Notes are no longer free-floating; each belongs to selected text. |
| Removed "exactly as you left them"; added the sentence about changed pages | Marks reappear on their words. If the words are gone they are listed as not found, not redrawn in the old place. |
| "copy all your marked text" became "copy all your marked text and notes ... download them as a file" | Copy now includes notes, and there is a new file download. |
| Added "Good to know: PDF files..." | True of both versions but never stated; saves a confused review. Drop it if you prefer. |

Left as written, although I would not have chosen the words: "powerful", "seamlessly", "magic". They are your voice and still true enough, so I did not touch them.

### Category

Suggested: **Tools** (or the nearest equivalent the dashboard offers). Language: English (United Kingdom).

### Graphics

| Asset | File | Size |
|---|---|---|
| Store icon | `icons/icon128.png` (option C, text cursor on yellow; inside the zip, also upload it in the listing) | 128 × 128 |
| Screenshot 1 | `docs/store/screenshots/1-select-and-mark.png` | 1280 × 800 |
| Screenshot 2 | `docs/store/screenshots/2-colours-and-underline.png` | 1280 × 800 |
| Screenshot 3 | `docs/store/screenshots/3-notes-beside-the-text.png` | 1280 × 800 |
| Screenshot 4 | `docs/store/screenshots/4-readable-on-dark-sites.png` | 1280 × 800 |
| Screenshot 5 | `docs/store/screenshots/5-export-and-check.png` | 1280 × 800 |
| Small promo tile | `docs/store/promo/small-promo-tile-440x280.png` | 440 × 280 |
| Marquee promo tile | `docs/store/promo/marquee-promo-tile-1400x560.png` | 1400 × 560 |

The screenshots show fictional test sites written for this project, not real websites. All images are 24-bit PNG with no alpha.


Size rules: https://developer.chrome.com/docs/webstore/images

## 2. Privacy practices tab

### Single purpose

Oscar's existing text with one factual change: "persistent sticky notes directly on any webpage" became "persistent notes attached to selected text on any webpage", and the export list gained the file download. Everything else is unchanged and still accurate.

```
This extension has a single purpose: to provide users with tools to permanently annotate and mark up web content.

It allows users to highlight text, underline text, and create persistent notes attached to selected text on any webpage. All markups are saved locally and automatically reappear when the user revisits a page, effectively turning the web into a personal, annotatable notebook.

The included export functions (copying text, downloading it as a file, saving as PDF) directly serve this single purpose by allowing users to collect and utilize their saved annotations.
```

### Permission justifications

Oscar's existing answers, edited only where version 2.0 changes the facts. Upload the new package first: the `scripting` and `clipboardWrite` boxes should then disappear from this tab. If they are still shown, clear them.

**activeTab** (changed: the popup now does more than Save as PDF, and printing no longer goes through this permission)

```
The activeTab permission grants the extension temporary, user-invoked access to the currently active tab. When the user opens the popup, it is used to read the address and title of that tab so the popup can show, check, export and print the markups made on that page, without needing broad, persistent access to user tabs.
```

**storage** (changed: one sentence added about the colour preference)

```
The storage permission is essential for the core functionality of the extension. It is used to save the user's highlights, underlines, and notes locally on their device using chrome.storage.local. This allows the user's work to persist and automatically reappear when they revisit a previously marked-up page. The user's preferred highlight colour is saved with chrome.storage.sync.
```

**Host permission** (changed: the pattern is http and https pages, not <all_urls>; file list and "sticky notes" corrected)

```
Host permission for http://*/* and https://*/* is required to inject the extension's content scripts (content.js and its helper files) and stylesheet (styles.css) into webpages. This is the core mechanism that allows the user to select text on any page and use the pop-up toolbar to create highlights, underlines, and notes on the content, and to redraw saved markups when the page is revisited.
```

**scripting**: removed from version 2.0. Printing is now started by the extension's own content script, so chrome.scripting is not used.

**clipboardWrite**: removed from version 2.0. Copying happens when the user clicks the copy button in the popup, which Chrome allows without this permission.

Added to the manifest but **not permissions**, so no justification or warning applies: a background service worker (the single place that saves data) and two keyboard shortcuts (`commands`).

### Remote code

```
No, I am not using remote code.
```

All JavaScript is inside the package. There are no external scripts, no `eval`, and no network requests.

### Data usage

Tick **none** of the data-collection boxes. The extension does not collect or transmit user data. Highlights and notes stay in `chrome.storage.local` on the user's device; the colour preference is in `chrome.storage.sync`, which Chrome itself syncs if the user has sync switched on.

Tick all three certifications (no selling data, no unrelated use, no creditworthiness use).

## 3. Will existing users be asked to re-approve?

Not expected. Chrome disables an updated extension and asks for approval only when the update **adds** a permission that shows a warning ("When a new permission that triggers a warning is added, the extension will be disabled until the user accepts the new permission": https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings). Version 2.0 adds none: it removes two and keeps the same site access.

That page does not describe what happens when permissions are removed, so "no prompt" is the expected result, not a documented guarantee. Check it when the update lands by updating a copy of Chrome that has 1.1 installed.

## 4. Before pressing "Submit for review"

- [ ] Full browser test run of 2.0 is green, including the check that version 1 data converts correctly.
- [ ] Oscar has loaded the unpacked build once in his own Chrome and tried it on a real site.
- [ ] Summary and description above approved.
- [ ] Old `scripting` and `clipboardWrite` justifications removed from the Privacy practices tab.
- [ ] Decide on staged rollout: the dashboard can publish to a percentage of users first, which limits the damage if the data conversion misbehaves for someone.

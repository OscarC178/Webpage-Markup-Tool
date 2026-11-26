/**
 * ui/styles.js
 * All styling for the controls the extension draws on a page (toolbar, note
 * card, pins, toast). It is applied inside a sealed shadow root, so:
 *   - the page's own CSS cannot restyle or hide these controls, and
 *   - nothing here can affect the page.
 * It is a JavaScript string because stylesheets listed in manifest.json do not
 * reach into shadow roots.
 *
 * Look: floating surfaces are translucent "materials" (a tinted, blurred view
 * of the page behind them) with a bright hairline edge, after Apple's
 * materials guidance. Rules followed:
 *   - one translucent layer only: anything the user types into (the note box)
 *     and anything coloured (swatches, the pressed switch) sits on a solid layer;
 *   - bigger surfaces are "thicker": the card is more opaque and casts a
 *     deeper shadow than the small toolbar and pins;
 *   - the tints are opaque enough that text keeps at least 4.5:1 contrast
 *     even over a pure black or pure white page;
 *   - people who ask for less transparency or more contrast, and browsers
 *     without backdrop-filter, get solid surfaces (see the end of the file).
 *
 * Sizes are in px on purpose: inside a shadow root `rem` still follows the
 * host page's root font size, which would let a page shrink or balloon the UI.
 */
(function (root) {
  'use strict';
  const WMT = (root.WMT = root.WMT || {});

  WMT.uiCss = `
/* The host element. !important here beats any page rule aimed at it. */
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  overflow: visible !important;
  display: block !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
}
/* The controls never print; printed notes are handled separately. */
@media print { :host { display: none !important; } }

.wmt {
  /* Design tokens: light theme */
  --solid: #FFFFFF;                          /* opaque surface: fallbacks and the note box */
  --material-thin: rgba(255, 255, 255, .74); /* toolbar, pins, chip */
  --material-thick: rgba(255, 255, 255, .86);/* note card: more text, so more opaque */
  --blur-thin: blur(20px) saturate(180%);
  --blur-thick: blur(32px) saturate(180%);
  --edge: rgba(0, 0, 0, .14);                /* outer hairline */
  --edge-light: inset 0 1px 0 rgba(255, 255, 255, .85), inset 0 0 0 1px rgba(255, 255, 255, .35); /* light catching the rim */
  --hover: rgba(0, 0, 0, .07);
  --press: rgba(0, 0, 0, .13);
  --field-border: rgba(0, 0, 0, .22);
  --divider: rgba(0, 0, 0, .12);
  --text: #18181B;
  --text-muted: #4B4B54;
  --accent: #1D4ED8;
  --danger: #B42318;
  --toast-bg: rgba(28, 28, 31, .84);
  --toast-solid: #1C1C1F;
  --toast-text: #FFFFFF;
  --shadow-sm: 0 4px 14px rgba(0, 0, 0, .14), 0 1px 3px rgba(0, 0, 0, .10);
  --shadow-lg: 0 18px 48px rgba(0, 0, 0, .22), 0 4px 12px rgba(0, 0, 0, .10);

  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --control: 36px;
  --radius-control: 10px;
  --radius-card: 16px;
  --dur-press: 80ms;
  --dur-fast: 120ms;
  --dur-base: 180ms;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);

  font: 400 14px/20px var(--font);
  color: var(--text);
  letter-spacing: 0;
  text-align: left;
  direction: ltr;
}
/* Dark theme: chosen when the page itself is dark. */
.wmt[data-theme="dark"] {
  --solid: #1C1C1F;
  --material-thin: rgba(36, 36, 40, .76);
  --material-thick: rgba(30, 30, 34, .86);
  --edge: rgba(255, 255, 255, .20);
  --edge-light: inset 0 1px 0 rgba(255, 255, 255, .16), inset 0 0 0 1px rgba(255, 255, 255, .05);
  --hover: rgba(255, 255, 255, .11);
  --press: rgba(255, 255, 255, .18);
  --field-border: rgba(255, 255, 255, .28);
  --divider: rgba(255, 255, 255, .14);
  --text: #F4F4F5;
  --text-muted: #BDBDC6;
  --accent: #8AB4FF;
  --danger: #FF8A80;
  --toast-bg: rgba(244, 244, 245, .88);
  --toast-solid: #F4F4F5;
  --toast-text: #18181B;
  --shadow-sm: 0 4px 14px rgba(0, 0, 0, .5), 0 1px 3px rgba(0, 0, 0, .4);
  --shadow-lg: 0 18px 48px rgba(0, 0, 0, .65), 0 4px 12px rgba(0, 0, 0, .4);
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

/* Text for screen readers only. */
.sr-only {
  position: fixed; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}

/* --------------------------------------------------------------- materials */
.toolbar, .pin, .chip {
  background: var(--material-thin);
  -webkit-backdrop-filter: var(--blur-thin); backdrop-filter: var(--blur-thin);
  border: 1px solid var(--edge);
  box-shadow: var(--edge-light), var(--shadow-sm);
}
.card {
  background: var(--material-thick);
  -webkit-backdrop-filter: var(--blur-thick); backdrop-filter: var(--blur-thick);
  border: 1px solid var(--edge);
  box-shadow: var(--edge-light), var(--shadow-lg);
}
.toast {
  background: var(--toast-bg);
  -webkit-backdrop-filter: var(--blur-thin); backdrop-filter: var(--blur-thin);
  box-shadow: var(--shadow-lg);
}

/* ---------------------------------------------------------------- buttons */
button {
  font: inherit; color: inherit; margin: 0; padding: 0;
  background: transparent; border: 0; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: var(--control); height: var(--control);
  border-radius: var(--radius-control);
  transition: background-color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.btn:hover { background: var(--hover); }
.btn:active { background: var(--press); transform: scale(.96); }
.btn:focus-visible, textarea:focus-visible, .pin:focus-visible, .chip:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
.btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.btn.danger { color: var(--danger); }
.btn.text { padding: 0 10px; font-weight: 500; font-size: 13px; }

/* Colour dots: a 20px solid dot inside a 36px target. */
.swatch { border-radius: 999px; }
.swatch::before {
  content: ""; width: 20px; height: 20px; border-radius: 999px;
  background: var(--dot);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .22), inset 0 1px 0 rgba(255, 255, 255, .5);
}
/* The chosen colour: a ring with a clear gap, so it reads on any backdrop. */
.swatch[aria-pressed="true"]::before, .swatch[aria-checked="true"]::before {
  outline: 2px solid var(--text); outline-offset: 2px;
}

/* ---------------------------------------------------------------- toolbar */
.toolbar, .card, .toast, .chip, .pin, .tooltip { pointer-events: auto; }

.toolbar {
  position: fixed; left: 0; top: 0;
  display: flex; align-items: center; gap: 2px; padding: 4px;
  border-radius: 999px;
  animation: wmt-in-thin var(--dur-base) var(--ease-out);
}
.toolbar .btn { border-radius: 999px; }
.divider { width: 1px; height: 20px; margin: 0 4px; background: var(--divider); }

.tooltip {
  position: fixed; left: 0; top: 0; pointer-events: none;
  padding: 4px 8px; border-radius: 8px;
  background: var(--toast-solid); color: var(--toast-text);
  font-size: 12px; line-height: 16px; font-weight: 500; white-space: nowrap;
}

/* ------------------------------------------------------------------- pins */
.pin {
  position: fixed; left: 0; top: 0; width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px; color: var(--text);
}
/* The visible pin is 20px; this enlarges the clickable area to 36px. */
.pin::after { content: ""; position: absolute; inset: -8px; }
.pin svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }

/* Fallback label (no free gutter): the pin shows the start of the note and
   expands to the whole note on hover or focus. The colour bar on its left
   ties it to its passage. */
.pin.label {
  width: auto; height: auto; max-width: 220px; min-height: 22px;
  padding: 2px 8px 2px 12px; border-radius: 8px;
  justify-content: flex-start; text-align: left;
  font-size: 12px; line-height: 16px; font-weight: 500;
  animation: wmt-fade var(--dur-base) var(--ease-out);
}
.pin.label::before {
  content: ""; position: absolute; left: 4px; top: 4px; bottom: 4px; width: 3px;
  border-radius: 2px; background: var(--bar);
}
.pin.label::after { inset: -4px; }
.pin.label .short { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pin.label .full, .pin.label .tiny, .pin.label svg { display: none; }
/* Compact form (last resort, when it may sit over page words): icon + 12 characters. */
.pin.label.compact { gap: 4px; }
.pin.label.compact .short { display: none; }
.pin.label.compact svg { display: block; flex: none; }
.pin.label.compact .tiny { display: block; white-space: nowrap; }
.pin.label:hover, .pin.label:focus-visible { max-width: 280px; z-index: 1; }
.pin.label:hover .short, .pin.label:focus-visible .short,
.pin.label:hover .tiny, .pin.label:focus-visible .tiny,
.pin.label:hover svg, .pin.label:focus-visible svg { display: none; }
.pin.label:hover .full, .pin.label:focus-visible .full {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 12; overflow: hidden;
  white-space: pre-wrap; overflow-wrap: anywhere;
}

/* ----------------------------------------------------------- margin notes */
/* A note shown in the free space beside its passage. One translucent layer,
   the same thin material as the pins. */
.margin-note {
  position: fixed; left: 0; top: 0; width: 240px;
  display: block; padding: 8px 10px 8px 16px;
  border-radius: 10px; color: var(--text); text-align: left;
  font-size: 13px; line-height: 18px; font-weight: 450;
  background: var(--material-thin);
  -webkit-backdrop-filter: var(--blur-thin); backdrop-filter: var(--blur-thin);
  border: 1px solid var(--edge);
  box-shadow: var(--edge-light), var(--shadow-sm);
  pointer-events: auto;
  animation: wmt-fade var(--dur-base) var(--ease-out);
}
/* Colour bar matching the mark. */
.margin-note::before {
  content: ""; position: absolute; left: 6px; top: 8px; bottom: 8px; width: 3px;
  border-radius: 2px; background: var(--bar);
}
/* Up to six lines, then an ellipsis. */
.mn-text {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
/* Narrow gutter (under 176px): allow eight lines. */
.margin-note.narrow .mn-text { -webkit-line-clamp: 8; }
.margin-note:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* Hovering the note or its passage: a ring in the mark's colour. */
.margin-note:hover, .margin-note.is-emph, .pin.is-emph {
  box-shadow: var(--edge-light), var(--shadow-sm), 0 0 0 2px var(--bar);
}
/* Outline drawn around the passage while its note is hovered or focused. */
.emph-ring {
  position: fixed; left: 0; top: 0; pointer-events: none;
  border: 2px solid var(--bar); border-radius: 4px;
  animation: wmt-fade var(--dur-fast) var(--ease-out);
}
@keyframes wmt-fade { from { opacity: 0; } to { opacity: 1; } }

/* ------------------------------------------------------------------- card */
.card {
  position: fixed; left: 0; top: 0; width: 280px; max-width: calc(100vw - 16px);
  border-radius: var(--radius-card);
  animation: wmt-in-thick var(--dur-base) var(--ease-out);
}
.card-head {
  display: flex; align-items: center; height: 44px; padding: 0 4px 0 14px;
  border-bottom: 1px solid var(--divider);
}
/* Text on a translucent surface: a touch heavier, never flat grey. */
.card-title { flex: 1; font-weight: 600; font-size: 14px; margin: 0; }
.card-body { padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 -8px; }
.controls { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.controls .swatches { margin: 0 -8px; }
.swatches { display: flex; }

/* Highlight | Underline switch: a recessed track with a solid thumb. */
.seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 10px; background: var(--hover); }
.seg button { height: 30px; padding: 0 12px; font-size: 13px; font-weight: 500; border-radius: 8px;
  transition: background-color var(--dur-fast) var(--ease-out); }
.seg button:hover { background: var(--hover); }
.seg button[aria-pressed="true"] { background: var(--solid); box-shadow: 0 1px 3px rgba(0, 0, 0, .18), 0 0 0 0.5px var(--edge); }
.seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* The note box is a solid layer: typed text never sits on a see-through surface. */
textarea {
  display: block; width: 100%; min-height: 76px; max-height: 180px; resize: vertical;
  padding: 8px 10px; margin: 0;
  font: inherit; color: var(--text); background: var(--solid);
  border: 1px solid var(--field-border); border-radius: var(--radius-control);
}
textarea::placeholder { color: var(--text-muted); opacity: 1; }
.status { min-height: 16px; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--text-muted); text-align: right; }

/* Unattached notes list */
.orphan-list { max-height: 50vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.orphan { border-top: 1px solid var(--divider); padding-top: 8px; }
.orphan:first-child { border-top: 0; padding-top: 0; }
.orphan q { display: block; color: var(--text-muted); font-size: 13px; line-height: 18px; font-weight: 500; overflow-wrap: anywhere; }
.orphan p { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.orphan .row { justify-content: flex-end; margin: 4px -8px 0; }
.muted { color: var(--text-muted); font-size: 13px; line-height: 18px; font-weight: 500; margin: 0; }

/* ------------------------------------------------------------ toast, chip */
.toast {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 16px; min-height: 44px;
  max-width: calc(100vw - 32px);
  color: var(--toast-text);
  border-radius: 999px;
  font-size: 14px; line-height: 20px; font-weight: 500;
}
.toast .msg { padding: 8px 10px 8px 0; }
.toast .btn { color: var(--toast-text); border-radius: 999px; text-decoration: underline; text-underline-offset: 3px; }
.toast .btn:hover, .toast .btn:active { background: rgba(127, 127, 127, .35); }
.toast .btn:focus-visible { outline-color: var(--toast-text); }

.chip {
  position: fixed; right: 16px; bottom: 16px; height: 36px; padding: 0 14px;
  color: var(--text); border-radius: 999px;
  font-size: 13px; font-weight: 500;
  transition: transform var(--dur-press) var(--ease-out);
}
.chip:active { transform: scale(.97); }

/* Materialise: the surface scales up while its blur arrives, so it reads as
   a material appearing, not a flat fade. */
@keyframes wmt-in-thin {
  from { opacity: 0; transform: scale(.94); -webkit-backdrop-filter: blur(0); backdrop-filter: blur(0); }
  to   { opacity: 1; transform: scale(1); -webkit-backdrop-filter: var(--blur-thin); backdrop-filter: var(--blur-thin); }
}
@keyframes wmt-in-thick {
  from { opacity: 0; transform: scale(.96); -webkit-backdrop-filter: blur(0); backdrop-filter: blur(0); }
  to   { opacity: 1; transform: scale(1); -webkit-backdrop-filter: var(--blur-thick); backdrop-filter: var(--blur-thick); }
}

/* People who ask for less motion get a plain fade and no scaling. */
@media (prefers-reduced-motion: reduce) {
  @keyframes wmt-in-thin { from { opacity: 0; } to { opacity: 1; } }
  @keyframes wmt-in-thick { from { opacity: 0; } to { opacity: 1; } }
  .btn:active, .chip:active { transform: none; }
}

/* Solid surfaces for people who ask for less transparency or more contrast. */
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .toolbar, .pin, .chip, .card, .margin-note { background: var(--solid); -webkit-backdrop-filter: none; backdrop-filter: none; }
  .toast { background: var(--toast-solid); -webkit-backdrop-filter: none; backdrop-filter: none; }
  .toolbar, .card { animation-name: wmt-in-solid; }
}
@keyframes wmt-in-solid { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-contrast: more) {
  .wmt { --edge: var(--text); --divider: var(--text); --field-border: var(--text); --edge-light: 0 0 0 0 transparent; }
}
/* Browsers without backdrop-filter: same solid fallback. */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .toolbar, .pin, .chip, .card, .margin-note { background: var(--solid); }
  .toast { background: var(--toast-solid); }
}
@media (forced-colors: active) {
  .swatch::before { forced-color-adjust: none; }
}
`;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/**
 * tests/lib/colour.js
 * Colour maths for the legibility check: parsing CSS colours, stacking
 * semi-transparent layers, blend modes and the WCAG contrast ratio.
 *
 * Colours are plain objects {r, g, b, a} with r/g/b in 0..255 and a in 0..1.
 */

/** Parse what getComputedStyle returns: "rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)" or "color(srgb 0.1 0.2 0.3 / 0.5)". */
function parseColour(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
  if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  return null; // oklch(), lab() etc. are not handled; callers fall back to measured pixels
}

/**
 * Paint `top` over an opaque `bottom` colour.
 * mode 'normal' is ordinary transparency; 'multiply' darkens (like a highlighter pen on paper).
 */
function layer(bottom, top, mode = 'normal') {
  const a = top.a;
  const mix = (cb, cs) => {
    const blended = mode === 'multiply' ? (cb * cs) / 255 : cs;
    return cb * (1 - a) + blended * a;
  };
  return { r: mix(bottom.r, top.r), g: mix(bottom.g, top.g), b: mix(bottom.b, top.b), a: 1 };
}

/** Flatten a stack of background colours (innermost first, as page-helpers returns them) onto a white canvas. */
function flattenBackgrounds(cssColours) {
  let result = { r: 255, g: 255, b: 255, a: 1 }; // browsers paint white under everything
  for (const css of cssColours.slice().reverse()) {
    const c = parseColour(css);
    if (!c) return null; // a colour format we cannot parse
    if (c.a > 0) result = layer(result, c);
  }
  return result;
}

/** WCAG 2.x relative luminance of an opaque colour. */
function luminance(c) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between two opaque colours: 1 (identical) to 21 (black on white). */
function contrast(c1, c2) {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Convert to CIE L*a*b* (D65), the usual space for "how different do two colours look". */
function toLab(c) {
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const r = lin(c.r);
  const g = lin(c.g);
  const b = lin(c.b);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return { L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/**
 * Delta E (CIE76): perceived difference between two colours.
 * Roughly: under 2 is invisible, 2-10 is noticeable at a glance only side by side, over 10 is clearly different.
 */
function deltaE(c1, c2) {
  const a = toLab(c1);
  const b = toLab(c2);
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

/** "rgb(12, 34, 56)" for reports. */
function show(c) {
  return c ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : 'unknown';
}

/** Straight-line distance between two colours in RGB space (0 to about 441). */
function distance(c1, c2) {
  return Math.sqrt((c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2);
}

/**
 * Summarise the pixels of a small picture of some text:
 *  - background = the most common colour
 *  - text       = the colour that contrasts most with the background, ignoring
 *                 the rarest few pixels (so one stray pixel cannot decide it)
 * @param {{width:number,height:number,data:Buffer,channels:number}} img decoded image (see png.js)
 */
function summarisePixels(img) {
  const counts = new Map();
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * img.channels;
    // Round to steps of 4 so near-identical shades count as one colour.
    const key = ((img.data[o] >> 2) << 16) | ((img.data[o + 1] >> 2) << 8) | (img.data[o + 2] >> 2);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const toColour = (key) => ({ r: ((key >> 16) & 63) * 4 + 2, g: ((key >> 8) & 63) * 4 + 2, b: (key & 63) * 4 + 2, a: 1 });
  let bgKey = null;
  let bgCount = -1;
  for (const [k, c] of counts) if (c > bgCount) { bgKey = k; bgCount = c; }
  const background = toColour(bgKey);
  // Rank every other colour by contrast against the background; take the strongest that still
  // covers a meaningful number of pixels (at least 1% of the non-background pixels, minimum 3).
  const others = [];
  let otherTotal = 0;
  for (const [k, c] of counts) {
    if (k === bgKey) continue;
    others.push({ colour: toColour(k), count: c, contrast: contrast(toColour(k), background) });
    otherTotal += c;
  }
  others.sort((a, b) => b.contrast - a.contrast);
  const need = Math.max(3, otherTotal * 0.01);
  let acc = 0;
  let text = null;
  for (const o of others) {
    acc += o.count;
    if (acc >= need) { text = o; break; }
  }
  return {
    background,
    backgroundShare: bgCount / n,
    text: text ? text.colour : null,
    contrast: text ? text.contrast : 1,
    pixels: n,
  };
}

module.exports = { toLab, deltaE, parseColour, layer, flattenBackgrounds, luminance, contrast, show, distance, summarisePixels };

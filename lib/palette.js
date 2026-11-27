/**
 * lib/palette.js
 * The five markup colours and the colour maths used to keep text readable.
 *
 * Each colour has:
 *   light: fill used on light pages (dark text stays readable on it)
 *   dark:  fill used on dark pages (light text stays readable on it)
 *   ink:   underline colour on light pages (the `light` fill is the underline on dark pages)
 * styles.css holds the matching ::highlight() rules; keep the two in step.
 */
(function (root) {
  'use strict';

  const WMT = (root.WMT = root.WMT || {});

  const COLOURS = {
    yellow: { label: 'yellow', light: '#FFE566', dark: '#806600', ink: '#B58900' },
    green:  { label: 'green',  light: '#A8E6A1', dark: '#2F7D3B', ink: '#2E9E44' },
    blue:   { label: 'blue',   light: '#A5D4FF', dark: '#2C6CC4', ink: '#2F7FE0' },
    pink:   { label: 'pink',   light: '#FFB3D1', dark: '#B8336F', ink: '#E0408A' },
    purple: { label: 'purple', light: '#D4BBFF', dark: '#7448C9', ink: '#8E5CE6' },
  };
  const NAMES = Object.keys(COLOURS);
  const DEFAULT = 'yellow';

  // Text colours forced onto a highlight when the page's own text would be unreadable.
  const MARK_TEXT_DARK = '#1B1B1F';
  const MARK_TEXT_LIGHT = '#FFFFFF';

  /** "#rrggbb" -> [r, g, b] */
  function hexToRgb(hex) {
    const h = String(hex).replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  /** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" -> {r, g, b, a} or null */
  function parseCssColour(str) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(String(str || ''));
    if (!m) return null;
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }

  /** WCAG relative luminance, 0 (black) to 1 (white). */
  function luminance(r, g, b) {
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function hexLuminance(hex) {
    return luminance(...hexToRgb(hex));
  }

  /** WCAG contrast ratio between two luminances (1 to 21). */
  function contrast(l1, l2) {
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** Hue in degrees (0-360) and saturation (0-1) of an RGB colour. */
  function hueSat(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return { h: 0, s: 0 };
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    return { h, s: d / max };
  }

  /**
   * Map any old free-choice colour (version 1 let users pick any hex) to the
   * nearest of the five, by hue. Greys and invalid values become the default.
   */
  function nearestColour(hex, fallback) {
    if (!/^#[0-9a-f]{6}$/i.test(String(hex || ''))) return fallback || DEFAULT;
    const { h, s } = hueSat(...hexToRgb(hex));
    if (s < 0.1) return fallback || DEFAULT;
    let best = DEFAULT;
    let bestDist = Infinity;
    for (const name of NAMES) {
      const ref = hueSat(...hexToRgb(COLOURS[name].light)).h;
      const dist = Math.min(Math.abs(h - ref), 360 - Math.abs(h - ref));
      if (dist < bestDist) { bestDist = dist; best = name; }
    }
    return best;
  }

  function isColour(name) {
    return Object.prototype.hasOwnProperty.call(COLOURS, name);
  }

  WMT.palette = {
    COLOURS, NAMES, DEFAULT, MARK_TEXT_DARK, MARK_TEXT_LIGHT,
    hexToRgb, parseCssColour, luminance, hexLuminance, contrast, nearestColour, isColour,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = WMT.palette;
})(typeof globalThis !== 'undefined' ? globalThis : this);

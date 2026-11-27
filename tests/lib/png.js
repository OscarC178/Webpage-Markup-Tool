/**
 * tests/lib/png.js
 * Minimal image readers with no dependencies, enough for the two formats the
 * harness produces:
 *   - PNG screenshots from Chromium (8-bit RGB or RGBA, not interlaced)
 *   - PPM pictures from `pdftoppm` (binary "P6")
 * Both return { width, height, channels, data } where data is a Buffer of
 * channels bytes per pixel, row by row from the top-left.
 */

const zlib = require('zlib');

/** Decode a PNG buffer. Throws on formats Chromium never produces (palette, 16-bit, interlaced). */
function decodePng(buf) {
  const signature = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== signature) throw new Error('not a PNG file');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colourType = body[9];
      if (depth !== 8 || (colourType !== 2 && colourType !== 6) || body[12] !== 0) {
        throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${colourType}, interlace ${body[12]})`);
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + body + checksum
  }
  const channels = colourType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  // Each row starts with a "filter" byte saying how the row was stored relative to its neighbours.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[rowOut + x - channels] : 0;
      const up = y > 0 ? data[rowOut - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[rowOut - stride + x - channels] : 0;
      let v = raw[rowIn + x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      data[rowOut + x] = v & 255;
    }
  }
  return { width, height, channels, data };
}

/** Decode a binary PPM ("P6", 8-bit) as written by pdftoppm. */
function decodePpm(buf) {
  // Header: "P6\n<width> <height>\n<maxval>\n" then raw RGB bytes. Comments (#...) may appear.
  let pos = 0;
  const token = () => {
    for (;;) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
      if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; }
      break;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    return buf.toString('ascii', start, pos);
  };
  if (token() !== 'P6') throw new Error('not a binary PPM file');
  const width = parseInt(token(), 10);
  const height = parseInt(token(), 10);
  const maxval = parseInt(token(), 10);
  if (maxval !== 255) throw new Error('unsupported PPM depth');
  pos += 1; // the single whitespace byte after maxval
  return { width, height, channels: 3, data: buf.subarray(pos, pos + width * height * 3) };
}

/** Cut a rectangle out of a decoded image (clamped to the image edges). Returns null if nothing is left. */
function crop(img, x, y, w, h) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w));
  const y1 = Math.min(img.height, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return null;
  const width = x1 - x0;
  const height = y1 - y0;
  const data = Buffer.alloc(width * height * img.channels);
  for (let row = 0; row < height; row++) {
    const from = ((y0 + row) * img.width + x0) * img.channels;
    img.data.copy(data, row * width * img.channels, from, from + width * img.channels);
  }
  return { width, height, channels: img.channels, data };
}

module.exports = { decodePng, decodePpm, crop };

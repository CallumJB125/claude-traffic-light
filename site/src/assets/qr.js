// A small QR code encoder: byte mode, error correction level M, versions 1–10
// (enough for a URL of up to ~210 bytes). Follows ISO/IEC 18004. UMD: the site
// build inlines the result as an SVG, and a test decodes it with zbar.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlexiformQR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // level M, versions 1..10
  const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

  const rawModules = (v) => {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const a = Math.floor(v / 7) + 2; r -= (25 * a - 10) * a - 55; if (v >= 7) r -= 36; }
    return r;
  };
  const dataCodewords = (v) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * NUM_BLOCKS[v];
  const bit = (x, i) => ((x >>> i) & 1) !== 0;

  // Reed–Solomon over GF(256) with polynomial 0x11D
  function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i -= 1) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
  function rsDivisor(degree) {
    const r = new Array(degree).fill(0); r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i += 1) { for (let j = 0; j < r.length; j += 1) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; } root = gfMul(root, 0x02); }
    return r;
  }
  function rsRemainder(data, divisor) {
    const r = new Array(divisor.length).fill(0);
    for (const b of data) { const f = b ^ r.shift(); r.push(0); divisor.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
    return r;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 1;
    for (; ver <= 10; ver += 1) { const cc = ver < 10 ? 8 : 16; if (4 + cc + bytes.length * 8 <= dataCodewords(ver) * 8) break; }
    if (ver > 10) throw new Error('text too long for this encoder');
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1); };
    push(0b0100, 4); push(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => push(b, 8));
    const cap = dataCodewords(ver) * 8;
    push(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // split into blocks, add error correction, interleave
    const nb = NUM_BLOCKS[ver]; const eccLen = ECC_PER_BLOCK[ver]; const raw = Math.floor(rawModules(ver) / 8);
    const shortBlocks = nb - (raw % nb); const shortLen = Math.floor(raw / nb);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < nb; i += 1) { const d = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1)); k += d.length; const e = rsRemainder(d, div); if (i < shortBlocks) d.push(0); blocks.push(d.concat(e)); }
    const all = [];
    for (let i = 0; i < blocks[0].length; i += 1) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) all.push(b[i]); });

    const size = ver * 4 + 17;
    const grid = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { grid[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) { const d = Math.max(Math.abs(dx), Math.abs(dy)); const x = cx + dx; const y = cy + dy; if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4); } };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const na = ver === 1 ? 0 : Math.floor(ver / 7) + 2;
    const pos = [];
    if (na) { const step = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2; pos.push(6); for (let p = size - 7; pos.length < na; p -= step) pos.splice(1, 0, p); }
    pos.forEach((px, i) => pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const formatBits = (mask) => { const d = (0 << 3) | mask; let r = d; for (let i = 0; i < 10; i += 1) r = (r << 1) ^ ((r >>> 9) * 0x537); return ((d << 10) | r) ^ 0x5412; };
    const drawFormat = (mask) => {
      const b = formatBits(mask);
      for (let i = 0; i <= 5; i += 1) set(8, i, bit(b, i));
      set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
      for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(b, i));
      for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(b, i));
      for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(b, i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let r = ver; for (let i = 0; i < 12; i += 1) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      const b = (ver << 12) | r;
      for (let i = 0; i < 18; i += 1) { const a = size - 11 + (i % 3); const c = Math.floor(i / 3); set(a, c, bit(b, i)); set(c, a, bit(b, i)); }
    }
    // data, in the zigzag
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v += 1) for (let j = 0; j < 2; j += 1) {
        const x = right - j; const up = ((right + 1) & 2) === 0; const y = up ? size - 1 - v : v;
        if (!fn[y][x] && k < all.length * 8) { grid[y][x] = bit(all[k >>> 3], 7 - (k & 7)); k += 1; }
      }
    }
    const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
    // runs of five or more, in rows and columns, is the part of the penalty that matters most
    const penalty = (g) => { let p = 0; for (let a = 0; a < size; a += 1) for (const horiz of [true, false]) { let run = 1; for (let b = 1; b < size; b += 1) { const cur = horiz ? g[a][b] : g[b][a]; const prev = horiz ? g[a][b - 1] : g[b - 1][a]; if (cur === prev) { run += 1; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1; } } return p; };
    let best = null;
    for (let m = 0; m < 8; m += 1) {
      const g = grid.map((row, y) => row.map((v, x) => (fn[y][x] ? v : v !== MASKS[m](x, y))));
      const p = penalty(g);
      if (!best || p < best.p) best = { m, g, p };
    }
    drawFormat(best.m);
    // the format bits were drawn into `grid`; copy them into the masked result
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (fn[y][x]) best.g[y][x] = grid[y][x];
    return { size, version: ver, modules: best.g };
  }

  // an SVG string: one path, dark modules only, with the quiet zone
  function toSvg(text, { quiet = 4, dark = '#15171c', light = '#ffffff', label = '' } = {}) {
    const { size, modules } = encode(text);
    const n = size + quiet * 2;
    let d = '';
    for (let y = 0; y < size; y += 1) { let x = 0; while (x < size) { if (!modules[y][x]) { x += 1; continue; } let w = 1; while (x + w < size && modules[y][x + w]) w += 1; d += `M${x + quiet} ${y + quiet}h${w}v1h${-w}z`; x += w; } }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }
  return { encode, toSvg };
});

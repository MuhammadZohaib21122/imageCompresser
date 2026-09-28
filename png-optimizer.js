/* imageCompresser indexed PNG encoder. No external services or libraries required.
   Quantization is optional/lossy; for <=256 unique colors a lossless indexed
   candidate is produced first. PNG data uses the browser's DeflateStream. */
(function (root) {
  'use strict';
  const encoder = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function put32(a, at, v) {
    a[at] = v >>> 24; a[at + 1] = v >>> 16; a[at + 2] = v >>> 8; a[at + 3] = v;
  }
  function chunk(name, data) {
    const out = new Uint8Array(data.length + 12);
    put32(out, 0, data.length);
    out.set(encoder.encode(name), 4);
    out.set(data, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < out.length - 4; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8);
    put32(out, out.length - 4, (crc ^ 0xffffffff) >>> 0);
    return out;
  }
  function concat(parts) {
    const size = parts.reduce((n, p) => n + p.length, 0);
    const result = new Uint8Array(size);
    let position = 0;
    for (const p of parts) { result.set(p, position); position += p.length; }
    return result;
  }
  function colorKey(r, g, b, a) {
    // Fully transparent pixels can share one palette entry (invisible RGB).
    if (!a) return 0;
    return ((((r << 8) | g) << 8 | b) << 8 | a) >>> 0;
  }
  function gather(imageData) {
    const pixels = imageData.data;
    const exact = new Map();
    let losslessPossible = true;
    // Sample up to 320K pixels for the palette; encode every pixel afterwards.
    const stride = Math.max(1, Math.floor(pixels.length / 4 / 320000));
    const histogram = new Map();
    for (let p = 0; p < pixels.length; p += 4) {
      const a = pixels[p + 3], r = a ? pixels[p] : 0, g = a ? pixels[p + 1] : 0, b = a ? pixels[p + 2] : 0;
      if (losslessPossible) {
        const key = colorKey(r, g, b, a);
        if (!exact.has(key)) {
          if (exact.size === 256) { losslessPossible = false; exact.clear(); }
          else exact.set(key, [r, g, b, a]);
        }
      }
      if ((p >>> 2) % stride !== 0) continue;
      // 4-bit histogram bins cap memory use, but palette representatives use
      // the original (unrounded) source colors.
      const key = ((r >>> 4) << 12) | ((g >>> 4) << 8) | ((b >>> 4) << 4) | (a >>> 4);
      let entry = histogram.get(key);
      if (!entry) { entry = { r: 0, g: 0, b: 0, a: 0, n: 0 }; histogram.set(key, entry); }
      entry.r += r; entry.g += g; entry.b += b; entry.a += a; entry.n++;
    }
    const points = Array.from(histogram.values(), x => ({ r: x.r / x.n, g: x.g / x.n, b: x.b / x.n, a: x.a / x.n, n: x.n }));
    return { exact: losslessPossible ? Array.from(exact.values()) : null, points };
  }
  function medianCut(points, wanted) {
    const boxes = [{ points, weight: points.reduce((s, p) => s + p.n, 0) }];
    while (boxes.length < wanted) {
      let bestIndex = -1, bestChannel = '', bestScore = -1;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.points.length < 2) continue;
        let channel = 'r', spread = -1;
        for (const ch of ['r', 'g', 'b', 'a']) {
          let min = 255, max = 0;
          for (const p of box.points) { min = Math.min(min, p[ch]); max = Math.max(max, p[ch]); }
          const delta = (max - min) * (ch === 'a' ? 1.6 : 1);
          if (delta > spread) { spread = delta; channel = ch; }
        }
        const score = spread * Math.sqrt(box.weight);
        if (score > bestScore) { bestScore = score; bestIndex = i; bestChannel = channel; }
      }
      if (bestIndex < 0 || bestScore <= 0) break;
      const box = boxes[bestIndex];
      box.points.sort((a, b) => a[bestChannel] - b[bestChannel]);
      let count = 0, split = 0;
      for (; split < box.points.length - 1; split++) {
        count += box.points[split].n;
        if (count >= box.weight / 2) { split++; break; }
      }
      split = Math.max(1, Math.min(box.points.length - 1, split));
      const a = box.points.slice(0, split), b = box.points.slice(split);
      boxes.splice(bestIndex, 1, { points: a, weight: count }, { points: b, weight: box.weight - count });
    }
    return boxes.map(box => {
      const total = [0, 0, 0, 0];
      for (const p of box.points) {
        total[0] += p.r * p.n; total[1] += p.g * p.n;
        total[2] += p.b * p.n; total[3] += p.a * p.n;
      }
      return total.map(v => Math.round(v / box.weight));
    });
  }
  function indexPixels(data, palette) {
    const output = new Uint8Array(data.length >>> 2);
    const cache = new Map();
    const palettePremult = palette.map(([r, g, b, a]) => [r * a / 255, g * a / 255, b * a / 255, a]);
    for (let p = 0, i = 0; p < data.length; p += 4, i++) {
      const a = data[p + 3];
      const r = a ? data[p] : 0, g = a ? data[p + 1] : 0, b = a ? data[p + 2] : 0;
      const key = colorKey(r, g, b, a);
      let index = cache.get(key);
      if (index === undefined) {
        index = 0;
        let best = Infinity;
        const pr = r * a / 255, pg = g * a / 255, pb = b * a / 255;
        for (let j = 0; j < palette.length; j++) {
          const pc = palettePremult[j];
          const dr = pr - pc[0], dg = pg - pc[1], db = pb - pc[2], da = a - pc[3];
          const distance = dr * dr + dg * dg + db * db + 2.5 * da * da;
          if (distance < best) { best = distance; index = j; if (best === 0) break; }
        }
        if (cache.size < 180000) cache.set(key, index);
      }
      output[i] = index;
    }
    return output;
  }
  function filteredScanlines(indices, width, height, depth) {
    const rowBytes = Math.ceil(width * depth / 8);
    const result = new Uint8Array((rowBytes + 1) * height);
    const row = new Uint8Array(rowBytes), previous = new Uint8Array(rowBytes);
    const possible = [0, 1, 2];
    for (let y = 0; y < height; y++) {
      row.fill(0);
      for (let x = 0; x < width; x++) {
        const color = indices[y * width + x];
        if (depth === 8) row[x] = color;
        else row[Math.floor(x * depth / 8)] |= color << (8 - depth - (x * depth % 8));
      }
      let chosen = 0, best = Infinity;
      for (const filter of possible) {
        let score = 0;
        for (let i = 0; i < rowBytes; i++) {
          const prev = filter === 1 && i ? row[i - 1] : filter === 2 ? previous[i] : 0;
          const byte = (row[i] - prev) & 255;
          score += Math.min(byte, 256 - byte);
        }
        if (score < best) { best = score; chosen = filter; }
      }
      const offset = y * (rowBytes + 1);
      result[offset] = chosen;
      for (let i = 0; i < rowBytes; i++) {
        const prev = chosen === 1 && i ? row[i - 1] : chosen === 2 ? previous[i] : 0;
        result[offset + 1 + i] = (row[i] - prev) & 255;
      }
      previous.set(row);
    }
    return result;
  }
  async function encodeIndexedPNG(imageData, palette, indexed) {
    if (!('CompressionStream' in root)) throw Error('This browser does not support PNG palette compression');
    const { width, height } = imageData;
    const depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
    const ihdr = new Uint8Array(13);
    put32(ihdr, 0, width); put32(ihdr, 4, height);
    ihdr[8] = depth; ihdr[9] = 3; // indexed PNG, legal bit depths 1/2/4/8
    const colors = new Uint8Array(palette.length * 3);
    const alphas = new Uint8Array(palette.length);
    palette.forEach((color, i) => {
      colors.set(color.slice(0, 3), i * 3); alphas[i] = color[3];
    });
    let alphaLength = alphas.length;
    while (alphaLength && alphas[alphaLength - 1] === 255) alphaLength--;
    const uncompressed = filteredScanlines(indexed, width, height, depth);
    const zipped = new Blob([uncompressed]).stream().pipeThrough(new CompressionStream('deflate'));
    const compressed = new Uint8Array(await new Response(zipped).arrayBuffer());
    const chunks = [new Uint8Array([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('PLTE', colors)];
    if (alphaLength) chunks.push(chunk('tRNS', alphas.subarray(0, alphaLength)));
    chunks.push(chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0)));
    return new Blob([concat(chunks)], { type: 'image/png' });
  }
  async function optimize(canvas, quality, onCandidate) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const { exact, points } = gather(image);
    if (exact && exact.length) {
      const palette = exact;
      const blob = await encodeIndexedPNG(image, palette, indexPixels(image.data, palette));
      await onCandidate(blob, 'Lossless palette PNG');
      return;
    }
    // Preserve more colors at high quality. Low quality makes an aggressively
    // reduced (still valid) PNG. All candidates preserve the PNG format.
    const maxColors = quality >= .9 ? 256 : quality >= .75 ? 192 : quality >= .55 ? 128 : quality >= .35 ? 64 : quality >= .2 ? 32 : 16;
    const candidates = maxColors <= 32 ? [maxColors] : quality > .85 ? [maxColors] : [Math.min(256, maxColors * 2), maxColors, Math.max(16, Math.floor(maxColors / 2))];
    for (const count of new Set(candidates)) {
      const palette = medianCut(points.map(p => ({ ...p })), count);
      const indices = indexPixels(image.data, palette);
      const blob = await encodeIndexedPNG(image, palette, indices);
      await onCandidate(blob, `${palette.length}-color PNG`);
    }
  }
  root.imageCompresserPNG = { optimize, encodeIndexedPNG };
})(window);

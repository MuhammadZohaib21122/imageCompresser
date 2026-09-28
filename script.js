const $ = id => document.getElementById(id);
const drop = $('drop'), picker = $('files'), items = $('items'), records = [];
const mimeExt = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };
const supported = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp']);
const fmt = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
let busy = false, toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 5000); }
function blobFromCanvas(canvas, type, quality) { return new Promise(resolve => canvas.toBlob(resolve, type, quality)); }
async function decode(file) { const url = URL.createObjectURL(file); try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); } }
function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
function render() {
  const done = records.filter(r => r.blob), pending = records.some(r => r.status === 'working');
  $('results').hidden = !records.length;
  $('count').textContent = `(${records.length})`;
  const saved = done.reduce((sum, r) => sum + Math.max(0, r.file.size - r.blob.size), 0);
  $('summary').textContent = done.length ? `${done.length} ready · ${fmt(saved)} saved in total` : 'Processing your images…';
  $('downloadAll').disabled = !done.length || pending; $('clear').disabled = pending;
  items.replaceChildren(...records.map(r => {
    const row = document.createElement('div'); row.className = `item ${r.status === 'working' ? 'working' : ''}`;
    const img = document.createElement('img'); img.className = 'thumb'; img.src = r.preview; img.alt = 'Preview';
    const main = document.createElement('div'); main.className = 'item-main';
    const title = document.createElement('strong'); title.textContent = r.file.name;
    const meta = document.createElement('small');
    meta.textContent = r.blob ? `${fmt(r.file.size)} → ${fmt(r.blob.size)} · ${r.name.split('.').pop().toUpperCase()}${r.note ? ' · ' + r.note : ''}` : r.status === 'error' ? r.error : 'Optimizing…';
    const meter = document.createElement('div'); meter.className = 'meter'; const fill = document.createElement('span');
    fill.style.width = r.blob ? `${Math.min(100, r.blob.size / r.file.size * 100)}%` : '30%'; meter.append(fill); main.append(title, meta, meter);
    const saving = document.createElement('span'); saving.className = 'saving';
    if (r.blob) { const percent = (1 - r.blob.size / r.file.size) * 100; saving.textContent = percent >= .05 ? `−${percent.toFixed(1)}%` : percent < -.05 ? `+${(-percent).toFixed(1)}%` : 'Original'; if (percent < .05) saving.classList.add('neutral'); }
    else saving.textContent = r.status === 'error' ? 'Error' : '…';
    const btn = document.createElement('button'); btn.className = 'download'; btn.textContent = '↓ Save'; btn.disabled = !r.blob; btn.addEventListener('click', () => download(r.blob, r.name));
    row.append(img, main, saving, btn); return row;
  }));
}
async function encode(canvas, type, quality) { const blob = await blobFromCanvas(canvas, type, quality); return blob && blob.type === type ? blob : null; }
async function optimize(file, img, settings) {
  const max = settings.max;
  const scale = max ? Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw Error('Cannot create image canvas');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { chosen, quality } = settings;
  const types = chosen === 'auto' ? [...(file.type === 'image/png' ? ['image/png'] : []), 'image/webp', ...(file.type !== 'image/png' ? ['image/jpeg'] : [])] : [chosen === 'original' ? (mimeExt[file.type] ? file.type : 'image/png') : chosen];
  // If the requested output format differs from input, an actual conversion is
  // necessary even if its resulting bytes are larger. Otherwise, keep original
  // until an encoder finds a strictly smaller candidate.
  let best = { blob: file, type: file.type, original: true, note: '' };
  const allowOriginal = chosen === 'auto' || chosen === 'original' || types[0] === file.type;
  if (!allowOriginal) best = null;
  function consider(blob, type, note) {
    if (blob && (!best || blob.size < best.blob.size)) best = { blob, type, original: false, note };
  }
  for (const type of [...new Set(types)]) {
    if (type === 'image/png') {
      // Browser canvas.toBlob('image/png', q) ignores q. We instead encode real
      // indexed PNG files with a controlled palette, zlib, correct PNG chunks,
      // and tRNS transparency. This stays .png even when colors are reduced.
      try {
        const pngOptimizer = window.imageCompresserPNG;
        if (!pngOptimizer) throw Error('PNG optimizer script is unavailable');
        await pngOptimizer.optimize(canvas, quality, async (blob, note) => consider(blob, type, note));
      } catch (err) {
        // Still make a normal PNG if palette compression cannot run.
        const fallback = await encode(canvas, type);
        consider(fallback, type, 'Standard lossless PNG (palette encoder unavailable)');
        if (!fallback && chosen !== 'auto') throw err;
      }
      if (chosen === 'auto' && best && best.blob.size < file.size * .5) break;
      continue;
    }
    if (type === 'image/jpeg') {
      // Smart mode never silently removes transparency.
      if (chosen === 'auto') {
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let hasAlpha = false;
        for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) { hasAlpha = true; break; }
        if (hasAlpha) continue;
      }
    }
    let target = canvas;
    if (type === 'image/jpeg') {
      target = document.createElement('canvas'); target.width = canvas.width; target.height = canvas.height;
      const t = target.getContext('2d'); t.fillStyle = '#ffffff'; t.fillRect(0, 0, target.width, target.height); t.drawImage(canvas, 0, 0);
    }
    const levels = [quality, Math.min(quality, .7), Math.min(quality, .55), Math.min(quality, .4)];
    for (const q of [...new Set(levels)]) {
      const blob = await encode(target, type, q);
      if (!blob) { if (chosen !== 'auto') throw Error(`${type.split('/')[1].toUpperCase()} encoding is not supported by this browser`); break; }
      consider(blob, type, `${Math.round(q * 100)}% quality`);
      if (chosen !== 'auto' && blob.size < file.size * .8) break;
    }
  }
  if (!best) throw Error('Could not encode this image in the requested format');
  return best;
}
async function process(file, settings) {
  const record = { file, preview: URL.createObjectURL(file), status: 'working', blob: null, name: file.name };
  records.push(record); render();
  try {
    const img = await decode(file), best = await optimize(file, img, settings);
    record.blob = best.blob;
    record.name = best.original ? file.name : `${file.name.replace(/\.[^.]+$/, '')}-compressed.${mimeExt[best.type]}`;
    record.note = best.original ? (file.type === 'image/png' ? 'No smaller PNG at this quality · Try 30–50% or resize' : 'Already optimized; original kept') : `${best.note}${best.type !== file.type ? ' · Converted format' : ''}`;
    record.status = 'done';
  } catch (error) { record.status = 'error'; record.error = error.message || 'Could not process image'; }
  render();
}
async function addFiles(files) {
  if (busy) { toast('Please wait for current images to finish'); return; }
  const valid = [...files].filter(file => {
    if (file.type === 'image/gif') { toast('Animated GIF compression is not supported'); return false; }
    if (!supported.has(file.type)) { toast(`Unsupported file: ${file.name}`); return false; }
    if (file.size > 30 * 1024 * 1024) { toast(`${file.name} exceeds the 30 MB limit`); return false; }
    return true;
  });
  if (!valid.length) return;
  const settings = { chosen: $('format').value, quality: Number($('quality').value) / 100, max: Number($('dimension').value) };
  busy = true;
  let completed = 0;
  const progress = $('batchProgress');
  progress.hidden = false;
  $('batchLabel').textContent = 'Compressing your images…';
  $('batchCount').textContent = `0 / ${valid.length}`;
  $('batchFill').style.width = '0%';
  try {
    for (const file of valid) {
      await process(file, settings);
      completed++;
      $('batchCount').textContent = `${completed} / ${valid.length}`;
      $('batchFill').style.width = `${Math.round(completed / valid.length * 100)}%`;
    }
    $('batchLabel').textContent = 'All images processed';
  } finally {
    busy = false;
    render();
    setTimeout(() => { if (!busy) progress.hidden = true; }, 1500);
  }
}
drop.addEventListener('click', () => picker.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
picker.addEventListener('change', e => { addFiles(e.target.files); picker.value = ''; });
for (const event of ['dragenter', 'dragover']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.remove('dragging'); });
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
function updateQuality() {
  const range = $('quality');
  $('qualityValue').textContent = `${range.value}%`;
  range.style.setProperty('--range-progress', `${(Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min)) * 100}%`);
}
$('quality').addEventListener('input', updateQuality);
updateQuality();
$('format').addEventListener('change', e => { $('formatTip').textContent = e.target.value === 'image/png' || e.target.value === 'original' ? 'PNG images stay PNG. Lower quality reduces the number of colors; transparency is supported.' : e.target.value === 'auto' ? 'Smart may switch formats to achieve a smaller file.' : 'Different output formats can change transparency or animation.'; });
$('clear').addEventListener('click', () => { if (busy) return; for (const r of records) URL.revokeObjectURL(r.preview); records.length = 0; render(); });
$('downloadAll').addEventListener('click', async () => {
  if (busy) return;
  const done = records.filter(r => r.blob); if (!done.length) return;
  if (!window.JSZip) { toast('ZIP library could not load. Download images individually.'); return; }
  const btn = $('downloadAll'); btn.disabled = true; btn.textContent = 'Creating ZIP…';
  try {
    const zip = new JSZip(), used = new Set();
    for (const r of done) {
      let name = r.name, n = 2;
      while (used.has(name)) { const dot = r.name.lastIndexOf('.'); name = `${r.name.slice(0, dot)}-${n++}${r.name.slice(dot)}`; }
      used.add(name); zip.file(name, r.blob);
    }
    download(await zip.generateAsync({ type: 'blob' }), 'imageCompresser-images.zip');
  } catch (e) { toast('Could not create ZIP file'); }
  finally { btn.textContent = '↓ Download all (.zip)'; btn.disabled = false; }
});

// Reveal content gently as it enters the viewport. Respect reduced-motion settings.
const revealTargets = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        revealObserver.unobserve(entry.target);
      }
    }
  }, { threshold: .08 });
  revealTargets.forEach(el => revealObserver.observe(el));
} else revealTargets.forEach(el => el.classList.add('revealed'));

// Library job (run by .github/workflows/book-pages.yml): for each book waiting on Bayna,
// 1. get the file (PDF, EPUB, photos of the pages, or a link to a PDF / archive.org item),
// 2. make a picture of each page (WebP, up to 1400 px wide) and send it back,
// 3. keep the text already inside the file when there is real text; otherwise read printed pages with Tesseract and the
//    book's language pack; handwritten pages wait for the handwriting reader (stage 2),
// 4. send the text of each page back, and mark the book ready. Long books carry on in the next run.
// Needs API (bayna's workers.dev address) and MAP_OPS_KEY (the same key as the map job).
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
const API = process.env.API, KEY = process.env.MAP_OPS_KEY; if (!API || !KEY) { console.log('API and MAP_OPS_KEY are needed'); process.exit(1); }
const H = { 'x-ops-key': KEY }; const T0 = Date.now(), BUDGET = 85 * 60 * 1000;
sharp.cache(false); sharp.concurrency(2);
const TESS = { la: 'lat', ca: 'cat', ar: 'ara', grc: 'grc', el: 'ell', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', en: 'eng', de: 'deu', ota: 'ara', tr: 'tur', fa: 'fas', he: 'heb', other: 'eng' };
const call = async (method, p, body, headers = {}) => { for (let i = 0; i < 5; i++) { try { const r = await fetch(API + p, { method, headers: { ...H, ...headers }, body }); if (r.status < 500) return r; } catch {} await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); } throw new Error('API unreachable ' + p); };
const js = async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j; };
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opt }).toString();
const state = async (id, st, extra = {}) => js(await call('POST', `/api/ops/books/${id}/state`, JSON.stringify({ state: st, ...extra }), { 'content-type': 'application/json' }));
// real text (not a scanner's empty or garbage layer): enough letters, mostly letters
const realText = (t) => { const L = (t.match(/\p{L}/gu) || []).length; return L >= 120 && L / Math.max(1, t.replace(/\s/g, '').length) > 0.6; };
const tidy = (t) => t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/-\n(\p{Ll})/gu, '$1').trim();
let HAVE = null; const packFor = (lang) => { if (!HAVE) { try { HAVE = new Set(sh('tesseract', ['--list-langs']).split('\n').slice(1).map((x) => x.trim()).filter(Boolean)); } catch { HAVE = new Set(['eng']); } } const want = TESS[lang] || 'eng'; return HAVE.has(want) ? want : 'eng'; };
function ocr(png, lang) {
  const tsv = sh('tesseract', [png, '-', '-l', packFor(lang), '--psm', '3', 'tsv']);
  const rows = tsv.split('\n').slice(1).map((l) => l.split('\t')).filter((c) => c.length >= 12);
  const words = rows.filter((c) => c[11] && c[11].trim() && Number(c[10]) >= 0); const conf = words.length ? words.reduce((a, c) => a + Number(c[10]), 0) / words.length / 100 : 0;
  let out = '', last = ''; for (const c of words) { const key = `${c[2]}-${c[3]}-${c[4]}`; out += (last && key !== last ? (c[3] !== last.split('-')[1] ? '\n\n' : '\n') : out ? ' ' : '') + c[11]; last = key; }
  // blocks of text and where they sit (0-1 of the page), and the words the reader was unsure of (board 322)
  const pg = rows.find((c) => c[0] === '1'); const W = Number(pg?.[8]) || 1, Hh = Number(pg?.[9]) || 1; const bl = new Map();
  for (const c of words) { const k = c[2]; const x0 = +c[6], y0 = +c[7], x1 = x0 + +c[8], y1 = y0 + +c[9]; const o = bl.get(k) || { b: [1e9, 1e9, 0, 0], w: [], low: [] }; o.b = [Math.min(o.b[0], x0), Math.min(o.b[1], y0), Math.max(o.b[2], x1), Math.max(o.b[3], y1)]; o.w.push(c[11]); if (Number(c[10]) < 60 && /\p{L}{3,}/u.test(c[11])) o.low.push(c[11]); bl.set(k, o); }
  const blocks = [...bl.values()].map((o) => ({ b: [o.b[0] / W, o.b[1] / Hh, o.b[2] / W, o.b[3] / Hh].map((v) => Math.round(v * 10000) / 10000), t: o.w.join(' '), ...(o.low.length ? { low: [...new Set(o.low)].slice(0, 30) } : {}) })).filter((x) => x.t.trim());
  return { text: tidy(out), conf: Math.round(conf * 100) / 100, blocks };
}
// the text already inside a PDF page, as blocks with their place on the page (pdftotext -bbox-layout)
function pdfBlocks(file, n) {
  let x = ''; try { x = sh('pdftotext', ['-f', String(n), '-l', String(n), '-bbox-layout', file, '-']); } catch { return []; }
  const pm = x.match(/<page width="([\d.]+)" height="([\d.]+)"/); if (!pm) return []; const W = +pm[1], Hh = +pm[2]; const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const out = []; for (const bm of x.matchAll(/<block xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/block>/g)) {
    const lines = [...bm[5].matchAll(/<line[^>]*>([\s\S]*?)<\/line>/g)].map((l) => [...l[1].matchAll(/<word[^>]*>([\s\S]*?)<\/word>/g)].map((w) => w[1].replace(/&(\w+);/g, (m, e) => ent[e] ?? m)).join(' '));
    const t = lines.join(' ').replace(/-\s(\p{Ll})/gu, '$1').trim(); if (!t) continue;
    out.push({ b: [bm[1] / W, bm[2] / Hh, bm[3] / W, bm[4] / Hh].map((v) => Math.round(v * 10000) / 10000), t }); }
  return out;
}
// a sharp copy of the page for zooming (only loaded where the reader zooms in), and the blocks of text with their places
async function sendZoom(b, n, buf) { const webp = await sharp(buf, { limitInputPixels: false }).rotate().resize({ width: 2600, height: 3800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(); if (webp.length > 11 * 1048576) return false; await js(await call('PUT', `/api/ops/books/${b.id}/zoom/${n}?pub=${b.pub ? 1 : 0}`, webp)); return true; }
async function sendBoxes(b, n, o) { await js(await call('PUT', `/api/ops/books/${b.id}/boxes/${n}`, JSON.stringify(o), { 'content-type': 'application/json' })); }
async function sendPage(b, n, buf) { const webp = await sharp(buf, { limitInputPixels: false }).rotate().resize({ width: 1400, height: 2200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(); await js(await call('PUT', `/api/ops/books/${b.id}/page/${n}?pub=${b.pub ? 1 : 0}`, webp)); }
// pictures inside a PDF page (board 300): maps, photos and drawn diagrams, each with its caption (ops/books/figs.py)
const FIGS = path.join(path.dirname(new URL(import.meta.url).pathname), 'figs.py');
async function pageFigs(b, file, n, dir) {
  let list = []; try { list = JSON.parse(sh('python3', ['-W', 'ignore', FIGS, file, String(n), dir])); } catch (e) { console.log(`  page ${n}: pictures not read (${String(e).slice(0, 120)})`); return []; }
  const out = [];
  for (const [k, f] of list.entries()) {
    const name = `${String(n).padStart(4, '0')}-${k + 1}`;
    const webp = await sharp(fs.readFileSync(f.file), { limitInputPixels: false }).resize({ width: 1400, height: 1800, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    const meta = await sharp(webp).metadata();
    await js(await call('PUT', `/api/ops/books/${b.id}/fig/${name}?pub=${b.pub ? 1 : 0}`, webp));
    out.push({ name, n, kind: f.kind, w: meta.width, h: meta.height, box: f.box, caption: f.caption });
  }
  return out;
}
async function sendFigs(b, figs, done) { await js(await call('POST', `/api/ops/books/${b.id}/figs`, JSON.stringify({ figs, done }), { 'content-type': 'application/json' })); }
async function sendText(b, list) { for (let i = 0; i < list.length; i += 20) await js(await call('POST', `/api/ops/books/${b.id}/pages`, JSON.stringify({ pages: list.slice(i, i + 20) }), { 'content-type': 'application/json' })); }
async function download(url, file) { const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'bayna-library/1 (+https://bayna.co)' } }); if (!r.ok) throw new Error('link ' + r.status); const len = Number(r.headers.get('content-length') || 0); if (len > 150 * 1048576) throw new Error('link file too large');
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 400 * 1048576) throw new Error('link file too large'); fs.writeFileSync(file, buf); return buf; }

async function doPdf(b, file, dir) {
  const info = sh('pdfinfo', [file]); const total = Math.min(Number((info.match(/Pages:\s+(\d+)/) || [])[1] || 0), b.maxPages); if (!total) throw new Error('no pages in the PDF');
  // the book's own title and author inside the PDF, offered to the site in case the title was taken from a file name (6 Nov)
  const meta = { title: ((info.match(/^Title:\s+(.+)$/m) || [])[1] || '').trim(), author: ((info.match(/^Author:\s+(.+)$/m) || [])[1] || '').trim() };
  await state(b.id, 'reading', { pages: total, meta }); const done = new Set(b.done || []); let batch = [], figs = [];
  for (let n = 1; n <= total; n++) {
    if (done.has(n)) continue; if (Date.now() - T0 > BUDGET) { await sendText(b, batch); await sendFigs(b, figs, false); return 'more'; }
    const base = path.join(dir, 'p'); sh('pdftoppm', ['-r', '110', '-f', String(n), '-l', String(n), '-png', '-singlefile', file, base]); await sendPage(b, n, fs.readFileSync(base + '.png'));
    figs.push(...(await pageFigs(b, file, n, dir)));
    const r = await pdfV2(b, file, n, dir); let { text, how, conf } = r;
    batch.push({ n, text, how, conf }); if (batch.length >= 20) { await sendText(b, batch); batch = []; }
    if (n % 25 === 0) console.log(`  page ${n}/${total}`);
  }
  await sendText(b, batch); await sendFigs(b, figs, true); return total;
}
// one PDF page: its sharp copy, its text and where each block of it sits
async function pdfV2(b, file, n, dir) {
  const base = path.join(dir, 'z'); sh('pdftoppm', ['-r', '220', '-f', String(n), '-l', String(n), '-png', '-singlefile', file, base]); const z = await sendZoom(b, n, fs.readFileSync(base + '.png')).catch(() => false);
  let text = tidy(sh('pdftotext', ['-f', String(n), '-l', String(n), '-layout', file, '-'])); let how = 'inside', conf = 0.95, blocks = [];
  if (realText(text)) blocks = pdfBlocks(file, n);
  else if (b.script === 'hand') { text = ''; how = 'hand-waiting'; conf = 0; }
  else { sh('pdftoppm', ['-r', '300', '-gray', '-f', String(n), '-l', String(n), '-png', '-singlefile', file, base + 'h']); const o = ocr(base + 'h.png', b.lang); text = o.text; conf = o.conf; how = text ? 'print' : 'none'; blocks = o.blocks; }
  await sendBoxes(b, n, { z, blocks: blocks.slice(0, 120) });
  return { text, how, conf };
}
// books read before the new reader (board 322): add the sharp copies and the blocks; their text stays as it is
async function v2Only(b, file, dir) {
  const info = sh('pdfinfo', [file]); const total = Math.min(Number((info.match(/Pages:\s+(\d+)/) || [])[1] || 0), b.maxPages);
  for (let n = 1; n <= total; n++) { if (Date.now() - T0 > BUDGET) return 'more'; await pdfV2(b, file, n, dir); }
  await js(await call('POST', `/api/ops/books/${b.id}/v2`, JSON.stringify({ done: true }), { 'content-type': 'application/json' })); return total;
}
async function v2Photos(b, dir) {
  const list = (b.src.photos || []).slice(0, b.maxPages);
  for (const [i, k] of list.entries()) { const n = i + 1; if (Date.now() - T0 > BUDGET) return 'more';
    const r = await call('GET', `/api/ops/books/${b.id}/source?k=${encodeURIComponent(k)}`); if (!r.ok) continue; const buf = Buffer.from(await r.arrayBuffer()); await photoV2(b, n, buf, dir); }
  await js(await call('POST', `/api/ops/books/${b.id}/v2`, JSON.stringify({ done: true }), { 'content-type': 'application/json' })); return list.length;
}
async function photoV2(b, n, buf, dir) {
  const z = await sendZoom(b, n, buf).catch(() => false); let text = '', how = 'hand-waiting', conf = 0, blocks = [];
  if (b.script !== 'hand') { const png = path.join(dir, 'ph.png'); await sharp(buf, { limitInputPixels: false }).rotate().resize({ width: 2400, height: 3400, fit: 'inside', withoutEnlargement: true }).grayscale().png().toFile(png); const o = ocr(png, b.lang); text = o.text; conf = o.conf; how = text ? 'print' : 'none'; blocks = o.blocks; }
  await sendBoxes(b, n, { z, blocks: blocks.slice(0, 120) }); return { text, how, conf };
}
// a PDF read before pictures were looked for: only its pictures, pages and text stay as they are
async function figsOnly(b, file, dir) {
  const info = sh('pdfinfo', [file]); const total = Math.min(Number((info.match(/Pages:\s+(\d+)/) || [])[1] || 0), b.maxPages); const figs = [];
  for (let n = 1; n <= total; n++) { if (Date.now() - T0 > BUDGET) return 'more'; figs.push(...(await pageFigs(b, file, n, dir))); }
  await sendFigs(b, figs, true); return figs.length;
}
async function doEpub(b, file, dir) {
  const x = path.join(dir, 'x'); fs.mkdirSync(x); sh('unzip', ['-q', '-o', file, '-d', x]);
  const cont = fs.readFileSync(path.join(x, 'META-INF/container.xml'), 'utf8'); const opfRel = (cont.match(/full-path="([^"]+)"/) || [])[1]; if (!opfRel) throw new Error('not a readable EPUB');
  const opf = fs.readFileSync(path.join(x, opfRel), 'utf8'); const base = path.dirname(path.join(x, opfRel));
  const items = Object.fromEntries([...opf.matchAll(/<item\b[^>]*>/g)].map((m) => [(m[0].match(/id="([^"]+)"/) || [])[1], (m[0].match(/href="([^"]+)"/) || [])[1]]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => items[m[1]]).filter(Boolean);
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const plain = (h) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<\/(p|div|h\d|li|blockquote|tr)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ''), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : ent[e] ?? m);
  const all = tidy(spine.map((h) => { try { return plain(fs.readFileSync(path.join(base, decodeURIComponent(h)), 'utf8')); } catch { return ''; } }).join('\n\n'));
  // e-books have no pages: cut into pages of about 2,500 characters, at paragraph ends
  const pages = []; let cur = ''; for (const para of all.split(/\n\n+/)) { if (cur && (cur + para).length > 2500) { pages.push(cur.trim()); cur = ''; } cur += para + '\n\n'; } if (cur.trim()) pages.push(cur.trim());
  const total = Math.min(pages.length, b.maxPages); if (!total) throw new Error('no text in the EPUB'); await state(b.id, 'reading', { pages: total });
  await sendText(b, pages.slice(0, total).map((text, i) => ({ n: i + 1, text, how: 'inside', conf: 1 }))); return total;
}
async function doPhotos(b, dir) {
  const list = (b.src.photos || []).slice(0, b.maxPages); await state(b.id, 'reading', { pages: list.length }); const done = new Set(b.done || []); let batch = [];
  for (const [i, k] of list.entries()) { const n = i + 1; if (done.has(n)) continue; if (Date.now() - T0 > BUDGET) { await sendText(b, batch); return 'more'; }
    const r = await call('GET', `/api/ops/books/${b.id}/source?k=${encodeURIComponent(k)}`); if (!r.ok) continue; const buf = Buffer.from(await r.arrayBuffer()); await sendPage(b, n, buf);
    const { text, how, conf } = await photoV2(b, n, buf, dir);
    batch.push({ n, text, how, conf }); if (batch.length >= 20) { await sendText(b, batch); batch = []; } }
  await sendText(b, batch); return list.length;
}

// board 361: the cover of each book = the first of its first 15 pages that has print on it (scans often start with white or
// nearly white pages: a library stamp, a blank flyleaf). None found: cover 0, and the site shows a designed cover instead.
async function chooseCovers() { const { books: nc = [] } = await js(await call('GET', '/api/ops/books/nocover')); console.log('books without a chosen cover:', nc.length);
  for (const b of nc) { const blank = []; let cover = 0;
    try { for (const p of b.pages) { const r = await call('GET', `/api/ops/books/${b.id}/source?k=${encodeURIComponent(p.img)}`); if (!r.ok) continue;
        const { data } = await sharp(Buffer.from(await r.arrayBuffer())).greyscale().resize({ width: 300 }).raw().toBuffer({ resolveWithObject: true });
        let sum = 0; for (const v of data) sum += v; const mean = sum / data.length; let ink = 0; for (const v of data) if (v < mean - 45) ink++;
        if (ink / data.length < 0.004) blank.push(p.n); else { cover = p.n; break; } }
      await js(await call('POST', `/api/ops/books/${b.id}/cover`, JSON.stringify({ cover, blank }), { 'content-type': 'application/json' }));
      console.log(`  ${b.id}: cover ${cover ? 'page ' + cover : 'designed (no page with print)'}${blank.length ? `, blank pages ${blank.join(', ')}` : ''}`);
    } catch (e) { console.log('  cover FAILED', b.id, String(e).slice(0, 200)); } } }
// covers first (quick), so they never wait behind a long book; again at the end for books finished in this run
await chooseCovers().catch((e) => console.log('covers FAILED', String(e).slice(0, 200)));
// the waiting list is asked for again after each round, so a book uploaded while the job is busy is done in the same run;
// smaller books first, so a short book never waits hours behind a long one
const seen = new Set(); let stopAll = false;
while (!stopAll) {
const { books: all } = await js(await call('GET', '/api/ops/books/pending'));
const books = all.filter((b) => !seen.has(b.id)).sort((a, b) => (a.src?.size || 0) - (b.src?.size || 0)); if (!books.length) break;
console.log(new Date().toISOString(), 'books waiting:', books.length);
for (const b of books) { seen.add(b.id);
  const dir = fs.mkdtempSync('/tmp/book-'); const t0 = Date.now();
  try {
    let res;
    if (b.v2Only && b.kind === 'photos') { const r = await v2Photos(b, dir); console.log(`  ${b.id}: new reader ${r === 'more' ? 'time is up' : r + ' pages ready'}`); continue; }
    if (b.kind === 'photos') res = await doPhotos(b, dir);
    else {
      const file = path.join(dir, 'source.' + (b.kind === 'epub' ? 'epub' : 'pdf'));
      if (b.kind === 'link') { let u = b.src.url; const ia = u.match(/archive\.org\/(?:details|download)\/([^/?#]+)/); if (ia) u = `https://archive.org/download/${ia[1]}/${ia[1]}.pdf`;
        const buf = await download(u, file); if (buf.slice(0, 4).toString() !== '%PDF') throw new Error('the link is not a PDF (a direct PDF link or an archive.org item is needed)'); }
      else { const r = await call('GET', `/api/ops/books/${b.id}/source?k=${encodeURIComponent(b.src.file)}`); if (!r.ok) throw new Error('file ' + r.status); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); }
      if (b.v2Only) { const r = await v2Only(b, file, dir); console.log(`  ${b.id}: new reader ${r === 'more' ? 'time is up' : r + ' pages ready'}`); continue; }
      if (b.figsOnly) { const r = await figsOnly(b, file, dir); console.log(`  ${b.id}: ${r === 'more' ? 'time is up' : r + ' pictures found'}`); continue; }
      res = b.kind === 'epub' ? await doEpub(b, file, dir) : await doPdf(b, file, dir);
    }
    if (res === 'more') { await state(b.id, 'pending', { note: 'carrying on in the next run' }); console.log(`  ${b.id}: time is up, carrying on next run`); try { fs.writeFileSync('/tmp/book-more', '1'); } catch {} stopAll = true; break; }
    await js(await call('POST', `/api/ops/books/${b.id}/v2`, JSON.stringify({ done: true }), { 'content-type': 'application/json' })).catch(() => {});
    await state(b.id, 'ready', { pages: res, note: '' }); console.log(`  ${b.id} ${b.kind}: ${res} pages in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) { console.log('  FAILED', b.id, String(e).slice(0, 300)); await state(b.id, 'failed', { note: String(e.message || e).slice(0, 200) }).catch(() => {}); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
}
await chooseCovers().catch((e) => console.log('covers FAILED', String(e).slice(0, 200)));

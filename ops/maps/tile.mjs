// Map tiles job (run by .github/workflows/map-tiles.yml): for each full-detail map waiting on Bayna,
// 1. fetch the original, 2. remove hidden file labels without re-compressing (exiftool), 3. make the 1,600 px preview if the
// uploader's device could not, 4. cut the map into Deep Zoom tiles (510 px + 1 px overlap, WebP quality 90) at every level,
// 5. send them back and mark the map ready. Needs API (bayna's workers.dev address) and MAP_OPS_KEY.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
const API = process.env.API, KEY = process.env.MAP_OPS_KEY; if (!API || !KEY) { console.log('API and MAP_OPS_KEY are needed'); process.exit(1); }
const H = { 'x-ops-key': KEY };
sharp.cache(false); sharp.concurrency(2);
const TS = 510, OV = 1, Q = 90;
const call = async (method, p, body, headers = {}) => { for (let i = 0; i < 5; i++) { try { const r = await fetch(API + p, { method, headers: { ...H, ...headers }, body }); if (r.status < 500) return r; } catch {} await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); } throw new Error('failed ' + method + ' ' + p); };
const js = async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || j.ok === false) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j; };
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); };

// board 358: the map's fingerprint: a 17×16 grey copy, each point compared with its right-hand neighbour (256 points, as 64 hex digits)
const fingerprint = async (input) => { const { data } = await sharp(input, { limitInputPixels: false, unlimited: true }).rotate().greyscale().resize(17, 16, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = ''; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bits += data[y * 17 + x] > data[y * 17 + x + 1] ? '1' : '0';
  return bits.match(/.{4}/g).map((b) => parseInt(b, 2).toString(16)).join(''); };
// board 359: clearer copies asked for on the site: contrast evened out (CLAHE), faded ink darkened, edges sharpened; small scans
// enlarged ×2. Plain image processing (no AI). Sent back as a new map in the same post; the tiles step below then processes it.
{ const { maps: clr } = await js(await call('GET', '/api/ops/maps/clear')); console.log('clearer copies asked:', clr.length);
  for (const m of clr) { const dir = fs.mkdtempSync('/tmp/clr-'); const file = path.join(dir, 'o'); let nid = null;
    try { const r = await call('GET', `/api/ops/maps/${m.id}/original`); if (!r.ok) throw new Error('original ' + r.status); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      const long = Math.max(m.w, m.h), small = long < 4000; let im = sharp(file, { limitInputPixels: false, unlimited: true }).rotate();
      if (small) im = im.resize(m.w * 2, m.h * 2, { kernel: 'lanczos3' });
      const tile = Math.max(64, Math.round(Math.min(m.w, m.h) * (small ? 2 : 1) / 8));
      const out = await im.normalise({ lower: 1, upper: 99 }).clahe({ width: tile, height: tile, maxSlope: 3 }).sharpen({ sigma: small ? 1.2 : 0.8 }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
      nid = (await js(await call('POST', `/api/ops/maps/${m.id}/clear/start`, JSON.stringify({ size: out.length }), { 'content-type': 'application/json' }))).id;
      const st = await js(await call('POST', `/api/ops/maps/${nid}/original/start`)); const parts = [];
      for (let n = 1, off = 0; off < out.length; n++, off += st.partSize) parts.push((await js(await call('PUT', `/api/ops/maps/${nid}/original/part?mp=${encodeURIComponent(st.mp)}&n=${n}`, out.subarray(off, off + st.partSize)))).part);
      await js(await call('POST', `/api/ops/maps/${nid}/original/done`, JSON.stringify({ mp: st.mp, parts }), { 'content-type': 'application/json' }));
      await js(await call('POST', `/api/ops/maps/${nid}/clear/done`, '{}', { 'content-type': 'application/json' }));
      console.log(`  clearer copy of ${m.id}: ${nid} ${(out.length / 1048576).toFixed(1)} MB${small ? ' (×2)' : ''}`);
    } catch (e) { console.log('  clearer copy FAILED', m.id, String(e).slice(0, 200)); if (nid) await call('POST', `/api/ops/maps/${nid}/clear/done`, JSON.stringify({ failed: true }), { 'content-type': 'application/json' }).catch(() => {}); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); } } }

const { maps } = await js(await call('GET', '/api/ops/maps/pending'));
console.log(new Date().toISOString(), 'maps waiting:', maps.length);
for (const m of maps) {
  const dir = fs.mkdtempSync('/tmp/map-'); const ext = m.orig.split('.').pop(); const file = path.join(dir, 'original.' + ext); const t0 = Date.now();
  try {
    // 1. the original
    const r = await call('GET', `/api/ops/maps/${m.id}/original`); if (!r.ok) throw new Error('original ' + r.status);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); const size0 = fs.statSync(file).size;
    // 2. hidden labels (camera, GPS place, dates, software) removed; the picture data is not touched. Orientation and colour profile kept.
    try { execFileSync('exiftool', ['-q', '-q', '-overwrite_original', '-all=', '-tagsFromFile', '@', '-Orientation', '-ICC_Profile', file], { stdio: 'pipe' }); } catch (e) { console.log('  exiftool:', String(e.stderr || e).slice(0, 160)); }
    const size1 = fs.statSync(file).size;
    if (size1 !== size0) { // send the cleaned original back, in 10 MB parts
      const st = await js(await call('POST', `/api/ops/maps/${m.id}/original/start`)); const buf = fs.readFileSync(file); const parts = [];
      for (let n = 1, off = 0; off < buf.length; n++, off += st.partSize) parts.push((await js(await call('PUT', `/api/ops/maps/${m.id}/original/part?mp=${encodeURIComponent(st.mp)}&n=${n}`, buf.subarray(off, off + st.partSize)))).part);
      await js(await call('POST', `/api/ops/maps/${m.id}/original/done`, JSON.stringify({ mp: st.mp, parts }), { 'content-type': 'application/json' }));
    }
    const img = () => sharp(file, { limitInputPixels: false, unlimited: true }).rotate();
    const meta = await sharp(file, { limitInputPixels: false }).metadata(); const turned = (meta.orientation || 1) >= 5;
    const w = turned ? meta.height : meta.width, h = turned ? meta.width : meta.height;
    console.log(`  ${m.id} ${ext} ${(size1 / 1048576).toFixed(1)} MB ${w}×${h}`);
    // 3. preview (when the uploader's device could not make one: TIFF, or a very large map on a phone)
    let review = m.review;
    if (!m.hasPreview) { const pv = await img().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(); review = (await js(await call('PUT', `/api/ops/maps/${m.id}/preview`, pv))).review; }
    const pub = review === 'ok' && m.access !== 'members';
    // 4. tiles
    const out = path.join(dir, 'z'); await img().webp({ quality: Q, effort: 4 }).tile({ size: TS, overlap: OV, layout: 'dz' }).toFile(out + '.dz');
    const tdir = fs.existsSync(out + '_files') ? out + '_files' : fs.readdirSync(dir).map((x) => path.join(dir, x)).find((x) => x.endsWith('_files'));
    const levels = fs.readdirSync(tdir).map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b); const max = levels[levels.length - 1];
    const tiles = levels.flatMap((l) => fs.readdirSync(path.join(tdir, String(l))).filter((f) => f.endsWith('.webp')).map((f) => `${l}/${f}`));
    let sent = 0; await pool(tiles, 12, async (p) => { await js(await call('PUT', `/api/ops/maps/${m.id}/tile?p=${encodeURIComponent(p)}&pub=${pub ? 1 : 0}`, fs.readFileSync(path.join(tdir, p)))); sent++; });
    // 5. ready
    let fp = null; try { fp = await fingerprint(file); } catch (e) { console.log('  fingerprint:', String(e).slice(0, 120)); }
    await js(await call('POST', `/api/ops/maps/${m.id}/done`, JSON.stringify({ w, h, ts: TS, ov: OV, max, pub, fp }), { 'content-type': 'application/json' }));
    console.log(`  ready: ${sent} tiles, ${levels.length} levels, ${pub ? 'public copy on files.bayna.co' : 'served by the site (members or waiting for a check)'}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (e) {
    console.log('  FAILED', m.id, String(e).slice(0, 300));
    await call('POST', `/api/ops/maps/${m.id}/done`, JSON.stringify({ failed: String(e).slice(0, 200) }), { 'content-type': 'application/json' }).catch(() => {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// board 358: catch-up — fingerprints for maps processed before they existed (from the 1,600 px preview)
const { maps: nofp } = await js(await call('GET', '/api/ops/maps/nofp')); console.log('maps without a fingerprint:', nofp.length); let fpN = 0;
for (const m of nofp) { try { const r = await call('GET', `/api/ops/maps/${m.id}/preview`); if (!r.ok) throw new Error('preview ' + r.status);
  const fp = await fingerprint(Buffer.from(await r.arrayBuffer())); await js(await call('POST', `/api/ops/maps/${m.id}/fp`, JSON.stringify({ fp }), { 'content-type': 'application/json' })); fpN++; } catch (e) { console.log('  fingerprint FAILED', m.id, String(e).slice(0, 160)); } }
console.log('fingerprints added:', fpN);

// board 359: the writing on each map read by the AI without anyone asking, in the viewer's 1,024 px squares. Empty squares (sea,
// margins, plain paper) are skipped here without the AI. The site sets how many squares a day (AUTO_READ_DAY); the rest wait for the next run.
{ const R = await js(await call('GET', '/api/ops/maps/toread')); let left = R.left; const CELL = R.cell; console.log('maps to read:', R.maps.length, '· squares allowed today:', left);
  for (const m of R.maps) { if (left <= 0) break; const dir = fs.mkdtempSync('/tmp/rd-'); const file = path.join(dir, 'o'); let read = 0, failed = 0, stop = false; const blank = [];
    try { const r = await call('GET', `/api/ops/maps/${m.id}/original`); if (!r.ok) throw new Error('original ' + r.status); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      const skip = new Set([...m.done, ...m.blank]); const cells = []; for (let y = 0; y * CELL < m.h; y++) for (let x = 0; x * CELL < m.w; x++) if (!skip.has(`${x}_${y}`)) cells.push([x, y]);
      for (const [x, y] of cells) { if (left <= 0) { stop = true; break; }
        const buf = await sharp(file, { limitInputPixels: false, unlimited: true }).rotate().extract({ left: x * CELL, top: y * CELL, width: Math.min(CELL, m.w - x * CELL), height: Math.min(CELL, m.h - y * CELL) }).jpeg({ quality: 85 }).toBuffer();
        const st = await sharp(buf).greyscale().stats(); if (st.channels[0].stdev < 8 || st.entropy < 1.2) { blank.push(`${x}_${y}`); continue; }
        const j = await (await call('POST', `/api/ops/maps/${m.id}/readcell`, JSON.stringify({ cell: `${x}_${y}`, image: buf.toString('base64') }), { 'content-type': 'application/json' })).json().catch(() => ({}));
        if (j.ok) { if (!j.had) { left--; read++; } } else if (j.error === 'later') { stop = true; left = 0; break; } else if (++failed > 3) break; }
      await js(await call('POST', `/api/ops/maps/${m.id}/readmark`, JSON.stringify({ blank, all: !stop && failed === 0 }), { 'content-type': 'application/json' }));
      console.log(`  ${m.id}: ${read} squares read, ${blank.length} empty skipped${stop ? ', the rest next time' : failed ? `, ${failed} failed` : ', all done'}`);
    } catch (e) { console.log('  reading FAILED', m.id, String(e).slice(0, 200)); } finally { fs.rmSync(dir, { recursive: true, force: true }); } } }

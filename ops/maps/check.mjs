// Board 360: the checking agent. Run by the map job after the tiles step. For each map post not checked in the last 30 days
// (up to 8 a run): the site's AI writes catalogue search words; the Library of Congress and Wikimedia Commons (which holds
// many scans from the BnF and other libraries, with maker, date and holding library) are searched; each result's picture
// is compared with the map's fingerprint; the site's AI then judges which results are the same map or another edition and
// saves them as proposals for a moderator. Gallica refuses GitHub's servers, so it is not searched from here.
import sharp from 'sharp';
const API = process.env.API, KEY = process.env.MAP_OPS_KEY; if (!API || !KEY) { console.log('API and MAP_OPS_KEY are needed'); process.exit(1); }
const H = { 'x-ops-key': KEY }; const UA = { 'user-agent': 'BaynaMapChecker/1.0 (https://bayna.co)' };
const call = async (method, p, body) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(API + p, { method, headers: { ...H, 'content-type': 'application/json' }, body }); if (r.status < 500) return r.json().catch(() => ({})); } catch {} await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); } return { ok: false, error: 'site' }; };
const get = async (u, as = 'json') => { try { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(25000) }); if (!r.ok) return null; return as === 'json' ? await r.json() : Buffer.from(await r.arrayBuffer()); } catch { return null; } };
const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const fpOf = async (buf) => { const { data } = await sharp(buf, { limitInputPixels: false }).rotate().greyscale().resize(17, 16, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = ''; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) bits += data[y * 17 + x] > data[y * 17 + x + 1] ? '1' : '0'; return bits; };
const hexBits = (h) => [...h].map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
const sim = (a, b) => { let d = 0; for (let i = 0; i < 256; i++) if (a[i] !== b[i]) d++; return Math.round((1 - d / 256) * 100); };
// a catalogue picture often has margins, colour bars or a ruler: compare as it is and with plain borders trimmed, keep the best
const picSim = async (url, fp) => { if (!fp || !url) return 0; const buf = await get(url, 'buf'); if (!buf) return 0; const mine = hexBits(fp);
  try { let best = sim(await fpOf(buf), mine); const t = await sharp(buf).rotate().trim({ threshold: 30 }).toBuffer().catch(() => null); if (t) best = Math.max(best, sim(await fpOf(t), mine)); return best; } catch { return 0; } };

async function loc(q) {
  const j = await get('https://www.loc.gov/maps/?fo=json&c=6&q=' + encodeURIComponent(q)); if (!j?.results) return [];
  return j.results.filter((x) => x.url).map((x) => { const it = x.item || {}; const imgs = (x.image_url || []).map(String);
    const iiif = imgs.find((u) => u.includes('/iiif/')); const thumb = iiif ? iiif.replace(/\/full\/[^/]+\//, '/full/!600,600/').replace(/#.*$/, '') : imgs[0]?.replace(/#.*$/, '');
    return { src: 'Library of Congress', title: strip(it.title || x.title), maker: strip((it.contributor_names || x.contributor_names || it.creator || [])[0] || ''), date: strip(it.created_published?.[0] || it.date || x.date),
      held: 'Library of Congress' + (it.call_number?.[0] ? ', ' + it.call_number[0] : ''), url: x.url.replace(/^http:/, 'https:'), thumb, scan: iiif ? iiif.replace(/\/full\/[^/]+\//, '/full/max/').replace(/#.*$/, '') : '', size: strip(it.medium?.[0]).slice(0, 40), rights: 'see the catalogue' }; });
}
// Wikimedia's dates can carry template code ("1375 date QS:P571,+1375…"); its credit line names the source site, not always the library
const cleanDate = (d) => String(d || '').replace(/\s*date QS:.*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 60);
const LIBS = [[/gallica|biblioth[eè]que nationale de france|\bBnF\b/i, 'Bibliothèque nationale de France'], [/library of congress/i, 'Library of Congress'], [/british library/i, 'British Library'], [/biblioteca nacional de espa/i, 'Biblioteca Nacional de España'],
  [/rijksmuseum/i, 'Rijksmuseum'], [/staatsbibliothek/i, 'Staatsbibliothek'], [/bodleian/i, 'Bodleian Library'], [/vatican|apostolica vaticana/i, 'Vatican Library'], [/david rumsey/i, 'David Rumsey Map Collection'], [/national library of (\w+)/i, null], [/biblioteca (\w+ ?\w*)/i, null]];
const library = (...texts) => { const t = texts.join(' '); for (const [re, name] of LIBS) { const m = t.match(re); if (m) return name || m[0]; } return ''; };
async function commons(q) {
  const j = await get('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=600&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap'));
  return Object.values(j?.query?.pages || {}).map((p) => { const ii = p.imageinfo?.[0] || {}; const m = ii.extmetadata || {}; const v = (k) => strip(m[k]?.value);
    return { src: 'Wikimedia Commons', title: v('ObjectName') || strip(p.title).replace(/^File:|\.\w+$/g, ''), maker: v('Artist').replace(/\s*(Creator|Author):?\s*/i, ' ').trim().slice(0, 160), date: cleanDate(v('DateTimeOriginal')),
      held: library(v('Credit'), v('ImageDescription'), v('Attribution')), url: (ii.descriptionurl || '').replace(/^http:/, 'https:'), thumb: ii.thumburl, scan: ii.url, size: ii.width ? `${ii.width} × ${ii.height} px` : '', rights: v('LicenseShortName') }; }).filter((x) => x.url);
}

const { posts = [] } = await call('GET', '/api/ops/maps/tocheck'); console.log('map posts to check:', posts.length);
for (const p of posts) {
  const q = await call('POST', `/api/ops/maps/check/${encodeURIComponent(p.slug)}/queries`, JSON.stringify(p));
  if (!q.ok) { console.log(`  ${p.slug}: search words not written (${q.error}); stopping for today`); break; }
  const found = new Map();
  // the post's own title is always searched too (the AI's search words vary from run to run)
  const own = String(p.title || '').replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^\d+$/.test(w)).slice(0, 6).join(' ');
  if (own.length > 6) { for (const c of await commons(own)) found.set(c.url, c); for (const c of await loc(own)) found.set(c.url, c); }
  for (const w of (q.en || []).slice(0, 2)) for (const c of await loc(w)) found.set(c.url, c);
  for (const w of [...(q.en || []).slice(0, 1), ...(q.fr || []).slice(0, 2)]) for (const c of await commons(w)) found.set(c.url, c);
  const cands = [...found.values()].filter((c) => !p.no.includes(c.url)).slice(0, 20);
  for (const c of cands) c.sim = await picSim(c.thumb, p.fp);
  cands.sort((a, b) => b.sim - a.sim);
  const j = await call('POST', `/api/ops/maps/check/${encodeURIComponent(p.slug)}/judge`, JSON.stringify({ cands: cands.slice(0, 10), names: p.names }));
  console.log(`  ${p.slug}: searched ${JSON.stringify([...(q.en || []), ...(q.fr || [])])}, ${cands.length} results (best picture ${cands[0]?.sim ?? '-'}%) → ${j.ok ? `${j.props} proposals, ${j.flags} flags` : 'not judged: ' + j.error}`);
  if (!j.ok && j.error === 'later') break;
}

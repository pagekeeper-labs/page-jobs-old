# Pictures inside a PDF page (board 300), for "Make posts from this": run by ops/books/read.mjs.
#   python3 figs.py <file.pdf> <page> <out dir>   → prints JSON: [{ "file", "kind", "w", "h", "box", "caption" }]
# 1. every picture placed on the page (maps, photos, scans), cut out as it is shown (already cropped as the author placed it);
# 2. drawn diagrams (boxes and lines, like a timeline of names): that part of the page, taken as a picture with its words;
# each with its caption: the text right under it (or right above it), as written in the document.
import sys, json, os, unicodedata
import pymupdf

path, n, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
doc = pymupdf.open(path); page = doc[n - 1]; P = page.rect
blocks = [b for b in page.get_text('blocks') if b[6] == 0 and b[4].strip()]  # text blocks: x0, y0, x1, y1, text
# which blocks look like captions: smaller than the page's usual text, or in italics
sizes, small = [], set()
for b in page.get_text('dict')['blocks']:
    for l in b.get('lines', []):
        for sp in l['spans']:
            if sp['text'].strip(): sizes.append(sp['size'])
med = sorted(sizes)[len(sizes) // 2] if sizes else 10
for b in page.get_text('dict')['blocks']:
    sp = [sp for l in b.get('lines', []) for sp in l['spans'] if sp['text'].strip()]
    if sp and (sum(x['size'] for x in sp) / len(sp) < med * 0.95 or all(x['flags'] & 2 for x in sp)): small.add(tuple(round(v) for v in b['bbox']))
isCap = lambda b: tuple(round(v) for v in b[:4]) in small

def caption(r, drawn=False):
    near = lambda b: b[0] < r.x1 and b[2] > r.x0
    below = sorted([b for b in blocks if b[1] >= r.y1 - 2 and b[1] - r.y1 < 48 and near(b)], key=lambda b: b[1])
    above = sorted([b for b in blocks if b[3] <= r.y0 + 2 and r.y0 - b[3] < 36 and near(b)], key=lambda b: -b[3])
    capb = [b for b in below if isCap(b)][:2] or [b for b in above if isCap(b)][:1]
    pick = capb or ((above[:1] or below[:1]) if drawn else (below[:2] or above[:1]))  # a caption in small or italic type; otherwise the text right under it, or the heading just above
    t = ' '.join(' '.join(b[4].split()) for b in pick)
    return unicodedata.normalize('NFKC', t)[:400]  # Arabic in PDFs is often stored as presentation forms (ﺑﺮﺷﻚ): back to plain letters (برشك)

found = []
near_x = lambda b, r: b[0] < r.x1 and b[2] > r.x0
# 1. pictures as placed
for info in page.get_image_info(xrefs=True):
    r = pymupdf.Rect(info['bbox']) & P
    if r.is_empty or r.width < P.width * 0.18 or r.height < 60 or r.width * r.height < P.width * P.height * 0.03: continue  # icons, logos, rules
    if any((r & f[0]).get_area() > 0.6 * r.get_area() for f in found): continue
    found.append((r, 'image', r))
# 2. drawn diagrams: clusters of boxes and lines big enough to be a figure, not a page border or a single rule
try:
    for c in page.cluster_drawings(x_tolerance=6, y_tolerance=6):
        r = pymupdf.Rect(c) & P
        if r.width < P.width * 0.35 or r.height < 16 or r.get_area() > P.get_area() * 0.6: continue
        if any((r & f[0]).get_area() > 0.3 * r.get_area() for f in found): continue
        # a diagram has several shapes with words in them (a table's lines or a coloured band alone is not one)
        shapes = [d for d in page.get_drawings() if pymupdf.Rect(d['rect']).intersects(r)]
        words = [b for b in blocks if pymupdf.Rect(b[:4]).intersects(r)]
        if len(shapes) < 4 or not words: continue
        words2 = [b for b in blocks if b[1] >= r.y1 - 1 and b[1] - r.y1 < 16 and near_x(b, r) and len(b[4].strip()) < 40]  # short labels just under the boxes (years)
        y1 = max([r.y1] + [b[3] for b in words2])
        found.append((pymupdf.Rect(r.x0 - 6, r.y0 - 6, r.x1 + 6, y1 + 6) & P, 'drawn', r))
except Exception:
    pass

res = []
for k, (r, kind, core) in enumerate(sorted(found, key=lambda f: (f[0].y0, f[0].x0)), 1):
    zoom = max(1.0, min(3.0, 1400 / max(1, r.width)))
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=r, alpha=False)
    f = os.path.join(out, f'f{n:04d}-{k}.png'); pix.save(f)
    res.append({ 'file': f, 'kind': kind, 'w': pix.width, 'h': pix.height, 'box': [round(r.x0 / P.width, 4), round(r.y0 / P.height, 4), round(r.width / P.width, 4), round(r.height / P.height, 4)], 'caption': caption(core, False) if kind == 'image' else caption(pymupdf.Rect(r.x0, r.y0 + 6, r.x1, r.y1 - 6), True) })
print(json.dumps(res))

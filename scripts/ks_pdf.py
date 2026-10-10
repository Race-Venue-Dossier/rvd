#!/usr/bin/env python3
"""Kurssetzungs-PDFs (Gate-to-Gate-Format) aus monday auswerten: Tore mit Distanz, Versatz, Gefälle, Winkel und Lage im Plan.

Eingabe:  kspdf/todo.json  [{id, d, disc}]  und  kspdf/<id>.pdf   (von scripts/ks.mjs vorbereitet)
Ausgabe:  kspdf/out.json   {id: {gates:[[typ, distanz, versatz, gefälle, winkel, x, y, farbe], ...], fin:[distanz, gefälle, x, y]} | {err:"…"}}
Typ: 0 offen, 1 Banane (Delayed), 2 Hairpin, 3 Flush. x/y in Metern, Start bei 0/0, y talwärts.
Der Plan steht je nach Länge auf Seite 2 (Speed) oder 3 (Technik); genommen wird die erste Seite, deren Tor-Marker zur Tabelle passen.
"""
import json, math, os, re, sys
import pymupdf

H = 'kspdf'
TY = {'Open': 0, 'Delayed': 1, 'Hairpin': 2, 'V.Comb': 3}
RED, BLUE, GREEN = (0.89, 0.29, 0.2), (0.19, 0.51, 0.74), (0.45, 0.77, 0.46)
num = lambda s: float(s.replace('−', '-'))
isnum = lambda s: re.fullmatch(r'[−-]?\d+(\.\d+)?', s) is not None


def lines(page):
    """Wörter zu Zeilen gruppieren (gleiche Höhe ±4 pt)."""
    ws = sorted(page.get_text('words'), key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    out, cur, cy = [], [], None
    for w in ws:
        y = (w[1] + w[3]) / 2
        if cy is not None and abs(y - cy) > 4:
            out.append(sorted(cur)); cur = []
        cur.append(w); cy = y if not cur[:-1] else cy
    if cur: out.append(sorted(cur))
    return [[w[4] for w in l] for l in out]


def table(doc):
    rows, fin = {}, None
    for page in doc:
        for r in lines(page):
            if len(r) < 3 or not re.fullmatch(r'\d+', r[0]): continue
            if r[1] == 'Finish':
                fin = [num(x) for x in r[2:] if isnum(x)]
            elif r[1] in TY:
                v = [num(x) for x in r[2:] if isnum(x)]
                if len(v) >= 3: rows.setdefault(int(r[0]), (TY[r[1]], v))
    return [(n,) + rows[n] for n in sorted(rows)], fin


def fit(pairs):
    n = len(pairs); sx = sum(p for p, _ in pairs); sy = sum(v for _, v in pairs)
    sxx = sum(p * p for p, _ in pairs); sxy = sum(p * v for p, v in pairs)
    a = (n * sxy - sx * sy) / (n * sxx - sx * sx); return a, (sy - a * sx) / n


def plan(page):
    """Marker (rot/blau) und Start/Ziel (grün) in Metern, über die Achsenbeschriftung kalibriert."""
    nums = [w for w in page.get_text('words') if re.fullmatch(r'[−-]?\d+', w[4])]
    if len(nums) < 6: return None
    bottom = max(w[3] for w in nums); xt = [w for w in nums if abs(w[3] - bottom) < 3]
    rest = [w for w in nums if w not in xt]
    if len(xt) < 2 or not rest: return None
    lx = min(w[0] for w in rest)
    yt = [w for w in rest if w[0] < lx + 60 and (abs(num(w[4])) >= 100 or w[4] == '0')]
    if len(yt) < 2: return None
    ax, bx = fit([((w[0] + w[2]) / 2, num(w[4])) for w in xt]); ay, by = fit([((w[1] + w[3]) / 2, num(w[4])) for w in yt])
    mk, se = [], []
    for d in page.get_drawings():
        col = tuple(round(x, 2) for x in (d.get('fill') or ()))
        if d['type'] not in ('f', 'fs'): continue
        r = d['rect']; c = (ax * (r.x0 + r.x1) / 2 + bx, ay * (r.y0 + r.y1) / 2 + by)
        if len(d['items']) == 16 and col in (RED, BLUE): mk.append(c + (1 if col == RED else 0,))
        elif col == GREEN and len(d['items']) >= 4: se.append(c)
    return mk, se


def parse(path):
    doc = pymupdf.open(path); T, fin = table(doc)
    if len(T) < 5: return {'err': 'keine Tortabelle'}
    for pi in range(1, len(doc)):
        p = plan(doc[pi])
        if not p: continue
        mk, se = p
        if len(mk) != len(T): continue
        se.sort(key=lambda q: -q[1]); st = se[0] if se else (0.0, 0.0); fi = se[-1] if len(se) > 1 else None
        cur, free, order = st, list(mk), []
        for n, t, v in T:
            hd = v[0] * math.cos(math.atan(v[2] / 100))
            best = min(free, key=lambda m: abs(math.dist(cur, m[:2]) - hd) + 0.15 * math.dist(cur, m[:2]))
            order.append(best); free.remove(best); cur = best[:2]
        sx = 1 if pi == 1 else -1   # Seite 2: Ansicht Start oben; Seite 3: gespiegelt (wie data/kurs_xy.py)
        tt = lambda q: (round(sx * (q[0] - st[0]), 1), round(-(q[1] - st[1]), 1))
        gates = []
        for i, (n, t, v) in enumerate(T):
            x, y = tt(order[i]); gates.append([t, v[0], v[1], v[2], v[3] if len(v) > 3 else None, x, y, order[i][2]])
        P = [(0, 0)] + [(g[5], g[6]) for g in gates]
        err = max(abs(math.dist(P[i], P[i + 1]) - gates[i][1] * math.cos(math.atan(gates[i][3] / 100))) for i in range(len(gates)))
        if err > 5: continue
        f = None
        if fin:
            fx, fy = tt(fi) if fi else (None, None); f = [fin[0], fin[-1], fx, fy]
        return {'gates': gates, 'fin': f}
    return {'err': 'Plan passt nicht zur Tabelle'}


def main():
    todo = json.load(open(os.path.join(H, 'todo.json'))) if os.path.exists(os.path.join(H, 'todo.json')) else []
    out = {}
    for t in todo:
        p = os.path.join(H, str(t['id']) + '.pdf')
        try: out[str(t['id'])] = parse(p)
        except Exception as e: out[str(t['id'])] = {'err': str(e)[:120]}
        r = out[str(t['id'])]
        print('Kurssetzung', t.get('d', ''), t.get('disc', ''), t['id'], ':', (str(len(r['gates'])) + ' Tore') if 'gates' in r else r['err'])
    json.dump(out, open(os.path.join(H, 'out.json'), 'w'))


if __name__ == '__main__':
    if len(sys.argv) > 1:          # Test: Dateien direkt auswerten
        for p in sys.argv[1:]:
            r = parse(p); print(os.path.basename(p), (str(len(r['gates'])) + ' Tore') if 'gates' in r else r['err'])
    else:
        main()

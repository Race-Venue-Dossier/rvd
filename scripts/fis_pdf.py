#!/usr/bin/env python3
"""FIS «Results, Analysis, Standings» automatisch auswerten (GitHub Action, nach sync-monday.mjs).

Eingabe:  fispdf/todo.json  [{rid, url, d, g, disc, did}]   (von sync-monday.mjs, nur neue Rennen)
          fispdf/slope.json Board «Slope Analysis SPEED» (Streckencharakter und Bedingungen)
Ausgabe:  fispdf/out.json   {races:[...wie speed.json races...], ts:[...wie speed.json ts...], done:[rid,...]}
Gleiche Auswertung wie data/fis_sectors.py + data/speed_build.py (Speed) und data/fis_tech.py (Technik).
"""
import json, os, re, sys, time, urllib.request
import pymupdf

H = 'fispdf'
TEST = os.environ.get('FIS_TEST', '')
MON = dict(JAN='01', FEB='02', MAR='03', APR='04', MAY='05', JUN='06', JUL='07', AUG='08', SEP='09', OCT='10', NOV='11', DEC='12')
T = r'(\d+:\d\d\.\d\d|\d+\.\d\d)'
SEC = {'Technisch (Steil)': 'T', 'Mix (Coupiert)': 'M', 'Gleiten (Flach)': 'G'}
SECK = ['drop_down7', 'dup__of_abschnitt_1', 'dup__of_sec_2', 'dup__of_sec_3', 'dup__of_sec_4',
        'dup__of_sec_5', 'dup__of_sec_6', 'dup__of_sec_7', 'dup__of_sec_8', 'dup__of_sec_9']
DISCN = {'GS': 'Riesenslalom', 'SL': 'Slalom'}


def note(msg):
    print(('::notice title=FIS-PDF::' if TEST else '') + msg)


def pdfinfo(p):
    b = open(p, 'rb').read()
    if not b.startswith(b'%PDF'):
        return 'keine PDF-Datei, %d Bytes, Anfang %r' % (len(b), b[:60])
    try:
        d = pymupdf.open(p)
        heads = []
        for pg in d:
            t = [l.strip() for l in pg.get_text().split('\n') if l.strip()]
            heads.append(next((l for l in t if l.isupper() and len(l) > 12), t[0] if t else ''))
        return '%d Seiten: %s' % (len(d), ' / '.join(sorted(set(heads)))[:300])
    except Exception as e:
        return 'PDF-Fehler %s' % str(e)[:80]


def tsec(s):
    s = s.strip()
    if ':' in s:
        m, x = s.split(':'); return round(int(m) * 60 + float(x), 2)
    return float(s)


def num(v):
    try: return round(float(str(v).replace(',', '.')), 1)
    except Exception: return None


def lst(v): return [x.strip() for x in (v or '').split(',') if x.strip()]


def nice0(n):
    """«ODERMATT Marco» / «von ALLMEN Franjo» -> «Marco Odermatt» / «Franjo von Allmen»"""
    parts = n.split()
    PART = ('von', 'van', 'de', 'di', 'da', 'del', 'der')
    parts = [p.lower() if p.lower() in PART else p for p in parts]
    sur = [p for p in parts if p.isupper() or p in PART]
    first = [p for p in parts if p not in sur]
    def cap(w): return w if w in ('von', 'van', 'de', 'di', 'da', 'del', 'der') else '-'.join(x.capitalize() for x in w.split('-'))
    return ' '.join(first + [cap(w) for w in sur])



def nice(n):
    n = re.sub(r'\bMc([A-Z]+)\b', lambda m: 'MC' + m.group(1), n)
    x = nice0(n)
    return re.sub(r'\bMc(\w)', lambda m: 'Mc' + m.group(1).upper(), x)


def sec_parse(path):
    doc = pymupdf.open(path)
    meta = None; rows = []
    for page in doc:
        t = page.get_text()
        if 'PERFORMANCE ANALYSIS BY RANK' not in t: continue
        L = [l.strip() for l in t.split('\n') if l.strip()]
        if meta is None:
            title = L[0]
            dm = re.search(r'(\d{1,2}) ([A-Z]{3}) (\d{4})', t)
            hdr = next(l for l in L if 'PERFORMANCE ANALYSIS BY RANK' in l)
            place = L[L.index(hdr) + 1]
            meta = dict(title=title, date='%s-%s-%02d' % (dm.group(3), MON[dm.group(2)], int(dm.group(1))),
                        g='W' if re.search(r"Ladies|Women", title) else 'M',
                        disc='SG' if 'Super' in title else ('AC' if 'Combined' in title else 'DH'),
                        tr=bool(re.search(r'TRAINING', hdr)), place=place, hdr=hdr)
        # Athletenbloecke: Zeile = Rang (Zahl), naechste Zeile «Bib NAME»
        i = 0; starts = []
        while i < len(L) - 2:
            if re.fullmatch(r'\d{1,3}', L[i]) and re.fullmatch(r'\d{1,3} [A-Za-zÀ-ÿ\'\-].*', L[i + 1]) and re.fullmatch(r'[A-Z]{3}', L[i + 2]):
                starts.append(i)
            i += 1
        for k, s in enumerate(starts):
            e = starts[k + 1] if k + 1 < len(starts) else len(L)
            blk = L[s:e]
            bib, name = blk[1].split(' ', 1)
            a = dict(r=int(blk[0]), bib=int(bib), n=name, nat=blk[2], ints={}, parts={}, sp={})
            txt = ' '.join(blk[3:])
            T = r'(\d+:\d\d\.\d\d|\d+\.\d\d)'
            for m in re.finditer(r'Int(\d+): ' + T + r' \((\d+)\)', txt): a['ints'][int(m.group(1))] = (tsec(m.group(2)), int(m.group(3)))
            for m in re.finditer(r'(I\d+-(?:I\d+|Fin)): ' + T + r' \((\d+)\)', txt): a['parts'][m.group(1)] = (tsec(m.group(2)), int(m.group(3)))
            for m in re.finditer(r'Sp(\d+) (\d+\.\d+) \((\d+)\)', txt): a['sp'][int(m.group(1))] = (float(m.group(2)), int(m.group(3)))
            m = re.search(r'(?<!-)Fin: ' + T + r' \((\d+)\)', txt)
            if m: a['fin'] = tsec(m.group(1))
            rows.append(a)
    if not meta: return None
    # Sektoren: S1 = Int1, Sk = I(k-1)-Ik, letzte = In-Fin
    n = max([max(a['ints']) for a in rows if a['ints']] or [0])
    out = []
    for a in rows:
        if 'fin' not in a: continue
        sec = []
        ok = True
        for k in range(1, n + 2):
            if k == 1:
                v = a['ints'].get(1)
            elif k <= n:
                v = a['parts'].get('I%d-I%d' % (k - 1, k))
            else:
                v = a['parts'].get('I%d-Fin' % n)
            if not v or v[0] is None: ok = False; break
            sec.append([v[0], v[1]])
        if not ok: continue
        # Plausibilitaet: Summe Sektoren = Endzeit
        if abs(sum(x[0] for x in sec) - a['fin']) > 0.05: continue
        out.append(dict(r=a['r'], bib=a['bib'], n=a['n'], nat=a['nat'], fin=a['fin'], sec=sec,
                        sp=[a['sp'].get(k, (None, None))[0] for k in range(1, n + 2)]))
    meta.update(n=n + 1, ath=out)
    return meta


def tech_parse(path):
    doc = pymupdf.open(path)
    ath = []
    for page in doc:
        t = page.get_text()
        if 'PERFORMANCE ANALYSIS BY BIB' not in t:
            continue
        L = [l.strip() for l in t.split('\n') if l.strip()]
        idx = [i for i, l in enumerate(L) if l.startswith('Run 1:')]
        for k, i in enumerate(idx):
            e = idx[k + 1] - 4 if k + 1 < len(idx) else len(L)
            name, nat = L[i - 3], L[i - 2]
            if not re.fullmatch(r'[A-Z]{3}', nat):
                continue
            txt = ' '.join(L[i:e])
            segs = re.split(r'(Run [12]:|Total:)', txt)
            a = dict(n=name, nat=nat, runs={})
            for j in range(1, len(segs) - 1, 2):
                lab, s = segs[j], segs[j + 1]
                if lab.startswith('Total'):
                    m = re.search(r'(?<!-)Fin: ' + T + r' \((\d+)\)', s)
                    mm = re.search(r'(DNQ|DNF|DSQ|DNS)', s)
                    a['tot'] = int(m.group(2)) if m else (mm.group(1) if mm else '')
                    continue
                if not lab.startswith('Run'):
                    continue
                rn = int(lab[4])
                o = dict(ints={}, parts={})
                for m in re.finditer(r'Int(\d+): ' + T + r' \((\d+)\)', s): o['ints'][int(m.group(1))] = (tsec(m.group(2)), int(m.group(3)))
                for m in re.finditer(r'(I\d+-(?:I\d+|Fin)): ' + T + r' \((\d+)\)', s): o['parts'][m.group(1)] = (tsec(m.group(2)), int(m.group(3)))
                m = re.search(r'(?<!-)Fin: ' + T + r' \((\d+)\)', s)
                if m:
                    o['fin'] = (tsec(m.group(1)), int(m.group(2)))
                a['runs'][rn] = o
            ath.append(a)
    return ath



def slope_index():
    B = {}
    try:
        items = json.load(open(os.path.join(H, 'slope.json')))
    except Exception:
        return B
    for c in items:
        cv = {k: (v if isinstance(v, str) else None) for k, v in c['column_values'].items()}
        grp = (c.get('group') or {}).get('title') or ''
        if not cv.get('datum'): continue
        G = 'M' if grp.startswith('Herren') else 'W'
        nm = c['name']
        disc = 'SG' if re.search(r'\bSG', nm) else 'DH'
        tr = bool(re.search(r'\bTR', nm))
        d = cv['datum']
        try:
            y = int(grp.split()[-1][:4]); mo = int(d[5:7]); d = '%d%s' % (y if mo >= 7 else y + 1, d[4:])
        except Exception:
            pass
        B[(d, G, disc, tr)] = dict(sec=[SEC.get(cv.get(k)) for k in SECK if cv.get(k) in SEC],
                                   air=[num(cv.get('zahlen')), num(cv.get('numeric'))], snow=[num(cv.get('zahlen1')), num(cv.get('numeric4'))],
                                   rh=[num(cv.get('numeric0')), num(cv.get('numeric2'))], tm=[cv.get('text3'), cv.get('text8')],
                                   prep=lst(cv.get('drop_down0')), wx=lst(cv.get('drop_down6')))
    return B


def speed_race(rid, m, B):
    disc = m['disc'] if m['disc'] in ('DH', 'SG') else 'DH'
    c = B.get((m['date'], m['g'], disc, m['tr']))
    n = m['n']; ath = m['ath']
    st = c['sec'] if c and len(c['sec']) == n else None
    best = []
    for k in range(n):
        b = min(ath, key=lambda a: a['sec'][k][0])
        best.append([b['sec'][k][0], nice(b['n']), b['nat']])
    bf = min(a['fin'] for a in ath)
    A = [[nice(a['n']), a['nat'], a['r'], a['fin'], [round(a['sec'][k][0] - best[k][0], 2) for k in range(n)], [a['sec'][k][1] for k in range(n)]]
         for a in sorted(ath, key=lambda a: a['r'])]
    cc = {}
    if c:
        for k in ('air', 'snow', 'rh'):
            if any(v is not None for v in c[k]): cc[k] = c[k]
        if any(c['tm']): cc['tm'] = c['tm']
        if c['prep']: cc['prep'] = c['prep']
        if c['wx']: cc['wx'] = c['wx']
    pl = re.sub(r'\s*\(.*\)$', '', m['place'])
    tn = re.search(r'(\d)(?:ST|ND|RD|TH) TRAINING', m['hdr'])
    lab = ('Abfahrt' if disc == 'DH' else 'Super-G') + (' Training' + (' ' + tn.group(1) if tn else '') if m['tr'] else '')
    return dict(id=int(rid), d=m['date'], g=m['g'], disc=disc, tr=m['tr'], pl=pl, lab=lab, n=n, st=st, c=cc, best=best, bf=bf, a=A, auto=1)


def tech_runs(rid, meta, ath):
    out = []
    for rn in (1, 2):
        R = [a for a in ath if rn in a['runs'] and 'fin' in a['runs'][rn]]
        if not R: continue
        n = max([max(a['runs'][rn]['ints']) for a in R if a['runs'][rn]['ints']] or [0])
        rows = []
        for a in R:
            o = a['runs'][rn]; sec = []
            for k in range(1, n + 2):
                v = o['ints'].get(1) if k == 1 else (o['parts'].get('I%d-I%d' % (k - 1, k)) if k <= n else o['parts'].get('I%d-Fin' % n))
                if not v: sec = None; break
                sec.append(v)
            if not sec or abs(sum(x[0] for x in sec) - o['fin'][0]) > 0.05: continue
            rows.append([nice(a['n']), a['nat'], o['fin'][1], o['fin'][0], sec])
        if not rows: continue
        rows.sort(key=lambda x: (x[2], x[3]))
        best = []
        for k in range(n + 1):
            b = min(rows, key=lambda x: x[4][k][0]); best.append([b[4][k][0], b[0], b[1]])
        bf = min(x[3] for x in rows)
        a2 = [[x[0], x[1], x[2], x[3], [round(x[4][k][0] - best[k][0], 2) for k in range(n + 1)], [x[4][k][1] for k in range(n + 1)]] for x in rows if x[2] <= 5 or x[1] == 'SUI']
        out.append(dict(id=int(rid), d=meta['d'], g=meta['g'], disc=meta['disc'], run=rn, pl=meta['pl'], lab=DISCN[meta['disc']] + ' · ' + str(rn) + '. Lauf',
                        n=n + 1, best=best, bf=bf, a=a2, auto=1))
    return out


def tech_meta(path, fallback):
    doc = pymupdf.open(path)
    for page in doc:
        t = page.get_text()
        if 'PERFORMANCE ANALYSIS' not in t and 'OFFICIAL RESULTS' not in t: continue
        L = [l.strip() for l in t.split('\n') if l.strip()]
        hdr = next((l for l in L if 'PERFORMANCE ANALYSIS' in l or 'OFFICIAL RESULTS' in l), None)
        place = L[L.index(hdr) + 1] if hdr else ''
        return dict(d=fallback['d'], g=fallback['g'], disc=fallback['disc'], pl=fallback.get('pl') or re.sub(r'\s*\(.*\)$', '', place).strip())
    return dict(fallback)


def main():
    try:
        todo = json.load(open(os.path.join(H, 'todo.json')))
    except Exception:
        todo = []
    if not todo:
        print('FIS-PDF: nichts zu tun'); return
    B = slope_index()
    res = dict(races=[], ts=[], done=[])
    for t in todo:
        rid = str(t['rid']); p = os.path.join(H, rid + '.pdf')
        try:
            req = urllib.request.Request(t['url'], headers={'User-Agent': 'Swiss-Ski FEA Race Venue Dossier (internal)'})
            open(p, 'wb').write(urllib.request.urlopen(req, timeout=60).read())
            time.sleep(1)
        except Exception as e:
            note('%s nicht geladen: %s' % (rid, str(e)[:80])); continue
        try:
            if t['disc'] in ('DH', 'SG', 'DHT'):
                m = sec_parse(p)
                if not m or not m['ath']:
                    note('%s %s: noch keine Analyse im PDF (%s)' % (rid, t['disc'], pdfinfo(p))); continue
                r = speed_race(rid, m, B)
                if t.get('pl'): r['pl'] = t['pl']
                res['races'].append(r)
                note('%s %s %s %s: %d Sektoren, %d Athlet:innen, %d SUI, Streckencharakter %s' % (rid, r['d'], r['g'], r['lab'], r['n'], len(r['a']), sum(a[1] == 'SUI' for a in r['a']), 'ja' if r['st'] else 'nein'))
            elif t['disc'] in ('GS', 'SL'):
                ath = tech_parse(p)
                if not ath:
                    note('%s %s: noch keine Analyse im PDF (%s)' % (rid, t['disc'], pdfinfo(p))); continue
                runs = tech_runs(rid, tech_meta(p, t), ath)
                if not runs:
                    note('%s: keine Laufzeiten' % rid); continue
                res['ts'] += runs
                note('%s %s %s %s: %d Läufe, SUI %s' % (rid, t['d'], t['g'], t['disc'], len(runs), ', '.join(str(sum(a[1] == 'SUI' for a in r['a'])) for r in runs)))
            else:
                continue
            res['done'].append(rid)
        except Exception as e:
            note('%s Fehler: %s' % (rid, str(e)[:120]))
    json.dump(res, open(os.path.join(H, 'out.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print('FIS-PDF:', len(res['races']), 'Speed-Rennen,', len(res['ts']), 'Technik-Läufe')


if __name__ == '__main__':
    main()

// Kurssetzungs-PDFs aus monday («Art: Kurssetzung» mit PDF in «Datei») automatisch auswerten.
//   node scripts/ks.mjs prep   → kspdf/todo.json und kspdf/<datei-id>.pdf (nur noch nicht ausgewertete)
//   python3 scripts/ks_pdf.py  → kspdf/out.json
//   node scripts/ks.mjs store  → Ergebnisse in data/ks.enc (Zwischenspeicher) und in data/live.enc beim Unterelement (sub.ks)
// Danach zeigt die Seite die Kurssetzung wie bei Technik: Kennzahlen, Plan, Torliste und das PDF.
import fs from 'node:fs';
import crypto from 'node:crypto';
const PASS = process.env.RVD_PASS, MODE = process.argv[2] || 'prep';
if (!PASS || !fs.existsSync('data/live.enc')) { console.log('ks: nichts zu tun'); process.exit(0); }
const kj = JSON.parse(fs.readFileSync('key.json', 'utf8'));
const K = crypto.pbkdf2Sync(PASS, Buffer.from(kj.salt, 'base64'), kj.iter, 32, 'sha256');
const enc = b => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', K, iv); return Buffer.concat([iv, c.update(b), c.final(), c.getAuthTag()]); };
const dec = b => { const d = crypto.createDecipheriv('aes-256-gcm', K, b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]); };
const live = JSON.parse(dec(fs.readFileSync('data/live.enc')).toString());
let cache = {}; try { cache = JSON.parse(dec(fs.readFileSync('data/ks.enc')).toString()); } catch (e) {}
// alle Kurssetzungs-PDFs in «RVD Sync»
const subs = [];
for (const p of (live.rvd || {}).items || []) for (const s of p.sub || []) {
  if (!/Kurssetzung/i.test(s.art || '')) continue;
  const f = (s.files || []).find(x => x.ok && /^pdf$/i.test(x.ext || '') && fs.existsSync('monasset/' + x.id + '.enc'));
  if (f) subs.push({ s, f, d: s.d || '', disc: s.disc || '' });
}
if (MODE === 'prep') {
  const todo = subs.filter(x => !cache[x.f.id]);
  fs.mkdirSync('kspdf', { recursive: true });
  for (const x of todo) fs.writeFileSync('kspdf/' + x.f.id + '.pdf', dec(fs.readFileSync('monasset/' + x.f.id + '.enc')));
  fs.writeFileSync('kspdf/todo.json', JSON.stringify(todo.map(x => ({ id: x.f.id, d: x.d, disc: x.disc }))));
  console.log('ks: ' + subs.length + ' Kurssetzungs-PDFs, ' + todo.length + ' neu auszuwerten');
} else {
  let add = {}; try { add = JSON.parse(fs.readFileSync('kspdf/out.json', 'utf8')); } catch (e) {}
  let nNew = 0;
  for (const [id, r] of Object.entries(add)) { cache[id] = r; nNew++; }
  if (nNew) fs.writeFileSync('data/ks.enc', enc(Buffer.from(JSON.stringify(cache))));
  let nIn = 0, changed = false;
  for (const x of subs) {
    const r = cache[x.f.id]; if (!r || !r.gates) continue;
    const v = { fid: x.f.id, gates: r.gates, fin: r.fin };
    if (JSON.stringify(x.s.ks) !== JSON.stringify(v)) { x.s.ks = v; changed = true; }
    nIn++;
  }
  if (changed) fs.writeFileSync('data/live.enc', enc(Buffer.from(JSON.stringify(live))));
  const bad = Object.entries(add).filter(([, r]) => r.err).map(([id, r]) => id + ': ' + r.err);
  console.log((process.env.GITHUB_ACTIONS ? '::notice title=Kurssetzungen::' : '') + nIn + ' Kurssetzungen mit Tordaten' + (nNew ? ' · ' + nNew + ' neu ausgewertet' : '') + (bad.length ? ' · nicht lesbar: ' + bad.join('; ') : ''));
}

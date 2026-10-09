// Speichert die automatisch ausgewerteten FIS-Sektordaten (fispdf/out.json von fis_pdf.py) verschlüsselt in data/fissec.enc.
// Läuft in der GitHub Action nach fis_pdf.py. data/fissec_done.json listet die fertigen FIS-Rennnummern.
import fs from 'node:fs';
import crypto from 'node:crypto';
const PASS = process.env.RVD_PASS;
if (!PASS || !fs.existsSync('fispdf/out.json')) { console.log('fis-store: nichts zu tun'); process.exit(0); }
const add = JSON.parse(fs.readFileSync('fispdf/out.json', 'utf8'));
if (process.env.FIS_TEST) { console.log('::notice title=FIS-PDF::Test: ' + add.races.length + ' Speed-Rennen, ' + add.ts.length + ' Technik-Läufe ausgewertet, nicht gespeichert'); process.exit(0); }
if (!add.done.length) { console.log('fis-store: keine neuen Rennen'); process.exit(0); }
const key = JSON.parse(fs.readFileSync('key.json', 'utf8'));
const k = crypto.pbkdf2Sync(PASS, Buffer.from(key.salt, 'base64'), key.iter, 32, 'sha256');
let cur = { races: [], ts: [] };
if (fs.existsSync('data/fissec.enc')) {
  const b = fs.readFileSync('data/fissec.enc');
  const dc = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12)); dc.setAuthTag(b.subarray(b.length - 16));
  cur = JSON.parse(Buffer.concat([dc.update(b.subarray(12, b.length - 16)), dc.final()]).toString());
}
const ids = new Set(add.races.map(r => r.id)), tids = new Set(add.ts.map(r => r.id + '|' + r.run));
cur.races = cur.races.filter(r => !ids.has(r.id)).concat(add.races).sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
cur.ts = cur.ts.filter(r => !tids.has(r.id + '|' + r.run)).concat(add.ts).sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : a.run - b.run);
cur.at = Date.now();
const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
const ct = Buffer.concat([c.update(JSON.stringify(cur)), c.final(), c.getAuthTag()]);
fs.writeFileSync('data/fissec.enc', Buffer.concat([iv, ct]));
let done = []; try { done = JSON.parse(fs.readFileSync('data/fissec_done.json', 'utf8')); } catch (e) {}
fs.writeFileSync('data/fissec_done.json', JSON.stringify([...new Set(done.concat(add.done.map(String)))].sort()));
console.log('fis-store:', cur.races.length, 'Speed-Rennen,', cur.ts.length, 'Technik-Läufe gespeichert');

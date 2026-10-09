// Holt die monday-Boards «Sport Science Support» (Einsatzplanung), «Slope Analysis TECH» und «RVD Sync»
// (Event-Inhalte: Kurssetzungen, Gate-to-Gate, Videos, Links, Dateien) und legt sie verschlüsselt als data/live.enc ab.
// Dateien aus «RVD Sync» werden einmalig heruntergeladen und verschlüsselt unter monasset/<id>.enc abgelegt. Läuft als GitHub Action (siehe .github/workflows/monday-sync.yml).
// Benötigte Repository-Secrets: MONDAY_TOKEN (monday API-Token), RVD_PASS (Passwort der Seite).
import fs from 'node:fs';
import crypto from 'node:crypto';

const TOKEN = process.env.MONDAY_TOKEN, PASS = process.env.RVD_PASS;
if (!TOKEN || !PASS) { console.log('Secrets MONDAY_TOKEN und RVD_PASS fehlen noch – Abgleich übersprungen.'); process.exit(0); }
const BOARDS = {
  einsatz: { id: 18385700928, cols: ['zeitleiste', 'dup__of_responsible__1', 'personen__1', 'dup__of_sport__1', 'sport', 'disziplin__1', 'label', 'status'] },
  tech: { id: 7222612952, cols: ['datum', 'drop_down', 'dup__of_typ', 'drop_down7', 'dup__of_abschnitt_1', 'dup__of_sec_2', 'dup__of_sec_3', 'dup__of_sec_4', 'dup__of_sec_5', 'dup__of_sec_6', 'dup__of_sec_7', 'dup__of_sec_8', 'dup__of_sec_9', 'zahlen', 'numeric', 'zahlen1', 'numeric4', 'numeric0', 'numeric2', 'text3', 'text8', 'drop_down0', 'drop_down6', 'drop_down5'] },
};

async function gql(query, variables) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: TOKEN, 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error(JSON.stringify(j.errors || j).slice(0, 500));
  return j.data;
}

async function board(b) {
  const items = [];
  let d = await gql(`query($id:[ID!],$cols:[String!]){ boards(ids:$id){ items_page(limit:500){ cursor items{ id name url group{title} column_values(ids:$cols){ id text } } } } }`, { id: [b.id], cols: b.cols });
  let page = d.boards[0].items_page;
  for (;;) {
    for (const it of page.items) {
      const cv = {};
      for (const c of it.column_values) cv[c.id] = c.text || null;
      items.push({ id: it.id, name: it.name, url: it.url, group: it.group, column_values: cv });
    }
    if (!page.cursor) break;
    d = await gql(`query($c:String!,$cols:[String!]){ next_items_page(limit:500,cursor:$c){ cursor items{ id name url group{title} column_values(ids:$cols){ id text } } } }`, { c: page.cursor, cols: b.cols });
    page = d.next_items_page;
  }
  return items;
}

// ── RVD Sync (Board 18434554343, Unterelemente 18434562036) ──
const RVD = 18434554343, RVD_SUB = 18434562036;
const PCOLS = ['text_mm7y6990', 'timerange_mm7ynrqk', 'color_mm7y4pr', 'color_mm7y6xtz', 'long_text_mm7yahaq', 'dropdown_mm7zsj09'];
const SCOLS = ['status', 'date0', 'dropdown_mm7yqjaj', 'color_mm7y3pqp', 'file_mm7ys0e2', 'link_mm7yseny', 'long_text_mm7ya2cv', 'dropdown_mm7zem4t', 'color_mm7zkayz', 'person'];
const SUBQ = `id name updated_at parent_item{ id } column_values(ids:$sc){ id text value ... on FileValue{ files{ ... on FileAssetValue{ asset{ id name file_extension file_size public_url } } } } }`;
async function rvdBoard() {
  const parents = {};
  for (const it of await board({ id: RVD, cols: PCOLS })) {
    const cv = it.column_values;
    parents[it.id] = { id: it.id, name: it.name, url: it.url, grp: it.group && it.group.title, did: cv.text_mm7y6990 || '', span: cv.timerange_mm7ynrqk || '', g: cv.color_mm7y4pr || '', cat: cv.color_mm7y6xtz || '', info: cv.long_text_mm7yahaq || '', ath: cv.dropdown_mm7zsj09 || '', sub: [] };
  }
  let d = await gql(`query($id:[ID!],$sc:[String!]){ boards(ids:$id){ items_page(limit:200){ cursor items{ ${SUBQ} } } } }`, { id: [RVD_SUB], sc: SCOLS });
  let page = d.boards[0].items_page;
  for (;;) {
    for (const it of page.items) {
      const p = it.parent_item && parents[it.parent_item.id]; if (!p) continue;
      const cv = {}, files = [];
      for (const c of it.column_values) { cv[c.id] = c.text || ''; if (c.files) for (const f of c.files) if (f.asset) files.push(f.asset); }
      let link = null;
      try { const lv = JSON.parse((it.column_values.find(c => c.id === 'link_mm7yseny') || {}).value || 'null'); if (lv && lv.url) link = { u: lv.url, t: lv.text || '' }; } catch (e) {}
      // Vorlage ohne Inhalt (keine Datei, kein Link, keine Notiz): nur für «offene Analysen» mitgeben
      if (!files.length && !link && !(cv.long_text_mm7ya2cv || '').trim()) {
        p.sub.push({ id: it.id, name: it.name, art: cv.status, d: cv.date0, disc: cv.dropdown_mm7yqjaj, run: cv.color_mm7y3pqp, st: cv.color_mm7zkayz || '', ath: cv.dropdown_mm7zem4t || '', who: cv.person || '', e: 1, files: [] });
        continue;
      }
      p.sub.push({ id: it.id, name: it.name, art: cv.status, d: cv.date0, disc: cv.dropdown_mm7yqjaj, run: cv.color_mm7y3pqp, note: cv.long_text_mm7ya2cv, link, st: cv.color_mm7zkayz || '', ath: cv.dropdown_mm7zem4t || '', who: cv.person || '',
        files: files.map(a => ({ id: a.id, n: a.name, ext: (a.file_extension || '').replace(/^\./, '').toLowerCase(), size: +a.file_size || 0, url: a.public_url })) });
    }
    if (!page.cursor) break;
    d = await gql(`query($c:String!,$sc:[String!]){ next_items_page(limit:200,cursor:$c){ cursor items{ ${SUBQ} } } }`, { c: page.cursor, sc: SCOLS });
    page = d.next_items_page;
  }
  return Object.values(parents).filter(p => p.sub.length || p.info || p.ath);
}

const out = {};
for (const [k, b] of Object.entries(BOARDS)) out[k] = { items: await board(b) };
out.rvd = { items: await rvdBoard() };
// Dateien: Download-Adressen gelten nur eine Stunde, deshalb werden sie einmalig geholt und verschlüsselt im Repo abgelegt.
const MAXA = 40 * 1024 * 1024;
// Aus dem Dossier nach monday kopierte Dateien sind schon auf der Seite: nicht nochmals holen (data/monasset_skip.json)
let SKIP = { names: [], ids: [] };
try { SKIP = JSON.parse(fs.readFileSync('data/monasset_skip.json', 'utf8')); } catch (e) {}
const skipN = new Set(SKIP.names || []), skipI = new Set((SKIP.ids || []).map(String));
const assets = [];
for (const p of out.rvd.items) for (const s of p.sub) for (const f of s.files) {
  f.dup = skipN.has(f.n) || skipI.has(String(f.id));
  f.ok = !f.dup && f.size <= MAXA && !!f.ext; if (f.ok) assets.push({ ...f }); delete f.url; }
const body = JSON.stringify(out);
const hash = crypto.createHash('sha256').update(body).digest('hex');
const hf = 'data/live.sha';
if (fs.existsSync(hf) && fs.readFileSync(hf, 'utf8').trim() === hash) { console.log('unverändert'); process.exit(0); }

const key = JSON.parse(fs.readFileSync('key.json', 'utf8'));
const k = crypto.pbkdf2Sync(PASS, Buffer.from(key.salt, 'base64'), key.iter, 32, 'sha256');
// Passwort prüfen (gleicher Kontrollwert wie die Login-Seite)
const chk = Buffer.from(key.check, 'base64');
const dc = crypto.createDecipheriv('aes-256-gcm', k, chk.subarray(0, 12));
dc.setAuthTag(chk.subarray(chk.length - 16));
const ok = Buffer.concat([dc.update(chk.subarray(12, chk.length - 16)), dc.final()]).toString();
if (ok !== 'rvd-ok') { console.error('RVD_PASS passt nicht zu key.json'); process.exit(1); }

fs.mkdirSync('monasset', { recursive: true });
const enc = (buf) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv); return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]); };
let nA = 0;
for (const f of assets) {
  const fp = 'monasset/' + f.id + '.enc';
  if (fs.existsSync(fp)) continue;
  try { const r = await fetch(f.url); if (!r.ok) throw new Error(r.status); fs.writeFileSync(fp, enc(Buffer.from(await r.arrayBuffer()))); nA++; }
  catch (e) { console.log('Datei nicht geladen', f.id, f.n, String(e).slice(0, 80)); f.ok = false; }
}
out.at = Date.now();
const iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', k, iv);
const ct = Buffer.concat([c.update(JSON.stringify(out)), c.final(), c.getAuthTag()]);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/live.enc', Buffer.concat([iv, ct]));
fs.writeFileSync(hf, hash + '\n');
console.log('aktualisiert:', out.einsatz.items.length, 'Einsätze,', out.tech.items.length, 'Läufe TECH,', out.rvd.items.length, 'Events RVD Sync,', nA, 'neue Dateien');

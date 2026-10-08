// Holt die monday-Boards «Sport Science Support» (Einsatzplanung) und «Slope Analysis TECH»
// und legt sie verschlüsselt als data/live.enc ab. Läuft als GitHub Action (siehe .github/workflows/monday-sync.yml).
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

const out = {};
for (const [k, b] of Object.entries(BOARDS)) out[k] = { items: await board(b) };
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

out.at = Date.now();
const iv = crypto.randomBytes(12);
const c = crypto.createCipheriv('aes-256-gcm', k, iv);
const ct = Buffer.concat([c.update(JSON.stringify(out)), c.final(), c.getAuthTag()]);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/live.enc', Buffer.concat([iv, ct]));
fs.writeFileSync(hf, hash + '\n');
console.log('aktualisiert:', out.einsatz.items.length, 'Einsätze,', out.tech.items.length, 'Läufe TECH');

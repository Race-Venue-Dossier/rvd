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

// ───────────── FIS ─────────────
const UA = { 'User-Agent': 'Swiss-Ski FEA Race Venue Dossier (internal; contact via swiss-ski.ch)', 'Accept-Language': 'en' };
async function robotsOk(path) {
  const r = await fetch('https://www.fis-ski.com/robots.txt', { headers: UA });
  if (!r.ok) return true;
  const lines = (await r.text()).split(/\r?\n/); let applies = false; const dis = [];
  for (const l of lines) {
    const m = l.match(/^\s*([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') applies = v === '*';
    else if (k === 'disallow' && applies && v) dis.push(v);
  }
  return !dis.some(d => path.startsWith(d.replace(/\*.*$/, '')));
}
const ent = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const strip = s => ent(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const DISCS = [['Downhill Training', 'DHT'], ['Training', 'DHT'], ['Super G', 'SG'], ['Super-G', 'SG'], ['Giant Slalom', 'GS'], ['Parallel', 'PAR'], ['Slalom', 'SL'], ['Downhill', 'DH'], ['Alpine combined', 'AC'], ['Team Combined', 'TC']];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseRows(html) {
  const rows = [];
  const re = /<a[^>]*class="[^"]*table-row[^"]*"[^>]*>([\s\S]*?)<\/a>/g; let m;
  while ((m = re.exec(html))) {
    const inner = m[1];
    const nat = (inner.match(/country__name-short[^>]*>\s*([A-Z]{3})\s*</) || [])[1] || '';
    const cells = [...inner.matchAll(/<div[^>]*class="([^"]*)"[^>]*>([^<]*)<\/div>/g)].map(c => ({ c: c[1], t: ent(c[2]).trim() })).filter(c => c.t);
    const name = (cells.find(c => /justify-left/.test(c.c) && /[A-Za-z]{2}/.test(c.t) && !/^\d/.test(c.t)) || {}).t || '';
    if (!name || !nat) continue;
    const nums = cells.map(c => c.t);
    const rk = /^\d+$/.test(nums[0]) && /bold|pr-1/.test(cells[0].c) ? +nums[0] : null;
    const times = nums.filter(t => /^(\d+:)?\d{1,2}\.\d\d$/.test(t));
    const diff = nums.find(t => /^\+\d/.test(t)) || '';
    rows.push({ n: name, nat, rk, t: times[times.length - 1] || '', diff });
  }
  return rows;
}
const FIS_PDF = [];
async function fisSync(rvdItems) {
  const today = new Date(); const day = d => new Date(d + 'T12:00:00Z');
  const TEST = (process.env.FIS_TEST || '').trim();  // Test über «Run workflow»: Dossier-ID eines vergangenen Events
  const near = rvdItems.filter(p => {
    if (TEST) return p.did === TEST;
    const m = (p.span || '').match(/(\d{4}-\d\d-\d\d)\s*-\s*(\d{4}-\d\d-\d\d)/); if (!m || !/^\d{4}-\d+-[MW]$/.test(p.did || '')) return false;
    return (day(m[1]) - today) / 864e5 <= 2 && (today - day(m[2])) / 864e5 <= 1;
  });
  if (!near.length) { console.log((TEST ? '::notice title=FIS-Test::' : '') + 'FIS: keine Events in der Nähe'); return {}; }
  if (!(await robotsOk('/DB/general/'))) { console.log((TEST ? '::notice title=FIS-Test::' : '') + 'FIS: robots.txt erlaubt den Abruf nicht'); return {}; }
  const res = {};
  for (const p of near) {
    const [season, eid] = p.did.split('-');
    const evUrl = `https://www.fis-ski.com/DB/general/event-details.html?sectorcode=AL&eventid=${eid}&seasoncode=${season}`;
    const eh = await (await fetch(evUrl, { headers: UA })).text();
    const ids = [...new Set([...eh.matchAll(/results\.html\?sectorcode=AL(?:&amp;|&)raceid=(\d+)/g)].map(x => x[1]))];
    // Zeile zum Rennen in der Event-Übersicht: Datum, Disziplin, Geschlecht
    const rowInfo = rid => {
      const all = [...eh.matchAll(new RegExp('<a[^>]*raceid=' + rid + '[^0-9][^>]*>([\\s\\S]*?)</a>', 'g'))].map(x => strip(x[1])).filter(Boolean);
      return all.join(' ');
    };
    const wantG = p.did.slice(-1);
    // PDFs «Results, Analysis, Standings» in der Event-Übersicht: dem Rennen davor zuordnen
    const pdfOf = {}, pos = [...eh.matchAll(/raceid=(\d+)/g)].map(x => [x.index, x[1]]);
    let lastEnd = 0;
    for (const a of eh.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const before = strip(eh.slice(lastEnd, a.index)); lastEnd = a.index + a[0].length;
      const hr = (a[1].match(/href="([^"]+)"/) || [])[1]; if (!hr) continue;
      const ga = (a[1].match(/data-ga-download="([^"]*)"/) || [])[1] || '';
      const own = strip(a[2]) + ' ' + ga;
      // Beschriftung im Link selbst oder direkt davor (nicht die des nächsten Dokuments)
      if (!(/Analysis/i.test(own) || /Analysis/i.test(before.slice(-160))) || /raceid=/.test(hr)) continue;
      const prev = pos.filter(x => x[0] < a.index).pop(); if (!prev || pdfOf[prev[1]]) continue;
      const u = ent(hr); pdfOf[prev[1]] = u.startsWith('http') ? u : 'https://www.fis-ski.com' + u;
    }
    if (TEST) console.log('::notice title=FIS-PDF-Links::' + (Object.entries(pdfOf).map(([k, v]) => k + ' → ' + v.slice(0, 90)).join(' | ') || 'keine'));
    for (const rid of ids) {
      const info = rowInfo(rid);
      const gm = info.match(/\b(?:WC|EC|WSC|OWG|NAC|FIS)\s+([MW])\b/), ig = gm ? gm[1] : /\bWomen\b|\bLadies\b/.test(info) ? 'W' : /\bMen\b/.test(info) ? 'M' : '';
      if (ig && ig !== wantG) continue;
      await new Promise(r => setTimeout(r, 800));
      const html = await (await fetch(`https://www.fis-ski.com/DB/general/results.html?sectorcode=AL&raceid=${rid}`, { headers: UA })).text();
      const head = strip((html.match(/<h1[\s\S]*?<\/h1>/) || [''])[0] + ' ' + (html.match(/event-header__subtitle[\s\S]{0,400}/) || [''])[0] + ' ' + (html.match(/<title>[\s\S]*?<\/title>/) || [''])[0]);
      const g = ig || (/\b(Women|Ladies)\b/i.test(head) ? 'W' : /\bMen\b/i.test(head) ? 'M' : '');
      if (g && g !== wantG) continue;
      const disc = (DISCS.find(d => new RegExp(d[0], 'i').test(info)) || DISCS.find(d => new RegExp(d[0], 'i').test(head)) || [])[1] || '';
      const dm = (info + ' ' + head).match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+(\d{4}))?/i);
      let d = '';
      if (dm) { const mo = MONTHS[dm[2].toLowerCase().slice(0, 3)]; const yr = dm[3] || (mo >= 7 ? +season - 1 : +season); d = `${yr}-${String(mo).padStart(2, '0')}-${dm[1].padStart(2, '0')}`; }
      const rows = parseRows(html);
      const ranked = rows.some(r => r.rk) && rows.some(r => r.t);  // Startliste: Nummern, aber keine Zeiten
      const kind = rows.length ? (ranked ? 'res' : 'start') : 'none';
      const keep = rows.filter(r => r.nat === 'SUI' || (r.rk && r.rk <= 3));
      // PDF «Results, Analysis, Standings» (Zwischenzeiten) für die automatische Sektoranalyse
      const pdf = pdfOf[rid] || '';
      res[rid] = { did: p.did, d, g, disc, kind, n: rows.length, rows: keep, pdf };
      if (kind === 'res' && pdf && /^(DH|SG|DHT|GS|SL)$/.test(disc)) FIS_PDF.push({ rid, url: pdf, d, g, disc, did: p.did, pl: (p.name || '').split('·')[0].replace(/\s*\(.*\)/, '').trim() });
      const msg = ['FIS', p.did, rid, disc, g, d, kind, rows.length, 'Zeilen,', keep.filter(r => r.nat === 'SUI').length, 'SUI'].join(' ');
      console.log(TEST ? '::notice title=FIS-Test::' + msg + ' · ' + keep.filter(r => r.nat === 'SUI').slice(0, 3).map(r => r.rk + '. ' + r.n).join(', ') : msg);
    }
  }
  return res;
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
// ── FIS: Startlisten und Resultate rund um die Renntage (nur Events von 2 Tagen vorher bis 1 Tag nachher) ──
// Hält sich an robots.txt, wenige Abrufe pro Lauf, speichert nur Schweizer Zeilen und das Podest.
out.fis = await fisSync(out.rvd.items).catch(e => { console.log('FIS übersprungen:', String(e).slice(0, 120)); return {}; });
// Neue PDFs für scripts/fis_pdf.py vormerken (schon ausgewertete stehen in data/fissec_done.json)
{
  let done = []; try { done = JSON.parse(fs.readFileSync('data/fissec_done.json', 'utf8')); } catch (e) {}
  const todo = FIS_PDF.filter(t => process.env.FIS_TEST || !done.includes(String(t.rid)));
  fs.mkdirSync('fispdf', { recursive: true });
  fs.writeFileSync('fispdf/todo.json', JSON.stringify(todo));
  if (todo.some(t => /^(DH|SG|DHT)$/.test(t.disc))) {
    const sl = await board({ id: 5288162728, cols: ['datum', 'drop_down7', 'dup__of_abschnitt_1', 'dup__of_sec_2', 'dup__of_sec_3', 'dup__of_sec_4', 'dup__of_sec_5', 'dup__of_sec_6', 'dup__of_sec_7', 'dup__of_sec_8', 'dup__of_sec_9', 'zahlen', 'numeric', 'zahlen1', 'numeric4', 'text3', 'text8', 'numeric0', 'numeric2', 'drop_down0', 'drop_down6'] }).catch(e => { console.log('Slope SPEED nicht geladen', String(e).slice(0, 80)); return []; });
    fs.writeFileSync('fispdf/slope.json', JSON.stringify(sl));
  }
  if (todo.length) console.log((process.env.FIS_TEST ? '::notice title=FIS-PDF::' : '') + 'FIS-PDFs zum Auswerten: ' + todo.map(t => t.rid + ' ' + t.disc).join(', '));
}
if (process.env.FIS_TEST) { console.log('FIS-Test beendet, nichts gespeichert'); process.exit(0); }
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


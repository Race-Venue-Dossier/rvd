// Zugriffe pro Person: Daten nach Bereich (Männer/Frauen × Speed/Technik) aufteilen und je Bereich verschlüsseln,
// dazu ein Schlüsselbund (data/keyring.json), in dem jede Person nur die Schlüssel ihrer Bereiche bekommt –
// verschlüsselt mit ihrem eigenen Passwort aus der Login-Liste (Supabase, gleiche Logins wie Gate-to-Gate).
//
// Läuft in der GitHub Action nach dem monday-Sync. Braucht RVD_PASS (Hauptschlüssel) und SUPABASE_SERVICE_KEY
// (nur lesen der Tabelle «logins»). Ohne SUPABASE_SERVICE_KEY passiert nichts (die Seite bleibt beim Team-Passwort).
// Lokal testbar mit LOGINS_FILE=<json> und RVD_ROOT=<ordner>.
//
// Bereiche: MS Männer Speed · MT Männer Technik · WS Frauen Speed · WT Frauen Technik.
// Admins (Rolle admin/direktor) bekommen den Hauptschlüssel und sehen alles wie bisher.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const ROOT = process.env.RVD_ROOT || '.';
const PASS = process.env.RVD_PASS;
const SUPA = 'https://sswtnkwqkmokozrcqrxf.supabase.co';
const P = p => path.join(ROOT, p);
const note = m => console.log(process.env.GITHUB_ACTIONS ? '::notice title=Zugriffe::' + m : 'Zugriffe: ' + m);
if (!PASS) { console.log('Zugriffe: RVD_PASS fehlt'); process.exit(0); }

// ── Regeln: Gruppe aus der Login-Liste → Bereiche ──
const SEGS = ['MS', 'MT', 'WS', 'WT'];
const ALL_NAMES = /reusser|flatscher/i;            // dürfen Männer und Frauen sehen (ohne FEA-Seiten)
function rules(groups) {
  const s = new Set();
  for (const g0 of groups) {
    const g = g0.trim();
    if (/^Männer\b/i.test(g)) {
      if (/Speed\s*$/i.test(g)) s.add('MS');
      else if (/\b(GS|SL)\s*$/i.test(g)) s.add('MT');
      else if (/Nachwuchs/i.test(g)) { s.add('MS'); s.add('MT'); }
    } else if (/^Frauen\b/i.test(g)) {
      if (/Mastery WC 1\s*$/i.test(g)) s.add('WS');
      else if (/Mastery WC [23]\s*$/i.test(g)) s.add('WT');
      else if (/Elite (EC|Nachwuchs)/i.test(g)) { s.add('WS'); s.add('WT'); }
    }
  }
  return SEGS.filter(x => s.has(x));
}
function normRow(r) {
  const name = String(r.name || ((r.vorname || '') + ' ' + (r.nachname || ''))).trim();
  const email = String(r.email || r.mail || '').trim().toLowerCase();
  const role = String(r.role || r.rolle || '').trim();
  const pw = String(r.password ?? r.passwort ?? '');
  const gr = r.groups ?? r.gruppen ?? r.team ?? '';
  const groups = Array.isArray(gr) ? gr.map(String) : String(gr).split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  return { name, email, role, pw, groups };
}
export function accessOf(u) {
  if (ALL_NAMES.test(u.name)) return { admin: false, segs: SEGS.slice() };   // vor der Admin-Regel: auch mit Rolle «Direktor» keine FEA-Seiten
  if (/admin|direktor/i.test(u.role)) return { admin: true, segs: SEGS.slice() };
  return { admin: false, segs: rules(u.groups) };
}

// ── Krypto (gleiches Format wie die Seite: IV 12 Byte + AES-256-GCM + Tag) ──
const kj = JSON.parse(fs.readFileSync(P('key.json'), 'utf8'));
const K = crypto.pbkdf2Sync(PASS, Buffer.from(kj.salt, 'base64'), kj.iter, 32, 'sha256');
function enc(key, buf) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]); }
function dec(key, b) { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16)); return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]); }
if (dec(K, Buffer.from(kj.check, 'base64')).toString() !== 'rvd-ok') { console.log('Zugriffe: RVD_PASS passt nicht zu key.json'); process.exit(1); }
const subKey = name => Buffer.from(crypto.hkdfSync('sha256', K, Buffer.from('rvd-access'), Buffer.from(name), 32));
const fp = buf => crypto.createHmac('sha256', K).update(buf).digest('hex').slice(0, 24);

// ── Login-Liste ──
let rows = [];
if (process.env.LOGINS_FILE) rows = JSON.parse(fs.readFileSync(process.env.LOGINS_FILE, 'utf8'));
else if (process.env.SUPABASE_SERVICE_KEY) {
  const k = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(SUPA + '/rest/v1/logins?select=*', { headers: { apikey: k, Authorization: 'Bearer ' + k, Accept: 'application/json' } });
  if (!r.ok) { note('Login-Liste nicht geladen (' + r.status + ')'); process.exit(0); }
  rows = await r.json();
} else { console.log('Zugriffe: SUPABASE_SERVICE_KEY fehlt – persönliche Logins noch nicht aktiv'); process.exit(0); }
const users = rows.map(normRow).filter(u => u.email && u.pw).map(u => ({ ...u, ...accessOf(u) })).filter(u => u.admin || u.segs.length);

// ── Bereiche bestimmen ──
const SPEED = new Set(['DH', 'SG', 'DHT']), TECH = new Set(['GS', 'SL', 'TP', 'GSQ', 'SLQ', 'PGS', 'PSL', 'PAR']), BOTH = new Set(['TC', 'AC']);
function areas(disc) {
  const d = String(disc || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (BOTH.has(d)) return ['S', 'T'];
  if (SPEED.has(d)) return ['S'];
  if (TECH.has(d)) return ['T'];
  return null;  // unbekannt: gilt fürs ganze Event
}
function areasTxt(t) {  // monday-Texte wie «Abfahrt», «Riesenslalom», «Team-Kombination»
  t = String(t || ''); if (!t.trim()) return null;
  const a = new Set();
  if (/Kombi/i.test(t)) { a.add('S'); a.add('T'); }
  if (/Abfahrt|Super|\bDH\b|\bSG\b|Training/i.test(t)) a.add('S');
  if (/(Riesen)?[Ss]lalom|\bGS\b|\bSL\b|Parallel/.test(t.replace(/Super-?G/gi, ''))) a.add('T');
  return a.size ? [...a] : null;
}
const ok = (allow, g, ar) => ar && ar.some(x => allow.has(g + x));

// ── Filter: Kerndaten (Events + Sektoranalysen) ──
function filterCore(core, segs) {
  const allow = new Set(segs), out = { seed: { events: {}, meta: {} }, speed: {} };
  const keepIds = new Set();
  for (const [id, e] of Object.entries(core.seed.events || {})) {
    const races = (e.races || []).filter(r => ok(allow, e.g, areas(r.disc)));
    if (!races.length) continue;
    races.forEach(r => keepIds.add(String(r.id)));
    const discs = new Set(races.map(r => r.disc)), dates = new Set(races.map(r => r.d));
    const items = (e.items || []).filter(it => { const a = areas(it.disc); return a ? ok(allow, e.g, a) : true; });
    items.forEach(it => it.d && dates.add(it.d));
    out.seed.events[id] = { ...e, races, items, staff: [],
      days: (e.days || []).filter(d => dates.has(d.d)),
      pts: (e.pts || []).filter(p => !p.l || discs.has(p.l) || ok(allow, e.g, areas(p.l))),
      lf: (e.lf || []).filter(l => !l.l || (/speed/i.test(l.l) ? allow.has(e.g + 'S') : /tech/i.test(l.l) ? allow.has(e.g + 'T') : true)) };
  }
  const m = core.seed.meta || {};
  out.seed.meta = { fisSynced: m.fisSynced, gtgSynced: m.gtgSynced, archive: m.archive || [], roster: [] };
  const sp = core.speed || {}, keepR = r => ok(allow, r.g, areas(r.disc));
  out.speed.v = sp.v;
  for (const k of ['races', 'ts', 'tr']) { out.speed[k] = (sp[k] || []).filter(keepR); out.speed[k].forEach(r => keepIds.add(String(r.id))); }
  out.speed.tech = { runs: ((sp.tech || {}).runs || []).filter(keepR), res: ((sp.tech || {}).res || []).filter(keepR) };
  if (sp.tech && sp.tech.thr) out.speed.tech.thr = sp.tech.thr;
  out.speed.cs = Object.fromEntries(Object.entries(sp.cs || {}).filter(([k]) => keepIds.has(String(k))));
  for (const k of Object.keys(sp)) if (!(k in out.speed)) out.speed[k] = sp[k];   // sonstige Felder unverändert
  return out;
}
// ── Filter: monday live (ohne Einsatzplanung) ──
function filterLive(live, segs, evIds) {
  const allow = new Set(segs), o = { at: live.at };
  if (live.tech) o.tech = { items: (live.tech.items || []).filter(it => { const n = it.name || '', g = /Frauen|Damen/i.test(n) ? 'W' : /M(ä|a)nner|Herren/i.test(n) ? 'M' : ''; return g && allow.has(g + 'T'); }) };
  if (live.rvd) o.rvd = { items: (live.rvd.items || []).map(p => {
    const g = /-W$/.test(p.did || '') || p.g === 'Frauen' ? 'W' : /-M$/.test(p.did || '') || p.g === 'Männer' ? 'M' : '';
    if (!g || !(allow.has(g + 'S') || allow.has(g + 'T'))) return null;
    if (p.did && !evIds.has(p.did)) return null;
    const sub = (p.sub || []).filter(s => { const a = areasTxt(s.disc); return a ? ok(allow, g, a) : true; });
    return { ...p, url: '', sub: sub.map(s => ({ ...s, who: '' })) };
  }).filter(Boolean) };
  if (live.fis) o.fis = Object.fromEntries(Object.entries(live.fis).filter(([, r]) => r && evIds.has(r.did) && ok(allow, r.g || (r.did || '').slice(-1), areas(r.disc))));
  return o;
}
function filterSec(sec, segs) {
  const allow = new Set(segs), keepR = r => ok(allow, r.g, areas(r.disc));
  return { races: (sec.races || []).filter(keepR), ts: (sec.ts || []).filter(keepR), at: sec.at };
}
// ── Dateien, auf die ein Bereich verweist ──
function assetsOf(core, live) {
  const files = {}, mon = {};
  const add = f => { if (fs.existsSync(P(f))) files[f] = 1; };
  const walk = v => {
    if (typeof v === 'string') {
      let m = /^mon\/(\d+):(\d+)$/.exec(v);
      if (m) { (mon[m[1]] = mon[m[1]] || new Set()).add(m[2]); return; }
      if (/^[\w\-./]+\.pdf$/i.test(v)) add(v.replace(/\.pdf$/i, '.enc'));
      else if (/^[\w\-./]+\.webp$/i.test(v)) add('img/' + v.replace(/\.webp$/i, '.enc'));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(core.seed); walk(core.speed);
  for (const p of (live.rvd || {}).items || []) for (const s of p.sub || []) for (const f of s.files || []) if (f.ok && f.id) add('monasset/' + f.id + '.enc');
  for (const d of Object.keys(mon)) if (!fs.existsSync(P('mon/' + d + '.enc'))) delete mon[d];
  return { files: Object.keys(files), mon };
}

// ── Schreiben: nur wenn sich der Inhalt geändert hat ──
const STATE = P('data/seg/state.json');
let state = { f: {} }; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) {}
const keepFiles = new Set(); let nW = 0;
function put(rel, key, plain) {
  keepFiles.add(rel); const f = fp(Buffer.concat([Buffer.from(rel), plain]));
  if (state.f[rel] === f && fs.existsSync(P(rel))) return;
  fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), enc(key, plain)); state.f[rel] = f; nW++;
}
const readEnc = rel => fs.existsSync(P(rel)) ? dec(K, fs.readFileSync(P(rel))) : null;

const coreB = readEnc('data/core.enc'); if (!coreB) { console.log('Zugriffe: data/core.enc fehlt'); process.exit(1); }
const core = JSON.parse(coreB.toString());
const live = JSON.parse((readEnc('data/live.enc') || Buffer.from('{}')).toString());
const sec = JSON.parse((readEnc('data/fissec.enc') || Buffer.from('{"races":[],"ts":[]}')).toString());

// Einzelbereiche: Dateien (Bilder, PDFs, monday-Grafiken) mit dem Bereichsschlüssel
const segAssets = {};
const monCache = {};
for (const s of SEGS) {
  const c = filterCore(JSON.parse(coreB.toString()), [s]), l = filterLive(live, [s], new Set(Object.keys(c.seed.events)));
  const a = assetsOf(c, l), key = subKey('seg:' + s); segAssets[s] = a;
  for (const f of a.files) {
    const src = fs.readFileSync(P(f)), rel = 'seg/' + s + '/' + f;
    const sf = fp(Buffer.concat([Buffer.from(rel), src]));
    keepFiles.add(rel);
    if (state.f[rel] === sf && fs.existsSync(P(rel))) continue;
    put(rel, key, dec(K, src)); state.f[rel] = sf;
  }
  for (const [d, keys] of Object.entries(a.mon)) {
    const all = monCache[d] || (monCache[d] = JSON.parse(dec(K, fs.readFileSync(P('mon/' + d + '.enc'))).toString()));
    const sub = {}; for (const k of keys) if (all[k]) sub[k] = all[k];
    put('seg/' + s + '/mon/' + d + '.enc', key, Buffer.from(JSON.stringify(sub)));
  }
}
// Kombinationen, wie sie in der Login-Liste vorkommen (z. B. «MS» oder «MS-MT»): Kerndaten, monday, Sektordaten
const combos = new Set(users.filter(u => !u.admin).map(u => u.segs.join('-')));
for (const cb of combos) {
  const segs = cb.split('-'), key = subKey('combo:' + cb);
  const c = filterCore(JSON.parse(coreB.toString()), segs);
  const evIds = new Set(Object.keys(c.seed.events));
  const amap = {};
  for (const s of segs) { for (const f of segAssets[s].files) (amap[f] = amap[f] || []).push(s); for (const d of Object.keys(segAssets[s].mon)) (amap['mon/' + d + '.enc'] = amap['mon/' + d + '.enc'] || []).push(s); }
  c.assets = amap;
  put('data/seg/' + cb + '.gz.enc', key, zlib.gzipSync(Buffer.from(JSON.stringify(c)), { level: 9 }));
  put('data/seg/' + cb + '-live.enc', key, Buffer.from(JSON.stringify(filterLive(live, segs, evIds))));
  put('data/seg/' + cb + '-sec.enc', key, Buffer.from(JSON.stringify(filterSec(sec, segs))));
}
// Alte Dateien entfernen (Bereich oder Kombination nicht mehr gebraucht)
const walkDir = d => fs.existsSync(P(d)) ? fs.readdirSync(P(d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkDir(d + '/' + e.name) : [d + '/' + e.name]) : [];
let nDel = 0;
for (const f of [...walkDir('seg'), ...walkDir('data/seg')]) if (f !== 'data/seg/state.json' && !keepFiles.has(f)) { fs.unlinkSync(P(f)); delete state.f[f]; nDel++; }
for (const f of Object.keys(state.f)) if (!keepFiles.has(f)) delete state.f[f];

// ── Schlüsselbund: pro Person mit ihrem Passwort verschlüsselt ──
const KR = P('data/keyring.json');
let kr = { v: 1, iter: 210000, u: {} }; try { kr = JSON.parse(fs.readFileSync(KR, 'utf8')); } catch (e) {}
const nu = {};
for (const u of users) {
  const id = crypto.createHash('sha256').update(u.email).digest('hex');
  const combo = u.admin ? '' : u.segs.join('-');
  const payload = { n: u.name, a: u.admin ? 1 : 0, c: combo, s: u.segs, k: {} };
  if (u.admin) payload.m = K.toString('base64');
  else { payload.k['c:' + combo] = subKey('combo:' + combo).toString('base64'); for (const s of u.segs) payload.k[s] = subKey('seg:' + s).toString('base64'); }
  const pj = JSON.stringify(payload), f = fp(Buffer.from(u.email + '\n' + u.pw + '\n' + pj));
  if (kr.u[id] && kr.u[id].f === f) { nu[id] = kr.u[id]; continue; }
  const salt = crypto.randomBytes(16), wk = crypto.pbkdf2Sync(u.pw, salt, kr.iter, 32, 'sha256');
  nu[id] = { s: salt.toString('base64'), w: enc(wk, Buffer.from(pj)).toString('base64'), f };
}
const krNew = JSON.stringify({ v: 1, iter: kr.iter, u: nu });
if (!fs.existsSync(KR) || fs.readFileSync(KR, 'utf8') !== krNew) { fs.writeFileSync(KR, krNew); nW++; }
fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(state));
const cnt = { admin: users.filter(u => u.admin).length };
for (const u of users) if (!u.admin) cnt[u.segs.join('-')] = (cnt[u.segs.join('-')] || 0) + 1;
note(users.length + ' Logins (' + Object.entries(cnt).map(([k, v]) => k + ' ' + v).join(', ') + ') · ' + nW + ' Dateien neu, ' + nDel + ' entfernt');

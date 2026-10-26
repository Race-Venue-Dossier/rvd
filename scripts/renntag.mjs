// Renntag-Abgleich (Vonsie, 26.10.2026): An Renntagen den monday-Sync selbst alle 30 Minuten starten (9–18 Uhr),
// danach stündlich bis 22 Uhr (Nachtrennen). Der GitHub-Zeitplan allein läuft nur etwa alle 3–4 Stunden.
//   node scripts/renntag.mjs kick   (am Ende jedes monday-Syncs) startet die Schlaufe, wenn bald ein Renntag ist und keine läuft
//   node scripts/renntag.mjs loop   (Workflow renntag.yml) wartet bis zum nächsten Termin, startet den Sync; nach ~5½ h startet sie sich neu
// Renntag = Datum liegt im Zeitraum eines Events in monday «RVD Sync» (Spalte Zeitraum, nur Events mit Dossier-ID).
// Benötigt: MONDAY_TOKEN, GH_TOKEN (GITHUB_TOKEN mit actions: write), GITHUB_REPOSITORY.
const TOKEN = process.env.MONDAY_TOKEN, GH = process.env.GH_TOKEN, REPO = process.env.GITHUB_REPOSITORY || 'Race-Venue-Dossier/rvd';
const MODE = process.argv[2] || 'kick';
const RVD = 18434554343;
const MAXRUN = 5 * 3600e3 + 40 * 60e3;          // Job-Grenze bei GitHub: 6 h
const SLOTS = [];
for (let m = 9 * 60; m <= 18 * 60; m += 30) SLOTS.push(m);
for (const h of [19, 20, 21, 22]) SLOTS.push(h * 60);

export function zurichOffsetMin(t) {   // Minuten, die Zürich vor UTC liegt (60 oder 120)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60e3) * 60e3) / 60e3);
}
export function zurichDate(t) { return new Date(t + zurichOffsetMin(t) * 60e3).toISOString().slice(0, 10); }
function localToUtc(day, min) {   // «2026-10-26», 570 → Zeitpunkt 09:30 Zürich
  const guess = Date.parse(day + 'T00:00:00Z') + min * 60e3;
  return guess - zurichOffsetMin(guess - 60 * 60e3) * 60e3;
}
// Nächste Termine an Renntagen ab «from» (höchstens 3 Tage voraus)
export function nextSlots(days, from, n = 1) {
  const out = [];
  for (let i = 0; i < 4 && out.length < n; i++) {
    const day = zurichDate(from + i * 864e5);
    if (!days.has(day)) continue;
    for (const m of SLOTS) { const t = localToUtc(day, m); if (t > from && out.length < n) out.push(t); }
  }
  return out;
}
export function raceDays(spans) {
  const set = new Set();
  for (const s of spans) {
    const m = (s || '').match(/(\d{4}-\d\d-\d\d)\s*-\s*(\d{4}-\d\d-\d\d)/); if (!m) continue;
    for (let t = Date.parse(m[1] + 'T12:00:00Z'); t <= Date.parse(m[2] + 'T12:00:00Z') && set.size < 400; t += 864e5) set.add(new Date(t).toISOString().slice(0, 10));
  }
  return set;
}

async function spans() {
  const items = []; let cursor = null;
  for (let i = 0; i < 10; i++) {
    const q = cursor
      ? { query: 'query($c:String!){ next_items_page(limit:500,cursor:$c){ cursor items{ column_values(ids:["text_mm7y6990","timerange_mm7ynrqk"]){ id text } } } }', variables: { c: cursor } }
      : { query: 'query($id:[ID!]){ boards(ids:$id){ items_page(limit:500){ cursor items{ column_values(ids:["text_mm7y6990","timerange_mm7ynrqk"]){ id text } } } } }', variables: { id: [RVD] } };
    const r = await fetch('https://api.monday.com/v2', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: TOKEN, 'API-Version': '2024-10' }, body: JSON.stringify(q) });
    const j = await r.json(); if (!r.ok || j.errors) throw new Error(JSON.stringify(j.errors || j).slice(0, 300));
    const page = cursor ? j.data.next_items_page : j.data.boards[0].items_page;
    items.push(...page.items); cursor = page.cursor; if (!cursor) break;
  }
  return items.map(it => Object.fromEntries(it.column_values.map(c => [c.id, c.text || ''])))
    .filter(c => /^\d{4}-\d+-[MW]$/.test(c.text_mm7y6990 || '')).map(c => c.timerange_mm7ynrqk);
}
async function gh(path, method = 'GET', body) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { method, headers: { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.status === 204 ? null : r.json();
}
const dispatch = wf => gh('/actions/workflows/' + wf + '/dispatches', 'POST', { ref: 'main' });
const hhmm = t => new Date(t + zurichOffsetMin(t) * 60e3).toISOString().slice(11, 16);

async function main() {
  if (!TOKEN || !GH) { console.log('Renntag: MONDAY_TOKEN oder GH_TOKEN fehlt – übersprungen.'); return; }
  const days = raceDays(await spans());
  const now = Date.now();
  if (MODE === 'kick') {
    const [t] = nextSlots(days, now);
    if (!t || t - now > 36 * 3600e3) { console.log('Renntag: kein Renntag in den nächsten 36 h.'); return; }
    let busy = 0;
    for (const st of ['in_progress', 'queued', 'waiting', 'pending']) busy += (await gh('/actions/workflows/renntag.yml/runs?per_page=5&status=' + st)).total_count || 0;
    if (busy) { console.log('Renntag: Schlaufe läuft schon.'); return; }
    await dispatch('renntag.yml');
    console.log('::notice title=Renntag::Schlaufe gestartet, nächster Abgleich ' + zurichDate(t) + ' ' + hhmm(t) + ' Uhr');
    return;
  }
  // loop
  const start = Date.now();
  for (;;) {
    const [t] = nextSlots(days, Date.now());
    if (!t || t - Date.now() > 36 * 3600e3) { console.log('Renntag: keine Termine mehr in den nächsten 36 h – Schlaufe endet.'); return; }
    if (t - start > MAXRUN) {   // Termin liegt hinter der Job-Grenze: bis kurz davor warten, dann Nachfolger starten
      console.log('Renntag: nächster Termin ' + zurichDate(t) + ' ' + hhmm(t) + ' Uhr – warte bis zur Laufzeitgrenze');
      await new Promise(r => setTimeout(r, Math.max(0, start + MAXRUN - Date.now())));
      await dispatch('renntag.yml'); console.log('Renntag: neue Schlaufe gestartet.'); return;
    }
    console.log('Renntag: warte bis ' + zurichDate(t) + ' ' + hhmm(t) + ' Uhr');
    await new Promise(r => setTimeout(r, Math.max(0, t - Date.now())));
    try { await dispatch('monday-sync.yml'); console.log('Renntag: Abgleich ' + hhmm(t) + ' gestartet'); }
    catch (e) { console.log('::warning title=Renntag::Abgleich ' + hhmm(t) + ' nicht gestartet: ' + String(e).slice(0, 150)); }
  }
}
if (import.meta.url === 'file://' + process.argv[1]) main().catch(e => { console.log('::warning title=Renntag::' + String(e).slice(0, 300)); });

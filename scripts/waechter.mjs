// Wächter: prüft nach einem Push auf main, ob Änderungen der anderen Person an index.html verloren gingen.
// Hintergrund: index.html wird bei jedem Deploy komplett aus den eigenen Quellen neu gebaut. Fehlt in den
// Quellen eine Änderung der anderen Person, verschwindet sie beim nächsten Push still – ohne Git-Konflikt.
//
// Ablauf: HEAD = der Push, BASE = Stand davor (Action: github.event.before, lokal: origin/main, sonst HEAD^).
// Für die letzten 60 Commits anderer Personen an index.html: Jeder dort eingefügte Textabschnitt (Wort-Diff),
// der in BASE noch vorhanden war, muss auch in HEAD vorkommen. Fehlt er, wird die Stelle im Diff BASE→HEAD
// eingeordnet:
//   ZURÜCKGESETZT  – an der Stelle steht wieder Text von vor dem fremden Commit (alter Stand gebaut)  → Fehler
//   ENTFERNT       – die Stelle ist ersatzlos weg                                                       → Fehler
//   GEÄNDERT       – die Stelle wurde durch neuen Text ersetzt (bewusste Weiterentwicklung)            → Hinweis
// Fehler: Lauf rot, Annotation, Issue. Hinweis: nur Annotation und Summary.
//
// Aufruf:  node scripts/waechter.mjs            (GitHub Action)
//          node scripts/waechter.mjs --local    (vor dem Push im Klon nach `git pull --rebase`: nur Ausgabe)
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const LOCAL = process.argv.includes('--local');
const FILE = 'index.html';
const BOTS = /monday-sync|github-actions|\[bot\]/i;
const MAXC = 60;          // so viele Commits an index.html zurück
const MINLEN = 8;         // kürzere Textabschnitte sind nicht aussagekräftig (Zahlen, Klammern)
const git = (a) => execSync('git ' + a, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const ok = (rev) => { try { git('rev-parse --verify --quiet ' + rev + '^{commit}'); return true; } catch (e) { return false; } };
const short = (s) => s.slice(0, 7);

const [hsha, hauthor, hdate, hsubject] = git('log -1 --format=%H%n%an%n%ad%n%s --date=short HEAD').trim().split('\n');
if (BOTS.test(hauthor)) { console.log('Wächter: Push von ' + hauthor + ' (Automatik), keine Prüfung.'); process.exit(0); }

let base = process.env.WAECHTER_BASE || (LOCAL ? 'origin/main' : '') || 'HEAD^';
if (/^0+$/.test(base) || !ok(base)) base = 'HEAD^';
const bsha = git('rev-parse ' + base).trim();
if (bsha === hsha) { console.log('Wächter: HEAD ist bereits der Stand von ' + base + ', nichts zu prüfen.'); process.exit(0); }
const before = git('show ' + bsha + ':' + FILE);
const now = fs.readFileSync(FILE, 'utf8');

// Änderungsstellen des Pushes (BASE→HEAD) auf Wortebene: zusammenhängende entfernte/eingefügte Abschnitte
// (Zeilen in index.html sind teils sehr lang – Zeilenvergleich würde alles als «geändert» sehen)
const hunks = []; let cur = null;
for (const l of git('diff -U0 --word-diff=porcelain ' + bsha + ' HEAD -- ' + FILE).split('\n')) {
  if (l.startsWith('@@') || l.startsWith('~') || l.startsWith(' ')) { cur = null; continue; }
  if (l.startsWith('-') && !l.startsWith('---')) { if (!cur) { cur = { del: [], add: [] }; hunks.push(cur); } cur.del.push(l.slice(1)); }
  else if (l.startsWith('+') && !l.startsWith('+++')) { if (!cur) { cur = { del: [], add: [] }; hunks.push(cur); } cur.add.push(l.slice(1)); }
}

// Commits anderer Personen an index.html (vor BASE)
const others = git('log --format=%H%x09%an%x09%ad%x09%s --date=short -n ' + MAXC + ' ' + bsha + ' -- ' + FILE).trim().split('\n').filter(Boolean)
  .map(l => l.split('\t')).map(([sha, author, date, subject]) => ({ sha, author, date, subject }))
  .filter(c => c.author !== hauthor && !BOTS.test(c.author));

const findings = [];
for (const c of others) {
  const d = git('diff -U0 --word-diff=porcelain ' + c.sha + '^ ' + c.sha + ' -- ' + FILE);
  const added = [...new Set(d.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1).trim()).filter(s => s.length >= MINLEN))]
    .filter(s => before.includes(s));
  if (!added.length) continue;
  const missing = added.filter(s => !now.includes(s));
  if (!missing.length) continue;
  // Einordnung je fehlender Stelle anhand des Hunks, der sie entfernt hat
  const old = git('show ' + c.sha + '^:' + FILE);
  let reset = 0, removed = 0, changed = 0;
  for (const s of missing) {
    const hk = hunks.find(h => h.del.some(l => l.includes(s) || (l.trim().length >= MINLEN && s.includes(l.trim()))));
    if (!hk || !hk.add.length) removed++;
    else if (hk.add.some(l => l.trim().length >= MINLEN && old.includes(l.trim()) && !before.includes(l.trim()))) reset++;
    else changed++;
  }
  findings.push({ ...c, total: added.length, missing, reset, removed, changed, error: reset + removed > 0 });
}

const errors = findings.filter(f => f.error), hints = findings.filter(f => !f.error);
const lines = [];
lines.push('Wächter: Push ' + short(hsha) + ' von ' + hauthor + ' (' + hdate + ', «' + hsubject + '»), Stand davor ' + short(bsha));
lines.push('Geprüft: ' + others.length + ' Commit(s) anderer Personen an ' + FILE + '.');
const kind = (f) => [f.reset ? f.reset + ' zurückgesetzt' : '', f.removed ? f.removed + ' entfernt' : '', f.changed ? f.changed + ' geändert' : ''].filter(Boolean).join(', ');
for (const f of findings) {
  lines.push('');
  lines.push((f.error ? 'VERLOREN' : 'Hinweis') + ': Commit ' + short(f.sha) + ' von ' + f.author + ' (' + f.date + ', «' + f.subject + '») – ' + f.missing.length + ' von ' + f.total + ' Textabschnitten fehlen nach diesem Push (' + kind(f) + ').');
  for (const m of f.missing.slice(0, 4)) lines.push('   fehlt: ' + (m.length > 140 ? m.slice(0, 140) + '…' : m));
  if (f.missing.length > 4) lines.push('   … und ' + (f.missing.length - 4) + ' weitere');
}
if (!findings.length) lines.push('Alles noch drin.');
else if (!errors.length) lines.push('', 'Nur ersetzte Stellen (bewusste Änderung?) – kein Fehler.');
const text = lines.join('\n');
console.log(text);

if (!LOCAL) {
  for (const f of findings) console.log('::' + (f.error ? 'error' : 'warning') + ' title=Wächter: Änderung von ' + f.author + (f.error ? ' verloren' : ' ersetzt') + '::Commit ' + short(f.sha) + ' «' + f.subject + '» – ' + f.missing.length + ' von ' + f.total + ' Textabschnitten fehlen nach Push ' + short(hsha) + ' von ' + hauthor + ' (' + kind(f) + ')');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
  if (errors.length && process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY) {
    const repo = process.env.GITHUB_REPOSITORY;
    const who = [...new Set(errors.map(f => f.author))].join(', ');
    const title = 'Wächter: Push ' + short(hsha) + ' von ' + hauthor + ' überschreibt Änderung von ' + who;
    let open = '0';
    try { open = execSync('gh issue list --repo ' + repo + ' --state open --search ' + JSON.stringify(short(hsha) + ' in:title') + ' --json number --jq length', { encoding: 'utf8' }).trim(); } catch (e) { open = '0'; }
    if (open === '0') {
      const body = 'Nach dem Push https://github.com/' + repo + '/commit/' + hsha + ' fehlen in `' + FILE + '` Stellen, die ' + who + ' eingefügt hatte und die bis zu diesem Push noch drin waren:\n\n' +
        errors.map(f => '- ' + f.author + ', ' + f.date + ', «' + f.subject + '» (https://github.com/' + repo + '/commit/' + f.sha + '): ' + f.missing.length + ' von ' + f.total + ' Abschnitten fehlen (' + kind(f) + ')').join('\n') +
        '\n\nWahrscheinliche Ursache: Die Quellen der pushenden Person enthielten diese Änderung nicht (Stand aus OneDrive `02_Quellcode` nicht übernommen). ' +
        'Bitte die Quellen (`speed.js`, `tech.js`, `app/*.js` …) abgleichen, neu bauen und nochmals pushen. War es Absicht: Issue einfach schliessen.\n\n```\n' + text + '\n```';
      fs.writeFileSync('/tmp/waechter_body.md', body);
      execSync('gh issue create --repo ' + repo + ' --title ' + JSON.stringify(title) + ' --body-file /tmp/waechter_body.md', { encoding: 'utf8', stdio: 'inherit' });
    }
  }
}
process.exit(errors.length ? 1 : 0);

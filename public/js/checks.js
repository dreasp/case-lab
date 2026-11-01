// Case checks: spots common AI mix-ups without any AI calls.
// 1. Two camera angles of the same scene (same start clock, same length) -> duplicates
// 2. A file whose only date comes from its file name (often the export date, not the event date)
// 3. The same named person described in two different videos at the same moment

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDate = ms => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const fmtClock = ms => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`; };

// "2025-01-25 10:42:48 -0500" or "01/25/2025 14:13:32" -> ms (clock time treated as UTC so no zone shifts)
export function clockAt(clock, t = 0) {
  if (!clock) return null;
  const s = String(clock);
  const d = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const tm = s.match(/(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP]M))?/i);
  if (!d || !tm) return null;
  const [y, mo, da] = d[1] ? [+d[1], +d[2], +d[3]] : [+d[6], +d[4], +d[5]];
  let h = +tm[1];
  if (tm[4]) h = h % 12 + (/p/i.test(tm[4]) ? 12 : 0);
  const ms = Date.UTC(y, mo - 1, da, h, +tm[2], +tm[3]);
  return isFinite(ms) ? ms + Math.round(t) * 1000 : null;
}

// A date written in a file name: 2026-03-26, 01-25-2025, 20250125, 2025_01_25
export function nameDate(name) {
  const n = String(name || '');
  let m = n.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = n.match(/(?<!\d)(\d{1,2})[-_.](\d{1,2})[-_.](20\d{2})/);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
  return null;
}

const label = f => f.path || f.name;
const DAY = 86400000;

// Proper names the AI used for people (not roles like "Officer (camera wearer)")
function personNames(files) {
  const names = new Set();
  const ok = /^(?:(?:Mr|Ms|Mrs|Miss|Dr|Detective|Det|Officer|Sgt|Sergeant|Deputy|Lt)\.? )?[A-Z][a-z'-]+(?: [A-Z][a-z'-]+)*$/;
  const role = /^(?:Mr|Ms|Mrs|Miss|Dr|Detective|Det|Officer|Sgt|Sergeant|Deputy|Lt)\.?$/;
  for (const f of files) {
    const a = f.analysis || {};
    for (const v of [...Object.values(a.speakers || {}), ...(a.people || []).map(p => p.who)]) {
      const n = String(v || '').trim();
      if (!ok.test(n) || n.split(' ').length < 2 && !role.test(n.split(' ')[0])) continue;
      if (/^(Speaker|Caller|Witness|Dispatch|Dispatcher|Operator|Unknown|Woman|Man)\b/i.test(n)) continue;
      names.add(n);
    }
  }
  return [...names];
}

// What happens in a video, with real clock times
function clockedLines(f) {
  const a = f.analysis || {};
  const start = clockAt(a.clock_start);
  if (start == null) return [];
  const out = [];
  for (const e of a.events || []) if (e && e.what) out.push({ t: +e.t || 0, text: String(e.what) });
  for (const m of a.moments || []) if (m && m.description) out.push({ t: +m.start || 0, text: String(m.description) });
  return out.map(x => ({ ...x, at: start + x.t * 1000 }));
}

export function caseChecks(cur) {
  const ignored = new Set(cur.checksIgnored || []);
  const files = (cur.files || []).filter(f => f.analysis && (f.type === 'video' || f.type === 'audio'));
  const checks = [];

  // 1. Two angles of the same scene
  const vids = files.filter(f => f.type === 'video' && clockAt(f.analysis.clock_start) != null);
  const angleOf = new Map();
  for (let i = 0; i < vids.length; i++) for (let j = i + 1; j < vids.length; j++) {
    const a = vids[i], b = vids[j];
    const ds = Math.abs(clockAt(a.analysis.clock_start) - clockAt(b.analysis.clock_start)) / 1000;
    const dd = Math.abs((a.duration || 0) - (b.duration || 0));
    if (ds > 15 || dd > Math.max(15, 0.01 * Math.max(a.duration || 0, b.duration || 0))) continue;
    angleOf.set(b.id, a.id); angleOf.set(a.id, b.id);
    // keep the one without "pip" in the name (picture-in-picture copies repeat the main view)
    const [main, second] = /pip/i.test(label(a)) && !/pip/i.test(label(b)) ? [b, a] : [a, b];
    const key = `angle:${[a.id, b.id].sort().join(':')}`;
    if (ignored.has(key)) continue;
    checks.push({
      key, kind: 'angle',
      title: 'Two camera angles of the same scene',
      text: `"${label(main)}" and "${label(second)}" start at the same time and are the same length, so they look like two views of the same room. The second one is probably the extra view. Using both makes every event appear twice in the research.`,
      refs: [{ file: main.id, t: 0 }, { file: second.id, t: 0 }],
      action: second.skipResearch ? null : { type: 'skip', file: second.id, label: 'Leave the second one out of the research' },
      done: second.skipResearch ? `"${label(second)}" is left out of the research.` : null,
      undo: second.skipResearch ? { type: 'include', file: second.id, label: 'Include it again' } : null,
    });
  }

  // 2. Dates that only come from the file name
  const realDays = files.filter(f => f.type === 'video').map(f => clockAt(f.analysis.clock_start)).filter(x => x != null);
  for (const f of files) {
    const nd = nameDate(label(f));
    if (nd == null) continue;
    const onScreen = f.type === 'video' && clockAt(f.analysis.clock_start) != null;
    if (onScreen) continue; // the date printed on the footage wins
    const key = `namedate:${f.id}`;
    if (ignored.has(key)) continue;
    const far = realDays.length && realDays.every(d => Math.abs(d - nd) > 2 * DAY);
    checks.push({
      key, kind: 'namedate',
      title: 'Date only from the file name',
      text: `The only date for "${label(f)}" is in its file name: ${fmtDate(nd)}. That is often the day the file was exported, not the day it was recorded.` +
        (far ? ` The rest of the footage is from ${fmtDate(realDays[0])}, so this date is probably wrong.` : '') +
        ' Add the real date and time to Case context, then rebuild the research.',
      refs: [{ file: f.id, t: 0 }],
      action: { type: 'context', line: `"${label(f)}" was recorded on ${far ? fmtDate(realDays[0]) : '(date)'} at about (time). The date in its file name is not the recording date.`, label: 'Add a note to Case context' },
    });
  }

  // 3. One person in two places at once
  const names = personNames(files);
  const firstWord = n => { const w = n.split(' '); return /^(Mr|Ms|Mrs|Miss|Dr|Detective|Det|Officer|Sgt|Sergeant|Deputy|Lt)\.?$/.test(w[0]) ? null : w[0]; };
  const subjectIs = (text, n) => text.startsWith(n) || (firstWord(n) && new RegExp(`^${firstWord(n)}\\b`).test(text));
  const placed = vids.filter(f => !f.skipResearch).map(f => ({ f, lines: clockedLines(f), from: clockAt(f.analysis.clock_start), to: clockAt(f.analysis.clock_start, f.duration || 0) }));
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const A = placed[i], B = placed[j];
    if (angleOf.get(A.f.id) === B.f.id) continue;
    if (A.from > B.to || B.from > A.to) continue;
    for (const n of names) {
      const key = `twoplaces:${[A.f.id, B.f.id].sort().join(':')}:${n}`;
      if (ignored.has(key)) continue;
      const la = A.lines.filter(x => subjectIs(x.text, n));
      const lb = B.lines.filter(x => subjectIs(x.text, n));
      const hits = [];
      for (const x of la) { const y = lb.find(y => Math.abs(y.at - x.at) <= 60000); if (y) hits.push([x, y]); }
      if (!hits.length) continue;
      const [x, y] = hits[0];
      checks.push({
        key, kind: 'twoplaces',
        title: `${n} in two places at once`,
        text: `At ${fmtClock(x.at)}, ${n} is described both in "${label(A.f)}" ("${x.text.slice(0, 90)}${x.text.length > 90 ? '…' : ''}") and in "${label(B.f)}" ("${y.text.slice(0, 90)}${y.text.length > 90 ? '…' : ''}")${hits.length > 1 ? `, and ${hits.length - 1} more time${hits.length > 2 ? 's' : ''}` : ''}. In one of them it is probably someone else. If both cameras were at the same place (like two bodycams at one scene), you can ignore this.`,
        refs: [{ file: A.f.id, t: x.t }, { file: B.f.id, t: y.t }],
        action: { type: 'context', line: `In "${label(A.f)}" the person is ______; in "${label(B.f)}" it is ______. ${n} is only in one of them at ${fmtClock(x.at)}.`, label: 'Add a note to Case context' },
      });
    }
  }
  return checks;
}

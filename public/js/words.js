// Exact word timing for footage transcripts, so captions match the speech even after you
// edit lines (fix words, split, change speaker). Fetched once per file from AssemblyAI (free:
// the transcript already exists) and saved with the case.

import { alignWords } from './captions.js';

let X = null;
const cache = new Map(); // file id -> [[start, end, word]]

export function initWords(helpers) { X = helpers; }

export async function getWords(c, f) {
  if (!f || !f.aai || !f.aai.id) return null;
  if (cache.has(f.id)) return cache.get(f.id);
  const key = `${c.id}:w:${f.id}`;
  let words = null;
  try { const b = await X.getFile(key); if (b) words = JSON.parse(await b.text()); } catch (e) { words = null; }
  if (!words) {
    try {
      words = (await X.api(`case/words/${f.aai.id}`)).words;
      X.putFile(key, new Blob([JSON.stringify(words)], { type: 'application/json' })).catch(() => {});
    } catch (e) { return null; }
  }
  cache.set(f.id, words);
  return words;
}

// Spoken words near a stretch of time, in the form the aligner wants
function near(words, a, b) {
  const out = [];
  for (const [s, e, t] of words) { if (e < a) continue; if (s > b) break; out.push({ t, s, e }); }
  return out;
}

// Each word of a (possibly edited) line, with the time it is really said
export function timeLine(u, words) {
  const text = String(u.text || '').trim();
  if (!text) return [];
  if (!words || !words.length) {
    const ws = text.split(/\s+/), step = (u.e - u.s) / ws.length;
    return ws.map((w, k) => ({ w, s: u.s + step * k, e: u.s + step * (k + 1) }));
  }
  const asr = near(words, u.s - 4, u.e + 4);
  return alignWords([text], asr).map(x => ({ w: x.w, s: x.s, e: x.e }));
}

// Where the second part of a split line really starts. The lines just before and after are
// matched too, so repeated words ("ran over the baby") can't be taken from a neighbour.
export function splitTime(u, a, b, words, before = [], after = []) {
  if (!words || !words.length) return null;
  const from = Math.min(u.s, ...before.map(x => x.s)) - 2, to = Math.max(u.e, ...after.map(x => x.e)) + 2;
  const texts = [...before.map(x => x.text), a, b, ...after.map(x => x.text)];
  const al = alignWords(texts, near(words, from, to));
  const first = al.find(x => x.p === before.length + 1);
  return first ? first.s : null;
}

// All the lines of a stretch matched together, in order. Matching them one by one went wrong
// when the same words are said twice in a row ("…and ran over the baby." / "Who ran over the
// baby?"): a line could grab the other person's words. Returns one list of timed words per line.
export function timeLines(utts, words) {
  if (!utts.length) return [];
  if (!words || !words.length) return utts.map(u => timeLine(u, null));
  const from = Math.min(...utts.map(u => u.s)) - 3, to = Math.max(...utts.map(u => u.e)) + 3;
  const al = alignWords(utts.map(u => String(u.text || '').trim()), near(words, from, to));
  return utts.map((u, i) => al.filter(x => x.p === i).map(x => ({ w: x.w, s: x.s, e: x.e })));
}

// ---------- swear words ----------
// One per line in your list; a * at the end also matches longer words (fuck* = fucking, fucked…)
export const DEFAULT_MUTE = ['fuck*', 'motherfuck*', 'mf', 'shit*', 'bullshit*', 'ass', 'asses', 'asshole*', 'dumbass*', 'jackass*', 'badass*', 'bitch*', 'damn', 'dammit', 'goddamn*', 'goddam*', 'bastard*', 'dick', 'dicks', 'dickhead*', 'pussy', 'pussies', 'cunt*', 'cock', 'cocks', 'nigga*', 'nigger*', 'whore*', 'slut*', 'fag', 'fags', 'faggot*', 'retard*'];

const norm = w => String(w || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'*]+/g, '').replace(/'s$/, '');

export function muteMatcher(list) {
  const exact = new Set(), prefix = [];
  for (const raw of list) { const w = norm(raw); if (!w) continue; if (w.endsWith('*')) prefix.push(w.slice(0, -1).replace(/\*/g, '')); else exact.add(w.replace(/\*/g, '')); }
  return word => { const w = norm(word).replace(/\*/g, ''); return !!w && (exact.has(w) || prefix.some(p => w.startsWith(p))); };
}

// Caption text with a swear word masked: "fucking," -> "f******,"
export const maskWord = w => w.replace(/[A-Za-z][A-Za-z’']*/, m => m[0] + '*'.repeat(Math.max(1, m.length - 1)));

// Every swear word said between a and b (seconds in the file), from the exact word timing
// and from your edited lines (in case you typed one the transcript missed).
// Returns [{ s, e, w }] in file time, padded a little so nothing slips through.
export function swearsIn(words, utts, a, b, isSwear) {
  const out = [];
  for (const [s, e, t] of words || []) { if (e < a) continue; if (s > b) break; if (isSwear(t)) out.push({ s, e, w: t }); }
  const rel = (utts || []).filter(u => u.e > a - 3 && u.s < b + 3);
  if (rel.length) {
    for (const line of timeLines(rel, words)) for (const x of line) {
      if (x.e < a || x.s > b || !isSwear(x.w)) continue;
      if (!out.some(o => Math.abs(o.s - x.s) < 0.3)) out.push({ s: x.s, e: x.e, w: x.w });
    }
  }
  return out.sort((p, q) => p.s - q.s).map(o => ({ s: o.s - 0.08, e: o.e + 0.06, w: o.w }));
}

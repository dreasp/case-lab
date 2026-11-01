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

// Where the second part of a split line really starts
export function splitTime(u, a, b, words) {
  if (!words || !words.length) return null;
  const asr = near(words, u.s - 2, u.e + 2);
  const al = alignWords([a, b], asr);
  const first = al.find(x => x.p === 1);
  return first ? first.s : null;
}

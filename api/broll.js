// B-roll mode: plan search terms, gather stock footage, let the AI pick the best match.

const express = require('express');
const { Readable } = require('stream');
const { generateJSON } = require('./gemini');
const src = require('./sources');

const router = express.Router();

const RULES = `Hard rules for every visual:
- It must literally show what the narrator is talking about in that sentence (the place, object, action, era or setting), not an abstract mood.
- Never violent or graphic: no weapons being used, no blood, no injuries, no dead bodies, no attacks, no sexual content, no frightened victims. For violent events, show the neutral setting instead (an empty street at night, a closed door, police car lights, a courthouse, paperwork).
- Stock sites have no footage of the real people in true crime stories, so for real people describe something visible and neutral (a man in an interrogation room seen from behind, hands signing a document).`;

// 1) Turn each sentence into stock-footage search terms
router.post('/plan', async (req, res) => {
  try {
    const { title = '', script = '', shots = [] } = req.body || {};
    if (!shots.length) return res.status(400).json({ error: 'No sentences sent.' });
    const out = [];
    for (let i = 0; i < shots.length; i += 30) {
      const group = shots.slice(i, i + 30);
      const prompt = `You are a video editor choosing B-roll for a YouTube documentary narration titled "${title}".

FULL SCRIPT (for context only):
"""${String(script).slice(0, 30000)}"""

${RULES}

For each numbered sentence below, write search terms for free stock sites (Pixabay). Pixabay search works best with 1 to 3 plain keywords, so keep each query short and concrete, like "movie theater night", "vintage car", "police interrogation room", "supreme court building".

Return a JSON array, one object per sentence:
{"id": <same id>, "queries": [3 queries, most specific first, most general last], "prefer": "video" or "photo", "wiki": a Wikimedia Commons search for a real, named historical person, building, place or document mentioned in this sentence (for example "Earl Warren" or "Phoenix Arizona 1960s"), or null if there is none}

Prefer "video" unless the sentence is about a specific real person, document or historical moment where a photo fits better.

SENTENCES:
${group.map(s => `${s.id}: ${s.text}`).join('\n')}`;
      const result = await generateJSON([{ text: prompt }]);
      const arr = Array.isArray(result) ? result : (result.shots || result.items || []);
      for (const s of group) {
        const r = arr.find(x => String(x.id) === String(s.id)) || {};
        out.push({
          id: s.id,
          queries: (r.queries || []).map(src.cleanQuery).filter(Boolean).slice(0, 3),
          prefer: r.prefer === 'photo' ? 'photo' : 'video',
          wiki: r.wiki ? src.cleanQuery(r.wiki) : null,
        });
      }
    }
    res.json({ shots: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2) Search the stock sites for each sentence
router.post('/candidates', async (req, res) => {
  try {
    const shots = (req.body && req.body.shots) || [];
    const results = {};
    for (const s of shots.slice(0, 8)) {
      const seen = new Set();
      const list = [];
      const add = arr => { for (const c of arr) if (!seen.has(c.key)) { seen.add(c.key); list.push(c); } };
      if (s.wiki) { try { add(await src.wikimedia(s.wiki, 3)); } catch (e) { /* skip */ } }
      for (const q of s.queries || []) {
        if (list.length >= 8) break;
        try {
          if (s.prefer === 'photo') { add(await src.pixabayPhotos(q, 4)); add(await src.pixabayVideos(q, 4)); }
          else { add(await src.pixabayVideos(q, 6)); if (list.length < 6) add(await src.pixabayPhotos(q, 3)); }
        } catch (e) {
          if (/rate limit/i.test(e.message)) throw e;
        }
      }
      results[s.id] = list.slice(0, 9);
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual search from the review screen
router.post('/search', async (req, res) => {
  try {
    const q = src.cleanQuery(req.body && req.body.q);
    if (!q) return res.json({ results: [] });
    const [v, p, w] = await Promise.all([
      src.pixabayVideos(q, 10).catch(() => []),
      src.pixabayPhotos(q, 8).catch(() => []),
      src.wikimedia(q, 6).catch(() => []),
    ]);
    res.json({ results: [...v, ...p, ...w] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function thumbData(url) {
  if (!src.allowedHost(url)) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': src.UA } });
    if (!r.ok) return null;
    const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\//.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 1.5 * 1024 * 1024) return null;
    return { mime_type: type, data: buf.toString('base64') };
  } catch (e) { return null; }
}

// 3) The AI looks at the thumbnails and picks the best one per sentence
router.post('/pick', async (req, res) => {
  try {
    const { title = '', shots = [] } = req.body || {};
    const parts = [{ text: `You are a careful video editor picking B-roll for a YouTube documentary titled "${title}".
For each SHOT you get the narration sentence and numbered candidate thumbnails from free stock sites.

${RULES}
- Reject candidates with big watermarks, unrelated text overlays, or obviously wrong era or country when the sentence is clearly about a specific time and place.
- Prefer moving video over photos when both fit equally well.
- A slightly generic but accurate visual is better than a specific but wrong one.
- If no candidate fits, use -1.

Answer with a JSON array, one object per shot:
{"id": <shot id>, "best": <candidate number or -1>, "alt": <second choice number or -1>, "why": "<max 12 words>"}` }];

    for (const s of shots) {
      parts.push({ text: `\n=== SHOT ${s.id} (${Math.round(s.duration || 0)}s) ===\nNarration: "${s.text}"` });
      const cands = (s.candidates || []).slice(0, 9);
      const imgs = await Promise.all(cands.map(c => thumbData(c.thumb)));
      cands.forEach((c, i) => {
        if (!imgs[i]) return;
        parts.push({ text: `Candidate ${i} (${c.type}${c.duration ? ', ' + c.duration + 's' : ''}, ${c.source}, tags: ${String(c.tags || '').slice(0, 80)}):` });
        parts.push({ inline_data: imgs[i] });
      });
    }
    const result = await generateJSON(parts, { temperature: 0.1 });
    const arr = Array.isArray(result) ? result : (result.shots || []);
    const picks = {};
    for (const s of shots) {
      const r = arr.find(x => String(x.id) === String(s.id)) || {};
      const n = (s.candidates || []).length;
      const ok = v => Number.isInteger(v) && v >= 0 && v < n ? v : -1;
      picks[s.id] = { best: ok(r.best), alt: ok(r.alt), why: String(r.why || '').slice(0, 120) };
    }
    res.json({ picks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fresh link for a Pixabay item (their photo links expire after a day)
router.post('/refresh', async (req, res) => {
  try {
    const { type, id } = req.body || {};
    const url = await src.pixabayById(type, id);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pass stock footage through to the browser so it can be drawn into the video
router.get('/media', async (req, res) => {
  const u = String(req.query.u || '');
  if (!src.allowedHost(u)) return res.status(400).send('Source not allowed');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const headers = { 'User-Agent': src.UA };
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await fetch(u, { headers, signal: ac.signal });
    res.status(r.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send('Could not load media');
    else res.end();
  }
});

module.exports = { router };

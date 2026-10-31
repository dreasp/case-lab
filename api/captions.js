// Captions: word-by-word timing from AssemblyAI. The words shown on screen come from your
// script (so names are always spelled your way); only the timing comes from AssemblyAI.

const express = require('express');
const cloud = require('./cloud');
const usage = require('./usage');

const router = express.Router();
const BASE = () => (process.env.ASSEMBLYAI_BASE || 'https://api.assemblyai.com').replace(/\/$/, '');
const KEY = () => String(process.env.ASSEMBLYAI_API_KEY || '').trim();
const MODEL = 'universal-3-5-pro';
const PRICE_PER_HOUR = 0.21; // US dollars, AssemblyAI price list (October 2026)
const counted = new Set();   // transcripts already added to the cost counter

async function aai(path, opts = {}) {
  const r = await fetch(BASE() + path, {
    ...opts,
    headers: { authorization: KEY(), ...(opts.headers || {}) },
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!r.ok) throw new Error(`AssemblyAI error ${r.status}: ${(data.error || text).slice(0, 200)}`);
  return data;
}

async function startTranscript(audioUrl) {
  return aai('/v2/transcript', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, speech_models: [MODEL], language_code: 'en', punctuate: true, format_text: true }),
  });
}

router.get('/captions/ready', (req, res) => res.json({ ready: !!KEY() }));

// Narration already in cloud storage: AssemblyAI fetches it directly from there
router.post('/captions/start', async (req, res) => {
  try {
    if (!KEY()) return res.status(400).json({ error: 'ASSEMBLYAI_API_KEY is not set on the server.' });
    const key = String((req.body && req.body.key) || '');
    if (!cloud.filesReady() || !cloud.KEY_RE.test(key)) return res.status(400).json({ error: 'NO_CLOUD_FILE' });
    const t = await startTranscript(await cloud.signedUrl(key, 'GET'));
    res.json({ id: t.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Otherwise the browser sends the audio, and it's passed straight on to AssemblyAI
router.post('/captions/upload', async (req, res) => {
  try {
    if (!KEY()) return res.status(400).json({ error: 'ASSEMBLYAI_API_KEY is not set on the server.' });
    const up = await aai('/v2/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: req,
      duplex: 'half',
    });
    const t = await startTranscript(up.upload_url);
    res.json({ id: t.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/captions/status/:id', async (req, res) => {
  try {
    const id = String(req.params.id).replace(/[^\w-]/g, '');
    const t = await aai('/v2/transcript/' + id);
    if (t.status === 'error') return res.json({ status: 'error', error: t.error || 'Transcription failed' });
    if (t.status !== 'completed') return res.json({ status: t.status });
    if (!counted.has(id) && t.audio_duration) {
      counted.add(id);
      usage.addCost(t.audio_duration / 3600 * PRICE_PER_HOUR).catch(() => {});
    }
    res.json({
      status: 'completed',
      duration: t.audio_duration,
      words: (t.words || []).map(w => ({ t: w.text, s: w.start / 1000, e: w.end / 1000 })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router };

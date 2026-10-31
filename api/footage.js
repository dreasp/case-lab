// Footage analysis: speaker-labeled transcripts (AssemblyAI), what happens on screen (Gemini
// watching the small analysis copy), photo descriptions, and the master case timeline.
// The original footage stays on your computer; only small analysis copies are in storage.

const express = require('express');
const cloud = require('./cloud');
const usage = require('./usage');
const { generateJSON } = require('./gemini');

const router = express.Router();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- AssemblyAI: who said what ----------
const AAI = () => (process.env.ASSEMBLYAI_BASE || 'https://api.assemblyai.com').replace(/\/$/, '');
const AAI_KEY = () => String(process.env.ASSEMBLYAI_API_KEY || '').trim();
const AAI_PRICE = { base: 0.21, speakers: 0.02, keyterms: 0.05 }; // US dollars per hour (October 2026)
const counted = new Set();

async function aai(path, opts = {}) {
  const r = await fetch(AAI() + path, { ...opts, headers: { authorization: AAI_KEY(), ...(opts.headers || {}) } });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!r.ok) throw new Error(`AssemblyAI error ${r.status}: ${(data.error || text).slice(0, 200)}`);
  return data;
}

// Names and special words from the case context, so they're heard correctly
function keyterms(list) {
  const seen = new Set();
  return (list || []).map(t => String(t).trim()).filter(t => t && t.split(/\s+/).length <= 6 && t.length <= 60)
    .filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 200);
}

router.post('/case/transcribe', async (req, res) => {
  try {
    if (!AAI_KEY()) return res.status(400).json({ error: 'ASSEMBLYAI_API_KEY is not set on the server.' });
    const { key, terms } = req.body || {};
    if (!cloud.KEY_RE.test(String(key || ''))) return res.status(400).json({ error: 'Bad key' });
    const kt = keyterms(terms);
    const body = {
      audio_url: await cloud.signedUrl(key, 'GET', {}, 6 * 3600),
      speech_models: ['universal-3-5-pro'],
      speaker_labels: true,
      language_detection: true,
      punctuate: true,
      format_text: true,
    };
    if (kt.length) body.keyterms_prompt = kt;
    const t = await aai('/v2/transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    res.json({ id: t.id, keyterms: kt.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/case/transcribe/:id', async (req, res) => {
  try {
    const id = String(req.params.id).replace(/[^\w-]/g, '');
    const t = await aai('/v2/transcript/' + id);
    if (t.status === 'error') return res.json({ status: 'error', error: t.error || 'Transcription failed' });
    if (t.status !== 'completed') return res.json({ status: t.status });
    if (!counted.has(id) && t.audio_duration) {
      counted.add(id);
      const perHour = AAI_PRICE.base + AAI_PRICE.speakers + (Number(req.query.kt) > 0 ? AAI_PRICE.keyterms : 0);
      usage.addCost(t.audio_duration / 3600 * perHour).catch(() => {});
    }
    const utterances = (t.utterances || []).map(u => ({ sp: u.speaker, s: u.start / 1000, e: u.end / 1000, text: u.text }));
    res.json({ status: 'completed', duration: t.audio_duration, language: t.language_code || null, utterances });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Gemini: send the analysis copy so the AI can watch it ----------
const G_BASE = () => (process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const G_KEY = () => String(process.env.GEMINI_API_KEY || '').trim();

router.post('/case/gemini-upload', async (req, res) => {
  try {
    const { key, name, mime } = req.body || {};
    if (!cloud.KEY_RE.test(String(key || ''))) return res.status(400).json({ error: 'Bad key' });
    const src = await fetch(await cloud.signedUrl(key, 'GET'));
    if (!src.ok) throw new Error('Could not read the analysis copy from storage (' + src.status + ')');
    const size = Number(src.headers.get('content-length'));
    const type = /^(video\/mp4|application\/pdf)$/.test(String(mime)) ? mime : (src.headers.get('content-type') || 'video/mp4');
    const start = await fetch(`${G_BASE()}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': G_KEY(),
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': type,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: String(name || key).slice(0, 120) } }),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!start.ok || !uploadUrl) throw new Error('Gemini did not accept the upload: ' + (await start.text()).slice(0, 200));
    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: src.body,
      duplex: 'half',
    });
    const data = await up.json().catch(() => ({}));
    if (!up.ok || !data.file) throw new Error('Upload to Gemini failed: ' + JSON.stringify(data).slice(0, 200));
    res.json({ name: data.file.name, uri: data.file.uri, state: data.file.state, mime: data.file.mimeType || type });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/case/gemini-file/:id', async (req, res) => {
  try {
    const id = String(req.params.id).replace(/[^\w-]/g, '');
    const r = await fetch(`${G_BASE()}/v1beta/files/${id}`, { headers: { 'x-goog-api-key': G_KEY() } });
    const data = await r.json().catch(() => ({}));
    if (r.status === 404 || r.status === 403) return res.json({ state: 'GONE' });
    if (!r.ok) throw new Error('Gemini file check failed: ' + JSON.stringify(data).slice(0, 200));
    res.json({ state: data.state, uri: data.uri, error: data.error && data.error.message });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- the instructions ----------
const STYLE = `You are a meticulous research assistant for a true crime YouTube channel that tells real cases with respect.
- Be factual and neutral. Describe only what is actually seen or heard. Never invent names, motives or events.
- Respect victims: refer to them with dignity, never sensationalize injuries or suffering.
- When something is unclear (a name, a word, who is speaking), say so in "uncertain" instead of guessing.
- Use the CASE CONTEXT to identify people and spell names exactly as written there.`;

const fmtT = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

function transcriptText(utt, from, to) {
  return (utt || []).filter(u => u.e >= from && u.s <= to)
    .map(u => `[${fmtT(u.s)}] Speaker ${u.sp}: ${u.text}`).join('\n').slice(0, 120000);
}

// One part of a video (long videos are analyzed in 40-minute parts)
router.post('/case/analyze-video', async (req, res) => {
  try {
    const { uri, mime, fileName, duration, context, utterances, from = 0, to, title } = req.body || {};
    const end = Math.min(Number(to) || duration, duration);
    const transcript = transcriptText(utterances, from, end);
    const prompt = `${STYLE}

CASE: ${title || ''}
CASE CONTEXT (names, roles, known facts, written by the researcher):
"""${String(context || '').slice(0, 8000)}"""

FILE: ${fileName} (${fmtT(duration)} long). You are watching the part from ${fmtT(from)} to ${fmtT(end)}.
The video is shown at 1 frame per second without sound. Here is the speaker-labeled transcript of this part (times are from the start of the file; speaker letters come from voice separation and may need names):
"""
${transcript || '(no speech in this part)'}
"""

Return JSON:
{
  "clock_start": on-screen date and time printed on the footage (bodycam/dashcam overlay) at ${fmtT(from)}, written exactly like "2023-03-14 21:04:12", or null if none is visible,
  "camera": who is wearing or holding the camera, or what kind of camera it is (e.g. "Officer Diaz bodycam", "patrol car dashcam", "interview room camera"),
  "speakers": { "A": "name or role of speaker A", ... } for every speaker letter in the transcript (use case context names when clearly identifiable, otherwise roles like "Officer (camera wearer)", "Woman in red jacket"),
  "summary": 3 to 6 sentences about what happens in this part,
  "events": [ { "t": seconds from start of file, "what": one sentence } ] for every notable change in what is seen or said, about one every 15 to 60 seconds,
  "moments": [ { "start": seconds, "end": seconds, "title": short title, "description": 1-2 sentences, "importance": 1 to 5 (5 = essential to the story), "kind": "dialogue" | "action" | "reveal" | "emotional" | "context", "quote": the key line said, copied from the transcript, or "" } ] for the moments worth showing in a video (usually 10 to 40 seconds each),
  "people": [ { "who": name or role, "description": what they look like / do } ],
  "visible_text": [ important text seen on screen (signs, documents, plates, addresses) ],
  "sensitive": [ { "start": seconds, "end": seconds, "note": what is graphic or private (injuries, bodies, minors, nudity, personal info) } ],
  "uncertain": [ things a researcher should double-check ]
}`;
    const parts = [
      { file_data: { file_uri: uri, mime_type: mime || 'video/mp4' }, video_metadata: { start_offset: `${Math.floor(from)}s`, end_offset: `${Math.ceil(end)}s` } },
      { text: prompt },
    ];
    const out = await generateJSON(parts, { temperature: 0.2, images: true });
    // a cut-off answer can end with a half-written item: drop those
    if (out && Array.isArray(out.moments)) out.moments = out.moments.filter(m => m && m.title && m.start != null && m.end != null);
    if (out && Array.isArray(out.events)) out.events = out.events.filter(e => e && (e.what || e.description || e.text));
    res.json({ result: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Audio-only files (911 calls, phone recordings): analysis from the transcript
router.post('/case/analyze-audio', async (req, res) => {
  try {
    const { fileName, duration, context, utterances, title } = req.body || {};
    const prompt = `${STYLE}

CASE: ${title || ''}
CASE CONTEXT:
"""${String(context || '').slice(0, 8000)}"""

FILE: ${fileName} (audio only, ${fmtT(duration)} long). Speaker-labeled transcript:
"""
${transcriptText(utterances, 0, duration + 1) || '(no speech)'}
"""

Return JSON:
{ "clock_start": date/time of the recording if it is said or known, else null,
  "camera": "audio recording" plus what kind (e.g. "911 call", "jail phone call"),
  "speakers": { "A": "name or role", ... },
  "summary": 3 to 6 sentences,
  "events": [ { "t": seconds, "what": one sentence } ],
  "moments": [ { "start", "end", "title", "description", "importance": 1-5, "kind", "quote" } ],
  "people": [ { "who", "description" } ], "visible_text": [], "sensitive": [ { "start", "end", "note" } ], "uncertain": [] }`;
    res.json({ result: await generateJSON([{ text: prompt }], { temperature: 0.2 }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PDF documents (police reports, warrants, autopsy reports...): Gemini reads every page, scans too
router.post('/case/analyze-document', async (req, res) => {
  try {
    const { uri, fileName, context, title } = req.body || {};
    const prompt = `${STYLE}

CASE: ${title || ''}
CASE CONTEXT:
"""${String(context || '').slice(0, 8000)}"""

DOCUMENT: ${fileName}. Read every page (including scanned or handwritten pages). Return JSON:
{
  "doc_type": what kind of document it is (e.g. "Police incident report", "Search warrant", "Autopsy report", "Witness statement", "Court ruling"),
  "date": the main date of the document as written, or null,
  "summary": 3 to 6 sentences,
  "key_facts": [ the important facts, one sentence each, with page numbers like "(p. 3)" ],
  "people": [ { "who": name as written, "role": role in the case } ],
  "timeline": [ { "when": date/time as written, "what": one sentence } ] for every dated or timed event in the document,
  "quotes": [ { "who": speaker or writer, "quote": exact words, "page": page number } ] for statements worth quoting,
  "redactions": short note on what is blacked out, or "",
  "sensitive": [ graphic or private details to handle carefully, with page ],
  "uncertain": [ unreadable parts or things to double-check ]
}`;
    const out = await generateJSON([{ file_data: { file_uri: uri, mime_type: 'application/pdf' } }, { text: prompt }], { temperature: 0.2 });
    res.json({ result: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Photos: short descriptions (the AI sees the small analysis copies)
router.post('/case/photos', async (req, res) => {
  try {
    const { context, photos, title } = req.body || {};
    const parts = [{ text: `${STYLE}

CASE: ${title || ''}
CASE CONTEXT:
"""${String(context || '').slice(0, 6000)}"""

Describe each numbered photo from this case file. Return a JSON array, one object per photo:
{ "id": photo id, "description": 1-2 factual sentences, "shows": "scene" | "evidence" | "person" | "document" | "vehicle" | "map" | "other", "people": names from the case context only if clearly identifiable (else []), "text": important readable text or "", "sensitive": true if graphic (injuries, bodies), shows a minor, or personal data, "usefulness": 1-5 for a YouTube video (5 = very useful, 1 = not usable) }` }];
    for (const ph of (photos || []).slice(0, 24)) {
      if (!cloud.KEY_RE.test(String(ph.key || ''))) continue;
      try {
        const r = await fetch(await cloud.signedUrl(ph.key, 'GET'));
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        parts.push({ text: `Photo ${ph.id} (${String(ph.name || '').slice(0, 80)}):` });
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } });
      } catch (e) { /* skip this photo */ }
    }
    const out = await generateJSON(parts, { temperature: 0.2, images: true });
    res.json({ results: Array.isArray(out) ? out : (out.photos || []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The whole case: chronological timeline across all files + research document
router.post('/case/master', async (req, res) => {
  try {
    const { title, context, files, photos } = req.body || {};
    const fileText = (files || []).map(f => f.type === 'document' ? `=== FILE ${f.id}: ${f.name} (document: ${f.docType || 'document'}${f.date ? ', dated ' + f.date : ''})
Summary: ${f.summary || ''}
Key facts:
${(f.facts || []).map(x => '- ' + x).join('\n')}
Dated events:
${(f.events || []).map(e => `- ${e.when || '?'}: ${e.what}`).join('\n')}
Quotes: ${(f.quotes || []).map(q => `${q.who}: "${q.quote}" (p. ${q.page || '?'})`).join(' | ')}
Uncertain: ${(f.uncertain || []).join('; ')}` : `=== FILE ${f.id}: ${f.name} (${f.type}, ${fmtT(f.duration || 0)}${f.clock ? ', on-screen clock at start: ' + f.clock : ''}${f.camera ? ', ' + f.camera : ''})
Summary: ${f.summary || ''}
Speakers: ${JSON.stringify(f.speakers || {})}
Key moments:
${(f.moments || []).map(m => `- [${fmtT(m.start)}-${fmtT(m.end)}] (${m.importance}/5) ${m.title}: ${m.description}${m.quote ? ` Quote: "${m.quote}"` : ''}`).join('\n')}
Uncertain: ${(f.uncertain || []).join('; ')}`).join('\n\n').slice(0, 300000);
    const photoText = (photos || []).map(p => `- Photo ${p.id} ${p.name}: ${p.description}`).join('\n').slice(0, 40000);
    const prompt = `${STYLE}

CASE: ${title || ''}
CASE CONTEXT:
"""${String(context || '').slice(0, 10000)}"""

Below is the analysis of every file in this case (videos, audio recordings, documents such as police reports) and the photo descriptions. Documents give dates, names and facts; use them to place the footage in time and to name people correctly. For document files, use "t": 0.
Put everything together into one research document. Order events by when they really happened, using the on-screen clocks, what is said and the case context. When files overlap in time (several officers' bodycams), merge them.

${fileText}

PHOTOS:
${photoText || '(none)'}

Return JSON:
{
  "overview": one paragraph summary of the whole incident as shown in the files,
  "people": [ { "name": name or role, "role": who they are in the case, "appears_in": [file ids] } ],
  "timeline": [ { "when": real date/time if known else "", "file": file id, "t": seconds in that file, "what": one sentence } ] in real chronological order,
  "story_beats": [ { "title": short title, "description": what happens and why it matters, "sources": [ { "file": file id, "start": seconds, "end": seconds } ] } ] the 6 to 15 beats a documentary would tell, in story order,
  "key_quotes": [ { "file": file id, "t": seconds, "speaker": name or role, "quote": exact words } ],
  "open_questions": [ things the footage doesn't answer or that should be checked ],
  "content_warnings": [ graphic or sensitive material to handle carefully, with file and time ]
}`;
    res.json({ result: await generateJSON([{ text: prompt }], { temperature: 0.3 }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router };

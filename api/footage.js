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

// Exact timing of every word of a finished transcript (for captions that match the speech).
// Reading a finished transcript again is free at AssemblyAI.
router.get('/case/words/:id', async (req, res) => {
  try {
    const id = String(req.params.id).replace(/[^\w-]/g, '');
    const t = await aai('/v2/transcript/' + id);
    if (t.status !== 'completed') return res.status(400).json({ error: 'This transcript is not available.' });
    const r2 = x => Math.round(x / 10) / 100;
    res.json({ words: (t.words || []).map(w => [r2(w.start), r2(w.end), w.text]) });
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
    // Google sometimes can't describe a file it received (a 500 error every time for that file).
    // The app then sends the video again instead of stopping.
    if (r.status >= 500) return res.json({ state: 'BROKEN', error: 'Gemini file check failed: ' + JSON.stringify(data).slice(0, 200) });
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

// Transcript lines labeled with times counted from zero (the start of the part being watched)
function transcriptText(utt, from, to, zero = 0) {
  return (utt || []).filter(u => u.e >= from && u.s <= to)
    .map(u => `[${fmtT(Math.max(0, u.s - zero))}] Speaker ${u.sp}: ${u.text}`).join('\n').slice(0, 120000);
}

// "1:02:03", "4:05" or 245 -> seconds. The AI is asked for clock-style strings because it
// converts long times to seconds badly.
function parseTime(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3];
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

// Turns the AI's part-relative times into seconds from the start of the file
function fixTimes(out, from, len) {
  if (!out || typeof out !== 'object') return out;
  const abs = v => {
    let t = parseTime(v);
    if (t == null) return from;
    // a time already counted from the start of the file
    if (from > 0 && t > len + 30 && t >= from - 30 && t <= from + len + 30) t -= from;
    return from + Math.min(Math.max(0, t), len);
  };
  for (const e of out.events || []) e.t = abs(e.t);
  for (const k of ['moments', 'sensitive']) for (const m of out[k] || []) {
    m.start = abs(m.start);
    m.end = Math.max(m.start, abs(m.end));
  }
  return out;
}

// One part of a video (long videos are analyzed in 40-minute parts)
router.post('/case/analyze-video', async (req, res) => {
  try {
    const { uri, mime, fileName, duration, context, utterances, from = 0, to, title } = req.body || {};
    const end = Math.min(Number(to) || duration, duration);
    const len = Math.max(1, end - from);
    const transcript = transcriptText(utterances, from, end, from);
    const prompt = `${STYLE}

CASE: ${title || ''}
CASE CONTEXT (names, roles, known facts, written by the researcher):
"""${String(context || '').slice(0, 24000)}"""

FILE: ${fileName} (${fmtT(duration)} long). You are watching one part of it: ${fmtT(len)} long.
TIMES: count every time from the start of THIS PART, which is 0:00 and ends at ${fmtT(len)}. The transcript below uses the same times. Write every time as a string like "4:05" (minutes:seconds), never as a number of seconds.
The video is shown at 1 frame per second without sound. Here is the speaker-labeled transcript of this part (speaker letters come from voice separation and may need names):
"""
${transcript || '(no speech in this part)'}
"""

Return JSON:
{
  "clock_start": on-screen date and time printed on the footage (bodycam/dashcam overlay) at 0:00 of this part, written exactly like "2023-03-14 21:04:12", or null if none is visible,
  "camera": who is wearing or holding the camera, or what kind of camera it is (e.g. "Officer Diaz bodycam", "patrol car dashcam", "interview room camera"),
  "speakers": { "A": "name or role of speaker A", ... } for every speaker letter in the transcript (use case context names when clearly identifiable, otherwise roles like "Officer (camera wearer)", "Woman in red jacket"),
  "summary": 3 to 6 sentences about what happens in this part,
  "events": [ { "t": "m:ss", "what": one sentence } ] for every notable change in what is seen or said, about one every 15 to 60 seconds,
  "moments": [ { "start": "m:ss", "end": "m:ss", "title": short title, "description": 1-2 sentences, "importance": 1 to 5 (5 = essential to the story), "kind": "dialogue" | "action" | "reveal" | "emotional" | "context", "quote": the key line said, copied from the transcript, or "" } ] for the moments worth showing in a video (usually 10 to 40 seconds each),
  "people": [ { "who": name or role, "description": what they look like / do } ],
  "visible_text": [ important text seen on screen (signs, documents, plates, addresses) ],
  "sensitive": [ { "start": "m:ss", "end": "m:ss", "note": what is graphic or private (injuries, bodies, minors, nudity, personal info) } ],
  "uncertain": [ things a researcher should double-check ]
}`;
    const parts = [
      { file_data: { file_uri: uri, mime_type: mime || 'video/mp4' }, video_metadata: { start_offset: `${Math.floor(from)}s`, end_offset: `${Math.ceil(end)}s` } },
      { text: prompt },
    ];
    const out = await generateJSON(parts, { temperature: 0.2, images: true });
    // a cut-off answer can end with a half-written item: drop those
    fixTimes(out, Number(from) || 0, len);
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
"""${String(context || '').slice(0, 24000)}"""

FILE: ${fileName} (audio only, ${fmtT(duration)} long). Write every time as a string like "4:05" (minutes:seconds), copied from the transcript labels, never as a number of seconds.
Speaker-labeled transcript:
"""
${transcriptText(utterances, 0, duration + 1) || '(no speech)'}
"""

Return JSON:
{ "clock_start": date/time of the recording if it is said or known, else null,
  "camera": "audio recording" plus what kind (e.g. "911 call", "jail phone call"),
  "speakers": { "A": "name or role", ... },
  "summary": 3 to 6 sentences,
  "events": [ { "t": "m:ss", "what": one sentence } ],
  "moments": [ { "start": "m:ss", "end": "m:ss", "title", "description", "importance": 1-5, "kind", "quote" } ],
  "people": [ { "who", "description" } ], "visible_text": [], "sensitive": [ { "start": "m:ss", "end": "m:ss", "note" } ], "uncertain": [] }`;
    res.json({ result: fixTimes(await generateJSON([{ text: prompt }], { temperature: 0.2 }), 0, Math.max(1, Number(duration) || 1)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PDF documents (police reports, warrants, autopsy reports...): Gemini reads every page, scans too
router.post('/case/analyze-document', async (req, res) => {
  try {
    const { uri, fileName, context, title } = req.body || {};
    const prompt = `${STYLE}

CASE: ${title || ''}
CASE CONTEXT:
"""${String(context || '').slice(0, 24000)}"""

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
"""${String(context || '').slice(0, 24000)}"""

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
"""${String(context || '').slice(0, 24000)}"""

Below is the analysis of every file in this case (videos, audio recordings, documents such as police reports) and the photo descriptions. Documents give dates, names and facts; use them to place the footage in time and to name people correctly. For document files, use "t": 0.
Put everything together into one research document. Order events by when they really happened, using the on-screen clocks, what is said and the case context. When files overlap in time (several officers' bodycams, or two camera angles of the same room), merge them and don't repeat the same event twice.
Times inside a file are written like "1:02:03" or "4:05" (from the start of that file). Copy them in the same style, never as a number of seconds.
In sentences, call files by what they show (e.g. "the interview room video"), never by their file id; file ids only go in the "file" fields.

${fileText}

PHOTOS:
${photoText || '(none)'}

Return JSON:
{
  "overview": one paragraph summary of the whole incident as shown in the files,
  "people": [ { "name": name or role, "role": who they are in the case, "appears_in": [file ids] } ],
  "timeline": [ { "when": real date/time if known from a document or what is said, else "", "file": file id, "t": "h:mm:ss" or "m:ss", "what": one sentence } ] in real chronological order,
  "story_beats": [ { "title": short title, "description": what happens and why it matters, "sources": [ { "file": file id, "start": "m:ss", "end": "m:ss" } ] (the 1 to 4 best clips, not every mention) } ] the 6 to 15 beats a documentary would tell, in story order,
  "key_quotes": [ { "file": file id, "t": "m:ss", "speaker": name or role, "quote": exact words } ],
  "open_questions": [ things the footage doesn't answer or that should be checked ],
  "content_warnings": [ { "file": file id, "t": "m:ss", "note": graphic or sensitive material to handle carefully } ]
}`;
    const out = await generateJSON([{ text: prompt }], { temperature: 0.3 });
    res.json({ result: tidyMaster(out, files || []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Story builder: rough cut in story order with narration drafts ----------
const STORY_STYLE = `NARRATION STYLE (the channel's own standards):
- Victim-centered: remember the victim as a person; never sensational, never gory, never describe a case as "fascinating".
- Factually precise: only say what the files or the case context support. Say "police say", "according to" or "alleged" where something is not proven; only call someone guilty if the case context says they were convicted or pleaded guilty.
- Written to be read aloud: full, flowing sentences, not fragments. Plain, warm, serious tone.
- Never use em dashes. Use commas or full stops instead.
- Each narration part sets up the next clip: who we are about to see, where, and why it matters. Don't retell what the viewer is about to watch.
- Use the creator's notes (OUTCOME especially) and the ONLINE RESEARCH in the case context for background: who the victim was, how the case ended (charges, plea or verdict, sentence, dates). Only state facts found there or in the footage, and prefer the creator's notes when they disagree.
- Remember the victim as a person somewhere in the video, using only what the case context says about them.
- Near the end, tell viewers how the case ended, using the outcome from the case context.
- Vary the ending reflection from case to case. The very last narration part ends with exactly: "Until next time, stay safe, stay aware, and stay curious. I'll see you in the next video. Bye!"`;

router.post('/case/story', async (req, res) => {
  try {
    const { title, context, style, targetMin = 30, research, files, psych } = req.body || {};
    const target = Math.max(5, Math.min(120, Number(targetMin) || 30));
    const fileText = (files || []).map(f => `=== FILE ${f.id}: ${f.name} (${f.type}, ${fmtT(f.duration || 0)} long${f.clock ? ', on-screen clock at start ' + f.clock : ''}${f.camera ? ', ' + f.camera : ''})
Speakers: ${Object.entries(f.speakers || {}).map(([k, v]) => k + ' = ' + v).join(', ')}
Summary: ${f.summary || ''}
Moments:
${(f.moments || []).map(m => `- [${fmtT(m.start)} to ${fmtT(m.end)}] (${m.importance || '?'}/5${m.sensitive ? ', SENSITIVE' : ''}) ${m.title}: ${m.description}${m.quote ? ` Quote: "${String(m.quote).slice(0, 300)}"` : ''}`).join('\n')}`).join('\n\n').slice(0, 400000);
    const r = research || {};
    const pSecs = psych ? Math.max(10, Math.min(90, Number(psych.secs) || 30)) : 0;
    const psychText = psych ? `
PSYCHOLOGICAL PERSPECTIVE (the creator turned this on):
- After the case outcome has been told, add ONE separate narration part of about ${pSecs} seconds (about ${Math.round(pSecs * 2.6)} words) that gives a short psychological perspective on what happened, then the closing sign-off part.
- Keep it general and grounded: what psychology and behavioral research describe about this kind of situation (for example coercion, escalation, why people confess or stay silent), tied to behavior visible in this case's footage and context. Say "researchers describe" or "experts note", never invent studies or quotes, and do not diagnose or label any real named person.
- Do not add anything to the video's length: keep the total at the target minutes by making other narration parts slightly shorter.${psych.notes ? `\n- The creator wants this angle: """${String(psych.notes).slice(0, 600)}"""` : ''}
` : '';
    const prompt = `${STYLE}

You are the editor of a long-form true crime YouTube video built mostly from real footage (bodycam, interrogation, 911 calls), with short narration in between, in the style of channels like JCS.

CASE: ${title || ''}
CASE CONTEXT (written by the creator, trust it over the footage analysis):
"""${String(context || '').slice(0, 24000)}"""

${STORY_STYLE}
${style ? `\nEXTRA STYLE NOTES FROM THE CREATOR:\n"""${String(style).slice(0, 3000)}"""\n` : ''}${psychText}
CASE RESEARCH (already put together from all files):
Overview: ${r.overview || ''}
Story beats:
${(r.story_beats || []).map((b, i) => `${i + 1}. ${b.title}: ${b.description}`).join('\n')}
Key quotes:
${(r.key_quotes || []).map(q => `- ${q.speaker}: "${String(q.quote || '').slice(0, 300)}"`).join('\n')}

THE FOOTAGE (every time is from the start of that file):
${fileText}

Build the rough cut.
- Target length: about ${target} minutes in total. About 80% of the time should be footage clips, 20% narration.
- Start with a short cold open: one gripping but not graphic clip (20 to 60 seconds), then a narration part that introduces the case.
- After that, tell the story in the order it happened, following the story beats. Several clips in a row without narration are fine when the footage speaks for itself.
- Clips: usually 20 seconds to 3 minutes. Pick whole exchanges: start a little before the first line and end after the last line, so nobody is cut off mid-sentence. Use the moment times above; you may widen a clip to include the lines around a moment.
- Skip waiting, silence, repeats and small talk. Leave out anything marked SENSITIVE unless the story truly needs it, and never anything showing a child's body or injuries.
- Narration parts: 2 to 6 sentences each (about 15 to 45 seconds read aloud). The first one can be longer (up to about 90 seconds).
- Write every time as a string like "1:02:03" or "4:05", copied in the same style as above. Never as a number of seconds.

Return JSON:
{
  "title_ideas": [ 3 YouTube title ideas, factual and respectful ],
  "segments": [
    { "type": "clip", "file": file id, "start": "h:mm:ss", "end": "h:mm:ss", "label": short label for the editor, "why": one sentence on why this clip is here },
    { "type": "narration", "text": the narration to record }
  ],
  "notes": [ things the creator should check or decide before recording ]
}`;
    const out = await generateJSON([{ text: prompt }], { temperature: 0.5 });
    const byId = Object.fromEntries((files || []).map(f => [String(f.id), f]));
    const segments = [];
    for (const sgm of (out && out.segments) || []) {
      if (!sgm) continue;
      if (sgm.type === 'narration' && String(sgm.text || '').trim()) { segments.push({ type: 'narration', text: String(sgm.text).replace(/\s*[—–]\s*/g, ', ').trim() }); continue; }
      const f = byId[sgm.file];
      if (sgm.type !== 'clip' || !f) continue;
      let start = parseTime(sgm.start), end = parseTime(sgm.end);
      if (start == null || end == null) continue;
      const dur = f.duration || end;
      start = Math.max(0, Math.min(start, dur)); end = Math.max(0, Math.min(end, dur));
      if (end - start < 3) continue;
      segments.push({ type: 'clip', file: f.id, start, end, label: String(sgm.label || ''), why: String(sgm.why || '') });
    }
    res.json({ result: { title_ideas: (out && out.title_ideas) || [], notes: (out && out.notes) || [], segments } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Online research: what news and court sources say about the case ----------
router.post('/case/web-research', async (req, res) => {
  try {
    const { title, notes } = req.body || {};
    const prompt = `You are a careful true crime researcher. Use Google Search to research this real case. Prefer reliable sources: court records, police statements, established local and national news. Ignore forums, social media and speculation.

CASE: ${title || ''}
WHAT THE CREATOR ALREADY KNOWS (use it to find the right case; it may be incomplete):
"""${String(notes || '').slice(0, 12000)}"""

Rules:
- Only include facts you found in sources. If sources disagree, say so in "uncertain". Never guess.
- Use people's full names as reported. Say "alleged" for anything not proven in court.
- About the victim, keep it respectful: who they were, not graphic details.
- Write dates with the month spelled out (e.g. January 25, 2025). Never use em dashes.

Reply with ONLY a JSON object, no other text:
{
  "found": true or false (did you find this specific case?),
  "case_name": how the case is known,
  "location": city, county, state,
  "summary": one paragraph on what happened,
  "victim": { "name": "", "age": "", "about": "who they were, in 1 to 3 respectful sentences" },
  "suspect": { "name": "", "age": "", "background": "relevant background from sources" },
  "people": [ { "name": "", "role": "" } ],
  "timeline": [ { "date": "", "what": "" } ],
  "outcome": { "charges": "", "plea_or_verdict": "", "sentence": "", "status": "e.g. sentenced, awaiting trial, case closed", "dates": "key court dates" },
  "uncertain": [ things sources disagree on or that are not confirmed ]
}`;
    const out = await generateJSON([{ text: prompt }], { temperature: 0.2, search: true });
    const sources = (out && out._sources) || [];
    if (out) delete out._sources;
    res.json({ result: out, sources });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Real clock time of a moment: the file's on-screen start clock plus the time into the file
function clockAt(clock, t) {
  if (!clock) return null;
  const d = String(clock).match(/(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const tm = String(clock).match(/(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP]M))?/i);
  if (!d || !tm) return null;
  const [y, mo, da] = d[1] ? [+d[1], +d[2], +d[3]] : [+d[6], +d[4], +d[5]];
  let h = +tm[1];
  if (tm[4]) h = h % 12 + (/p/i.test(tm[4]) ? 12 : 0);
  return Date.UTC(y, mo - 1, da, h, +tm[2], +tm[3]) + Math.round(t || 0) * 1000;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtClock = ms => { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`; };

// Times to seconds, real clock times worked out by the app (not guessed by the AI),
// timeline in clock order, and file ids in sentences swapped for file names
function tidyMaster(m, files) {
  if (!m || typeof m !== 'object') return m;
  const byId = Object.fromEntries(files.map(f => [String(f.id), f]));
  const sec = (v, f) => { const t = parseTime(v); return t == null ? 0 : Math.max(0, Math.min(t, (f && f.duration) || t)); };
  const names = s => typeof s === 'string' ? s.replace(/\b[a-z0-9]{10,16}\b/g, w => byId[w] ? byId[w].name : w) : s;
  for (const e of m.timeline || []) {
    const f = byId[e.file];
    e.t = sec(e.t, f);
    const at = f && clockAt(f.clock, e.t);
    if (at) { e.at = at; e.when = fmtClock(at); }
  }
  // put the clocked events in clock order, leaving the others where the AI placed them
  const tl = m.timeline || [];
  const slots = tl.map((e, i) => e.at ? i : -1).filter(i => i >= 0);
  const sorted = slots.map(i => tl[i]).sort((a, b) => a.at - b.at);
  slots.forEach((i, k) => { tl[i] = sorted[k]; });
  for (const b of m.story_beats || []) for (const src of b.sources || []) { src.start = sec(src.start, byId[src.file]); src.end = sec(src.end, byId[src.file]); }
  for (const q of m.key_quotes || []) q.t = sec(q.t, byId[q.file]);
  m.content_warnings = (m.content_warnings || []).map(c => typeof c === 'string' ? { note: c } : { ...c, t: sec(c.t, byId[c.file]), note: c.note || c.description || '' });
  m.overview = names(m.overview);
  m.open_questions = (m.open_questions || []).map(names);
  for (const p of m.people || []) p.role = names(p.role);
  for (const b of m.story_beats || []) b.description = names(b.description);
  for (const e of tl) e.what = names(e.what);
  for (const c of m.content_warnings) c.note = names(c.note);
  return m;
}

module.exports = { router, parseTime, fixTimes, clockAt, tidyMaster };

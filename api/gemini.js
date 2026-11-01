// Small helper for calling the Gemini API with automatic retries.

const usage = require('./usage');
const { jsonrepair } = require('jsonrepair');

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One request at a time. Starts fast (paid tier allows 1,000 a minute); if Google ever says
// "too many requests", it slows to one every 13 seconds (free tier: 5 a minute).
let chain = Promise.resolve();
let lastCall = 0;
let minGap = 500;
function queued(fn) {
  const run = chain.then(async () => {
    const gap = lastCall + minGap - Date.now();
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

// True crime scripts mention crimes; without this, Gemini's filters refuse whole batches.
const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map(category => ({ category, threshold: 'BLOCK_NONE' }));

class GeminiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// search: true lets the AI look things up on Google; the sources come back in result._sources
async function generateJSON(parts, { temperature = 0.3, images = false, search = false } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError('GEMINI_API_KEY is not set on the server.', 'SETUP');
  const base = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
  const url = `${base}/v1beta/models/${MODEL()}:generateContent`;
  const generationConfig = { temperature, maxOutputTokens: 65536 };
  // Google Search can't be combined with forced JSON output, so the JSON is read from the text then
  if (!search) generationConfig.responseMimeType = 'application/json';
  // Flash doesn't need to "think" for this, which saves tokens and avoids empty answers
  if (/flash/i.test(MODEL())) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  // Small previews are enough to judge a shot and use far fewer tokens
  if (images) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  const body = { contents: [{ role: 'user', parts }], generationConfig, safetySettings: SAFETY };
  if (search) body.tools = [{ google_search: {} }];

  return queued(async () => {
    const waits = [15000, 30000, 60000];
    let parseRetried = false;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const data = await r.json();
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
        if (!text) {
          const why = data.promptFeedback?.blockReason || cand?.finishReason || 'unknown reason';
          throw new GeminiError(`Gemini returned an empty answer (${why}).`, 'BLOCKED');
        }
        await usage.record(MODEL(), data.usageMetadata).catch(() => {});
        try {
          const parsed = parseJSON(text.replace(/^```(?:json)?\s*|\s*```\s*$/g, ''), cand && cand.finishReason);
          if (search && parsed && typeof parsed === 'object') {
            const seen = new Set();
            parsed._sources = ((cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [])
              .map(c => c.web).filter(w => w && w.uri && !seen.has(w.title + w.uri) && seen.add(w.title + w.uri))
              .map(w => ({ title: w.title || w.uri, url: w.uri }));
          }
          return parsed;
        } catch (e) {
          console.warn(`Gemini answer unreadable (finish: ${cand && cand.finishReason}, ${text.length} chars): ${text.slice(0, 200)} ... ${text.slice(-200)}`);
          // The same request usually gives the same broken answer; one retry with more variety
          if (!parseRetried) {
            parseRetried = true;
            generationConfig.temperature = Math.min(1, temperature + 0.4);
            continue;
          }
          throw e;
        }
      }
      const errText = await r.text();
      if (r.status === 429 && /per ?day|PerDay|daily/i.test(errText)) {
        throw new GeminiError('Gemini free daily limit reached (20 requests a day on the free tier). It resets every morning around 8 to 9 Italian time. Your progress is saved: press the button again after that.', 'DAILY_LIMIT');
      }
      if ((r.status === 429 || r.status >= 500) && attempt < waits.length) {
        if (r.status === 429) minGap = 13000;
        await sleep(waits[attempt]);
        continue;
      }
      throw new GeminiError(`Gemini error ${r.status}: ${errText.slice(0, 300)}`, 'HTTP');
    }
  });
}

// Reads the AI's answer. If it was cut off (very long answers), everything before the cut is kept.
function parseJSON(text, finishReason) {
  try { return JSON.parse(text); } catch (e) { /* try harder below */ }
  const start = text.search(/[\[{]/);
  const body = start >= 0 ? text.slice(start) : text;
  // an answer with words around the JSON (web search answers sometimes have them)
  const end = text.lastIndexOf(text[start] === '[' ? ']' : '}');
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { /* keep trying */ } }
  try { const v = JSON.parse(jsonrepair(body)); if (v && typeof v === 'object') return v; } catch (e) { /* give up below */ }
  throw new GeminiError(finishReason === 'MAX_TOKENS'
    ? 'The AI answer was too long and got cut off. Try again; long files are analyzed in smaller parts.'
    : 'Could not read the AI answer. Try again.', 'PARSE');
}

module.exports = { generateJSON };

// Small helper for calling the Gemini API with automatic retries.

const usage = require('./usage');

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

async function generateJSON(parts, { temperature = 0.3, images = false } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError('GEMINI_API_KEY is not set on the server.', 'SETUP');
  const base = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
  const url = `${base}/v1beta/models/${MODEL()}:generateContent`;
  const generationConfig = { temperature, responseMimeType: 'application/json', maxOutputTokens: 16000 };
  // Flash doesn't need to "think" for this, which saves tokens and avoids empty answers
  if (/flash/i.test(MODEL())) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  // Small previews are enough to judge a shot and use far fewer tokens
  if (images) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  const body = { contents: [{ role: 'user', parts }], generationConfig, safetySettings: SAFETY };

  return queued(async () => {
    const waits = [15000, 30000, 60000];
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
        return parseJSON(text);
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

function parseJSON(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = text.match(/[\[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new GeminiError('Could not read Gemini answer as JSON.', 'PARSE');
}

module.exports = { generateJSON };

// Small helper for calling the Gemini API with automatic retries.

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One request at a time, so the free tier's per-minute limit is respected.
let chain = Promise.resolve();
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function generateJSON(parts, { temperature = 0.3 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  const base = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
  const url = `${base}/v1beta/models/${MODEL()}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, responseMimeType: 'application/json' },
  };

  return queued(async () => {
    const waits = [4000, 10000, 20000, 40000, 60000];
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const data = await r.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        if (!text) throw new Error('Gemini returned an empty answer.');
        return parseJSON(text);
      }
      const errText = await r.text();
      if ((r.status === 429 || r.status >= 500) && attempt < waits.length) {
        await sleep(waits[attempt]);
        continue;
      }
      throw new Error(`Gemini error ${r.status}: ${errText.slice(0, 300)}`);
    }
  });
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = text.match(/[\[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('Could not read Gemini answer as JSON.');
}

module.exports = { generateJSON };

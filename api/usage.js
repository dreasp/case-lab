// Keeps a running estimate of what the AI (Gemini) has cost this month.
// It's an estimate from Google's published prices; the exact bill is in AI Studio > Spend.

const express = require('express');

// US dollars per 1 million tokens (checked October 2026). Override with GEMINI_PRICE_IN / GEMINI_PRICE_OUT.
const PRICES = {
  'gemini-2.5-flash': { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
  'gemini-2.5-pro': { in: 1.25, out: 10.00 },
};

function priceFor(model) {
  const p = PRICES[model] || PRICES['gemini-2.5-flash'];
  return {
    in: Number(process.env.GEMINI_PRICE_IN) || p.in,
    out: Number(process.env.GEMINI_PRICE_OUT) || p.out,
  };
}

const month = () => new Date().toISOString().slice(0, 7); // e.g. 2026-10
const memory = new Map(); // used when there's no database

let dbFn = null;
let ready = null;
function setDb(fn) { dbFn = fn; }
async function db() {
  const pool = dbFn ? await dbFn() : null;
  if (!pool) return null;
  if (!ready) {
    ready = pool.query(`CREATE TABLE IF NOT EXISTS ai_usage (
      month TEXT PRIMARY KEY,
      requests INT NOT NULL DEFAULT 0,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      cost DOUBLE PRECISION NOT NULL DEFAULT 0
    )`).catch(e => { ready = null; throw e; });
  }
  await ready;
  return pool;
}

// Called after every successful Gemini answer
async function record(model, meta) {
  if (!meta) return;
  const input = meta.promptTokenCount || 0;
  const output = (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
  const p = priceFor(model);
  const cost = (input * p.in + output * p.out) / 1e6;
  const m = month();
  try {
    const pool = await db();
    if (pool) {
      await pool.query(`INSERT INTO ai_usage (month, requests, input_tokens, output_tokens, cost) VALUES ($1, 1, $2, $3, $4)
        ON CONFLICT (month) DO UPDATE SET requests = ai_usage.requests + 1,
          input_tokens = ai_usage.input_tokens + $2, output_tokens = ai_usage.output_tokens + $3, cost = ai_usage.cost + $4`,
      [m, input, output, cost]);
      return;
    }
  } catch (e) { console.warn('Could not save AI usage:', e.message); }
  const cur = memory.get(m) || { requests: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
  cur.requests++; cur.input_tokens += input; cur.output_tokens += output; cur.cost += cost;
  memory.set(m, cur);
}

const router = express.Router();
router.get('/usage', async (req, res) => {
  const m = month();
  let row = null;
  try {
    const pool = await db();
    if (pool) row = (await pool.query('SELECT * FROM ai_usage WHERE month = $1', [m])).rows[0] || null;
  } catch (e) { /* fall back to memory */ }
  row = row || memory.get(m) || { requests: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
  res.json({
    month: m,
    requests: Number(row.requests),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    estimatedUSD: Math.round(Number(row.cost) * 10000) / 10000,
    saved: !!dbFn && !!process.env.DATABASE_URL,
  });
});

module.exports = { router, record, setDb };

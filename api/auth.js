// Simple password gate so strangers can't use your API keys.
const crypto = require('crypto');
const express = require('express');

const router = express.Router();
const COOKIE = 'caselab_auth';
const MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function token() {
  const pw = process.env.APP_PASSWORD || '';
  return crypto.createHmac('sha256', 'case-lab-v1').update(pw).digest('hex');
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function isLoggedIn(req) {
  if (!process.env.APP_PASSWORD) return false;
  const c = readCookie(req, COOKIE);
  if (!c) return false;
  const a = Buffer.from(c), b = Buffer.from(token());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Slow down password guessing
const attempts = new Map();

router.post('/login', (req, res) => {
  const ip = req.ip || 'x';
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
  if (rec.n >= 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });

  if (!process.env.APP_PASSWORD) {
    return res.status(500).json({ error: 'APP_PASSWORD is not set on the server.' });
  }
  const given = String((req.body && req.body.password) || '');
  if (given !== process.env.APP_PASSWORD) {
    rec.n++; attempts.set(ip, rec);
    return res.status(401).json({ error: 'Wrong password.' });
  }
  attempts.delete(ip);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({
    loggedIn: isLoggedIn(req),
    setup: {
      gemini: !!process.env.GEMINI_API_KEY,
      pixabay: !!process.env.PIXABAY_API_KEY,
      password: !!process.env.APP_PASSWORD,
    },
  });
});

function requireLogin(req, res, next) {
  if (isLoggedIn(req)) return next();
  res.status(401).json({ error: 'Please log in.' });
}

module.exports = { router, requireLogin };

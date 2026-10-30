// Case Lab server
// Light work only: login, talking to Gemini / Pixabay / Wikimedia, and passing
// stock footage through to the browser. All heavy video work happens in the browser.

const path = require('path');
const fs = require('fs');
const express = require('express');

// Load a local .env file if there is one (Render uses its Environment tab instead)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const auth = require('./api/auth');
const broll = require('./api/broll');
const cloud = require('./api/cloud');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20mb' }));

// Browser libraries served from node_modules (no CDN needed)
app.get('/vendor/cfb.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/cfb/dist/cfb.min.js')));
app.get('/vendor/mammoth.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/mammoth/mammoth.browser.min.js')));

app.use('/api', auth.router);
app.use('/api', auth.requireLogin, broll.router);
app.use('/api', auth.requireLogin, cloud.router);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Case Lab running on http://localhost:${PORT}`);
  const missing = ['APP_PASSWORD', 'GEMINI_API_KEY', 'PIXABAY_API_KEY'].filter(k => !process.env[k]);
  if (missing.length) console.log('Missing settings: ' + missing.join(', '));
});

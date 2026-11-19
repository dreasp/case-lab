// Posting Shorts to YouTube and Instagram, now or at a set time.
//
// The exported Short is kept in Cloudflare R2 (key "p<project>:s:<short>"). YouTube gets the file
// streamed from R2 and does the scheduling itself (the video is uploaded right away as private with a
// publish time). Instagram can't schedule through its API, so a scheduled Reel waits here and is
// posted by the check that runs every minute while the app is awake (a free pinger keeps it awake).
// TikTok only lets audited apps post publicly, so TikTok is done by hand (download + copy caption).

const crypto = require('crypto');
const express = require('express');
const cloud = require('./cloud');

const router = express.Router();
const IG_V = 'v23.0';
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
const IG_SCOPES = 'instagram_business_basic,instagram_business_content_publish';

// ---------- tables ----------
let ready = null;
async function db() {
  const p = await cloud.db();
  if (!p) return null;
  if (!ready) {
    ready = p.query(`CREATE TABLE IF NOT EXISTS social_accounts (platform TEXT PRIMARY KEY, data JSONB NOT NULL, updated BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS social_posts (
        id SERIAL PRIMARY KEY, platform TEXT NOT NULL, project TEXT NOT NULL, short TEXT NOT NULL, key TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', tags JSONB NOT NULL DEFAULT '[]',
        publish_at BIGINT, status TEXT NOT NULL, link TEXT, error TEXT, remote_id TEXT,
        created BIGINT NOT NULL, updated BIGINT NOT NULL)`).catch(e => { ready = null; throw e; });
  }
  await ready;
  return p;
}
async function getAccount(platform) {
  const p = await db();
  const r = await p.query('SELECT data FROM social_accounts WHERE platform = $1', [platform]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function setAccount(platform, data) {
  const p = await db();
  await p.query(`INSERT INTO social_accounts (platform, data, updated) VALUES ($1, $2, $3)
    ON CONFLICT (platform) DO UPDATE SET data = EXCLUDED.data, updated = EXCLUDED.updated`, [platform, data, Date.now()]);
}

const configured = {
  youtube: () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  instagram: () => !!(process.env.IG_APP_ID && process.env.IG_APP_SECRET),
};
const baseUrl = req => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = (req, platform) => `${baseUrl(req)}/api/social/${platform}/callback`;

async function readJson(r) {
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const msg = j && (j.error_message || (j.error && (j.error.message || j.error_description || j.error)) || j.error_description);
    throw new Error(typeof msg === 'string' ? msg : `Error ${r.status}: ${t.slice(0, 200)}`);
  }
  return j || {};
}

// ---------- connecting the accounts ----------
router.get('/social/status', async (req, res) => {
  try {
    const out = {};
    const hasDb = !!(await db().catch(() => null));
    for (const pf of ['youtube', 'instagram']) {
      const a = hasDb ? await getAccount(pf).catch(() => null) : null;
      out[pf] = { ready: configured[pf]() && hasDb, connected: !!a, name: a ? a.name : '' };
    }
    out.files = cloud.filesReady();
    out.database = hasDb;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/social/:platform/connect', (req, res) => {
  const pf = req.params.platform;
  if (!configured[pf]) return res.status(404).send('Unknown platform');
  if (!configured[pf]()) return res.status(400).send(page(`${pf === 'youtube' ? 'YouTube' : 'Instagram'} is not set up yet. Add the keys on Render first (see the setup steps).`));
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('caselab_oauth', state, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 15 * 60 * 1000 });
  const q = pf === 'youtube'
    ? new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(req, pf), response_type: 'code', scope: GOOGLE_SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state })
    : new URLSearchParams({ client_id: process.env.IG_APP_ID, redirect_uri: redirectUri(req, pf), response_type: 'code', scope: IG_SCOPES, state });
  res.redirect((pf === 'youtube' ? 'https://accounts.google.com/o/oauth2/v2/auth?' : 'https://www.instagram.com/oauth/authorize?') + q);
});

function page(msg, ok = false) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Case Lab</title>
  <body style="font-family:system-ui,sans-serif;background:#141518;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
  <div style="max-width:440px;text-align:center"><p style="font-size:18px">${msg.replace(/</g, '&lt;')}</p><p style="color:#999">You can close this tab.</p></div>
  <script>try{window.opener&&window.opener.postMessage(${JSON.stringify(ok ? 'social-connected' : 'social-failed')},location.origin)}catch(e){}${ok ? 'setTimeout(()=>window.close(),1500)' : ''}</script></body>`;
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

router.get('/social/:platform/callback', async (req, res) => {
  const pf = req.params.platform;
  const name = pf === 'youtube' ? 'YouTube' : 'Instagram';
  try {
    if (!configured[pf]) return res.status(404).send('Unknown platform');
    if (req.query.error) return res.send(page(`${name} was not connected (${req.query.error_description || req.query.error}).`));
    const state = readCookie(req, 'caselab_oauth');
    if (!state || state !== req.query.state) return res.send(page(`${name} was not connected: the link expired. Click Connect again.`));
    res.clearCookie('caselab_oauth');
    const code = String(req.query.code || '');
    if (pf === 'youtube') {
      const t = await readJson(await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(req, pf), grant_type: 'authorization_code' }),
      }));
      if (!t.refresh_token) throw new Error('Google did not give lasting access. Remove Case Lab at myaccount.google.com/permissions and connect again.');
      const ch = await readJson(await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${t.access_token}` } }));
      const c = (ch.items || [])[0];
      if (!c) throw new Error('This Google account has no YouTube channel. Pick the account (or brand account) of your channel.');
      await setAccount('youtube', { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (t.expires_in || 3600) * 1000, id: c.id, name: c.snippet.title });
      return res.send(page(`YouTube is connected (${c.snippet.title}).`, true));
    }
    // Instagram: short-lived token, then the 60-day token
    const t = await readJson(await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.IG_APP_ID, client_secret: process.env.IG_APP_SECRET, grant_type: 'authorization_code', redirect_uri: redirectUri(req, pf), code }),
    }));
    const short = t.access_token || (t.data && t.data[0] && t.data[0].access_token);
    const long = await readJson(await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: process.env.IG_APP_SECRET, access_token: short })}`));
    const me = await readJson(await fetch(`https://graph.instagram.com/${IG_V}/me?${new URLSearchParams({ fields: 'user_id,username', access_token: long.access_token })}`));
    await setAccount('instagram', { access: long.access_token, expires: Date.now() + (long.expires_in || 5184000) * 1000, refreshed: Date.now(), id: String(me.user_id || me.id), name: '@' + me.username });
    res.send(page(`Instagram is connected (@${me.username}).`, true));
  } catch (e) { res.send(page(`${name} was not connected: ${e.message}`)); }
});

router.post('/social/disconnect', async (req, res) => {
  try {
    const pf = String((req.body || {}).platform || '');
    const p = await db();
    const a = await getAccount(pf);
    if (pf === 'youtube' && a && a.refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refresh)}`, { method: 'POST' }).catch(() => {});
    await p.query('DELETE FROM social_accounts WHERE platform = $1', [pf]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fresh access tokens
async function youtubeToken() {
  const a = await getAccount('youtube');
  if (!a) throw new Error('YouTube is not connected.');
  if (a.expires > Date.now() + 120000) return a.access;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: a.refresh, grant_type: 'refresh_token' }),
  });
  if (r.status === 400 || r.status === 401) throw new Error('YouTube access ran out. Click Disconnect, then Connect YouTube again.');
  const t = await readJson(r);
  a.access = t.access_token; a.expires = Date.now() + (t.expires_in || 3600) * 1000;
  await setAccount('youtube', a);
  return a.access;
}
async function instagramToken() {
  const a = await getAccount('instagram');
  if (!a) throw new Error('Instagram is not connected.');
  if (a.expires < Date.now()) throw new Error('Instagram access ran out. Click Disconnect, then Connect Instagram again.');
  // the token lasts 60 days; renew it after a week of use so it never runs out while the app is used
  if (Date.now() - (a.refreshed || 0) > 7 * 86400000) {
    try {
      const t = await readJson(await fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: a.access })}`));
      a.access = t.access_token; a.expires = Date.now() + (t.expires_in || 5184000) * 1000; a.refreshed = Date.now();
      await setAccount('instagram', a);
    } catch (e) { console.warn('Instagram token refresh failed:', e.message); }
  }
  return a;
}

// ---------- posting ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the description with the hashtags under it (YouTube gets #shorts too)
function withTags(post, yt) {
  const tags = (post.tags || []).map(t => String(t).replace(/^#/, ''));
  if (yt && !tags.some(t => /^shorts$/i.test(t))) tags.push('shorts');
  return [post.caption, tags.map(t => '#' + t).join(' ')].filter(Boolean).join('\n\n');
}

async function postYouTube(post) {
  const token = await youtubeToken();
  const src = await fetch(await cloud.signedUrl(post.key, 'GET', {}, 6 * 3600));
  if (!src.ok) throw new Error('The exported Short is not in the cloud any more. Export it again.');
  const size = src.headers.get('content-length');
  const later = post.publish_at && post.publish_at > Date.now() + 60000;
  const meta = {
    snippet: { title: post.title.slice(0, 100), description: withTags(post, true).slice(0, 5000), tags: post.tags.slice(0, 15), categoryId: '22' },
    status: { privacyStatus: later ? 'private' : 'public', selfDeclaredMadeForKids: false, ...(later ? { publishAt: new Date(post.publish_at).toISOString() } : {}) },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', ...(size ? { 'X-Upload-Content-Length': size } : {}) },
    body: JSON.stringify(meta),
  });
  if (!init.ok) { await readJson(init); }
  const where = init.headers.get('location');
  if (!where) throw new Error('YouTube did not accept the upload.');
  const up = await fetch(where, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', ...(size ? { 'Content-Length': size } : {}) }, body: src.body, duplex: 'half' });
  const v = await readJson(up);
  const locked = v.status && v.status.privacyStatus === 'private' && !later;
  return {
    remote_id: v.id, link: `https://youtube.com/shorts/${v.id}`,
    status: later ? 'scheduled-remote' : 'posted',
    note: locked ? 'YouTube kept it private: the Google project needs its free audit before videos can be public.' : null,
  };
}

async function postInstagram(post, mark) {
  const a = await instagramToken();
  const g = (path, params, method = 'GET') => fetch(`https://graph.instagram.com/${IG_V}/${path}${method === 'GET' ? '?' + new URLSearchParams({ ...params, access_token: a.access }) : ''}`, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, access_token: a.access }),
  }).then(readJson);
  const videoUrl = await cloud.signedUrl(post.key, 'GET', {}, 6 * 3600);
  const caption = withTags(post, false).slice(0, 2200);
  const box = await g(`${a.id}/media`, { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true' }, 'POST');
  await mark({ remote_id: box.id });
  // Instagram downloads and processes the video; this usually takes under a minute
  let st = null;
  for (let i = 0; i < 60; i++) {
    await sleep(i < 3 ? 5000 : 10000);
    st = await g(box.id, { fields: 'status_code,status' });
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram could not use the video (${st.status || st.status_code}).`);
  }
  if (!st || st.status_code !== 'FINISHED') throw new Error('Instagram took too long to process the video. Try again.');
  const pub = await g(`${a.id}/media_publish`, { creation_id: box.id }, 'POST');
  let link = null;
  try { link = (await g(pub.id, { fields: 'permalink' })).permalink; } catch (e) { /* fine */ }
  return { remote_id: pub.id, link: link || 'https://www.instagram.com/' + a.name.replace('@', ''), status: 'posted' };
}

const running = new Set();
async function runPost(id) {
  if (running.has(id)) return;
  running.add(id);
  const p = await db();
  try {
    const r = await p.query(`UPDATE social_posts SET status = 'posting', updated = $2, error = NULL WHERE id = $1 AND status IN ('scheduled', 'queued') RETURNING *`, [id, Date.now()]);
    const post = r.rows[0];
    if (!post) return;
    post.publish_at = post.publish_at == null ? null : Number(post.publish_at);
    const mark = fields => p.query(`UPDATE social_posts SET ${Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated = ${Date.now()} WHERE id = $1`, [id, ...Object.values(fields)]);
    try {
      const out = post.platform === 'youtube' ? await postYouTube(post) : await postInstagram(post, mark);
      await mark({ status: out.status, link: out.link, remote_id: out.remote_id, error: out.note || null });
    } catch (e) {
      await mark({ status: 'failed', error: e.message.slice(0, 500) });
    }
  } finally { running.delete(id); }
}

// Every minute: post what's due; posts cut off by a restart are marked so they can be checked
async function tick() {
  const p = await db().catch(() => null);
  if (!p) return;
  try {
    await p.query(`UPDATE social_posts SET status = 'failed', error = 'The app restarted while posting. Check the account before trying again.' WHERE status = 'posting' AND updated < $1`, [Date.now() - 20 * 60000]);
    const due = await p.query(`SELECT id FROM social_posts WHERE status IN ('scheduled', 'queued') AND (publish_at IS NULL OR publish_at <= $1 OR platform = 'youtube') ORDER BY id LIMIT 5`, [Date.now() + 30000]);
    for (const row of due.rows) runPost(row.id);
  } catch (e) { console.warn('Social posting check failed:', e.message); }
}
if (process.env.DATABASE_URL) {
  setTimeout(tick, 5000);
  setInterval(tick, 60000).unref();
}

const PUBLIC = r => ({
  id: r.id, platform: r.platform, project: r.project, short: r.short, title: r.title, publishAt: r.publish_at == null ? null : Number(r.publish_at),
  status: r.status, link: r.link, error: r.error, created: Number(r.created),
});

router.post('/social/posts', async (req, res) => {
  try {
    const p = await db();
    if (!p) return res.status(400).json({ error: 'Cloud saving is not set up.' });
    const { platforms, project, short, title, caption, tags, publishAt } = req.body || {};
    const key = `${project}:s:${short}`;
    if (!cloud.KEY_RE.test(key)) return res.status(400).json({ error: 'Bad request' });
    const at = publishAt ? Number(publishAt) : null;
    if (at && at < Date.now() - 60000) return res.status(400).json({ error: 'That time has already passed.' });
    if (at && at > Date.now() + 120 * 86400000) return res.status(400).json({ error: 'Pick a time within the next 4 months.' });
    const out = [];
    for (const pf of [...new Set(platforms || [])]) {
      if (!configured[pf] || !(await getAccount(pf))) return res.status(400).json({ error: `${pf === 'youtube' ? 'YouTube' : 'Instagram'} is not connected.` });
      const tagList = (Array.isArray(tags) ? tags : []).map(t => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 30);
      const r = await p.query(`INSERT INTO social_posts (platform, project, short, key, title, caption, tags, publish_at, status, created, updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *`,
      [pf, project, short, key, String(title || '').slice(0, 100), String(caption || '').slice(0, 5000), JSON.stringify(tagList), at, at && pf === 'instagram' ? 'scheduled' : 'queued', Date.now()]);
      out.push(PUBLIC(r.rows[0]));
      // YouTube is uploaded right away (it holds the video until the publish time); Instagram waits
      if (!(at && pf === 'instagram' && at > Date.now() + 30000)) runPost(r.rows[0].id);
    }
    res.json({ posts: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/social/posts', async (req, res) => {
  try {
    const p = await db();
    if (!p) return res.json({ posts: [] });
    const r = await p.query('SELECT * FROM social_posts WHERE project = $1 ORDER BY id DESC LIMIT 200', [String(req.query.project || '')]);
    res.json({ posts: r.rows.map(PUBLIC) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancel a scheduled Instagram post, or forget a failed / finished one (nothing is removed from the platforms)
router.post('/social/posts/:id/remove', async (req, res) => {
  try {
    const p = await db();
    await p.query(`DELETE FROM social_posts WHERE id = $1 AND status <> 'posting'`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/social/posts/:id/retry', async (req, res) => {
  try {
    const p = await db();
    const r = await p.query(`UPDATE social_posts SET status = CASE WHEN platform = 'instagram' AND publish_at > $2 THEN 'scheduled' ELSE 'queued' END, error = NULL, updated = $2
      WHERE id = $1 AND status = 'failed' RETURNING id`, [Number(req.params.id), Date.now()]);
    if (r.rows[0]) runPost(r.rows[0].id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A download link for the exported Short (for TikTok, or to post from the phone)
router.post('/social/download-url', async (req, res) => {
  try {
    const { project, short, name } = req.body || {};
    const key = `${project}:s:${short}`;
    if (!cloud.filesReady() || !cloud.KEY_RE.test(key)) return res.status(400).json({ error: 'Bad request' });
    const file = String(name || 'short').replace(/[^\w\s()-]/g, '').trim().slice(0, 80) || 'short';
    res.json({ url: await cloud.signedUrl(key, 'GET', { 'response-content-disposition': `attachment; filename="${file}.mp4"` }, 6 * 3600) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router };

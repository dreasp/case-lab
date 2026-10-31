// Cloud saving: project data in Postgres (Neon), audio and uploaded clips in Cloudflare R2.
// Files go straight from the browser to R2 using short-lived signed links, so large files
// never pass through this server.

const express = require('express');
const { Pool } = require('pg');
const { AwsClient } = require('aws4fetch');

const router = express.Router();

// ---------- database ----------
let pool = null;
let ready = null;
function db() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 3 });
    pool.on('error', e => console.warn('Database connection problem:', e.message));
  }
  if (!ready) {
    // Creates the table the first time, so there is nothing to set up by hand
    ready = pool.query(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      updated BIGINT NOT NULL DEFAULT 0,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_projects (id TEXT PRIMARY KEY, deleted BIGINT NOT NULL)`).catch(e => { ready = null; throw e; });
  }
  return ready.then(() => pool);
}

// ---------- R2 (S3-compatible storage) ----------
function r2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !(R2_ACCOUNT_ID || process.env.R2_ENDPOINT)) return null;
  const endpoint = (process.env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`).replace(/\/$/, '');
  return {
    aws: new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID.trim(), secretAccessKey: R2_SECRET_ACCESS_KEY.trim(), service: 's3', region: 'auto' }),
    base: `${endpoint}/${R2_BUCKET.trim()}`,
  };
}

// Local keys look like "p1a2b3:audio" or "p1a2b3:u:xyz"; in R2 they become "p1a2b3/audio"
const KEY_RE = /^p[a-z0-9]+(:[a-z0-9]+)+$/i;
const objectPath = key => key.split(':').map(encodeURIComponent).join('/');

async function signedUrl(key, method, extra = {}, expires = 3600) {
  const s = r2();
  const url = new URL(`${s.base}/${objectPath(key)}`);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  url.searchParams.set('X-Amz-Expires', String(expires));
  const signed = await s.aws.sign(url.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

// Every stored file under a prefix (handles more than 1,000 files)
async function listAll(prefix) {
  const s = r2();
  if (!s) return [];
  const out = [];
  let token = null;
  do {
    const q = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
    if (prefix) q.set('prefix', prefix);
    if (token) q.set('continuation-token', token);
    const r = await s.aws.fetch(`${s.base}?${q}`);
    const xml = await r.text();
    if (!r.ok) throw new Error('Storage list failed: ' + xml.slice(0, 200));
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1];
      const size = Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
      if (key) out.push({ key: key.replace(/&amp;/g, '&'), size });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] : null;
  } while (token);
  return out;
}

async function deleteObjects(keys) {
  const s = r2();
  if (!s) return 0;
  let n = 0;
  for (const k of keys) {
    const r = await s.aws.fetch(`${s.base}/${k.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
    if (r.ok || r.status === 404) n++;
  }
  return n;
}

router.get('/cloud/status', (req, res) => {
  res.json({ projects: !!process.env.DATABASE_URL, files: !!r2() });
});

router.get('/cloud/projects', async (req, res) => {
  try {
    const p = await db();
    if (!p) return res.json({ projects: [] });
    const { rows } = await p.query(`SELECT id, title, updated, data->>'kind' AS kind,
      (data->>'duration')::float AS duration,
      jsonb_array_length(COALESCE(data->'shots', '[]'::jsonb)) AS shots,
      jsonb_array_length(COALESCE(data->'files', '[]'::jsonb)) AS files
      FROM projects ORDER BY updated DESC`);
    const del = await p.query('SELECT id FROM deleted_projects');
    res.json({ projects: rows.map(r => ({ ...r, updated: Number(r.updated) })), deleted: del.rows.map(r => r.id) });
  } catch (e) { res.status(500).json({ error: 'Database: ' + e.message }); }
});

router.get('/cloud/projects/:id', async (req, res) => {
  try {
    const p = await db();
    if (!p) return res.status(404).json({ error: 'Cloud saving is not set up.' });
    const { rows } = await p.query('SELECT data FROM projects WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ project: rows[0].data });
  } catch (e) { res.status(500).json({ error: 'Database: ' + e.message }); }
});

router.put('/cloud/projects/:id', async (req, res) => {
  try {
    const p = await db();
    if (!p) return res.status(400).json({ error: 'Cloud saving is not set up.' });
    const project = req.body && req.body.project;
    if (!project || project.id !== req.params.id) return res.status(400).json({ error: 'Bad project' });
    // A project deleted on another computer must not come back
    const gone = await p.query('SELECT 1 FROM deleted_projects WHERE id = $1', [project.id]);
    if (gone.rows.length) return res.json({ ok: false, deleted: true });
    // Never let an older copy overwrite a newer one
    const { rows } = await p.query(`INSERT INTO projects (id, title, updated, data) VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated = EXCLUDED.updated, data = EXCLUDED.data
      WHERE projects.updated <= EXCLUDED.updated
      RETURNING updated`, [project.id, String(project.title || ''), Number(project.updated) || Date.now(), project]);
    res.json({ ok: true, stale: !rows.length });
  } catch (e) { res.status(500).json({ error: 'Database: ' + e.message }); }
});

router.delete('/cloud/projects/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^p[a-z0-9]+$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
    const p = await db();
    if (p) {
      await p.query('DELETE FROM projects WHERE id = $1', [id]);
      await p.query('INSERT INTO deleted_projects (id, deleted) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, Date.now()]);
    }
    // Remove every file stored under this project
    if (r2()) await deleteObjects((await listAll(id + '/')).map(o => o.key));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Short-lived links so the browser can upload / download a file directly
router.post('/cloud/file-url', async (req, res) => {
  try {
    if (!r2()) return res.status(400).json({ error: 'File storage is not set up.' });
    const { key, method } = req.body || {};
    if (!KEY_RE.test(String(key || ''))) return res.status(400).json({ error: 'Bad key' });
    res.json({ url: await signedUrl(key, method === 'PUT' ? 'PUT' : 'GET') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Many download links at once (thumbnails for a case with hundreds of photos)
router.post('/cloud/file-urls', async (req, res) => {
  try {
    if (!r2()) return res.status(400).json({ error: 'File storage is not set up.' });
    const urls = {};
    for (const key of ((req.body && req.body.keys) || []).slice(0, 500)) {
      if (KEY_RE.test(String(key))) urls[key] = await signedUrl(key, 'GET', {}, 6 * 3600);
    }
    res.json({ urls });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- big files: uploaded in 50 MB parts, straight from the browser ----------
router.post('/cloud/multipart/start', async (req, res) => {
  try {
    const s = r2();
    const key = String((req.body && req.body.key) || '');
    if (!s || !KEY_RE.test(key)) return res.status(400).json({ error: 'Bad key' });
    const r = await s.aws.fetch(`${s.base}/${objectPath(key)}?uploads`, { method: 'POST' });
    const xml = await r.text();
    const id = (xml.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1];
    if (!r.ok || !id) throw new Error('Could not start upload: ' + xml.slice(0, 200));
    res.json({ uploadId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cloud/multipart/part-urls', async (req, res) => {
  try {
    const { key, uploadId, parts } = req.body || {};
    if (!r2() || !KEY_RE.test(String(key || '')) || !uploadId) return res.status(400).json({ error: 'Bad request' });
    const urls = {};
    for (const n of (parts || []).slice(0, 50)) {
      urls[n] = await signedUrl(key, 'PUT', { partNumber: String(n), uploadId }, 6 * 3600);
    }
    res.json({ urls });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cloud/multipart/complete', async (req, res) => {
  try {
    const s = r2();
    const { key, uploadId, parts } = req.body || {};
    if (!s || !KEY_RE.test(String(key || '')) || !uploadId) return res.status(400).json({ error: 'Bad request' });
    const body = '<CompleteMultipartUpload>' + parts.sort((a, b) => a.n - b.n)
      .map(p => `<Part><PartNumber>${p.n}</PartNumber><ETag>${String(p.etag).replace(/[<>&]/g, '')}</ETag></Part>`).join('') + '</CompleteMultipartUpload>';
    const r = await s.aws.fetch(`${s.base}/${objectPath(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST', body, headers: { 'Content-Type': 'application/xml' } });
    const xml = await r.text();
    if (!r.ok || /<Error>/.test(xml)) throw new Error('Could not finish upload: ' + xml.slice(0, 200));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cloud/multipart/abort', async (req, res) => {
  try {
    const s = r2();
    const { key, uploadId } = req.body || {};
    if (s && KEY_RE.test(String(key || '')) && uploadId) {
      await s.aws.fetch(`${s.base}/${objectPath(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// How much of the free 10 GB is used
router.get('/cloud/storage', async (req, res) => {
  try {
    if (!r2()) return res.json({ ready: false });
    const all = await listAll('');
    const byProject = {};
    for (const o of all) { const id = o.key.split('/')[0]; byProject[id] = (byProject[id] || 0) + o.size; }
    res.json({ ready: true, bytes: all.reduce((n, o) => n + o.size, 0), freeBytes: 10 * 1024 ** 3, byProject });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a case's footage and photos from storage but keep all results
router.post('/cloud/remove-footage', async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '');
    if (!/^p[a-z0-9]+$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
    // analysis copies (x = picture, a = sound) and any uploaded originals (f); thumbnails (t) stay
    const keys = (await listAll(id + '/')).filter(o => /^[^/]+\/(f|x|a)\//.test(o.key));
    const freed = keys.reduce((n, o) => n + o.size, 0);
    await deleteObjects(keys.map(o => o.key));
    res.json({ ok: true, removed: keys.length, freedBytes: freed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check page for the cloud setup
router.get('/cloud/check', async (req, res) => {
  const out = { database: null, files: null };
  try {
    const p = await db();
    if (!p) out.database = 'DATABASE_URL is not set';
    else { const { rows } = await p.query('SELECT count(*)::int AS n FROM projects'); out.database = `ok, ${rows[0].n} projects saved`; }
  } catch (e) { out.database = 'error: ' + e.message; }
  try {
    const s = r2();
    if (!s) out.files = 'R2 settings are missing';
    else {
      const key = 'pcheck:test';
      const put = await fetch(await signedUrl(key, 'PUT'), { method: 'PUT', body: 'ok' });
      const get = put.ok ? await fetch(await signedUrl(key, 'GET')) : null;
      out.files = put.ok && get && get.ok ? 'ok, upload and download work' : `error: upload ${put.status}${put.ok ? '' : ' ' + (await put.text()).slice(0, 200)}`;
      if (put.ok) await s.aws.fetch(`${s.base}/pcheck/test`, { method: 'DELETE' });
    }
  } catch (e) { out.files = 'error: ' + e.message; }
  res.json(out);
});

module.exports = { router, db, signedUrl, listAll, deleteObjects, objectPath, r2, filesReady: () => !!r2(), KEY_RE };

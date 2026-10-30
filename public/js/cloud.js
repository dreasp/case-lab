// Cloud sync: everything is saved in this browser first (instant), then copied to the cloud
// (project data to the database, audio and uploaded clips to file storage). Any computer you
// log in from gets the same projects.

import { store } from './store.js';

let status = null;
let pending = 0;
let lastError = '';
const listeners = new Set();
const timers = new Map();

export function onSync(fn) { listeners.add(fn); fn(syncState()); }
function emit() { const s = syncState(); listeners.forEach(fn => fn(s)); }
export function syncState() {
  if (!status) return { state: 'checking' };
  if (!status.projects) return { state: 'off' };
  if (pending > 0) return { state: 'saving', pending };
  if (lastError) return { state: 'error', error: lastError };
  return { state: 'saved' };
}

async function cloudStatus() {
  if (!status) {
    try {
      const r = await fetch('/api/cloud/status', { credentials: 'same-origin' });
      status = r.ok ? await r.json() : { projects: false, files: false };
    } catch (e) { status = { projects: false, files: false }; }
    emit();
  }
  return status;
}

async function call(path, opts = {}) {
  const r = await fetch('/api/' + path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Cloud error ${r.status}`);
  return data;
}

// Track background work so the page can show "Saving…"
async function track(fn) {
  pending++; emit();
  try { const v = await fn(); lastError = ''; return v; }
  catch (e) { lastError = e.message; console.warn('Cloud save problem:', e); throw e; }
  finally { pending--; emit(); }
}

// ---------- projects ----------
async function pushProject(p) {
  return track(() => call(`cloud/projects/${p.id}`, { method: 'PUT', body: { project: p } }));
}

function schedulePush(p) {
  clearTimeout(timers.get(p.id));
  const copy = JSON.parse(JSON.stringify(p));
  timers.set(p.id, setTimeout(() => {
    timers.delete(p.id);
    pushProject(copy).catch(() => setTimeout(() => schedulePush(copy), 30000));
  }, 1200));
}

// ---------- files ----------
const upMark = key => key + '#cloud';

async function uploadFile(key, blob) {
  return track(async () => {
    const { url } = await call('cloud/file-url', { method: 'POST', body: { key, method: 'PUT' } });
    const r = await fetch(url, { method: 'PUT', body: blob });
    if (!r.ok) throw new Error(`File upload failed (${r.status})`);
    await store.putFile(upMark(key), true);
  });
}

export const cloudStore = {
  async saveProject(p) {
    await store.saveProject(p);
    if ((await cloudStatus()).projects) schedulePush(p);
  },

  async getProject(id) {
    const local = await store.getProject(id);
    if (!(await cloudStatus()).projects) return local;
    try {
      const { project } = await call(`cloud/projects/${id}`);
      if (project && (!local || (project.updated || 0) > (local.updated || 0))) {
        await store.saveProject(project);
        return project;
      }
    } catch (e) { /* offline or not in the cloud yet: use the local copy */ }
    return local;
  },

  async listProjects() {
    const local = await store.listProjects();
    const map = new Map(local.map(p => [p.id, { id: p.id, title: p.title, updated: p.updated, duration: p.duration, shotCount: p.shots.length }]));
    if ((await cloudStatus()).projects) {
      try {
        const { projects, deleted = [] } = await call('cloud/projects');
        // Projects deleted on another computer: remove the copy in this browser too
        for (const id of deleted) if (map.has(id)) { map.delete(id); await store.deleteProject(id); }
        for (const c of projects) {
          const l = map.get(c.id);
          if (!l || (c.updated || 0) > (l.updated || 0)) map.set(c.id, { id: c.id, title: c.title, updated: c.updated, duration: c.duration, shotCount: c.shots });
        }
      } catch (e) { lastError = e.message; emit(); }
    }
    return [...map.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  },

  async deleteProject(id) {
    clearTimeout(timers.get(id));
    await store.deleteProject(id);
    if ((await cloudStatus()).projects) await track(() => call(`cloud/projects/${id}`, { method: 'DELETE' })).catch(() => {});
  },

  // Saves locally right away; the cloud upload continues in the background
  async putFile(key, blob) {
    await store.putFile(key, blob);
    if ((await cloudStatus()).files) uploadFile(key, blob).catch(() => {});
  },

  // Local copy first; otherwise download from the cloud and keep a local copy
  async getFile(key) {
    const local = await store.getFile(key);
    if (local || !(await cloudStatus()).files) return local;
    try {
      return await track(async () => {
        const { url } = await call('cloud/file-url', { method: 'POST', body: { key, method: 'GET' } });
        const r = await fetch(url);
        if (!r.ok) throw new Error(`File download failed (${r.status})`);
        const blob = await r.blob();
        await store.putFile(key, blob);
        await store.putFile(upMark(key), true);
        return blob;
      });
    } catch (e) { return undefined; }
  },
};

// Files a project uses: the narration and anything uploaded with "Upload my own"
function fileKeys(p) {
  const keys = new Set([p.id + ':audio']);
  for (const s of p.shots || []) if (s.choice && s.choice.custom) keys.add(s.choice.custom);
  return [...keys];
}

// Copy anything that only exists in this browser up to the cloud (runs after login)
export async function syncAll() {
  const st = await cloudStatus();
  if (!st.projects) return;
  let cloud = [], deleted = [];
  try { ({ projects: cloud, deleted = [] } = await call('cloud/projects')); } catch (e) { lastError = e.message; emit(); return; }
  const cloudMap = new Map(cloud.map(c => [c.id, c]));
  for (const p of await store.listProjects()) {
    if (deleted.includes(p.id)) { await store.deleteProject(p.id); continue; }
    const c = cloudMap.get(p.id);
    if (!c || (p.updated || 0) > (c.updated || 0)) await pushProject(p).catch(() => {});
    if (!st.files) continue;
    for (const key of fileKeys(p)) {
      if (await store.getFile(upMark(key))) continue;
      const blob = await store.getFile(key);
      if (blob) await uploadFile(key, blob).catch(() => {});
    }
  }
}

// Warn before closing the tab while something is still uploading
window.addEventListener('beforeunload', e => {
  if (pending > 0 || timers.size > 0) { e.preventDefault(); e.returnValue = ''; }
});

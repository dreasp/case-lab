// Saves projects and files in this browser (IndexedDB), so a refresh never loses work.

const DB_NAME = 'case-lab';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        // a short summary of each project, so lists don't have to read every whole project
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch (e) {
    console.warn('Storage problem:', e);
    lastError = e;
    // Chrome has no room left for this site: tell the app once, so it can explain what to do
    if (e && e.name === 'QuotaExceededError' && !fullWarned) { fullWarned = true; try { window.dispatchEvent(new Event('caselab-storage-full')); } catch (x) { /* not in a page */ } }
    return undefined;
  }
}
let lastError = null, fullWarned = false;

// Links to your folders and files live in their own small database, so a problem with the big
// one (full, or damaged) doesn't lose them
let linkDb = null;
function links() {
  if (!linkDb) {
    linkDb = new Promise((resolve, reject) => {
      const req = indexedDB.open('case-lab-links', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('links');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    linkDb.catch(() => { linkDb = null; });
  }
  return linkDb;
}
async function linkTx(mode, fn) {
  try {
    const d = await links();
    return await new Promise((resolve, reject) => {
      const t = d.transaction('links', mode);
      const r = fn(t.objectStore('links'));
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch (e) {
    console.warn('Link storage problem:', e);
    lastError = e;
    return undefined;
  }
}

// Files a project uses: the narration and anything uploaded with "Upload my own"
// (footage cases: the recorded narration and your photos/videos in story scenes)
export function fileKeys(p) {
  const keys = new Set([p.id + ':audio']);
  for (const s of p.shots || []) if (s.choice && s.choice.custom) keys.add(s.choice.custom);
  if (p.kind === 'case') {
    keys.add(`${p.id}:n:narration`);
    for (const s of (p.story && p.story.segments) || []) for (const m of s.media || []) if (m.key) keys.add(m.key);
    for (const sh of p.shorts || []) if (sh.narr && sh.narr.name) keys.add(`${p.id}:n:short${sh.id}`);
  }
  return [...keys];
}
const summary = p => ({ id: p.id, kind: p.kind || 'broll', title: p.title, updated: p.updated, duration: p.duration,
  shotCount: (p.shots || []).length, fileCount: (p.files || []).length, keys: fileKeys(p) });

export const store = {
  saveProject: async p => {
    const r = await tx('projects', 'readwrite', s => s.put(JSON.parse(JSON.stringify(p))));
    await tx('meta', 'readwrite', s => s.put(summary(p)));
    return r;
  },
  getProject: id => tx('projects', 'readonly', s => s.get(id)),
  // Summaries only (fast): { id, kind, title, updated, duration, shotCount, fileCount, keys }
  listProjects: async () => {
    let meta = (await tx('meta', 'readonly', s => s.getAll())) || [];
    const ids = (await tx('projects', 'readonly', s => s.getAllKeys())) || [];
    const have = new Set(meta.map(m => m.id));
    // the first time (or after an older version): make the missing summaries once
    for (const id of ids) {
      if (have.has(id)) continue;
      const p = await tx('projects', 'readonly', s => s.get(id));
      if (!p) continue;
      const m = summary(p);
      await tx('meta', 'readwrite', s => s.put(m));
      meta.push(m);
    }
    const alive = new Set(ids);
    meta = meta.filter(m => alive.has(m.id));
    return meta.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  },
  deleteProject: async id => {
    await tx('projects', 'readwrite', s => s.delete(id));
    await tx('meta', 'readwrite', s => s.delete(id));
    const keys = (await tx('files', 'readonly', s => s.getAllKeys())) || [];
    for (const k of keys) if (String(k).startsWith(id + ':')) await tx('files', 'readwrite', s => s.delete(k));
  },
  putFile: (key, blob) => tx('files', 'readwrite', s => s.put(blob, key)),
  fileKeysAll: () => tx('files', 'readonly', s => s.getAllKeys()),
  deleteFile: key => tx('files', 'readwrite', s => s.delete(key)),
  getFile: key => tx('files', 'readonly', s => s.get(key)),
  putLink: (key, h) => linkTx('readwrite', s => s.put(h, key)),
  getLink: key => linkTx('readonly', s => s.get(key)),
  lastError: () => lastError,
};

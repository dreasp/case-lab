// Saves projects and files in this browser (IndexedDB), so a refresh never loses work.

const DB_NAME = 'case-lab';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
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
    return undefined;
  }
}
let lastError = null;

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

export const store = {
  saveProject: p => tx('projects', 'readwrite', s => s.put(JSON.parse(JSON.stringify(p)))),
  getProject: id => tx('projects', 'readonly', s => s.get(id)),
  listProjects: async () => ((await tx('projects', 'readonly', s => s.getAll())) || [])
    .sort((a, b) => (b.updated || 0) - (a.updated || 0)),
  deleteProject: async id => {
    await tx('projects', 'readwrite', s => s.delete(id));
    const keys = (await tx('files', 'readonly', s => s.getAllKeys())) || [];
    for (const k of keys) if (String(k).startsWith(id + ':')) await tx('files', 'readwrite', s => s.delete(k));
  },
  putFile: (key, blob) => tx('files', 'readwrite', s => s.put(blob, key)),
  getFile: key => tx('files', 'readonly', s => s.get(key)),
  putLink: (key, h) => linkTx('readwrite', s => s.put(h, key)),
  getLink: key => linkTx('readonly', s => s.get(key)),
  lastError: () => lastError,
};

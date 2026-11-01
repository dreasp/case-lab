// Your own photos and videos added to a story scene (shared by the Story and Final video tabs).
// Items: { id, kind: 'photo' | 'video', name, key (uploaded, saved with the case) | caseFile (a case photo) }

let X = null;
const IMG = /\.(jpe?g|png|webp|gif)$/i;
const VID = /\.(mp4|mov|m4v)$/i;
const urlCache = new Map();

export function initMedia(helpers) { X = helpers; }

const newId = () => Math.random().toString(36).slice(2, 10);

// Saves picked files with the case; returns the new items (and names of files that can't be used)
export async function addFiles(caseId, files) {
  const items = [], skipped = [];
  for (const file of files) {
    const isImg = IMG.test(file.name) || /^image\//.test(file.type);
    const isVid = VID.test(file.name);
    if (!isImg && !isVid) { skipped.push(file.name); continue; }
    const id = newId();
    const key = `${caseId}:m:${id}`;
    await X.putFile(key, file);
    items.push({ id, kind: isImg ? 'photo' : 'video', name: file.name, key });
  }
  return { items, skipped };
}

export const casePhotoItem = f => ({ id: newId(), kind: 'photo', name: f.path || f.name, caseFile: f.id });

export async function mediaUrl(it) {
  if (urlCache.has(it.id)) return urlCache.get(it.id);
  let u = null;
  if (it.key) { const b = await X.getFile(it.key); if (b) u = URL.createObjectURL(b); }
  else if (it.caseFile) {
    const f = X.fileById(it.caseFile);
    const local = f ? await X.getLocalFile(f).catch(() => null) : null;
    if (local) u = URL.createObjectURL(local);
    else if (f && f.copyKey) u = (await X.signedUrls([f.copyKey]))[0] || null;
  }
  if (u) urlCache.set(it.id, u);
  return u;
}

export async function mediaBlob(it) {
  if (it.key) return X.getFile(it.key);
  const f = X.fileById(it.caseFile);
  if (!f) return null;
  const local = await X.getLocalFile(f).catch(() => null);
  if (local) return local;
  if (f.copyKey) { const [u] = await X.signedUrls([f.copyKey]); if (u) { const r = await fetch(u); if (r.ok) return r.blob(); } }
  return null;
}

// The thumbnails + add buttons. `scope` identifies the scene (its story segment id).
export function stripHtml(items, scope, casePhotos, hint) {
  const esc = X.esc;
  return `<div class="np-media" data-scope="${scope}">
    ${items.map((it, k) => `<div class="np-thumb" title="${esc(it.name)}">
      <div class="np-thumb-pic" data-thumb="${it.id}"></div>
      <div class="np-thumb-btns">${k ? `<button class="btn ghost" type="button" data-media="left" data-item="${it.id}" title="Show earlier">←</button>` : ''}<button class="btn ghost" type="button" data-media="del" data-item="${it.id}" title="Remove">✕</button></div>
    </div>`).join('')}
    <div class="np-media-add">
      <label class="btn small">+ Add photos or videos<input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mp4,.mov,.m4v" data-media-add hidden></label>
      ${casePhotos.length ? `<select data-case-photo><option value="">+ Add a photo from this case…</option>${casePhotos.map(f => `<option value="${f.id}">${esc(f.path || f.name)}</option>`).join('')}</select>` : ''}
      <span class="muted small-text">${hint || ''}</span>
    </div>
  </div>`;
}

export async function fillThumbs(root, allItems) {
  for (const el of root.querySelectorAll('[data-thumb]')) {
    const it = allItems.find(x => x.id === el.dataset.thumb);
    if (!it || el.dataset.filled) continue;
    el.dataset.filled = '1';
    const u = await mediaUrl(it).catch(() => null);
    if (!u) { el.textContent = 'missing'; continue; }
    el.innerHTML = it.kind === 'video' ? `<video src="${u}#t=0.5" muted preload="metadata"></video><span class="np-vid">▶</span>` : `<img src="${u}" alt="">`;
  }
}

// Photos/videos used to be set on the Final video tab; they now belong to the scene itself
export function migrate(c) {
  const m = c && c.narr && c.narr.media;
  if (!m) return false;
  for (const s of (c.story && c.story.segments) || []) if (m[s.id] && m[s.id].length && !(s.media && s.media.length)) s.media = m[s.id];
  delete c.narr.media;
  return true;
}

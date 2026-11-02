// Footage analysis mode: cases, local footage, analysis copies, transcripts, research.
// Originals stay on your computer (Chrome remembers the case folder). Small analysis copies
// go to the cloud so the AI can watch and listen; all results are saved to the cloud.

import { api, refreshUsage, fmt, esc } from './app.js';
import { cloudStore as store } from './cloud.js';
import { store as localStore } from './store.js';
import { caseChecks } from './checks.js';
import { initStory, renderStory } from './story.js';
import { initFinish, renderFinish } from './finish.js';
import { initMedia } from './media.js';
import { initWords } from './words.js';
import { initLines } from './lines.js';

const $ = id => document.getElementById(id);
const VIDEO_EXT = /\.(mp4|mov|m4v|wmv|avi|mpe?g|mkv|flv|3gp|webm|asf|vob|ts|mts|m2ts)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|wma|ogg|oga|opus|flac|amr)$/i;
const PHOTO_EXT = /\.(jpe?g|png|webp)$/i;
const DOC_EXT = /\.pdf$/i;
// Formats Chrome reads directly; anything else goes through the built-in converter
const NATIVE_VIDEO = /\.(mp4|mov|m4v)$/i;
const NATIVE_AUDIO = /\.(mp3|wav|m4a|aac)$/i;
const AUDIO_DIRECT_MAX = 100 * 1024 * 1024; // bigger recordings are shrunk before uploading
const SINGLE_PUT_MAX = self.__caselabSinglePutMax || 90 * 1024 * 1024; // files above this go up in parts
const PART = 50 * 1024 * 1024;
const WINDOW = 15 * 60; // long videos are analyzed in 15-minute parts (more detail, shorter answers)

let cur = null;            // the open case
let inited = false;
let running = false;
let stopFlag = false;
let activeWorker = null;
const sessionFiles = new Map(); // files added without a folder (only for this session)
const urlCache = new Map();     // storage key -> download link
const live = new Map();         // file id -> live progress text

// 1:53:14 for long recordings, 4:05 for short ones
const fmtH = t => { t = Math.max(0, Math.round(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), x = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const gb = b => (b / 1024 ** 3).toFixed(b < 1024 ** 3 ? 2 : 1) + ' GB';
const mb = b => b >= 1024 ** 3 ? gb(b) : Math.max(0.1, b / 1024 ** 2).toFixed(1) + ' MB';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const kindOf = name => VIDEO_EXT.test(name) ? 'video' : AUDIO_EXT.test(name) ? 'audio' : PHOTO_EXT.test(name) ? 'photo' : DOC_EXT.test(name) ? 'document' : null;
const key = (f, c) => `${cur.id}:${c}:${f.id}`;

// ---------- entry ----------
export async function openFootage() {
  if (!inited) { inited = true; wire(); }
  await refreshCases();
  refreshStorage();
  if (cur) return renderCase();
  const list = await caseList();
  if (list.length) openCase(list[0].id); else showNew();
}

async function caseList() {
  return (await store.listProjects()).filter(p => p.kind === 'case');
}

async function refreshCases() {
  const list = await caseList();
  $('caseList').innerHTML = list.map(p => `
    <li class="${cur && p.id === cur.id ? 'active' : ''}" data-id="${p.id}">
      <strong>${esc(p.title)}</strong>
      <span>${p.fileCount || 0} files</span>
    </li>`).join('') || '<li class="empty">No cases yet</li>';
  $('caseList').querySelectorAll('li[data-id]').forEach(li => li.addEventListener('click', () => openCase(li.dataset.id)));
}

async function refreshStorage() {
  try {
    const s = await api('cloud/storage');
    if (!s.ready) return;
    $('storageBox').classList.remove('hidden');
    const frac = s.bytes / s.freeBytes;
    $('storageFill').style.width = Math.min(100, frac * 100).toFixed(1) + '%';
    $('storageFill').className = frac > 0.9 ? 'full' : frac > 0.7 ? 'warn' : '';
    $("storageText").textContent = `${mb(s.bytes)} of 10 GB free used`;
  } catch (e) { /* not important */ }
}

function showNew() {
  cur = null;
  $('newCasePanel').classList.remove('hidden');
  $('casePanel').classList.add('hidden');
  refreshCases();
}

async function save() {
  if (!cur) return;
  cur.updated = Date.now();
  await store.saveProject(cur);
}

async function openCase(id) {
  if (running && cur && cur.id !== id && !confirm('Analysis is running for this case. Stop it and open the other case?')) return;
  if (running) stop();
  const c = await store.getProject(id);
  if (!c) return showNew();
  cur = c;
  cur.files = cur.files || [];
  renderCase();
  refreshCases();
}

async function renderCase() {
  $('newCasePanel').classList.add('hidden');
  $('casePanel').classList.remove('hidden');
  $('caseTitle').textContent = cur.title;
  $('caseTitle').classList.remove('hidden');
  $('caseTitleEdit').classList.add('hidden');
  renderContext();
  $('folderName').textContent = cur.folderName ? `Folder: ${cur.folderName}` : '';
  renderMeta();
  renderResearch();
  renderStory();
  checkAccess();
  await renderFiles();
}

function renderMeta() {
  const n = t => cur.files.filter(f => f.type === t).length;
  const hours = cur.files.reduce((x, f) => x + (f.duration || 0), 0);
  const done = cur.files.filter(f => f.status === 'done').length;
  const li = document.querySelector(`#caseList li[data-id="${cur.id}"] span`);
  if (li) li.textContent = `${cur.files.length} files`;
  $('caseMeta').textContent = `${n('video')} videos · ${n('audio')} audio · ${n('photo')} photos · ${n('document')} documents` +
    (hours ? ` · ${fmtH(hours)} of footage` : '') + ` · ${done} of ${cur.files.length} analyzed`;
}

// ---------- local footage access ----------
// Chrome remembers the case folder (and dropped files) in this browser's storage.
// (__caselabMemoryHandles is only used by automated tests, whose browser can't store folder links.)
const memHandles = new Map();
const putHandle = (k, h) => (self.__caselabMemoryHandles ? (memHandles.set(k, h), Promise.resolve()) : localStore.putFile(k, h));
const getHandle = k => (self.__caselabMemoryHandles ? Promise.resolve(memHandles.get(k)) : localStore.getFile(k));
async function folderHandle() { return cur ? getHandle(cur.id + ':dir') : null; }

async function checkAccess() {
  const bar = $('accessBar');
  const dir = await folderHandle();
  const needs = cur.files.some(f => !f.handleKey && f.path) && dir;
  if (!dir || !needs) { bar.classList.add('hidden'); return 'granted'; }
  const state = await dir.queryPermission({ mode: 'read' }).catch(() => 'denied');
  if (state === 'granted') { bar.classList.add('hidden'); return state; }
  $('accessText').textContent = `Chrome needs your OK to read the footage in "${dir.name}" (only needed for new analysis and for watching the originals).`;
  bar.classList.remove('hidden');
  return state;
}

async function requestAccess() {
  const dir = await folderHandle();
  if (!dir) return false;
  const st = await dir.requestPermission({ mode: 'read' }).catch(() => 'denied');
  await checkAccess();
  return st === 'granted';
}

// Link an original that the app can't find (added with "Add files" in an earlier session, moved,
// or on a drive that was unplugged): you pick it once, and it's remembered from then on.
async function linkOriginal(f) {
  if (!window.showOpenFilePicker) { alert('Your browser can\'t do this. Please use an up-to-date Chrome.'); return false; }
  let h;
  try { [h] = await window.showOpenFilePicker({ id: 'caselab-footage', multiple: false }); } catch (e) { return false; }
  const file = await h.getFile();
  if (file.name !== f.name && !confirm(`You picked "${file.name}", but the case file is "${f.name}". Use it anyway?`)) return false;
  if (f.size && file.size !== f.size && !confirm(`"${file.name}" is a different size than the file that was analyzed. If it's an edited version, the timing may not match. Use it anyway?`)) return false;
  const key = `${cur.id}:h:${f.id}`;
  await putHandle(key, h);
  f.handleKey = key;
  sessionFiles.set(f.id, file);
  await save();
  return true;
}

async function getLocalFile(f) {
  if (sessionFiles.has(f.id)) return sessionFiles.get(f.id);
  if (f.handleKey) {
    const h = await getHandle(f.handleKey);
    if (h) {
      let st = await h.queryPermission({ mode: 'read' }).catch(() => 'denied');
      if (st !== 'granted') st = await h.requestPermission({ mode: 'read' }).catch(() => 'denied');
      if (st === 'granted') return h.getFile();
    }
  }
  const dir = await folderHandle();
  if (dir && f.path) {
    let st = await dir.queryPermission({ mode: 'read' }).catch(() => 'denied');
    if (st !== 'granted') st = await dir.requestPermission({ mode: 'read' }).catch(() => 'denied');
    if (st !== 'granted') throw new Error('Click "Allow access" so the app can read your footage folder.');
    let h = dir;
    const parts = f.path.split('/');
    for (let i = 0; i < parts.length - 1; i++) h = await h.getDirectoryHandle(parts[i]);
    return (await h.getFileHandle(parts.at(-1))).getFile();
  }
  throw new Error('The original file is not linked on this computer. Choose the case folder again, or add the file again.');
}

async function scanFolder(dir, prefix = '', depth = 0, out = [], skipped = []) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') { if (depth < 5) await scanFolder(h, prefix + name + '/', depth + 1, out, skipped); continue; }
    const type = kindOf(name);
    if (!type) { skipped.push(name); continue; }
    const file = await h.getFile();
    out.push({ name, path: prefix + name, size: file.size, lastModified: file.lastModified, type });
  }
  return { out, skipped };
}

function addRecords(list) {
  let added = 0;
  for (const r of list) {
    const same = cur.files.find(f => (r.path && f.path === r.path) || (f.name === r.name && f.size === r.size));
    if (same) { if (r.handleKey && !same.handleKey) same.handleKey = r.handleKey; if (r.path && !same.path) same.path = r.path; continue; }
    cur.files.push({ id: r.id || newId(), name: r.name, path: r.path || null, handleKey: r.handleKey || null, size: r.size, lastModified: r.lastModified, type: r.type, status: 'new' });
    added++;
  }
  const order = { video: 0, audio: 1, document: 2, photo: 3 };
  cur.files.sort((a, b) => (order[a.type] - order[b.type]) || (a.path || a.name).localeCompare(b.path || b.name, undefined, { numeric: true }));
  return added;
}

async function pickFolder() {
  if (!window.showDirectoryPicker) return alert('Your browser can\'t open folders. Please use an up-to-date Chrome, or use "Add files".');
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'caselab-footage', mode: 'read' }); } catch (e) { return; }
  await putHandle(cur.id + ':dir', dir);
  cur.folderName = dir.name;
  $('folderName').textContent = 'Reading folder…';
  const { out, skipped } = await scanFolder(dir);
  const added = addRecords(out);
  await save();
  await renderCase();
  await refreshCases();
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))); // let the screen update first
  const kinds = [...new Set(skipped.map(n => (n.split('.').pop() || '').toUpperCase()))].slice(0, 6).join(', ');
  const conv = out.filter(r => (r.type === 'video' && !NATIVE_VIDEO.test(r.name)) || (r.type === 'audio' && !NATIVE_AUDIO.test(r.name))).length;
  alert(`Added ${added} file${added === 1 ? '' : 's'} from "${dir.name}".` +
    (conv ? `\n\n${conv} of them (like WMV) will be converted automatically during analysis; that part is a bit slower.` : '') +
    (skipped.length ? `\n\n${skipped.length} file(s) were skipped (${kinds}). Supported: videos (MP4, MOV, WMV, AVI, MPG, MKV...), audio (WAV, MP3, M4A, WMA...), photos (JPG, PNG, WEBP) and PDF documents. iPhone HEIC photos need converting to JPG first.` : ''));
}

async function addFileObjects(files, handles = []) {
  const recs = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const type = kindOf(f.name);
    if (!type) continue;
    const id = newId();
    let handleKey = null;
    if (handles[i]) { handleKey = `${cur.id}:h:${id}`; await putHandle(handleKey, handles[i]); }
    sessionFiles.set(id, f);
    recs.push({ id, name: f.name, size: f.size, lastModified: f.lastModified, type, handleKey });
  }
  // A file that's already in the list keeps its id; remember this session's copy for it too
  for (const r of recs) {
    const same = cur.files.find(x => x.name === r.name && x.size === r.size);
    if (same) sessionFiles.set(same.id, sessionFiles.get(r.id));
  }
  const added = addRecords(recs);
  await save();
  await renderCase();
  await refreshCases();
  return added;
}

// ---------- uploads to cloud storage ----------
function putWithProgress(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x.getResponseHeader('ETag')) : reject(new Error(`Upload failed (${x.status})`)));
    x.onerror = () => reject(new Error('Upload failed (network)'));
    x.send(blob);
  });
}

async function uploadBlob(k, blob, onProgress) {
  if (blob.size <= SINGLE_PUT_MAX) {
    const { url } = await api('cloud/file-url', { key: k, method: 'PUT' });
    await putWithProgress(url, blob, n => onProgress && onProgress(n / blob.size));
    return;
  }
  // Big files go up in 50 MB parts, three at a time
  const { uploadId } = await api('cloud/multipart/start', { key: k });
  const count = Math.ceil(blob.size / PART);
  const loaded = new Array(count + 1).fill(0);
  const report = () => onProgress && onProgress(loaded.reduce((a, b) => a + b, 0) / blob.size);
  const etags = [];
  let next = 1;
  try {
    const lane = async () => {
      while (next <= count) {
        const n = next++;
        const part = blob.slice((n - 1) * PART, n * PART);
        for (let attempt = 0; ; attempt++) {
          try {
            const { urls } = await api('cloud/multipart/part-urls', { key: k, uploadId, parts: [n] });
            const etag = await putWithProgress(urls[n], part, l => { loaded[n] = l; report(); });
            etags.push({ n, etag });
            break;
          } catch (e) { if (attempt >= 2) throw e; await sleep(2000 * (attempt + 1)); }
        }
      }
    };
    await Promise.all([lane(), lane(), lane()]);
    await api('cloud/multipart/complete', { key: k, uploadId, parts: etags });
  } catch (e) {
    api('cloud/multipart/abort', { key: k, uploadId }).catch(() => {});
    throw e;
  }
}

async function signedUrls(keys) {
  const need = keys.filter(k => k && !urlCache.has(k));
  for (let i = 0; i < need.length; i += 400) {
    try {
      const { urls } = await api('cloud/file-urls', { keys: need.slice(i, i + 400) });
      for (const [k, u] of Object.entries(urls)) urlCache.set(k, u);
    } catch (e) { break; }
  }
  return keys.map(k => urlCache.get(k));
}

// ---------- files table ----------
const STATUS = {
  new: 'Not analyzed yet',
  reading: 'Making analysis copy',
  uploading: 'Uploading analysis copy',
  transcribing: 'Transcribing (AssemblyAI)',
  sending: 'Sending to the AI',
  watching: 'AI is watching',
  describing: 'AI is looking',
  converting: 'Converting format',
  reading_doc: 'AI is reading',
  done: 'Analyzed',
  error: 'Problem',
};

async function renderFiles() {
  const rows = cur.files;
  const thumbs = await signedUrls(rows.map(f => f.thumbKey).filter(Boolean));
  void thumbs;
  $('fileRows').innerHTML = rows.map(f => {
    const th = f.thumbKey && urlCache.get(f.thumbKey);
    const icon = th ? `<img class="ftthumb" src="${esc(th)}" alt="" loading="lazy">` : `<div class="fticon">${f.type}</div>`;
    const len = f.duration ? fmtH(f.duration) + ' · ' : '';
    const busy = !['new', 'done', 'error'].includes(f.status);
    const lv = live.get(f.id);
    const st = `<div class="st ${f.status === 'done' ? 'done' : f.status === 'error' ? 'error' : busy ? 'busy' : ''}">${esc(STATUS[f.status] || f.status)}${f.status === 'error' && f.error ? ': ' + esc(f.error) : ''}</div>` +
      (busy && lv ? `<div class="mini-bar"><div style="width:${Math.round((lv.frac || 0) * 100)}%"></div></div>` : '') +
      (f.audioNote && f.type === 'video' ? `<div class="fsub">${esc(f.audioNote)}</div>` : '') +
      (f.skipResearch ? '<div class="fsub">Left out of the research (second camera angle)</div>' : '');
    const desc = f.type === 'photo' ? (f.photo && f.photo.description) : (f.analysis && ((f.type === 'document' && f.analysis.doc_type ? f.analysis.doc_type + ': ' : '') + (f.analysis.summary || '')));
    return `<tr class="${f.status === 'done' ? 'clickable' : ''}" data-id="${f.id}">
      <td>${icon}</td>
      <td><div class="fname">${esc(f.path || f.name)}</div>${desc ? `<div class="fsub">${esc(desc.slice(0, 160))}${desc.length > 160 ? '…' : ''}</div>` : ''}</td>
      <td>${f.type}</td>
      <td class="mono">${len}${mb(f.size || 0)}</td>
      <td>${st}</td>
      <td><button class="btn small ghost" data-act="remove" type="button" title="Remove from this case (your file is not deleted)">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">No files yet. Choose the case folder or drop files here.</td></tr>';
  renderMeta();
  renderChecks();
}

// ---------- checks (no AI: spots duplicates, file-name dates, one person in two places) ----------
function renderChecks() {
  const list = running ? [] : caseChecks(cur);
  const open = list.filter(c => !c.done);
  const html = list.length ? `<div class="checks-head"><strong>${open.length ? `${open.length} thing${open.length > 1 ? 's' : ''} to check` : 'Checks'}</strong><span class="muted small-text">Found by comparing the files, no AI used. Fix these before building the research.</span></div>` +
    list.map(c => `<div class="check ${c.done ? 'ok' : ''}" data-key="${esc(c.key)}">
      <div class="check-title">${esc(c.title)}</div>
      <div class="check-text">${esc(c.done || c.text)}</div>
      <div class="check-btns">${(c.refs || []).map(r => ref(r.file, r.t)).join(' ')}
        ${c.action ? `<button class="btn small" type="button" data-check="act">${esc(c.action.label)}</button>` : ''}
        ${c.undo ? `<button class="btn small ghost" type="button" data-check="undo">${esc(c.undo.label)}</button>` : ''}
        ${c.done ? '' : '<button class="btn small ghost" type="button" data-check="ignore">Ignore</button>'}</div>
    </div>`).join('') : '';
  for (const id of ['caseChecks', 'researchChecks']) {
    $(id).innerHTML = html;
    $(id).classList.toggle('hidden', !list.length);
  }
}

async function onCheckClick(e) {
  const r = e.target.closest('.ref');
  if (r) { const f = fileById(r.dataset.file); if (f) openViewer(f, Number(r.dataset.t) || 0); return; }
  const b = e.target.closest('[data-check]');
  if (!b) return;
  const key = b.closest('.check').dataset.key;
  const c = caseChecks(cur).find(x => x.key === key);
  if (!c) return;
  const step = b.dataset.check === 'act' ? c.action : b.dataset.check === 'undo' ? c.undo : { type: 'ignore' };
  if (step.type === 'skip' || step.type === 'include') {
    const f = fileById(step.file);
    if (f) f.skipResearch = step.type === 'skip';
  } else if (step.type === 'ignore') {
    cur.checksIgnored = [...new Set([...(cur.checksIgnored || []), key])];
  } else if (step.type === 'context') {
    cur.context = ((cur.context || '').trimEnd() + '\n' + step.line).trim();
    renderContext();
    document.querySelector('#caseTabs .tab[data-tab="context"]').click();
    const ta = $('caseContext');
    ta.focus();
    const i = ta.value.lastIndexOf(step.line);
    const blank = step.line.search(/\(date\)|\(time\)|______/);
    if (i >= 0) ta.setSelectionRange(i + Math.max(0, blank), i + Math.max(0, blank) + (blank >= 0 ? (step.line.match(/\(date\)|\(time\)|______/)[0].length) : step.line.length));
  }
  await save();
  renderFiles();
}

let renderTimer = null;
function renderSoon() { clearTimeout(renderTimer); renderTimer = setTimeout(renderFiles, 300); }

// ---------- case context ----------
const CTX = [['who', 'ctxWho', "WHO'S WHO"], ['files', 'ctxFiles', 'WHICH FILE IS WHICH'], ['dates', 'ctxDates', 'DATES AND TIMES'], ['outcome', 'ctxOutcome', 'OUTCOME']];
// Everything the creator wrote (and, unless web is false, the online research), as one text for the AI
function contextText(c, web = true) {
  const k = c.ctx || {};
  const parts = CTX.filter(([key]) => (k[key] || '').trim()).map(([key, , head]) => `${head}:\n${k[key].trim()}`);
  if ((c.context || '').trim()) parts.push(`OTHER NOTES:\n${c.context.trim()}`);
  if (web && (c.webText || '').trim()) parts.push(`ONLINE RESEARCH (found in news and court sources; the creator's notes above win if they disagree):\n${c.webText.trim()}`);
  return parts.join('\n\n');
}
const ownContextLength = c => contextText(c, false).length;

function renderContext() {
  const k = cur.ctx || {};
  for (const [key, id] of CTX) $(id).value = k[key] || '';
  $('caseContext').value = cur.context || '';
  $('webText').value = cur.webText || '';
  $('webText').classList.toggle('hidden', !cur.webText);
  $('webResearch').textContent = cur.webText ? 'Research again' : 'Research the case online';
  $('webStatus').textContent = cur.webAt ? `Researched on ${new Date(cur.webAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. Your edits to this text are saved and used.` : '';
  $('webSources').innerHTML = (cur.webSources || []).length ? `<strong class="small-text">Sources</strong><ol>${cur.webSources.map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join('')}</ol>` : '';
}

async function saveContext() {
  cur.ctx = cur.ctx || {};
  for (const [key, id] of CTX) cur.ctx[key] = $(id).value;
  cur.context = $('caseContext').value;
  if (!$('webText').classList.contains('hidden')) cur.webText = $('webText').value;
  await save();
}

function webToText(r) {
  const L = [];
  const line = (label, v) => { if (v && String(v).trim()) L.push(`${label}: ${String(v).trim()}`); };
  line('Case', r.case_name);
  line('Location', r.location);
  line('What happened', r.summary);
  const v = r.victim || {};
  if (v.name || v.about) L.push(`Victim: ${[v.name, v.age && `age ${v.age}`].filter(Boolean).join(', ')}${v.about ? '. ' + v.about : ''}`);
  const sp = r.suspect || {};
  if (sp.name || sp.background) L.push(`Suspect: ${[sp.name, sp.age && `age ${sp.age}`].filter(Boolean).join(', ')}${sp.background ? '. ' + sp.background : ''}`);
  if ((r.people || []).length) L.push('People:\n' + r.people.map(x => `- ${x.name}: ${x.role}`).join('\n'));
  if ((r.timeline || []).length) L.push('Timeline:\n' + r.timeline.map(x => `- ${x.date}: ${x.what}`).join('\n'));
  const o = r.outcome || {};
  const ol = [['Charges', o.charges], ['Plea or verdict', o.plea_or_verdict], ['Sentence', o.sentence], ['Status', o.status], ['Court dates', o.dates]].filter(x => x[1] && String(x[1]).trim());
  if (ol.length) L.push('Outcome:\n' + ol.map(([a, b]) => `- ${a}: ${b}`).join('\n'));
  if ((r.uncertain || []).length) L.push('Not confirmed or sources disagree:\n' + r.uncertain.map(x => `- ${x}`).join('\n'));
  return L.join('\n\n').replace(/\s*—\s*/g, ', ');
}

async function webResearch() {
  await saveContext();
  if (cur.webText && !confirm('Research again? This replaces the online research text below, including any changes you made to it.')) return;
  const btn = $('webResearch');
  btn.disabled = true;
  $('webStatus').textContent = 'Searching news and court sources… this takes about 30 seconds.';
  try {
    const r = await api('case/web-research', { title: cur.title, notes: contextText(cur, false) });
    const res = r.result || {};
    if (res.found === false || !String(res.summary || '').trim()) {
      $('webStatus').textContent = 'The app could not find this case online. Add more details above (full names, city, state, date) and try again.';
      return;
    }
    cur.webText = webToText(res);
    cur.webSources = r.sources || [];
    cur.webAt = Date.now();
    await save();
    refreshUsage();
    renderContext();
  } catch (e) {
    $('webStatus').textContent = 'Could not research the case: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- analysis ----------
function caseTerms() {
  const terms = new Set();
  for (const line of contextText(cur, false).split(/\r?\n/)) {
    const head = line.split(/[:(–—]| - /)[0];
    for (const part of head.split(/,|\band\b|&/)) { const t = part.trim().replace(/^[-*•\d.)\s]+/, ''); if (t && t.split(/\s+/).length <= 5 && /[A-Za-z]/.test(t)) terms.add(t); }
    for (const m of line.matchAll(/\b([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,3})\b/g)) terms.add(m[1]);
  }
  // Ordinary words that happen to start a sentence aren't names
  const common = /^(the|a|an|this|that|these|those|he|she|they|it|we|i|in|on|at|of|for|to|and|or|but|with|from|by|his|her|their|our|my|is|was|were|are|be|do|not|no|yes|after|before|when|then|there|here|what|who|incident|victim|suspect|witness|note|notes)$/i;
  return [...terms].filter(t => !(t.split(/\s+/).length === 1 && (common.test(t) || t.length < 3))).slice(0, 200);
}

function setStatus(f, status, frac) {
  f.status = status;
  if (frac !== undefined) live.set(f.id, { frac }); else live.delete(f.id);
  renderSoon();
}

function progress(show, frac = 0, text = '') {
  $('caseProgress').classList.toggle('hidden', !show);
  $('caseProgressFill').style.width = Math.round(frac * 100) + '%';
  $('caseProgressText').textContent = text;
}

function makeCopies(file, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker('/js/proxy-worker.js');
    activeWorker = w;
    let thumb = null;
    w.onmessage = ({ data }) => {
      if (data.type === 'thumb') thumb = data.blob;
      else if (data.type === 'progress') onProgress && onProgress(data.frac);
      else if (data.type === 'done') { w.terminate(); activeWorker = null; resolve({ ...data, thumb }); }
      else if (data.type === 'error') { w.terminate(); activeWorker = null; reject(new Error(data.message)); }
    };
    w.onerror = e => { w.terminate(); activeWorker = null; reject(new Error(e.message || 'The analysis copy could not be made')); };
    w.postMessage({ type: 'start', file });
  });
}

async function photoCopies(file) {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('This photo can\'t be opened by Chrome (HEIC photos must be converted to JPG first).'); });
  const make = async max => {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  };
  const out = { copy: await make(1280), thumb: await make(320), width: bmp.width, height: bmp.height };
  bmp.close();
  return out;
}

async function audioDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    const a = new Audio();
    a.preload = 'metadata';
    a.src = url;
    await new Promise((res, rej) => { a.onloadedmetadata = res; a.onerror = () => rej(new Error('This audio file can\'t be played by Chrome.')); setTimeout(res, 15000); });
    return isFinite(a.duration) ? a.duration : 0;
  } finally { URL.revokeObjectURL(url); }
}

// Heavy local work (reading big videos) runs one file at a time
let localLock = Promise.resolve();
function withLocalLock(fn) { const run = localLock.then(fn, fn); localLock = run.catch(() => {}); return run; }

async function converted(file, f, video) {
  setStatus(f, 'converting', 0);
  const { convertForAnalysis } = await import('./convert.js');
  return convertForAnalysis(file, { video, onProgress: fr => { live.set(f.id, { frac: fr }); renderSoon(); } });
}

async function ensureCopies(f) {
  if (f.type === 'video' && f.proxyKey) return;
  if (f.type === 'audio' && f.audioKey) return;
  if (f.type === 'photo' && f.copyKey) return;
  if (f.type === 'document' && f.docKey) return;
  await withLocalLock(async () => {
    if (stopFlag) throw new Error('Stopped');
    const file = await getLocalFile(f);
    if (f.type === 'video') {
      let r;
      if (NATIVE_VIDEO.test(f.name)) {
        setStatus(f, 'reading', 0);
        // If the fast reader can't handle this particular file, the converter takes over
        try { r = await makeCopies(file, fr => { live.set(f.id, { frac: fr }); renderSoon(); }); }
        catch (e) { if (stopFlag) throw e; r = await converted(file, f, true); }
      } else {
        r = await converted(file, f, true);
      }
      setStatus(f, 'uploading', 0);
      const total = r.blob.size + (r.audio ? r.audio.size : 0);
      let done = 0;
      await uploadBlob(key(f, 'x'), r.blob, fr => { live.set(f.id, { frac: (fr * r.blob.size) / total }); renderSoon(); });
      done = r.blob.size;
      if (r.audio) await uploadBlob(key(f, 'a'), r.audio, fr => { live.set(f.id, { frac: (done + fr * r.audio.size) / total }); renderSoon(); });
      if (r.thumb) await uploadBlob(key(f, 't'), r.thumb);
      Object.assign(f, {
        proxyKey: key(f, 'x'), audioKey: r.audio ? key(f, 'a') : null, thumbKey: r.thumb ? key(f, 't') : null,
        duration: r.info.duration, width: r.info.width, height: r.info.height, audioNote: r.info.audioNote || null,
      });
    } else if (f.type === 'audio') {
      let blob = file;
      if (!NATIVE_AUDIO.test(f.name) || file.size > AUDIO_DIRECT_MAX) {
        // Convert unusual formats, and shrink very long recordings, to a small sound copy
        const r = await converted(file, f, false);
        if (!r.audio) throw new Error('No sound could be read from this file.');
        blob = r.audio;
        f.duration = r.info.duration;
      } else {
        f.duration = await audioDuration(file);
      }
      setStatus(f, 'uploading', 0);
      await uploadBlob(key(f, 'a'), blob, fr => { live.set(f.id, { frac: fr }); renderSoon(); });
      f.audioKey = key(f, 'a');
    } else if (f.type === 'document') {
      if (file.size > 45 * 1024 * 1024) throw new Error('This PDF is over 45 MB. Split it into smaller PDFs (for example with ilovepdf.com) and add the parts.');
      setStatus(f, 'uploading', 0);
      await uploadBlob(key(f, 'x'), file, fr => { live.set(f.id, { frac: fr }); renderSoon(); });
      f.docKey = key(f, 'x');
    } else {
      setStatus(f, 'uploading', 0);
      const c = await photoCopies(file);
      await uploadBlob(key(f, 'x'), c.copy);
      await uploadBlob(key(f, 't'), c.thumb);
      Object.assign(f, { copyKey: key(f, 'x'), thumbKey: key(f, 't'), width: c.width, height: c.height });
    }
    await save();
  });
}

async function ensureTranscript(f) {
  if (f.transcript || !f.audioKey) return;
  setStatus(f, 'transcribing');
  if (!f.aai) {
    const r = await api('case/transcribe', { key: f.audioKey, terms: caseTerms() });
    f.aai = { id: r.id, kt: r.keyterms };
    await save();
  }
  const t0 = Date.now();
  for (;;) {
    if (stopFlag) throw new Error('Stopped');
    await sleep(4000);
    const r = await api(`case/transcribe/${f.aai.id}?kt=${f.aai.kt || 0}`);
    if (r.status === 'completed') { f.transcript = { utterances: r.utterances, language: r.language }; break; }
    if (r.status === 'error') { f.aai = null; throw new Error('Transcription failed: ' + r.error); }
    if (Date.now() - t0 > 90 * 60 * 1000) throw new Error('Transcription is taking too long; try again later.');
  }
  await save();
}

async function ensureGeminiFile(f) {
  const fresh = f.gfile && Date.now() - f.gfile.at < 40 * 3600 * 1000;
  if (fresh) {
    const st = await api('case/gemini-file/' + f.gfile.name.split('/').pop());
    if (st.state === 'ACTIVE') return f.gfile;
  }
  setStatus(f, 'sending');
  const up = await api('case/gemini-upload', { key: f.type === 'document' ? f.docKey : f.proxyKey, name: f.name, mime: f.type === 'document' ? 'application/pdf' : 'video/mp4' });
  f.gfile = { name: up.name, uri: up.uri, mime: up.mime, at: Date.now() };
  for (let i = 0; i < 120; i++) {
    const st = await api('case/gemini-file/' + up.name.split('/').pop());
    if (st.state === 'ACTIVE') { await save(); return f.gfile; }
    if (st.state === 'FAILED' || st.state === 'GONE') throw new Error('Gemini could not process this file' + (st.error ? ': ' + st.error : ''));
    await sleep(3000);
  }
  throw new Error('Gemini took too long to prepare the video.');
}

function mergeParts(parts) {
  const out = { clock_start: null, camera: '', speakers: {}, summary: '', events: [], moments: [], people: [], visible_text: [], sensitive: [], uncertain: [] };
  for (const p of parts) {
    if (!p) continue;
    if (!out.clock_start && p.clock_start) out.clock_start = p.clock_start;
    if (!out.camera && p.camera) out.camera = p.camera;
    for (const [k, v] of Object.entries(p.speakers || {})) if (!out.speakers[k] || /speaker|unknown/i.test(out.speakers[k])) out.speakers[k] = v;
    out.summary += (out.summary ? ' ' : '') + (p.summary || '');
    for (const k of ['events', 'moments', 'visible_text', 'sensitive', 'uncertain']) out[k].push(...(Array.isArray(p[k]) ? p[k] : []));
    for (const person of p.people || []) if (!out.people.some(x => x.who === person.who)) out.people.push(person);
  }
  out.events.sort((a, b) => (a.t || 0) - (b.t || 0));
  out.moments.sort((a, b) => (a.start || 0) - (b.start || 0));
  return out;
}

// One stretch of a video. If the AI's answer can't be read, the stretch is tried again in two
// halves; a short stretch that still fails is skipped with a note, so the rest of the file finishes.
const UNREADABLE = /read the AI answer|cut off|empty answer/i;
async function watchPart(f, utterances, from, to) {
  try {
    const r = await api('case/analyze-video', {
      uri: f.gfile.uri, mime: f.gfile.mime, fileName: f.name, duration: f.duration, title: cur.title,
      context: contextText(cur), utterances, from, to,
    });
    return r.result;
  } catch (e) {
    if (stopFlag || !UNREADABLE.test(e.message)) throw e;
    if (to - from > 4 * 60) {
      const mid = Math.round((from + to) / 2);
      const a = await watchPart(f, utterances, from, mid);
      const b = await watchPart(f, utterances, mid, to);
      return mergeParts([a, b]);
    }
    return { uncertain: [`The AI could not read the part from ${fmtH(from)} to ${fmtH(to)}. Watch it yourself; its transcript is still in the Transcript tab.`] };
  }
}

// Puts a quote at the transcript line where it is really said. The AI often gets long times
// wrong, but the transcript times come straight from the audio, so quotes can be placed exactly.
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
function findQuote(f, quote, near) {
  const utt = (f.transcript && f.transcript.utterances) || [];
  const q = words(quote).slice(0, 14);
  if (q.length < 3 || !utt.length) return null;
  let best = null, bestScore = 0;
  for (let i = 0; i < utt.length; i++) {
    // the quote has to start on this line, but can run over into the next one
    const own = new Set(words(utt[i].text));
    if (q.slice(0, 3).filter(x => own.has(x)).length < 2) continue;
    const w = new Set([...own, ...words(utt[i + 1] ? utt[i + 1].text : '')]);
    const score = q.filter(x => w.has(x)).length / q.length;
    if (score > bestScore + 0.001 || (Math.abs(score - bestScore) < 0.001 && best && Math.abs(utt[i].s - near) < Math.abs(best.s - near))) { best = utt[i]; bestScore = score; }
  }
  return bestScore >= 0.6 ? best : null;
}
function snapQuotes(f) {
  const a = f.analysis;
  if (!a || f.type === 'document' || f.type === 'photo') return false;
  let changed = false;
  for (const m of a.moments || []) {
    if (!m.quote) continue;
    const u = findQuote(f, m.quote, m.start);
    if (!u || (m.start >= u.s - 3 && m.start <= u.e + 3)) continue;
    const len = Math.max(3, Math.min(60, (m.end || 0) - (m.start || 0)));
    m.start = u.s;
    m.end = Math.min(f.duration || Infinity, Math.max(u.e, u.s + len));
    changed = true;
  }
  if (changed) a.moments.sort((x, y) => (x.start || 0) - (y.start || 0));
  return changed;
}

async function ensureAnalysis(f) {
  if (f.analysis) return;
  const utterances = (f.transcript && f.transcript.utterances) || [];
  if (f.type === 'document') {
    await ensureGeminiFile(f);
    setStatus(f, 'reading_doc');
    const r = await api('case/analyze-document', { uri: f.gfile.uri, fileName: f.path || f.name, title: cur.title, context: contextText(cur) });
    f.analysis = r.result;
  } else if (f.type === 'audio') {
    setStatus(f, 'watching');
    const r = await api('case/analyze-audio', { title: cur.title, fileName: f.name, duration: f.duration, context: contextText(cur), utterances });
    f.analysis = mergeParts([r.result]);
  } else {
    await ensureGeminiFile(f);
    // Parts saved with a different part length (older version) are redone
    if (f.analysisParts && f.analysisWindow !== WINDOW) f.analysisParts = [];
    f.analysisWindow = WINDOW;
    const parts = f.analysisParts || [];
    const count = Math.max(1, Math.ceil((f.duration || 1) / WINDOW));
    for (let i = parts.length; i < count; i++) {
      if (stopFlag) throw new Error('Stopped');
      setStatus(f, 'watching', i / count);
      parts.push(await watchPart(f, utterances, i * WINDOW, Math.min(f.duration, (i + 1) * WINDOW)));
      f.analysisParts = parts;
      await save();
    }
    f.analysis = mergeParts(parts);
    delete f.analysisParts;
    delete f.analysisWindow;
  }
  snapQuotes(f);
  await save();
}

async function processFile(f) {
  try {
    await ensureCopies(f);
    if (f.type === 'photo') { setStatus(f, 'describing'); return; } // photos are described together
    await ensureTranscript(f);
    await ensureAnalysis(f);
    setStatus(f, 'done');
    f.error = null;
  } catch (e) {
    if (stopFlag) { setStatus(f, f.analysis ? 'done' : 'new'); return; }
    f.error = e.message;
    setStatus(f, 'error');
  }
  await save();
}

async function describePhotos() {
  const todo = cur.files.filter(f => f.type === 'photo' && f.copyKey && !f.photo);
  for (let i = 0; i < todo.length && !stopFlag; i += 16) {
    const batch = todo.slice(i, i + 16);
    batch.forEach(f => setStatus(f, 'describing'));
    try {
      const r = await api('case/photos', { title: cur.title, context: contextText(cur), photos: batch.map(f => ({ id: f.id, key: f.copyKey, name: f.path || f.name })) });
      for (const f of batch) {
        const d = r.results.find(x => String(x.id) === f.id);
        if (d) { f.photo = d; f.status = 'done'; f.error = null; } else { f.status = 'error'; f.error = 'The AI skipped this photo; try again.'; }
      }
    } catch (e) { batch.forEach(f => { f.status = 'error'; f.error = e.message; }); }
    await save();
    renderSoon();
  }
}

async function analyzeAll() {
  if (running) return;
  // Ask for folder access first: Chrome only shows its question right after a click
  if (cur.files.some(f => f.path && !f.handleKey && !f.analysis) && (await checkAccess()) !== 'granted' && !(await requestAccess())) {
    return alert('Case Lab needs your OK to read the footage folder. Click "Analyze all" again and choose "Allow".');
  }
  for (const f of cur.files.filter(x => x.handleKey && x.status !== 'done' && !sessionFiles.has(x.id))) {
    const h = await getHandle(f.handleKey);
    if (h && (await h.queryPermission({ mode: 'read' }).catch(() => 'denied')) !== 'granted') await h.requestPermission({ mode: 'read' }).catch(() => {});
  }
  const todo = cur.files.filter(f => f.status !== 'done' || (f.type === 'photo' && !f.photo));
  if (!todo.length) return alert('Every file is already analyzed. Open the Research tab to build the case document.');
  if (ownContextLength(cur) < 150 && confirm('The Case context is almost empty.\n\nThe AI does much better (and you avoid paying to redo files) when it knows who is who, which file is whose, the real dates and the outcome.\n\nClick OK to fill in the Case context first (recommended), or Cancel to analyze anyway.')) {
    document.querySelector('#caseTabs .tab[data-tab="context"]').click();
    $('ctxWho').focus();
    return;
  }
  const hours = todo.filter(f => f.type === 'video' || f.type === 'audio').reduce((n, f) => n + (f.duration || 0), 0) / 3600;
  const unknownLen = todo.some(f => (f.type === 'video' || f.type === 'audio') && !f.duration);
  if (!confirm(`Analyze ${todo.length} file(s)?\n\nEstimated AI cost: ${unknownLen ? 'about $0.30 to $0.45 per hour of footage' : '$' + (hours * 0.45).toFixed(2) + ' or less'}, plus less than a cent per photo or document.\n\nYou can keep working in other tabs, but keep this tab open. Progress is saved as it goes.`)) return;
  running = true; stopFlag = false;
  $('analyzeAll').disabled = true;
  const total = todo.length;
  const tick = () => {
    const done = todo.filter(f => f.status === 'done' || f.status === 'error').length;
    progress(true, done / total, `${done} of ${total} files · you can use other tabs meanwhile`);
    document.title = `${Math.round(done / total * 100)}% · Analyzing · Case Lab`;
  };
  const timer = setInterval(tick, 1000);
  let release = null;
  try { if (navigator.locks) navigator.locks.request('case-lab-analysis', () => new Promise(r => { release = r; })); } catch (e) { /* not supported */ }
  try {
    // Two files at a time: while one is being read on your computer, the other is with the AI
    const queue = todo.filter(f => f.type !== 'photo');
    const photos = todo.filter(f => f.type === 'photo');
    const lane = async () => { while (queue.length && !stopFlag) await processFile(queue.shift()); };
    const photoLane = async () => { for (const f of photos) { if (stopFlag) break; await processFile(f); } await describePhotos(); };
    await Promise.all([lane(), lane(), photoLane()]);
  } finally {
    clearInterval(timer);
    running = false;
    if (release) release();
    document.title = 'Case Lab';
    progress(false);
    $('analyzeAll').disabled = false;
    live.clear();
    await save();
    renderFiles();
    refreshUsage();
    refreshStorage();
  }
  const errors = cur.files.filter(f => f.status === 'error');
  if (!stopFlag) alert(errors.length ? `Finished, but ${errors.length} file(s) had a problem (shown in red). Press "Analyze all" again to retry them.` : 'All files are analyzed. Open the Research tab and click "Build case research".');
}

function stop() {
  stopFlag = true;
  if (activeWorker) { activeWorker.postMessage({ type: 'cancel' }); }
  import('./convert.js').then(m => m.stopConverter()).catch(() => {});
}

// ---------- research ----------
async function buildMaster() {
  const files = cur.files.filter(f => f.analysis && !f.skipResearch);
  if (!files.length) return alert('Analyze the files first (Files tab).');
  $('buildMaster').disabled = true;
  $('researchBody').innerHTML = '<p class="muted">Putting the case together…</p>';
  if (files.map(snapQuotes).some(Boolean)) await save();
  try {
    const r = await api('case/master', {
      title: cur.title, context: contextText(cur),
      files: files.map(f => f.type === 'document' ? ({
        id: f.id, name: f.path || f.name, type: 'document', docType: f.analysis.doc_type, date: f.analysis.date,
        summary: f.analysis.summary, facts: f.analysis.key_facts, events: f.analysis.timeline, quotes: f.analysis.quotes, uncertain: f.analysis.uncertain,
      }) : ({
        id: f.id, name: f.path || f.name, type: f.type, duration: f.duration, clock: f.analysis.clock_start, camera: f.analysis.camera,
        summary: f.analysis.summary, speakers: speakerMap(f), moments: f.analysis.moments, uncertain: f.analysis.uncertain,
      })),
      photos: cur.files.filter(f => f.photo).map(f => ({ id: f.id, name: f.path || f.name, description: f.photo.description })),
    });
    const m = r.result;
    for (const q of m.key_quotes || []) { const f = fileById(q.file); const u = f && findQuote(f, q.quote, q.t); if (u && !(q.t >= u.s - 3 && q.t <= u.e + 3)) q.t = u.s; }
    cur.master = { ...m, builtAt: Date.now() };
    await save();
    refreshUsage();
  } catch (e) {
    alert('Could not build the research: ' + e.message);
  } finally {
    $('buildMaster').disabled = false;
    renderResearch();
  }
}

const fileById = id => cur.files.find(f => f.id === id);
const fileLabel = id => { const f = fileById(id); return f ? (f.path || f.name) : id; };
const ref = (id, t) => `<span class="ref" data-file="${esc(id)}" data-t="${Number(t) || 0}">${esc(fileLabel(id))} ${fmtH(t || 0)}</span>`;

function renderResearch() {
  const m = cur && cur.master;
  $('buildMaster').textContent = m ? 'Rebuild case research' : 'Build case research';
  $('downloadDoc').disabled = !m;
  if (!m) { $('researchBody').innerHTML = '<p class="muted">After analyzing the files, click "Build case research" to get one document with the whole case in order.</p>'; return; }
  $('researchBody').innerHTML = `
    <section><h3>Overview</h3><p>${esc(m.overview || '')}</p></section>
    <section><h3>People</h3><ul>${(m.people || []).map(p => `<li><strong>${esc(p.name)}</strong>: ${esc(p.role || '')}</li>`).join('')}</ul></section>
    <section><h3>Story beats</h3><ol>${(m.story_beats || []).map(b => `<li><strong>${esc(b.title)}</strong>: ${esc(b.description || '')}<br>${(b.sources || []).map(s => ref(s.file, s.start)).join(' ')}</li>`).join('')}</ol></section>
    <section><h3>Timeline</h3><div class="tl">${(m.timeline || []).map(e => `<div class="when">${esc(e.when || '')}</div><div>${esc(e.what || '')} ${ref(e.file, e.t)}</div>`).join('')}</div></section>
    <section><h3>Key quotes</h3><ul>${(m.key_quotes || []).map(q => `<li><strong>${esc(q.speaker || '')}:</strong> “${esc(q.quote || '')}” ${ref(q.file, q.t)}</li>`).join('')}</ul></section>
    <section><h3>Open questions</h3><ul>${(m.open_questions || []).map(q => `<li>${esc(q)}</li>`).join('')}</ul></section>
    <section><h3>Content warnings</h3><ul>${(m.content_warnings || []).map(q => typeof q === 'string' ? `<li>${esc(q)}</li>` : `<li>${esc(q.note || q.description || '')} ${q.file ? ref(q.file, q.t) : ''}</li>`).join('') || '<li class="muted">None noted</li>'}</ul></section>`;
}

function downloadDoc() {
  const m = cur.master;
  if (!m) return;
  const txt = s => esc(s || '');
  const at = (id, t) => `<i>(${txt(fileLabel(id))} at ${fmtH(t || 0)})</i>`;
  const files = cur.files.filter(f => f.analysis && !f.skipResearch).map(f => f.type === 'document' ? `<h3>${txt(f.path || f.name)}</h3>
    <p><b>${txt(f.analysis.doc_type)}</b>${f.analysis.date ? ` · ${txt(f.analysis.date)}` : ''}</p>
    <p>${txt(f.analysis.summary)}</p>
    <ul>${(f.analysis.key_facts || []).map(x => `<li>${txt(x)}</li>`).join('')}</ul>` : `<h3>${txt(f.path || f.name)}</h3>
    <p><b>${txt(f.analysis.camera)}</b>${f.analysis.clock_start ? ` · starts ${txt(f.analysis.clock_start)}` : ''} · ${fmtH(f.duration || 0)}</p>
    <p>${txt(f.analysis.summary)}</p>
    <ul>${(f.analysis.moments || []).map(mo => `<li>[${fmtH(mo.start)}–${fmtH(mo.end)}] <b>${txt(mo.title)}</b>: ${txt(mo.description)}${mo.quote ? ` “${txt(mo.quote)}”` : ''}</li>`).join('')}</ul>`).join('');
  const html = `<html><head><meta charset="utf-8"><title>${txt(cur.title)}</title>
    <style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}h1{font-size:20pt}h2{font-size:15pt;color:#8b1e1e;margin-top:18pt}h3{font-size:12pt}</style></head><body>
    <h1>${txt(cur.title)}</h1>
    <p><i>Case research generated by Case Lab on ${new Date(m.builtAt || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Check facts against the original footage before publishing.</i></p>
    <h2>Overview</h2><p>${txt(m.overview)}</p>
    <h2>People</h2><ul>${(m.people || []).map(p => `<li><b>${txt(p.name)}</b>: ${txt(p.role)}</li>`).join('')}</ul>
    <h2>Story beats</h2><ol>${(m.story_beats || []).map(b => `<li><b>${txt(b.title)}</b>: ${txt(b.description)} ${(b.sources || []).map(s => at(s.file, s.start)).join(' ')}</li>`).join('')}</ol>
    <h2>Timeline</h2><ul>${(m.timeline || []).map(e => `<li>${e.when ? `<b>${txt(e.when)}</b> ` : ''}${txt(e.what)} ${at(e.file, e.t)}</li>`).join('')}</ul>
    <h2>Key quotes</h2><ul>${(m.key_quotes || []).map(q => `<li><b>${txt(q.speaker)}:</b> “${txt(q.quote)}” ${at(q.file, q.t)}</li>`).join('')}</ul>
    <h2>Open questions</h2><ul>${(m.open_questions || []).map(q => `<li>${txt(q)}</li>`).join('')}</ul>
    <h2>Content warnings</h2><ul>${(m.content_warnings || []).map(q => typeof q === 'string' ? `<li>${txt(q)}</li>` : `<li>${txt(q.note || q.description)} ${q.file ? at(q.file, q.t) : ''}</li>`).join('')}</ul>
    <h2>File by file</h2>${files}
    </body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }));
  a.download = `${cur.title.replace(/[^\w\s-]/g, '').trim() || 'case'} research.doc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---------- file viewer ----------
let vf = null, vTab = 'transcript', vObjUrl = null;

function speakerMap(f) {
  const out = { ...((f.analysis && f.analysis.speakers) || {}) };
  for (const [k, v] of Object.entries(f.speakerNames || {})) out[k] = v;
  return out;
}

async function openViewer(f, t = 0) {
  vf = f;
  const video = $('fvVideo'), img = $('fvImage');
  $('fvName').textContent = f.path || f.name;
  $('fvMeta').textContent = [f.type, f.duration && f.type !== 'document' ? fmtH(f.duration) : '', f.analysis && f.analysis.clock_start ? 'starts ' + f.analysis.clock_start : '', f.analysis && f.analysis.camera].filter(Boolean).join(' · ');
  if (vObjUrl) { URL.revokeObjectURL(vObjUrl); vObjUrl = null; }
  video.classList.toggle('hidden', f.type === 'photo' || f.type === 'document');
  img.classList.toggle('hidden', f.type !== 'photo');
  $('fvSource').textContent = '';
  let src = null;
  try {
    const file = await getLocalFile(f);
    src = vObjUrl = URL.createObjectURL(file);
    $('fvSource').textContent = 'Playing your original file.';
  } catch (e) {
    const k = f.type === 'photo' ? f.copyKey : f.type === 'video' ? f.proxyKey : f.type === 'document' ? f.docKey : f.audioKey;
    if (k) { src = (await signedUrls([k]))[0]; $('fvSource').textContent = f.type === 'video' ? 'Original not available on this computer: showing the low-resolution analysis copy (1 frame per second, no sound).' : 'Original not available on this computer: showing the analysis copy.'; }
  }
  if (f.type === 'document') {
    $('fvSource').innerHTML = src ? `<a href="${esc(src)}" target="_blank" rel="noopener">Open the PDF</a>` : '';
  } else if (f.type === 'photo') img.src = src || ''; else { video.src = src || ''; video.currentTime = t || 0; }
  const a = f.analysis;
  $('fvSummary').innerHTML = f.type === 'photo'
    ? (f.photo ? `<p>${esc(f.photo.description)}</p>${f.photo.text ? `<p class="muted">Text: ${esc(f.photo.text)}</p>` : ''}${f.photo.sensitive ? '<p class="sens">Marked sensitive</p>' : ''}` : '')
    : (a ? `<p>${esc(a.summary)}</p>${(a.uncertain || []).length ? `<p class="muted small-text"><strong>Check:</strong> ${esc(a.uncertain.map(x => typeof x === 'string' ? x : (x && (x.note || x.text || x.what || x.issue || x.description)) || JSON.stringify(x)).join(' · '))}</p>` : ''}` : '');
  $('fvTabs').classList.toggle('hidden', f.type === 'photo' || f.type === 'document');
  vTab = f.transcript ? 'transcript' : 'moments';
  document.querySelectorAll('#fvTabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === vTab));
  renderViewerList();
  $('fileDialog').showModal();
  if (f.type !== 'photo' && t) video.play().catch(() => {});
}

function renderViewerList() {
  const f = vf;
  if (f && f.type === 'document') {
    const a = f.analysis || {};
    $('fvSpeakers').innerHTML = '';
    $('fvList').innerHTML = `
      <h4>${esc(a.doc_type || 'Document')}${a.date ? ' · ' + esc(a.date) : ''}</h4>
      <h4>Key facts</h4>${(a.key_facts || []).map(x => `<div class="line"><span class="tm">•</span><span>${esc(x)}</span></div>`).join('') || '<p class="muted">None</p>'}
      <h4>Timeline</h4>${(a.timeline || []).map(e => `<div class="line wide"><span class="tm">${esc(e.when || '')}</span><span>${esc(e.what || '')}</span></div>`).join('') || '<p class="muted">None</p>'}
      <h4>Quotes</h4>${(a.quotes || []).map(q => `<div class="line"><span class="tm">${q.page ? 'p. ' + esc(q.page) : ''}</span><span><span class="who">${esc(q.who || '')}:</span>“${esc(q.quote || '')}”</span></div>`).join('') || '<p class="muted">None</p>'}
      <h4>People</h4>${(a.people || []).map(x => `<div class="line"><span class="tm"></span><span><span class="who">${esc(x.who || '')}</span> ${esc(x.role || '')}</span></div>`).join('') || '<p class="muted">None</p>'}`;
    return;
  }
  if (!f || f.type === 'photo') { $('fvList').innerHTML = ''; $('fvSpeakers').innerHTML = ''; return; }
  const names = speakerMap(f);
  const letters = [...new Set(((f.transcript && f.transcript.utterances) || []).map(u => u.sp))];
  $('fvSpeakers').innerHTML = vTab === 'transcript' ? letters.map(l => `<span class="spk" data-sp="${esc(l)}" title="Click to rename">${esc(names[l] || 'Speaker ' + l)}</span>`).join('') : '';
  let html = '';
  if (vTab === 'transcript') {
    html = ((f.transcript && f.transcript.utterances) || []).map(u => `<div class="line" data-t="${u.s}"><span class="tm">${fmtH(u.s)}</span><span><span class="who">${esc(names[u.sp] || 'Speaker ' + u.sp)}:</span>${esc(u.text)}</span></div>`).join('') ||
      `<p class="muted">${f.audioKey ? 'No speech found.' : 'No transcript (this file has no usable sound).'}</p>`;
  } else if (vTab === 'moments') {
    html = ((f.analysis && f.analysis.moments) || []).map(m => `<div class="line" data-t="${m.start}"><span class="tm">${fmtH(m.start)}</span><span><span class="imp">${'★'.repeat(Math.max(1, Math.min(5, m.importance || 1)))}</span> <strong>${esc(m.title)}</strong> (${fmtH(m.start)}–${fmtH(m.end)})<br>${esc(m.description || '')}${m.quote ? `<br><em>“${esc(m.quote)}”</em>` : ''}</span></div>`).join('') +
      ((f.analysis && f.analysis.sensitive) || []).map(s => `<div class="line" data-t="${s.start}"><span class="tm">${fmtH(s.start)}</span><span class="sens">Sensitive: ${esc(s.note || '')}</span></div>`).join('');
  } else {
    html = ((f.analysis && f.analysis.events) || []).map(e => `<div class="line" data-t="${e.t}"><span class="tm">${fmtH(e.t)}</span><span>${esc(e.what)}</span></div>`).join('');
  }
  $('fvList').innerHTML = html || '<p class="muted">Nothing yet.</p>';
}

// ---------- wiring ----------
function wire() {
  initLines({ cur: () => cur, save, esc, fmtH, speakerMap });
  initWords({ api, putFile: (k, b) => store.putFile(k, b), getFile: k => store.getFile(k) });
  initMedia({ esc, fileById, getLocalFile, signedUrls, putFile: (k, b) => store.putFile(k, b), putFileSafe: (k, b) => store.putFileSafe(k, b), getFile: k => store.getFile(k) });
  initFinish({ cur: () => cur, save, api, esc, fmtH, fileById, getLocalFile, linkOriginal, signedUrls, speakerMap, checkAccess, requestAccess, refreshUsage, putFile: (k, b) => store.putFile(k, b), putFileSafe: (k, b) => store.putFileSafe(k, b), getFile: k => store.getFile(k) });
  initStory({ cur: () => cur, contextText, save, api, esc, fmtH, fileById, getLocalFile, signedUrls, openViewer, speakerMap, refreshUsage, NATIVE_VIDEO });
  $('newCase').addEventListener('click', () => { if (running) return alert('Wait for the analysis to finish or press Stop first.'); showNew(); $('caseTitleInput').focus(); });
  $('caseCreate').addEventListener('click', async () => {
    const title = $('caseTitleInput').value.trim();
    if (!title) return $('caseTitleInput').focus();
    cur = { id: 'p' + Date.now().toString(36), kind: 'case', title, context: $('caseContextInput').value.trim(), created: Date.now(), updated: Date.now(), files: [], master: null };
    await save();
    $('caseTitleInput').value = ''; $('caseContextInput').value = '';
    renderCase();
    refreshCases();
  });

  // rename
  const startRename = () => { $('caseTitleEditInput').value = cur.title; $('caseTitle').classList.add('hidden'); $('caseTitleEdit').classList.remove('hidden'); $('caseTitleEditInput').select(); };
  $('caseRename').addEventListener('click', startRename);
  $('caseTitle').addEventListener('dblclick', startRename);
  $('caseTitleEdit').addEventListener('submit', async e => {
    e.preventDefault();
    const t = $('caseTitleEditInput').value.trim();
    if (t && t !== cur.title) { cur.title = t; await save(); refreshCases(); }
    renderCase();
  });
  $('caseTitleCancel').addEventListener('click', renderCase);

  // tabs
  document.querySelectorAll('#caseTabs .tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#caseTabs .tab').forEach(x => x.classList.toggle('active', x === b));
    ['files', 'research', 'story', 'final', 'context'].forEach(t => $('ctab-' + t).classList.toggle('hidden', b.dataset.tab !== t));
    if (b.dataset.tab === 'story') renderStory();
    if (b.dataset.tab === 'final') renderFinish();
  }));

  $('webResearch').addEventListener('click', webResearch);
  ['ctxWho', 'ctxFiles', 'ctxDates', 'ctxOutcome', 'caseContext', 'webText'].forEach(id => $(id).addEventListener('change', saveContext));
  $('saveContext').addEventListener('click', async () => {
    await saveContext();
    $('contextSaved').textContent = 'Saved';
    setTimeout(() => { $('contextSaved').textContent = ''; }, 2000);
  });

  $('pickFolder').addEventListener('click', pickFolder);
  $('accessBtn').addEventListener('click', requestAccess);
  $('addFiles').addEventListener('change', async e => { await addFileObjects([...e.target.files]); e.target.value = ''; });

  const dz = $('dropZone');
  const panel = $('ctab-files');
  panel.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  panel.addEventListener('dragleave', e => { if (!panel.contains(e.relatedTarget)) dz.classList.remove('over'); });
  panel.addEventListener('drop', async e => {
    e.preventDefault();
    dz.classList.remove('over');
    const items = [...e.dataTransfer.items].filter(i => i.kind === 'file');
    const handles = await Promise.all(items.map(i => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null)));
    const files = [], hs = [];
    for (let i = 0; i < items.length; i++) {
      const h = handles[i];
      if (h && h.kind === 'directory') {
        const { out } = await scanFolder(h);
        for (const r of out) {
          let d = h; const parts = r.path.split('/');
          for (let j = 0; j < parts.length - 1; j++) d = await d.getDirectoryHandle(parts[j]);
          const fh = await d.getFileHandle(parts.at(-1));
          files.push(await fh.getFile()); hs.push(fh);
        }
      } else {
        const file = items[i].getAsFile();
        if (file) { files.push(file); hs.push(h && h.kind === 'file' ? h : null); }
      }
    }
    const added = await addFileObjects(files, hs);
    if (!added && files.length) alert('Those files are already in this case, or are not a supported type (MP4/MOV, MP3/WAV/M4A, JPG/PNG/WEBP).');
  });

  $('fileRows').addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const f = fileById(tr.dataset.id);
    if (e.target.dataset.act === 'remove') {
      if (running) return alert('Wait for the analysis to finish or press Stop first.');
      if (!confirm(`Remove "${f.name}" from this case? Your file stays on your computer; its analysis is removed.`)) return;
      cur.files = cur.files.filter(x => x !== f);
      await save();
      renderFiles();
      return;
    }
    if (f && f.status === 'done') openViewer(f);
  });

  $('analyzeAll').addEventListener('click', analyzeAll);
  $('caseCancel').addEventListener('click', stop);
  $('buildMaster').addEventListener('click', buildMaster);
  $('downloadDoc').addEventListener('click', downloadDoc);
  $('caseChecks').addEventListener('click', onCheckClick);
  $('researchChecks').addEventListener('click', onCheckClick);
  $('researchBody').addEventListener('click', e => {
    const r = e.target.closest('.ref');
    if (!r) return;
    const f = fileById(r.dataset.file);
    if (f) openViewer(f, Number(r.dataset.t) || 0);
  });

  $('caseFreeSpace').addEventListener('click', async () => {
    if (running) return alert('Wait for the analysis to finish or press Stop first.');
    if (!confirm('Delete this case\'s analysis copies from the cloud to free space?\n\nTranscripts, research and thumbnails stay. Your original files on your computer are not touched. You would only need the copies again to re-analyze a file.')) return;
    try {
      const r = await api('cloud/remove-footage', { id: cur.id });
      for (const f of cur.files) { f.proxyKey = null; f.audioKey = null; f.copyKey = null; f.docKey = null; f.gfile = null; }
      await save();
      refreshStorage();
      alert(`Freed ${mb(r.freedBytes || 0)}.`);
    } catch (e) { alert('Problem: ' + e.message); }
  });

  $('caseDelete').addEventListener('click', async () => {
    if (running) return alert('Wait for the analysis to finish or press Stop first.');
    if (!confirm(`Delete the case "${cur.title}"?\n\nIts transcripts, research and analysis copies are removed everywhere. Your original footage on your computer is NOT deleted.`)) return;
    await store.deleteProject(cur.id);
    cur = null;
    await refreshCases();
    refreshStorage();
    const list = await caseList();
    if (list.length) openCase(list[0].id); else showNew();
  });

  // viewer
  $('fvClose').addEventListener('click', () => $('fileDialog').close());
  $('fvRedo').addEventListener('click', async () => {
    const f = vf;
    if (!f || !f.analysis) return;
    if (running) return alert('Wait for the analysis to finish or press Stop first.');
    const cost = f.type === 'video' ? `about $${Math.max(0.01, (f.duration || 0) / 3600 * 0.45).toFixed(2)}` : 'less than a cent';
    if (!confirm(`Redo the AI notes for "${f.path || f.name}"?\n\nThe transcript is kept, so only the AI part runs again: ${cost}.\nAfter this, click "Analyze all".`)) return;
    delete f.analysis; delete f.analysisParts; delete f.analysisWindow;
    f.status = 'new'; f.error = null;
    await save();
    $('fileDialog').close();
    renderFiles();
  });
  $('fileDialog').addEventListener('close', () => { $('fvVideo').pause(); $('fvVideo').removeAttribute('src'); $('fvVideo').load(); if (vObjUrl) { URL.revokeObjectURL(vObjUrl); vObjUrl = null; } });
  document.querySelectorAll('#fvTabs .tab').forEach(b => b.addEventListener('click', () => {
    vTab = b.dataset.tab;
    document.querySelectorAll('#fvTabs .tab').forEach(x => x.classList.toggle('active', x === b));
    renderViewerList();
  }));
  $('fvList').addEventListener('click', e => {
    const l = e.target.closest('.line');
    if (!l || !vf || vf.type === 'photo') return;
    const v = $('fvVideo');
    v.currentTime = Number(l.dataset.t) || 0;
    v.play().catch(() => {});
  });
  $('fvSpeakers').addEventListener('click', async e => {
    const s = e.target.closest('.spk');
    if (!s || !vf) return;
    const names = speakerMap(vf);
    const name = prompt('Who is this speaker?', names[s.dataset.sp] || '');
    if (name === null) return;
    vf.speakerNames = { ...(vf.speakerNames || {}), [s.dataset.sp]: name.trim() || ('Speaker ' + s.dataset.sp) };
    await save();
    renderViewerList();
  });
  $('fvVideo').addEventListener('timeupdate', () => {
    const t = $('fvVideo').currentTime;
    let best = null;
    document.querySelectorAll('#fvList .line').forEach(l => { const lt = Number(l.dataset.t); l.classList.remove('now'); if (lt <= t + 0.2 && (!best || lt >= Number(best.dataset.t))) best = l; });
    if (best && vTab !== 'moments') { best.classList.add('now'); }
  });

  window.addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });
}

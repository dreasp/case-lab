import { cloudStore as store, syncAll, onSync } from './cloud.js';
import { store as localStore } from './store.js';
import { alignWords, buildCues, setCueText, setCueTime, cueText, toSRT, retimeShots, PRESETS, DEFAULT_STYLE } from './captions.js';
import { readAAF, readAudio, readScript, buildTimeline, wordCountCheck } from './importer.js';
import { Renderer, drawMedia, mediaLayout, frameFor, SIZES, loadVideo, loadImage } from './renderer.js';

const $ = id => document.getElementById(id);
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let project = null;
let audioBlob = null;
let selectedShot = 0;
let cancelFlag = false;
let busy = false;
const objectUrls = new Map();

// ---------- server calls ----------
async function api(path, body) {
  const r = await fetch('/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (r.status === 401 && path !== 'login') { showLogin(); throw new Error('Please log in again.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);
  return data;
}

// ---------- login ----------
function showLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); $('password').focus(); }
function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); }

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('login', { password: $('password').value });
    $('password').value = '';
    await start();
  } catch (err) { $('loginError').textContent = err.message; }
});

$('logout').addEventListener('click', async () => { await api('logout', {}).catch(() => {}); showLogin(); });

async function start() {
  const me = await api('me');
  if (!me.loggedIn) return showLogin();
  showApp();
  // Ask the browser to keep this site's saved projects even when disk space runs low
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* not supported */ }
  const missing = [];
  if (!me.setup.gemini) missing.push('GEMINI_API_KEY');
  if (!me.setup.pixabay) missing.push('PIXABAY_API_KEY');
  $('setupWarning').classList.toggle('hidden', !missing.length);
  $('setupWarning').textContent = missing.length ? `Missing on the server: ${missing.join(', ')}. Add them in Render > Environment.` : '';
  await refreshProjects();
  // Copy anything saved only in this browser up to the cloud
  syncAll().then(refreshProjects).catch(() => {});
  refreshUsage();
  const list = await store.listProjects();
  if (list.length) await openProject(list[0].id); else showImport();
}

// ---------- modes ----------
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.mode').forEach(x => x.classList.toggle('active', x === b));
  $('mode-broll').classList.toggle('hidden', b.dataset.mode !== 'broll');
  $('mode-footage').classList.toggle('hidden', b.dataset.mode !== 'footage');
}));

// ---------- project list ----------
async function refreshProjects() {
  const list = await store.listProjects();
  $('projectList').innerHTML = list.map(p => `
    <li class="${project && p.id === project.id ? 'active' : ''}" data-id="${p.id}">
      <strong>${esc(p.title)}</strong>
      <span>${fmt(p.duration)} · ${p.shotCount} shots</span>
    </li>`).join('') || '<li class="empty">No projects yet</li>';
  $('projectList').querySelectorAll('li[data-id]').forEach(li => li.addEventListener('click', () => openProject(li.dataset.id)));
}

$('newProject').addEventListener('click', () => { renderer.stop(); project = null; showImport(); refreshProjects(); });

function showImport() {
  $('importPanel').classList.remove('hidden');
  $('projectPanel').classList.add('hidden');
  $('importStatus').textContent = '';
}

async function save() {
  if (!project) return;
  project.updated = Date.now();
  await store.saveProject(project);
}

// ---------- import ----------
let audioFile = null, scriptFile = null;
function setupDrop(dropId, inputId, nameId, set) {
  const drop = $(dropId), input = $(inputId);
  const take = f => { if (!f) return; set(f); $(nameId).textContent = f.name; drop.classList.add('filled'); checkImport(); };
  input.addEventListener('change', () => take(input.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files[0]); });
}
setupDrop('audioDrop', 'audioFile', 'audioName', f => { audioFile = f; });
setupDrop('scriptDrop', 'scriptFile', 'scriptName', f => {
  scriptFile = f;
  if (!$('titleInput').value) $('titleInput').value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+-\s+/g, ': ').trim();
});
function checkImport() { $('importBtn').disabled = !(audioFile && scriptFile); }

$('importBtn').addEventListener('click', async () => {
  const status = $('importStatus');
  $('importBtn').disabled = true;
  try {
    status.textContent = 'Reading narration…';
    const audio = /\.aaf$/i.test(audioFile.name) ? await readAAF(audioFile) : await readAudio(audioFile);
    status.textContent = 'Reading script…';
    const paragraphs = await readScript(scriptFile);
    if (!paragraphs.length) throw new Error('The script file looks empty.');
    const { sentences, shots, matched } = buildTimeline(paragraphs, audio.clips, audio.duration);
    const fit = wordCountCheck(paragraphs, audio.clips);

    const id = 'p' + Date.now().toString(36);
    project = {
      id, title: $('titleInput').value.trim() || 'Untitled', created: Date.now(), updated: Date.now(),
      duration: audio.duration, paragraphs, clips: audio.clips, sentences, shots,
      timing: matched ? 'paragraphs' : 'estimated',
      aspect: $('formatInput').value === '9:16' ? '9:16' : '16:9',
      note: audio.clips
        ? (matched
          ? `${paragraphs.length} paragraphs matched to ${audio.clips.length} ElevenLabs clips${fit !== null && fit < 0.8 ? ' (lengths look uneven, check the order)' : ''}.`
          : `The script has ${paragraphs.length} paragraphs but the audio has ${audio.clips.length} clips, so timings are estimated.`)
        : 'Timings estimated from text length (upload the AAF for paragraph-accurate timing).',
    };
    await store.putFile(id + ':audio', audio.audio);
    await save();
    audioFile = scriptFile = null;
    ['audioName', 'scriptName'].forEach(n => { $(n).textContent = 'Click or drop a file'; });
    document.querySelectorAll('.drop').forEach(d => d.classList.remove('filled'));
    $('titleInput').value = '';
    status.textContent = '';
    await openProject(id);
  } catch (e) {
    status.textContent = 'Problem: ' + e.message;
    $('importBtn').disabled = false;
  }
});

// ---------- open project ----------
async function openProject(id) {
  renderer.stop();
  const p = await store.getProject(id);
  if (!p) return showImport();
  project = p;
  $('projectPanel').classList.add('hidden');
  $('importPanel').classList.add('hidden');
  audioBlob = await store.getFile(id + ':audio');
  if (!audioBlob) alert('The narration audio for this project could not be found on this computer or in the cloud.');
  for (const u of objectUrls.values()) URL.revokeObjectURL(u);
  objectUrls.clear();
  renderer.setProject(project.shots, audioBlob);
  applyAspect();
  selectedShot = 0;
  $('importPanel').classList.add('hidden');
  $('projectPanel').classList.remove('hidden');
  renderHeader();
  renderShots();
  renderCaptions();
  refreshProjects();
  clearCanvas();
  if (project.shots.some(s => s.choice)) renderer.showFrame(0).catch(() => {});
}

function renderHeader() {
  $('projectTitle').textContent = project.title;
  $('projectTitle').classList.remove('hidden');
  $('titleEdit').classList.add('hidden');
  const empty = project.shots.filter(s => !s.choice).length;
  $('projectMeta').textContent = `${fmt(project.duration)} · ${project.sentences.length} sentences · ${project.shots.length} shots` +
    (empty ? ` · ${empty} need footage` : '') + ' · ' + project.note;
  $('timeLabel').textContent = `0:00 / ${fmt(project.duration)}`;
  document.querySelectorAll('#formatSeg button').forEach(b => b.classList.toggle('active', b.dataset.aspect === aspectOf()));
  const anyPicked = project.sentences.some(s => s.pick);
  $('findBtn').textContent = anyPicked ? 'Find footage again for empty shots' : 'Find footage automatically';
}

$('deleteProject').addEventListener('click', async () => {
  if (!project || !confirm(`Delete "${project.title}"?\n\nIt will be removed everywhere, including the cloud copy and your uploaded clips. Videos you already exported stay on your computer.`)) return;
  renderer.stop();
  await store.deleteProject(project.id);
  project = null;
  await refreshProjects();
  const list = await store.listProjects();
  if (list.length) openProject(list[0].id); else showImport();
});

// ---------- shot list ----------
function sentenceOf(shot) { return project.sentences.find(s => s.id === shot.sid); }

function thumbFor(choice) {
  if (!choice) return '';
  if (choice.custom) return objectUrls.get(choice.custom) || '';
  return choice.thumb;
}

async function ensureCustomUrls() {
  for (const s of project.shots) {
    const c = s.choice;
    if (c && c.custom && !objectUrls.has(c.custom)) {
      const blob = await store.getFile(c.custom);
      if (blob) objectUrls.set(c.custom, URL.createObjectURL(blob));
    }
  }
}

async function renderShots() {
  await ensureCustomUrls();
  $('shotList').innerHTML = project.shots.map((shot, i) => {
    const sen = sentenceOf(shot);
    const c = shot.choice;
    const kind = !c ? 'none' : (c.auto ? 'ai' : 'you');
    const th = thumbFor(c);
    const media = !c ? '<div class="thumb empty">No footage</div>'
      : (c.custom && c.type === 'video'
        ? `<video class="thumb" src="${th}" muted preload="metadata"></video>`
        : `<img class="thumb" src="${esc(th)}" alt="" loading="lazy">`);
    const ed = shot.edit || {};
    const edited = [];
    if (ed.start) edited.push(`starts at ${fmt(ed.start)}`);
    if (ed.frames && ed.frames[aspectOf()]) edited.push('framed');
    const why = sen && sen.pick && sen.pick.why && c && c.auto ? `<span class="why">${esc(sen.pick.why)}</span>` : '';
    const src = c ? `<span class="src">${c.custom ? 'Your file' : esc(c.source)} · ${c.type}</span>` : '';
    return `<li class="shot ${kind} ${i === selectedShot ? 'selected' : ''}" data-i="${i}">
      <div class="shot-time mono">${fmt(shot.start)}</div>
      <div class="shot-media">${media}<span class="dot ${kind}"></span></div>
      <div class="shot-body">
        <p>${shot.part > 0 ? '<em class="cont">continued</em> ' : ''}${esc(sen ? sen.text : '')}</p>
        <div class="shot-meta">${src}${edited.length ? `<span class="edited">${edited.join(', ')}</span>` : ''}${why}</div>
      </div>
      <div class="shot-actions">
        <button class="btn small" data-act="swap">Swap</button>
        ${c ? '<button class="btn small ghost" data-act="edit">Adjust</button>' : ''}
        <button class="btn small ghost" data-act="play">▶ From here</button>
      </div>
    </li>`;
  }).join('');
}

$('shotList').addEventListener('click', e => {
  const li = e.target.closest('li.shot');
  if (!li) return;
  const i = +li.dataset.i;
  const act = e.target.dataset.act;
  selectShot(i);
  if (act === 'swap') openSwap(i);
  else if (act === 'edit') openEditor(i);
  else if (act === 'play') playFrom(project.shots[i].start);
  else if (!renderer.running) renderer.showFrame(project.shots[i].start + 0.01).catch(() => {});
});

function selectShot(i) {
  selectedShot = i;
  document.querySelectorAll('#shotList li.shot').forEach(li => li.classList.toggle('selected', +li.dataset.i === i));
}

// ---------- player ----------
const renderer = new Renderer($('canvas'), {
  mediaUrl: shot => mediaSources(shot.choice),
  getCaptions: () => {
    const c = project && project.captions;
    if (!c || !c.show) return null;
    return { cues: c.cues[aspectOf()], style: c.style[aspectOf()] };
  },
  onTime: (t, i) => {
    $('timeLabel').textContent = `${fmt(t)} / ${fmt(project ? project.duration : 0)}`;
    markActiveCue(t);
    if (i !== selectedShot && renderer.running) {
      selectShot(i);
      const li = document.querySelector(`#shotList li[data-i="${i}"]`);
      if (li && !$('exportBtn').disabled) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  },
  onState: s => {
    $('playerState').textContent = { loading: 'Loading footage…', buffering: 'Waiting for footage…', playing: '', recording: 'Recording', stopped: '' }[s] || '';
  },
});

function clearCanvas() {
  const c = $('canvas'), x = c.getContext('2d');
  x.fillStyle = '#0b0b0d';
  x.fillRect(0, 0, c.width, c.height);
}

// ---------- format: 16:9 long form or 9:16 Short ----------
function aspectOf() { return (project && project.aspect) || '16:9'; }

function applyAspect() {
  renderer.setAspect(aspectOf());
  $('viewer').classList.toggle('portrait', aspectOf() === '9:16');
  clearCanvas();
}

document.querySelectorAll('#formatSeg button').forEach(b => b.addEventListener('click', async () => {
  if (!project || busy || b.dataset.aspect === aspectOf()) return;
  renderer.stop();
  project.aspect = b.dataset.aspect;
  await save();
  applyAspect();
  renderHeader();
  renderCaptions();
  await renderShots();
  renderer.showFrame(project.shots[selectedShot]?.start + 0.01 || 0).catch(() => {});
}));

async function mediaUrl(choice) {
  if (!choice) return null;
  if (choice.custom) {
    if (!objectUrls.has(choice.custom)) {
      const blob = await store.getFile(choice.custom);
      if (!blob) return null;
      objectUrls.set(choice.custom, URL.createObjectURL(blob));
    }
    return objectUrls.get(choice.custom);
  }
  // Pixabay links expire, so fetch a fresh one when the saved link is older than 20 hours
  if (choice.source === 'Pixabay' && (!choice.fetchedAt || Date.now() - choice.fetchedAt > 20 * 3600 * 1000)) {
    try {
      const r = await api('refresh', { type: choice.type, id: choice.id });
      if (r.url) { choice.url = r.url; choice.urlSmall = r.url; choice.fetchedAt = Date.now(); save(); }
    } catch (e) { /* try the old link */ }
  }
  const u = choice.type === 'video' ? (choice.urlSmall || choice.url) : choice.url;
  return '/api/media?u=' + encodeURIComponent(u) + (choice.fallback ? '&f=' + encodeURIComponent(choice.fallback) : '');
}

// Addresses to try for a clip: straight from the stock site first (fast, no server limits),
// then through our server, then through our server again after a short pause.
async function mediaSources(choice) {
  if (!choice) return null;
  const proxied = await mediaUrl(choice);
  if (!proxied) return null;
  if (choice.custom) return [{ url: proxied }];
  const direct = choice.type === 'video' ? (choice.urlSmall || choice.url) : choice.url;
  const list = [];
  if (direct) list.push({ url: direct });
  list.push({ url: proxied }, { url: proxied + '&retry=1', delay: 2500 });
  return list;
}

// Plain-language reason when a clip won't load
async function whyNotLoading(choice) {
  if (choice.custom) return 'Chrome could not open this file right now. Close this window and try again. If it keeps happening, the file may be too large (4K) or in a format Chrome can\'t read: download the Full HD MP4 version (on Pexels, pick 1920x1080) and upload that instead.';
  try {
    const r = await fetch(await mediaUrl(choice), { headers: { Range: 'bytes=0-1' } });
    if (r.status === 429) return 'The stock site is limiting requests right now. Wait a minute and try again.';
    if (r.status === 404 || r.status === 410) return 'This clip has been removed from the stock site. Please swap it for another one.';
    if (!r.ok) return `The stock site answered with an error (${r.status}). Try again in a minute, or swap the clip.`;
  } catch (e) { /* fall through */ }
  return 'This video could not be loaded. Try again in a minute, or swap the clip.';
}

async function playFrom(t) {
  if (!project || busy) return;
  try { await renderer.play(t); } catch (e) { alert('Playback problem: ' + e.message); }
}
$('playBtn').addEventListener('click', () => playFrom(project.shots[selectedShot]?.start || 0));
$('stopBtn').addEventListener('click', () => renderer.stop());

// ---------- progress ----------
function progress(show, frac = 0, text = '') {
  $('progressWrap').classList.toggle('hidden', !show);
  $('progressFill').style.width = Math.round(frac * 100) + '%';
  $('progressText').textContent = text;
}
$('cancelBtn').addEventListener('click', () => { cancelFlag = true; renderer.stop(); if (exportWorker) exportWorker.postMessage({ type: 'cancel' }); });

function setBusy(b) {
  busy = b;
  ['findBtn', 'exportBtn', 'playBtn', 'deleteProject', 'newProject'].forEach(id => { $(id).disabled = b; });
}

// ---------- automatic footage finding ----------
$('findBtn').addEventListener('click', findFootage);

async function findFootage() {
  if (!project || busy) return;
  renderer.stop();
  setBusy(true);
  cancelFlag = false;
  const script = project.paragraphs.join('\n\n');
  const sourceErrors = new Set();
  try {
    // Re-run only for sentences whose shots are still empty and were not chosen by hand
    const needs = s => project.shots.some(sh => sh.sid === s.id && !sh.choice && !sh.leftEmpty);
    if (project.sentences.some(s => s.pick)) {
      // Keep the search terms (no extra AI cost), search again and let the AI pick again
      for (const s of project.sentences) if (needs(s)) { delete s.pick; delete s.candidates; }
    }
    const todo = () => project.sentences.filter(s => !s.pick);
    const total = Math.max(1, todo().length);

    // 1) search terms
    let list = todo().filter(s => !s.plan);
    for (let i = 0; i < list.length && !cancelFlag; i += 100) {
      progress(true, 0.05, `Writing search terms with AI (${Math.min(i + 100, list.length)} of ${list.length})…`);
      const batch = list.slice(i, i + 100);
      const r = await api('plan', { title: project.title, script, shots: batch.map(s => ({ id: s.id, text: s.text })) });
      for (const p of r.shots) { const s = project.sentences.find(x => x.id === p.id); if (s) s.plan = p; }
      await save();
    }

    // 2) stock searches
    list = todo().filter(s => s.plan && !s.candidates);
    for (let i = 0; i < list.length && !cancelFlag; i += 4) {
      progress(true, 0.1 + 0.5 * i / list.length, `Searching Pixabay and Wikimedia (${Math.min(i + 4, list.length)} of ${list.length})…`);
      const batch = list.slice(i, i + 4);
      const r = await api('candidates', { shots: batch.map(s => ({ id: s.id, ...s.plan })) });
      for (const err of r.errors || []) sourceErrors.add(err);
      const now = Date.now();
      for (const s of batch) s.candidates = (r.results[s.id] || []).map(c => ({ ...c, fetchedAt: now }));
      await save();
    }

    // 3) AI picks the best match from the thumbnails
    list = todo().filter(s => s.candidates);
    const groups = [];
    let g = [], imgs = 0;
    for (const s of list) {
      // Big batches: the free Gemini tier only allows 20 requests a day
      if (g.length && imgs + s.candidates.length > 110) { groups.push(g); g = []; imgs = 0; }
      g.push(s); imgs += s.candidates.length;
    }
    if (g.length) groups.push(g);
    let done = 0;
    for (const grp of groups) {
      if (cancelFlag) break;
      progress(true, 0.6 + 0.38 * done / list.length, `AI is looking at the footage (${done + grp.length} of ${list.length} sentences)…`);
      const withCands = grp.filter(s => s.candidates.length);
      if (withCands.length) {
        const r = await api('pick', {
          title: project.title,
          shots: withCands.map(s => ({ id: s.id, text: s.text, duration: s.end - s.start, candidates: s.candidates })),
        });
        for (const s of withCands) s.pick = r.picks[s.id] || { best: -1, alt: -1, why: '' };
        if (r.warning) sourceErrors.add(r.warning);
      }
      for (const s of grp) if (!s.candidates.length) s.pick = { best: -1, alt: -1, why: 'Nothing found on the stock sites' };
      done += grp.length;
      assignShots();
      await save();
      renderShots();
    }

    assignShots();
    await save();
    progress(false);
    renderHeader();
    renderShots();
    renderer.setProject(project.shots, audioBlob);
    if (cancelFlag) return;
    const empty = project.shots.filter(s => !s.choice).length;
    void total;
    if (sourceErrors.size) {
      alert('Some footage searches failed:\n\n' + [...sourceErrors].slice(0, 3).join('\n') +
        '\n\nOpen /api/check on your site and send a screenshot so this can be fixed.');
    }
    alert(empty ? `Done. ${empty} shots still need footage (marked red). Use Swap to search or upload your own.` : 'Done. Every shot has footage. Press Play to watch.');
    renderer.showFrame(0).catch(() => {});
  } catch (e) {
    progress(false);
    alert('Stopped: ' + e.message + '\n\nYour progress is saved. Press the button again to continue.');
  } finally {
    setBusy(false);
    renderHeader();
    refreshUsage();
  }
}

function assignShots() {
  const used = new Map(); // candidate key -> last shot index using it
  project.shots.forEach((shot, i) => {
    if (shot.choice && !shot.choice.auto) { if (shot.choice.key) used.set(shot.choice.key, i); return; }
    if (shot.leftEmpty) return;
    const s = sentenceOf(shot);
    if (!s || !s.pick || !s.candidates) return;
    const order = [];
    if (s.pick.best >= 0) {
      order.push(s.pick.best);
      if (s.pick.alt >= 0 && s.pick.alt !== s.pick.best) order.push(s.pick.alt);
      // Extra shots of a long sentence can fall back on the remaining candidates
      s.candidates.forEach((c, k) => { if (!order.includes(k)) order.push(k); });
    }
    if (!order.length) { shot.choice = null; return; }
    // Part 0 gets the best pick, part 1 the second, and avoid repeating a clip used nearby
    let pickIdx = order[Math.min(shot.part, order.length - 1)];
    for (let k = shot.part; k < order.length; k++) {
      const key = s.candidates[order[k]].key;
      const last = used.get(key);
      if (last === undefined || i - last > 6) { pickIdx = order[k]; break; }
    }
    const c = s.candidates[pickIdx];
    shot.choice = { ...c, auto: true };
    used.set(c.key, i);
  });
}

// ---------- swap dialog ----------
let swapIndex = -1;
function openSwap(i) {
  swapIndex = i;
  const shot = project.shots[i];
  const sen = sentenceOf(shot);
  $('swapTime').textContent = `${fmt(shot.start)} to ${fmt(shot.end)}`;
  $('swapText').textContent = sen ? sen.text : '';
  $('swapQuery').value = sen && sen.plan && sen.plan.queries ? sen.plan.queries[0] : '';
  $('swapStatus').textContent = sen && sen.candidates && sen.candidates.length ? 'Footage the app found for this sentence:' : 'Search for footage or upload your own.';
  showGrid(sen && sen.candidates ? sen.candidates : []);
  $('swapDialog').showModal();
}
$('swapClose').addEventListener('click', () => $('swapDialog').close());

function showGrid(cands) {
  const current = project.shots[swapIndex].choice;
  $('swapGrid').innerHTML = cands.map((c, k) => `
    <figure class="cand ${current && current.key === c.key ? 'current' : ''}" data-k="${k}">
      <img src="${esc(c.thumb)}" alt="" loading="lazy">
      <figcaption>
        <span>${c.type === 'video' ? '▶ ' + (c.duration ? c.duration + 's' : 'video') : 'photo'} · ${esc(c.source)}</span>
        <a href="${esc(c.page)}" target="_blank" rel="noopener">view</a>
      </figcaption>
    </figure>`).join('') || '<p class="muted">Nothing here yet.</p>';
  $('swapGrid')._cands = cands;
}

$('swapGrid').addEventListener('click', async e => {
  if (e.target.tagName === 'A') return;
  const fig = e.target.closest('figure.cand');
  if (!fig) return;
  const c = $('swapGrid')._cands[+fig.dataset.k];
  const shot = project.shots[swapIndex];
  shot.choice = { ...c, auto: false, fetchedAt: c.fetchedAt || Date.now() };
  shot.leftEmpty = false;
  await afterSwap();
});

$('swapSearch').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('swapQuery').value.trim();
  if (!q) return;
  $('swapStatus').textContent = 'Searching…';
  try {
    const r = await api('search', { q });
    const now = Date.now();
    const res = r.results.map(c => ({ ...c, fetchedAt: now }));
    $('swapStatus').textContent = res.length ? `${res.length} results for "${q}". Click one to use it.` : `Nothing found for "${q}". Try simpler words.`;
    showGrid(res);
  } catch (err) { $('swapStatus').textContent = err.message; }
});

// Check a video file before using it: can the browser play it, and how big is it?
async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.preload = 'metadata';
  try {
    await new Promise((res, rej) => {
      v.addEventListener('loadedmetadata', res, { once: true });
      v.addEventListener('error', () => rej(new Error('unplayable')), { once: true });
      setTimeout(() => rej(new Error('timeout')), 20000);
      v.src = url;
    });
    return { ok: true, w: v.videoWidth, h: v.videoHeight };
  } catch (e) {
    return { ok: false };
  } finally {
    v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
  }
}

// Same file uploaded twice (for two shots) is stored once
function fileId(f) {
  let h = 0;
  for (const ch of `${f.name}|${f.size}|${f.lastModified}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36) + f.size.toString(36);
}

$('swapUpload').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  e.target.value = '';
  if (f.type.startsWith('video')) {
    $('swapStatus').textContent = 'Checking the video…';
    const info = await probeVideo(f);
    if (!info.ok) {
      $('swapStatus').textContent = '';
      alert(`Chrome can't play "${f.name}". It's probably in a format like HEVC or ProRes. Download the MP4 version (Pexels: choose HD 1920x1080) or convert it to MP4, then upload again.`);
      return;
    }
    if (Math.max(info.w, info.h) > 2000 &&
      !confirm(`"${f.name}" is ${info.w}x${info.h} (4K or bigger). Very large clips can fail to load or make playback stutter, because the browser can only open a few at once.\n\nTip: on Pexels, use the download arrow and pick Full HD (1920x1080).\n\nUse this file anyway?`)) {
      $('swapStatus').textContent = '';
      return;
    }
  }
  const key = `${project.id}:u:${fileId(f)}`;
  if (!(await store.getFile(key))) await store.putFile(key, f);
  const shot = project.shots[swapIndex];
  shot.choice = { custom: key, key, type: f.type.startsWith('video') ? 'video' : 'photo', name: f.name, source: 'Your file', auto: false };
  shot.leftEmpty = false;
  await afterSwap();
});

$('swapClear').addEventListener('click', async () => {
  const shot = project.shots[swapIndex];
  shot.choice = null;
  shot.leftEmpty = true;
  await afterSwap();
});

async function afterSwap() {
  $('swapDialog').close();
  // A new clip starts fresh: no start point or framing carried over
  delete project.shots[swapIndex].edit;
  renderer.invalidate(project.shots[swapIndex].id);
  await save();
  renderHeader();
  await renderShots();
  renderer.showFrame(project.shots[swapIndex].start + 0.01).catch(() => {});
}

// ---------- export ----------
// Full-quality export: built frame by frame in a background worker from full-resolution
// clips, so you can use other tabs and apps while it runs.
const BITRATE = { '16:9': 16_000_000, '9:16': 16_000_000 };

function exportName() {
  return `${project.title.replace(/[^\w\s-]/g, '').trim() || 'case-lab'}${aspectOf() === '9:16' ? ' (Short)' : ''}.mp4`;
}

// Full-resolution addresses for a clip (the preview uses lighter versions)
async function exportSources(choice) {
  await mediaUrl(choice); // refreshes old Pixabay links if needed
  const full = choice.url || choice.urlSmall;
  const proxy = u => '/api/media?u=' + encodeURIComponent(u) + (choice.fallback ? '&f=' + encodeURIComponent(choice.fallback) : '');
  const list = [{ url: full }, { url: proxy(full) }, { url: proxy(full) + '&retry=1', delay: 3000 }];
  if (choice.urlSmall && choice.urlSmall !== full) list.push({ url: proxy(choice.urlSmall) }); // last resort
  return list;
}

// Narration as 48 kHz mono samples (the standard for YouTube)
async function narration48k() {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await audioBlob.arrayBuffer());
  ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 48000), 48000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

let exportWorker = null;

$('exportBtn').addEventListener('click', async () => {
  if (!project || busy) return;
  if (!window.VideoEncoder || !window.OffscreenCanvas) return legacyExport();

  // Ask where to save first, so the file is written straight to disk as it's built
  let fileHandle = null;
  if (window.showSaveFilePicker) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: exportName(),
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return; // you closed the save window
      fileHandle = null;
    }
  }

  renderer.stop();
  setBusy(true);
  cancelFlag = false;
  const empty = project.shots.filter(s => !s.choice).length;
  const baseTitle = document.title;
  // Holding a lock keeps Chrome from putting this tab to sleep while exporting
  let releaseLock = null;
  try { if (navigator.locks) navigator.locks.request('case-lab-export', () => new Promise(r => { releaseLock = r; })); } catch (e) { /* not supported */ }
  try {
    progress(true, 0, 'Preparing clips…');
    const aspect = aspectOf();
    const shots = [];
    for (const s of project.shots) {
      const c = s.choice;
      const item = { start: s.start, end: s.end, edit: s.edit || null, frame: frameFor(s, aspect), type: c ? c.type : null };
      if (c && c.custom) item.blob = await store.getFile(c.custom);
      else if (c) item.sources = await exportSources(c);
      shots.push(item);
    }
    progress(true, 0, 'Preparing narration…');
    const audio = await narration48k();
    if (cancelFlag) return;

    const result = await new Promise((resolve, reject) => {
      exportWorker = new Worker('/js/export-worker.js');
      exportWorker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          progress(true, data.frac, data.text + ' · you can use other tabs and apps meanwhile');
          document.title = `${Math.round(data.frac * 100)}% · Exporting · Case Lab`;
        } else if (data.type === 'done') resolve(data);
        else if (data.type === 'cancelled') resolve(null);
        else if (data.type === 'error') reject(new Error(data.message));
      };
      exportWorker.onerror = e => reject(new Error(e.message || 'Export stopped unexpectedly'));
      const cap = project.captions && project.captions.show ? { cues: project.captions.cues[aspect], style: project.captions.style[aspect] } : null;
      const job = { aspect, duration: project.duration, shots, audio, fileHandle, bitrate: BITRATE[aspect], captions: cap };
      exportWorker.postMessage({ type: 'start', job }, [audio.buffer]);
    });
    progress(false);
    if (!result) return;

    if (result.blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(result.blob);
      a.download = exportName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 120000);
    }
    const notes = [];
    if (result.problems && result.problems.length) notes.push(`${result.problems.length} clip(s) could not be loaded and kept the previous picture:\n` + result.problems.slice(0, 5).join('\n'));
    if (empty) notes.push(`${empty} shot(s) had no footage and are black.`);
    alert(`Export finished in ${fmt(result.seconds)}${fileHandle ? ` and saved as "${fileHandle.name}"` : ''}.` + (notes.length ? '\n\n' + notes.join('\n\n') : ''));
  } catch (e) {
    progress(false);
    alert('Export problem: ' + e.message);
  } finally {
    if (exportWorker) { exportWorker.terminate(); exportWorker = null; }
    if (releaseLock) releaseLock();
    document.title = baseTitle;
    setBusy(false);
  }
});

window.addEventListener('beforeunload', e => { if (exportWorker) { e.preventDefault(); e.returnValue = ''; } });

// Old method (records the preview in real time) for browsers without the needed features
async function legacyExport() {
  const empty = project.shots.filter(s => !s.choice).length;
  const msg = `Export "${project.title}"?\n\nThis browser doesn't support the full-quality export, so the video is recorded in real time (about ${fmt(project.duration)}). Keep this tab in front the whole time.` +
    (empty ? `\n\n${empty} shots have no footage and will show the previous picture or black.` : '');
  if (!confirm(msg)) return;
  setBusy(true);
  cancelFlag = false;
  try {
    progress(true, 0, 'Preparing…');
    const blob = await renderer.play(0, {
      record: true,
      muteSpeakers: true,
      onProgress: f => progress(true, f, `Recording ${fmt(f * project.duration)} of ${fmt(project.duration)}… keep this tab in front`),
    });
    progress(false);
    if (cancelFlag || !blob) return;
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportName().replace(/\.mp4$/, '.' + ext);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  } catch (e) {
    progress(false);
    alert('Export problem: ' + e.message);
  } finally {
    setBusy(false);
  }
}

// ---------- credits ----------
$('creditsBtn').addEventListener('click', async () => {
  if (!project) return;
  const seen = new Set(), must = [], nice = [];
  for (const s of project.shots) {
    const c = s.choice;
    if (!c || c.custom || seen.has(c.credit)) continue;
    seen.add(c.credit);
    (c.needsCredit ? must : nice).push(c.credit + (c.page ? ' ' + c.page : ''));
  }
  const text = [
    must.length ? 'Images used under Creative Commons:\n' + must.join('\n') : '',
    nice.length ? 'Footage and images:\n' + nice.join('\n') : '',
  ].filter(Boolean).join('\n\n') || 'No stock footage used yet.';
  try { await navigator.clipboard.writeText(text); alert('Credits copied. Paste them into your YouTube description.' + (must.length ? `\n\n${must.length} of them are required by their license.` : '')); }
  catch (e) { prompt('Copy these credits:', text); }
});

// ---------- go ----------
start().catch(e => { console.error(e); showLogin(); });

// ---------- shot editor: start point and framing ----------
const ed = { i: -1, el: null, start: 0, frame: {}, raf: 0, playing: false, drag: null };

async function openEditor(i) {
  const shot = project.shots[i];
  if (!shot.choice) return;
  renderer.stop();
  // Free the preview's videos first: browsers can only decode a few videos at once
  renderer.releaseAll();
  closeEditorMedia();
  ed.i = i;
  ed.start = (shot.edit && shot.edit.start) || 0;
  ed.frame = { x: 0.5, y: 0.5, zoom: 1, mode: 'auto', ...frameFor(shot, aspectOf()) };
  const sen = sentenceOf(shot);
  const len = shot.end - shot.start;
  $('editTime').textContent = `${fmt(shot.start)} to ${fmt(shot.end)} · ${len.toFixed(1)}s on screen · ${aspectOf() === '9:16' ? '9:16 Short' : '16:9'}`;
  $('editText').textContent = sen ? sen.text : '';
  const [W, H] = SIZES[aspectOf()];
  const c = $('editCanvas');
  c.width = W / 3; c.height = H / 3;
  c.classList.toggle('portrait', aspectOf() === '9:16');
  $('editStatus').textContent = 'Loading…';
  $('trimBox').classList.add('hidden');
  $('editDialog').showModal();

  try {
    const sources = await mediaSources(shot.choice);
    if (shot.choice.type === 'video') {
      let v;
      try { v = await loadVideo(sources); }
      catch (e) { throw new Error(await whyNotLoading(shot.choice)); }
      if (ed.i !== i || !$('editDialog').open) { v.removeAttribute('src'); v.load(); return; }
      ed.el = v;
      const d = v.duration || 0;
      const max = Math.max(0, d - len);
      $('trimRange').max = max.toFixed(1);
      $('trimRange').value = Math.min(ed.start, max);
      ed.start = +$('trimRange').value;
      $('trimBox').classList.remove('hidden');
      $('trimInfo').textContent = d < len
        ? `This clip is ${d.toFixed(1)}s, shorter than the shot (${len.toFixed(1)}s), so it will loop.`
        : `The clip is ${fmt(d)} long. Slide to choose which ${len.toFixed(1)} seconds play.`;
      v.currentTime = ed.start;
      updateTrimLabel();
    } else {
      let res;
      try { res = await loadImage(sources); }
      catch (e) { throw new Error(await whyNotLoading(shot.choice)); }
      ed.el = res.img;
    }
    $('editStatus').textContent = '';
    updateFrameControls();
    drawEditor();
  } catch (e) {
    $('editStatus').textContent = e.message;
  }
}

function drawEditor() {
  cancelAnimationFrame(ed.raf);
  const c = $('editCanvas'), x = c.getContext('2d');
  const loop = () => {
    if (!$('editDialog').open) return;
    x.fillStyle = '#000';
    x.fillRect(0, 0, c.width, c.height);
    if (ed.el) drawMedia(x, ed.el, c.width, c.height, ed.frame);
    if (ed.playing && ed.el && ed.el.tagName === 'VIDEO') {
      const shot = project.shots[ed.i];
      if (ed.el.currentTime >= ed.start + (shot.end - shot.start) || ed.el.ended) stopEditorPlay();
    }
    ed.raf = requestAnimationFrame(loop);
  };
  loop();
}

function updateTrimLabel() {
  const shot = project.shots[ed.i];
  const len = shot.end - shot.start;
  $('trimLabel').textContent = `${fmt(ed.start)} to ${fmt(ed.start + len)}`;
}

function stopEditorPlay() {
  ed.playing = false;
  if (ed.el && ed.el.tagName === 'VIDEO') { ed.el.pause(); ed.el.currentTime = ed.start; }
  $('trimPlay').textContent = '▶ Play this shot';
}

$('trimRange').addEventListener('input', () => {
  ed.start = +$('trimRange').value;
  if (ed.playing) stopEditorPlay();
  if (ed.el) ed.el.currentTime = ed.start;
  updateTrimLabel();
});

$('trimPlay').addEventListener('click', () => {
  if (!ed.el || ed.el.tagName !== 'VIDEO') return;
  if (ed.playing) return stopEditorPlay();
  ed.el.currentTime = ed.start;
  ed.el.play().catch(() => {});
  ed.playing = true;
  $('trimPlay').textContent = '■ Stop';
});

function updateFrameControls() {
  const c = $('editCanvas');
  const mode = ed.el ? mediaLayout(ed.el, c.width, c.height, ed.frame).mode : 'fill';
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('zoomRange').value = ed.frame.zoom || 1;
  $('zoomLabel').textContent = Math.round((ed.frame.zoom || 1) * 100) + '%';
}

document.querySelectorAll('#modeSeg button').forEach(b => b.addEventListener('click', () => {
  ed.frame.mode = b.dataset.mode;
  ed.frame.x = 0.5; ed.frame.y = 0.5;
  updateFrameControls();
}));

$('zoomRange').addEventListener('input', () => {
  ed.frame.zoom = +$('zoomRange').value;
  updateFrameControls();
});

$('frameReset').addEventListener('click', () => {
  ed.frame = { x: 0.5, y: 0.5, zoom: 1, mode: 'auto' };
  updateFrameControls();
});

// Drag the picture to choose which part stays on screen
const editCanvas = $('editCanvas');
editCanvas.addEventListener('pointerdown', e => {
  if (!ed.el) return;
  editCanvas.setPointerCapture(e.pointerId);
  ed.drag = { x: e.clientX, y: e.clientY, fx: ed.frame.x ?? 0.5, fy: ed.frame.y ?? 0.5 };
});
editCanvas.addEventListener('pointermove', e => {
  if (!ed.drag || !ed.el) return;
  const rect = editCanvas.getBoundingClientRect();
  const scale = editCanvas.width / rect.width;
  const { dw, dh } = mediaLayout(ed.el, editCanvas.width, editCanvas.height, ed.frame);
  const slackX = editCanvas.width - dw, slackY = editCanvas.height - dh;
  const clamp = v => Math.min(1, Math.max(0, v));
  // Offset = slack * f, so moving the pointer by d changes f by d / slack
  if (Math.abs(slackX) > 1) ed.frame.x = clamp(ed.drag.fx + (e.clientX - ed.drag.x) * scale / slackX);
  if (Math.abs(slackY) > 1) ed.frame.y = clamp(ed.drag.fy + (e.clientY - ed.drag.y) * scale / slackY);
});
['pointerup', 'pointercancel'].forEach(t => editCanvas.addEventListener(t, () => { ed.drag = null; }));

function closeEditorMedia() {
  cancelAnimationFrame(ed.raf);
  if (ed.el && ed.el.tagName === 'VIDEO') { ed.el.pause(); ed.el.removeAttribute('src'); ed.el.load(); }
  ed.el = null;
  ed.playing = false;
}

$('editCancel').addEventListener('click', () => { closeEditorMedia(); $('editDialog').close(); });
$('editDialog').addEventListener('close', closeEditorMedia);

$('editSave').addEventListener('click', async () => {
  const shot = project.shots[ed.i];
  const frames = { ...((shot.edit && shot.edit.frames) || {}) };
  const f = ed.frame;
  const isDefault = (f.mode || 'auto') === 'auto' && (f.zoom || 1) === 1 && (f.x ?? 0.5) === 0.5 && (f.y ?? 0.5) === 0.5;
  if (isDefault) delete frames[aspectOf()]; else frames[aspectOf()] = { ...f };
  shot.edit = { start: shot.choice.type === 'video' ? ed.start : 0, frames };
  closeEditorMedia();
  $('editDialog').close();
  renderer.invalidate(shot.id);
  await save();
  await renderShots();
  renderer.showFrame(shot.start + 0.01).catch(() => {});
});

// ---------- cloud save indicator ----------
onSync(({ state, error }) => {
  const el = $('syncState');
  const map = {
    checking: ['', ''],
    off: ['Saved in this browser only', 'off'],
    saving: ['Saving to cloud…', 'saving'],
    saved: ['Saved to cloud', 'saved'],
    error: ['Cloud save problem (saved in this browser)', 'error'],
  };
  const [text, cls] = map[state] || ['', ''];
  el.textContent = text;
  el.className = 'sync ' + cls;
  el.title = error || '';
});

// ---------- rename project ----------
function startRename() {
  if (!project) return;
  $('titleEditInput').value = project.title;
  $('projectTitle').classList.add('hidden');
  $('titleEdit').classList.remove('hidden');
  $('titleEditInput').focus();
  $('titleEditInput').select();
}
$('renameBtn').addEventListener('click', startRename);
$('projectTitle').addEventListener('dblclick', startRename);
$('titleEdit').addEventListener('submit', async e => {
  e.preventDefault();
  const t = $('titleEditInput').value.trim();
  if (t && t !== project.title) { project.title = t; await save(); await refreshProjects(); }
  renderHeader();
});
$('titleEditCancel').addEventListener('click', () => renderHeader());
$('titleEditInput').addEventListener('keydown', e => { if (e.key === 'Escape') renderHeader(); });

// ---------- AI cost counter ----------
let usageInfo = null;
async function refreshUsage() {
  try {
    usageInfo = await api('usage');
    const usd = usageInfo.estimatedUSD;
    $('aiUsage').textContent = `AI this month: $${usd < 0.01 && usd > 0 ? '<0.01' : usd.toFixed(2)}`;
  } catch (e) { /* not important enough to show an error */ }
}
$('aiUsage').addEventListener('click', () => {
  if (!usageInfo) return;
  const [y, m] = usageInfo.month.split('-');
  const name = new Date(+y, +m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  alert(`AI use in ${name}\n\n` +
    `Estimated cost: $${usageInfo.estimatedUSD.toFixed(4)} (US dollars)\n` +
    `AI requests: ${usageInfo.requests}\n` +
    `Tokens read (text + images): ${usageInfo.inputTokens.toLocaleString('en-GB')}\n` +
    `Tokens written: ${usageInfo.outputTokens.toLocaleString('en-GB')}\n\n` +
    `Only "Find footage" uses the AI. Searching, previewing and exporting are free.\n` +
    `This is an estimate from Google's published prices. Your exact bill is in Google AI Studio > Spend.` +
    (usageInfo.saved ? '' : '\n\n(Not saved permanently: the count restarts when the server restarts.)'));
});

// ---------- tabs ----------
document.querySelectorAll('#workTabs .tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#workTabs .tab').forEach(x => x.classList.toggle('active', x === b));
  $('tab-shots').classList.toggle('hidden', b.dataset.tab !== 'shots');
  $('tab-captions').classList.toggle('hidden', b.dataset.tab !== 'captions');
}));

// ---------- captions ----------
const capCues = () => project.captions.cues[aspectOf()];
const capStyle = () => project.captions.style[aspectOf()];
let capSaveTimer = null;
function capChanged(redraw = true) {
  clearTimeout(capSaveTimer);
  capSaveTimer = setTimeout(() => save(), 600);
  if (redraw && !renderer.running) renderer.refreshCaptions();
}

function renderCaptions() {
  if (!project) return;
  const c = project.captions;
  $('capEmpty').classList.toggle('hidden', !!c);
  $('capReady').classList.toggle('hidden', !c);
  if (!c) return;
  $('capShow').checked = !!c.show;
  $('capAspect').textContent = aspectOf() === '9:16' ? '9:16 Short' : '16:9';
  const st = capStyle();
  document.querySelectorAll('#capPreset button').forEach(b => b.classList.toggle('active', b.dataset.preset === st.preset));
  $('capSize').value = st.size;
  $('capY').value = st.y;
  $('capBox').checked = !!st.box;
  $('capCaps').checked = !!st.caps;
  $('capHighlight').value = st.highlight || '#ffd400';
  $('capHighlightWrap').classList.toggle('hidden', st.preset !== 'bold');
  renderCueList();
}

function renderCueList() {
  const cues = capCues();
  $('capList').innerHTML = cues.map((q, i) => `
    <li class="cap" data-i="${i}">
      <input class="t" data-f="s" value="${q.s.toFixed(1)}" inputmode="decimal" title="Start (seconds)">
      <input class="t" data-f="e" value="${q.e.toFixed(1)}" inputmode="decimal" title="End (seconds)">
      <input class="txt" data-f="text" value="${esc(cueText(q))}">
      <button class="x" data-f="del" type="button" title="Delete this line">✕</button>
    </li>`).join('');
  lastActiveCue = -1;
}

let lastActiveCue = -1;
function markActiveCue(t) {
  if (!project || !project.captions || $('tab-captions').classList.contains('hidden')) return;
  const cues = capCues();
  const i = cues.findIndex(q => t >= q.s && t < q.e);
  if (i === lastActiveCue) return;
  lastActiveCue = i;
  document.querySelectorAll('#capList .cap').forEach(li => li.classList.toggle('active', +li.dataset.i === i));
  const li = document.querySelector(`#capList .cap[data-i="${i}"]`);
  if (li && renderer.running) li.scrollIntoView({ block: 'nearest' });
}

$('capList').addEventListener('click', e => {
  const li = e.target.closest('.cap');
  if (!li) return;
  const i = +li.dataset.i;
  const cues = capCues();
  if (e.target.dataset.f === 'del') {
    cues.splice(i, 1);
    capChanged();
    renderCueList();
    return;
  }
  if (!renderer.running) renderer.showFrame(cues[i].s + 0.05).catch(() => {});
  document.querySelectorAll('#capList .cap').forEach(x => x.classList.toggle('active', x === li));
});

$('capList').addEventListener('change', e => {
  const li = e.target.closest('.cap');
  if (!li) return;
  const q = capCues()[+li.dataset.i];
  const f = e.target.dataset.f;
  if (f === 'text') {
    if (!e.target.value.trim()) { e.target.value = cueText(q); return; }
    setCueText(q, e.target.value);
  } else if (f === 's' || f === 'e') {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (!isFinite(v) || v < 0) { e.target.value = q[f].toFixed(1); return; }
    setCueTime(q, f === 's' ? v : q.s, f === 'e' ? v : q.e);
    capCues().sort((a, b) => a.s - b.s);
    renderCueList();
  }
  capChanged(false);
  if (!renderer.running) renderer.showFrame(q.s + 0.05).catch(() => {});
});

$('capShow').addEventListener('change', () => { project.captions.show = $('capShow').checked; capChanged(); if (!renderer.running) renderer.showFrame(renderer.lastFrameTime || 0).catch(() => {}); });
$('capSize').addEventListener('input', () => { capStyle().size = +$('capSize').value; capChanged(); });
$('capY').addEventListener('input', () => { capStyle().y = +$('capY').value; capChanged(); });
$('capBox').addEventListener('change', () => { capStyle().box = $('capBox').checked; capChanged(); });
$('capCaps').addEventListener('change', () => { capStyle().caps = $('capCaps').checked; capChanged(); });
$('capHighlight').addEventListener('input', () => { capStyle().highlight = $('capHighlight').value; capChanged(); });

document.querySelectorAll('#capPreset button').forEach(b => b.addEventListener('click', () => {
  const st = capStyle();
  if (b.dataset.preset === st.preset) return;
  if (capCues().some(q => q.edited) && !confirm('Switching style rebuilds the caption lines for this format, so your edits to the lines will be replaced. Continue?')) return;
  project.captions.style[aspectOf()] = { ...PRESETS[b.dataset.preset] };
  project.captions.cues[aspectOf()] = buildCues(project.captions.words, b.dataset.preset);
  capChanged();
  renderCaptions();
}));

$('capRebuild').addEventListener('click', () => {
  if (!confirm('Rebuild the caption lines for this format from the word timings? Your edits to the lines will be replaced (style settings stay).')) return;
  project.captions.cues[aspectOf()] = buildCues(project.captions.words, capStyle().preset);
  capChanged();
  renderCueList();
});

$('capSrt').addEventListener('click', () => {
  const blob = new Blob([toSRT(capCues())], { type: 'application/x-subrip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportName().replace(/\.mp4$/, '.srt');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
});

$('capRetime').addEventListener('click', async () => {
  if (!confirm('Move every B-roll cut to the exact moment its sentence starts being spoken?\n\nAll your footage choices, start points and framing stay the same; only the cut times shift slightly.')) return;
  renderer.stop();
  const moved = retimeShots(project);
  await save();
  renderer.setProject(project.shots, audioBlob);
  await renderShots();
  renderer.showFrame(0).catch(() => {});
  alert(moved ? `Done: ${moved} sentence cuts were moved to match your voice exactly.` : 'Everything already lined up, nothing needed to move.');
});

$('capCreate').addEventListener('click', async () => {
  if (!project || busy) return;
  const status = $('capStatus');
  $('capCreate').disabled = true;
  try {
    const ready = await api('captions/ready');
    if (!ready.ready) throw new Error('AssemblyAI is not connected yet: add ASSEMBLYAI_API_KEY in Render > Environment.');
    const key = project.id + ':audio';
    let id = null;
    // If the narration is already in cloud storage, AssemblyAI fetches it from there
    if (await localStore.getFile(key + '#cloud')) {
      try { id = (await api('captions/start', { key })).id; } catch (e) { id = null; }
    }
    if (!id) {
      status.textContent = 'Sending the narration to AssemblyAI…';
      const r = await fetch('/api/captions/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audioBlob, credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Upload failed');
      id = data.id;
    }
    const t0 = Date.now();
    let res;
    for (;;) {
      status.textContent = `AssemblyAI is listening to the narration… (${Math.round((Date.now() - t0) / 1000)}s, usually under a minute)`;
      await new Promise(r => setTimeout(r, 3000));
      res = await api('captions/status/' + id);
      if (res.status === 'completed') break;
      if (res.status === 'error') throw new Error(res.error);
      if (Date.now() - t0 > 20 * 60 * 1000) throw new Error('Transcription is taking too long. Try again later.');
    }
    status.textContent = 'Matching the timing to your script…';
    const words = alignWords(project.paragraphs, res.words);
    project.captions = {
      transcriptId: id,
      words,
      cues: { '16:9': buildCues(words, DEFAULT_STYLE['16:9'].preset), '9:16': buildCues(words, DEFAULT_STYLE['9:16'].preset) },
      style: { '16:9': { ...DEFAULT_STYLE['16:9'] }, '9:16': { ...DEFAULT_STYLE['9:16'] } },
      show: true,
    };
    await save();
    status.textContent = '';
    renderCaptions();
    renderer.showFrame(renderer.lastFrameTime || 0).catch(() => {});
    refreshUsage();
  } catch (e) {
    status.textContent = 'Problem: ' + e.message;
  } finally {
    $('capCreate').disabled = false;
  }
});

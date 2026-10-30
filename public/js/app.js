import { cloudStore as store, syncAll, onSync } from './cloud.js';
import { readAAF, readAudio, readScript, buildTimeline, wordCountCheck } from './importer.js';
import { Renderer, drawMedia, mediaLayout, frameFor, SIZES } from './renderer.js';

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
  refreshProjects();
  clearCanvas();
  if (project.shots.some(s => s.choice)) renderer.showFrame(0).catch(() => {});
}

function renderHeader() {
  $('projectTitle').textContent = project.title;
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
  mediaUrl: shot => mediaUrl(shot.choice),
  onTime: (t, i) => {
    $('timeLabel').textContent = `${fmt(t)} / ${fmt(project ? project.duration : 0)}`;
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
$('cancelBtn').addEventListener('click', () => { cancelFlag = true; renderer.stop(); });

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

$('swapUpload').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const key = `${project.id}:u:${Date.now().toString(36)}`;
  await store.putFile(key, f);
  const shot = project.shots[swapIndex];
  shot.choice = { custom: key, key, type: f.type.startsWith('video') ? 'video' : 'photo', name: f.name, source: 'Your file', auto: false };
  shot.leftEmpty = false;
  e.target.value = '';
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
$('exportBtn').addEventListener('click', async () => {
  if (!project || busy) return;
  const empty = project.shots.filter(s => !s.choice).length;
  const msg = `Export "${project.title}"?\n\nThe video is built in real time, so this takes about ${fmt(project.duration)}. Keep this tab open and in front the whole time (don't switch tabs or minimize).` +
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
    a.download = `${project.title.replace(/[^\w\s-]/g, '').trim() || 'case-lab'}${aspectOf() === '9:16' ? ' (Short)' : ''}.${ext}`;
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
});

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
    const url = await mediaUrl(shot.choice);
    if (shot.choice.type === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      v.src = url;
      await new Promise((res, rej) => {
        v.addEventListener('loadeddata', res, { once: true });
        v.addEventListener('error', () => rej(new Error('This video could not be loaded.')), { once: true });
        setTimeout(() => rej(new Error('This video is taking too long to load.')), 60000);
      });
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
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      await img.decode();
      ed.el = img;
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

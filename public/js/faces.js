// Blurring faces. The app looks for faces in a clip (YuNet face detector, runs in the browser, no
// AI cost) and follows each face as it moves. You tick which ones to blur. Faces the detector
// misses (people filmed from above, turned away) can be added by drawing a box; the app then
// follows that spot through the clip.
//
// Saved per file as f.faces = { tracks: [{ id, name, manual, thumb, pts: [[t, x, y, w, h]] }], blur: { id: true } }
// x/y/w/h are shares of the picture (0..1), t is seconds in the file. Blurring applies wherever that
// file is shown (clips and footage under narration), in the preview and the exported video.

const $ = id => document.getElementById(id);
let X = null;
export function initFaces(helpers) { X = helpers; wire(); }

const STEP = 0.5;      // look at 2 pictures a second
const FW = 1280;       // pictures are looked at this wide
let ort = null, session = null;

async function detector() {
  if (session) return session;
  ort = await import('/vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = '/vendor/ort/';
  ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create('/vendor/yunet/face_detection_yunet_2023mar.onnx', { executionProviders: ['wasm'] });
  return session;
}

// One 640 x 640 square of the picture -> faces [score, x, y, w, h] in its pixels
const sq = document.createElement('canvas'); sq.width = sq.height = 640;
const sqx = sq.getContext('2d', { willReadFrequently: true });
async function detectSquare(src, sx, sy, sw, sh, k) {
  sqx.fillStyle = '#000'; sqx.fillRect(0, 0, 640, 640);
  sqx.drawImage(src, sx, sy, sw, sh, 0, 0, sw * k, sh * k);
  const px = sqx.getImageData(0, 0, 640, 640).data;
  const N = 640 * 640, data = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) { data[i] = px[i * 4 + 2]; data[N + i] = px[i * 4 + 1]; data[2 * N + i] = px[i * 4]; } // BGR
  const out = await session.run({ input: new ort.Tensor('float32', data, [1, 3, 640, 640]) });
  const res = [];
  for (const st of [8, 16, 32]) {
    const cols = 640 / st, cls = out['cls_' + st].data, obj = out['obj_' + st].data, bb = out['bbox_' + st].data;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < 0.55) continue;
      const r = Math.floor(i / cols), c = i % cols;
      const cx = (c + bb[i * 4]) * st, cy = (r + bb[i * 4 + 1]) * st, w = Math.exp(bb[i * 4 + 2]) * st, h = Math.exp(bb[i * 4 + 3]) * st;
      res.push([score, sx + (cx - w / 2) / k, sy + (cy - h / 2) / k, w / k, h / k]);
    }
  }
  return res;
}

const iou = (a, b) => {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return i / (a[2] * a[3] + b[2] * b[3] - i || 1);
};

// Faces in a picture (canvas FW wide): the whole picture, plus overlapping squares for small faces
async function detectFrame(cv) {
  await detector();
  const W = cv.width, H = cv.height;
  const all = [];
  const k = 640 / Math.max(W, H);
  all.push(...await detectSquare(cv, 0, 0, W, H, k));
  const xs = W > 640 ? [0, (W - 640) / 2, W - 640] : [0];
  const ys = H > 640 ? [0, H - 640] : [0];
  for (const y of ys) for (const x of xs) all.push(...await detectSquare(cv, x, y, Math.min(640, W), Math.min(640, H), 1));
  all.sort((a, b) => b[0] - a[0]);
  const keep = [];
  for (const d of all) if (!keep.some(q => iou(q.slice(1), d.slice(1)) > 0.3)) keep.push(d);
  return keep.map(d => ({ score: d[0], box: [d[1] / W, d[2] / H, d[3] / W, d[4] / H] }));
}

// ---------- reading pictures from the clip ----------
let F = null; // { f, a, b, video, cv, url, note }
const cv = document.createElement('canvas');
const cvx = cv.getContext('2d', { willReadFrequently: true });

async function openSource(f, a, b) {
  const video = $('fdVideo');
  const tryUrl = (url, from = 0) => new Promise(ok => {
    if (!url) return ok(false);
    let done = false;
    const end = v => { if (done) return; done = true; video.onloadeddata = video.onerror = null; ok(v); };
    video.onloadeddata = () => end(video.videoWidth > 0);
    video.onerror = () => end(false);
    video.src = url;
    setTimeout(() => end(false), 15000);
  });
  F.offset = 0;
  // 1) the original, if it's linked on this computer and the browser can play it
  const file = await X.getLocalFile(f).catch(() => null);
  if (file) {
    const url = URL.createObjectURL(file);
    F.urls.push(url);
    if (await tryUrl(url)) return '';
    // 2) a format the browser can't play (WMV, police recorder files): convert just this part
    status('Converting this part of the file so it can be checked…');
    try {
      const { convertRange } = await import('./convert.js');
      const blob = await convertRange(file, a, b - a, { video: true, onProgress: p => status(`Converting this part of the file so it can be checked… ${Math.round(p * 100)}%`) });
      const u2 = URL.createObjectURL(blob);
      F.urls.push(u2);
      F.offset = a;
      if (await tryUrl(u2)) return '';
    } catch (e) { /* try the analysis copy */ }
  }
  // 3) the small analysis copy in the cloud
  // (downloaded first: a picture read straight from the cloud can't be checked for faces)
  const [u] = f.proxyKey ? await X.signedUrls([f.proxyKey]) : [];
  let local = null;
  if (u) {
    status('Downloading the analysis copy…');
    try { const r = await fetch(u); if (r.ok) { local = URL.createObjectURL(await r.blob()); F.urls.push(local); } } catch (e) { /* not reachable */ }
  }
  if (await tryUrl(local)) return 'The original file is not linked on this computer, so the small analysis copy (1 picture a second) is used. Small faces may be missed: link the original (Files tab, "Find it") for better results.';
  throw new Error('The video could not be opened. Link the original file on the Files tab first.');
}

function seek(t) {
  const v = $('fdVideo');
  const want = Math.max(0, t - F.offset);
  return new Promise(ok => {
    if (Math.abs(v.currentTime - want) < 0.01 && v.readyState >= 2) return ok();
    const done = () => { v.removeEventListener('seeked', done); ok(); };
    v.addEventListener('seeked', done);
    v.currentTime = want;
    setTimeout(done, 5000);
  });
}

async function grab(t) {
  await seek(t);
  const v = $('fdVideo');
  cv.width = FW; cv.height = Math.round(FW * v.videoHeight / v.videoWidth);
  cvx.drawImage(v, 0, 0, cv.width, cv.height);
  return cv;
}

function thumbOf(c, box) {
  const t = document.createElement('canvas'); t.width = t.height = 72;
  const [x, y, w, h] = box, m = 0.35;
  const s = Math.max(w * c.width, h * c.height) * (1 + m * 2);
  const cx = (x + w / 2) * c.width, cy = (y + h / 2) * c.height;
  t.getContext('2d').drawImage(c, cx - s / 2, cy - s / 2, s, s, 0, 0, 72, 72);
  return t.toDataURL('image/jpeg', 0.7);
}

// ---------- finding faces automatically ----------
let stopFlag = false;
async function scan() {
  const { f, a, b } = F;
  stopFlag = false;
  busy(true);
  try {
    status('Loading the face finder…');
    await detector();
    const found = []; // { pts, best, thumb, last }
    const times = [];
    for (let t = a; t <= b + 0.001; t += STEP) times.push(Math.round(t * 100) / 100);
    for (let k = 0; k < times.length; k++) {
      if (stopFlag) throw new Error('Stopped');
      const t = times[k];
      const c = await grab(t);
      const dets = await detectFrame(c);
      for (const d of dets) {
        let best = null, bestScore = 0;
        for (const tr of found) {
          const [lt, ...lb] = tr.pts[tr.pts.length - 1];
          if (t - lt > 2.5 || lt === t) continue;
          const ov = iou(lb, d.box);
          const dist = Math.hypot((lb[0] + lb[2] / 2) - (d.box[0] + d.box[2] / 2), (lb[1] + lb[3] / 2) - (d.box[1] + d.box[3] / 2)) / Math.max(lb[2], lb[3], d.box[2], d.box[3]);
          const sc = ov > 0.15 ? 1 + ov : dist < 0.9 ? 1 - dist : 0;
          if (sc > bestScore) { bestScore = sc; best = tr; }
        }
        const pt = [t, ...d.box.map(v => Math.round(v * 10000) / 10000)];
        if (best) { best.pts.push(pt); if (d.score > best.best) { best.best = d.score; best.thumb = thumbOf(c, d.box); } }
        else found.push({ pts: [pt], best: d.score, thumb: thumbOf(c, d.box) });
      }
      status(`Looking for faces… ${Math.round((k + 1) / times.length * 100)}% · ${found.filter(x => x.pts.length >= 2).length} found so far`);
      if (k % 4 === 0) drawFrame(c, t);
    }
    const keep = found.filter(x => x.pts.length >= Math.min(3, times.length)).sort((x, y) => y.pts.length - x.pts.length).slice(0, 12);
    // replaces faces found earlier in this part of the file (faces you drew stay)
    const data = faces(f);
    data.tracks = data.tracks.filter(tr => tr.manual || tr.pts[tr.pts.length - 1][0] < a - 0.5 || tr.pts[0][0] > b + 0.5);
    let n = data.tracks.length;
    for (const x of keep) data.tracks.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: `Person ${++n}`, thumb: x.thumb, pts: x.pts });
    cleanBlur(data);
    await X.save();
    status(keep.length ? `Found ${keep.length} face${keep.length === 1 ? '' : 's'}. Tick the ones to blur. If someone was missed (for example filmed from above), draw a box around their face on the picture.` : 'No faces were found automatically. You can draw a box around a face on the picture, and the app will follow it.');
  } catch (e) {
    status(e.message === 'Stopped' ? 'Stopped.' : 'Finding faces stopped: ' + e.message);
  } finally {
    busy(false);
    renderList();
    show(+$('fdTime').value);
  }
}

// ---------- following a box you drew ----------
const G = 320; // follows in a small gray picture this wide
function gray(c) {
  const h = Math.round(G * c.height / c.width);
  const t = document.createElement('canvas'); t.width = G; t.height = h;
  const tx = t.getContext('2d', { willReadFrequently: true });
  tx.drawImage(c, 0, 0, G, h);
  const d = tx.getImageData(0, 0, G, h).data, g = new Float32Array(G * h);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  return { g, w: G, h };
}
function patch(img, x, y, w, h) {
  const p = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) p[j * w + i] = img.g[Math.min(img.h - 1, Math.max(0, y + j)) * img.w + Math.min(img.w - 1, Math.max(0, x + i))];
  let m = 0; for (const v of p) m += v; m /= p.length;
  let s = 0; for (let i = 0; i < p.length; i++) { p[i] -= m; s += p[i] * p[i]; }
  return { p, n: Math.sqrt(s) || 1, w, h };
}
function match(img, tpl, x0, y0, r) {
  let best = { x: x0, y: y0, s: -1 };
  for (let y = y0 - r; y <= y0 + r; y += 1) {
    for (let x = x0 - r; x <= x0 + r; x += 1) {
      if (x < 0 || y < 0 || x + tpl.w > img.w || y + tpl.h > img.h) continue;
      let m = 0;
      for (let j = 0; j < tpl.h; j++) { const o = (y + j) * img.w + x; for (let i = 0; i < tpl.w; i++) m += img.g[o + i]; }
      m /= tpl.w * tpl.h;
      let dot = 0, ss = 0;
      for (let j = 0; j < tpl.h; j++) { const o = (y + j) * img.w + x; for (let i = 0; i < tpl.w; i++) { const v = img.g[o + i] - m; dot += v * tpl.p[j * tpl.w + i]; ss += v * v; } }
      const s = dot / ((Math.sqrt(ss) || 1) * tpl.n);
      if (s > best.s) best = { x, y, s };
    }
  }
  return best;
}

async function follow(box, t0) {
  const { f, a, b } = F;
  stopFlag = false;
  busy(true);
  try {
    const first = await grab(t0);
    const thumb = thumbOf(first, box);
    const img0 = gray(first);
    const bw = Math.max(6, Math.round(box[2] * img0.w)), bh = Math.max(6, Math.round(box[3] * img0.h));
    const pts = [[t0, ...box]];
    const total = Math.round((b - a) / STEP);
    let done = 0;
    for (const dir of [1, -1]) {
      let tpl = patch(img0, Math.round(box[0] * img0.w), Math.round(box[1] * img0.h), bw, bh);
      let x = Math.round(box[0] * img0.w), y = Math.round(box[1] * img0.h);
      for (let t = t0 + dir * STEP; dir > 0 ? t <= b + 0.001 : t >= a - 0.001; t += dir * STEP) {
        if (stopFlag) throw new Error('Stopped');
        const img = gray(await grab(t));
        const m = match(img, tpl, x, y, Math.max(4, Math.round(Math.max(bw, bh) * 0.6)));
        if (m.s > 0.35) { x = m.x; y = m.y; }
        if (m.s > 0.75) { const np = patch(img, x, y, bw, bh); for (let i = 0; i < tpl.p.length; i++) tpl.p[i] = tpl.p[i] * 0.85 + np.p[i] * 0.15; let s = 0; for (const v of tpl.p) s += v * v; tpl.n = Math.sqrt(s) || 1; }
        pts.push([Math.round(t * 100) / 100, x / img.w, y / img.h, bw / img.w, bh / img.h].map((v, i) => i ? Math.round(v * 10000) / 10000 : v));
        status(`Following the face you drew… ${Math.round(++done / total * 100)}%`);
      }
    }
    pts.sort((p, q) => p[0] - q[0]);
    const data = faces(f);
    const id = 'm' + Date.now().toString(36);
    data.tracks.push({ id, name: `Person ${data.tracks.length + 1}`, manual: true, thumb, pts });
    data.blur[id] = true; // you drew it, so it's blurred straight away
    await X.save();
    status('Added and blurred. Move the slider to check it follows the face. Untick it if it looks wrong, or draw it again.');
  } catch (e) {
    status(e.message === 'Stopped' ? 'Stopped.' : 'Following the face stopped: ' + e.message);
  } finally {
    busy(false);
    renderList();
    show(+$('fdTime').value);
  }
}

// ---------- the dialog ----------
const faces = f => { if (!f.faces) f.faces = { tracks: [], blur: {} }; f.faces.blur = f.faces.blur || {}; return f.faces; };
function cleanBlur(data) { const ids = new Set(data.tracks.map(t => t.id)); for (const k of Object.keys(data.blur)) if (!ids.has(k)) delete data.blur[k]; }
const status = t => { $('fdStatus').textContent = t; };
function busy(on) {
  F.busy = on;
  $('fdScan').disabled = on; $('fdStop').classList.toggle('hidden', !on); $('fdTime').disabled = on;
}

// Faces to blur for a file, in the shape the preview and export use
export function blurData(f) {
  if (!f || !f.faces || !f.faces.tracks) return null;
  const tracks = f.faces.tracks.filter(t => f.faces.blur && f.faces.blur[t.id]).map(t => ({ id: t.id, pts: t.pts }));
  return tracks.length ? { tracks } : null;
}

export async function openFaces(f, a, b) {
  if (!f || f.type !== 'video') return;
  const pad = 0; a = Math.max(0, a - pad); b = Math.min(f.duration || b, b + pad);
  F = { f, a, b, urls: [], offset: 0 };
  $('fdTitle').textContent = `Blur faces · ${f.path || f.name}`;
  $('fdTime').min = a; $('fdTime').max = b; $('fdTime').step = 0.1; $('fdTime').value = a;
  $('fdList').innerHTML = '';
  status('Opening the video…');
  $('faceDialog').showModal();
  busy(true);
  try {
    const note = await openSource(f, a, b);
    $('fdNote').textContent = note || '';
    busy(false);
    renderList();
    await show(a);
    status(faces(f).tracks.length ? 'Tick the faces to blur. Draw a box on the picture to add someone who was missed.' : 'Click "Find faces" to look for faces in this clip, or draw a box around a face on the picture.');
  } catch (e) { busy(false); status(e.message); }
}

function closeFaces() {
  stopFlag = true;
  const v = $('fdVideo'); v.removeAttribute('src'); v.load();
  if (F) F.urls.forEach(u => URL.revokeObjectURL(u));
  F = null;
  $('faceDialog').close();
  if (X.onFacesChanged) X.onFacesChanged();
}

const COLORS = ['#ffd84d', '#7fdcff', '#9be89b', '#ff9fcf', '#ffb26b', '#c7a6ff', '#ffffff'];
function drawFrame(src, t) {
  const out = $('fdCanvas'), ox = out.getContext('2d');
  out.width = src.width; out.height = src.height;
  ox.drawImage(src, 0, 0);
  if (!F) return;
  const data = faces(F.f);
  const rect = { x: 0, y: 0, w: out.width, h: out.height };
  CaseDraw.blurBoxes(ox, rect, CaseDraw.faceBoxesAt(blurData(F.f), t));
  data.tracks.forEach((tr, i) => {
    const bx = CaseDraw.faceBoxesAt({ tracks: [tr] }, t)[0];
    if (!bx) return;
    ox.strokeStyle = COLORS[i % COLORS.length]; ox.lineWidth = 3;
    ox.strokeRect(bx[0] * out.width, bx[1] * out.height, bx[2] * out.width, bx[3] * out.height);
    ox.fillStyle = ox.strokeStyle; ox.font = '600 22px Arial'; ox.fillText(String(i + 1), bx[0] * out.width, bx[1] * out.height - 6);
  });
  if (F.drag) { ox.strokeStyle = '#ff4d4d'; ox.lineWidth = 3; ox.setLineDash([8, 6]); const d = F.drag; ox.strokeRect(d.x, d.y, d.w, d.h); ox.setLineDash([]); }
  $('fdClock').textContent = X.fmtH(t);
}

async function show(t) {
  if (!F) return;
  const c = await grab(t);
  drawFrame(c, t);
}

function renderList() {
  if (!F) return;
  const data = faces(F.f);
  $('fdList').innerHTML = data.tracks.length ? data.tracks.map((tr, i) => `<li data-id="${tr.id}">
      <img src="${tr.thumb || ''}" alt="" style="border-color:${COLORS[i % COLORS.length]}">
      <div><b>${i + 1}.</b> <input data-fd="name" value="${X.esc(tr.name || 'Person ' + (i + 1))}"><div class="muted small-text">${tr.manual ? 'drawn by you' : 'found automatically'} · ${X.fmtH(tr.pts[0][0])} to ${X.fmtH(tr.pts[tr.pts.length - 1][0])}</div></div>
      <label class="fd-blur"><input type="checkbox" data-fd="blur" ${data.blur[tr.id] ? 'checked' : ''}> Blur</label>
      <button class="btn ghost small" data-fd="go" type="button" title="Show this face">Show</button>
      <button class="btn ghost small" data-fd="del" type="button" title="Remove">✕</button>
    </li>`).join('') : '<li class="muted">No faces yet.</li>';
}

function wire() {
  $('fdClose').addEventListener('click', closeFaces);
  $('faceDialog').addEventListener('cancel', e => { e.preventDefault(); closeFaces(); });
  $('fdScan').addEventListener('click', scan);
  $('fdStop').addEventListener('click', () => { stopFlag = true; });
  let showing = null;
  $('fdTime').addEventListener('input', () => {
    const t = +$('fdTime').value;
    $('fdClock').textContent = X.fmtH(t);
    if (showing) return;
    showing = show(t).finally(() => { showing = null; if (Math.abs(+$('fdTime').value - t) > 0.05) $('fdTime').dispatchEvent(new Event('input')); });
  });
  $('fdList').addEventListener('change', async e => {
    const li = e.target.closest('li[data-id]');
    if (!li || !F) return;
    const data = faces(F.f), tr = data.tracks.find(x => x.id === li.dataset.id);
    if (!tr) return;
    if (e.target.dataset.fd === 'blur') { if (e.target.checked) data.blur[tr.id] = true; else delete data.blur[tr.id]; }
    if (e.target.dataset.fd === 'name') tr.name = e.target.value.trim() || tr.name;
    await X.save();
    show(+$('fdTime').value);
  });
  $('fdList').addEventListener('click', async e => {
    const b = e.target.closest('[data-fd]');
    const li = e.target.closest('li[data-id]');
    if (!b || !li || !F || F.busy) return;
    const data = faces(F.f), tr = data.tracks.find(x => x.id === li.dataset.id);
    if (!tr) return;
    if (b.dataset.fd === 'go') {
      const best = tr.pts[Math.floor(tr.pts.length / 2)][0];
      $('fdTime').value = Math.min(F.b, Math.max(F.a, best));
      show(+$('fdTime').value);
    } else if (b.dataset.fd === 'del') {
      data.tracks = data.tracks.filter(x => x !== tr); cleanBlur(data);
      await X.save(); renderList(); show(+$('fdTime').value);
    }
  });
  // drawing a box around a face
  const canvas = $('fdCanvas');
  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };
  canvas.addEventListener('pointerdown', e => {
    if (!F || F.busy) return;
    const p = pos(e);
    F.drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, w: 0, h: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!F || !F.drag) return;
    const p = pos(e), d = F.drag;
    d.x = Math.min(d.x0, p.x); d.y = Math.min(d.y0, p.y); d.w = Math.abs(p.x - d.x0); d.h = Math.abs(p.y - d.y0);
    drawFrame(cv, +$('fdTime').value);
  });
  canvas.addEventListener('pointerup', () => {
    if (!F || !F.drag) return;
    const d = F.drag; F.drag = null;
    if (d.w < 12 || d.h < 12) { drawFrame(cv, +$('fdTime').value); return; }
    follow([d.x / canvas.width, d.y / canvas.height, d.w / canvas.width, d.h / canvas.height], +$('fdTime').value);
  });
}

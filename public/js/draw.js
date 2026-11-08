// Drawing a clip or photo into the frame, shared by the preview, the shot editor and the
// export worker (so what you see in the preview is what gets exported).
// Plain script (not a module) so the export worker can load it too.

(function (root) {
  let blurCanvas = null;
  function getBlurCanvas() {
    if (!blurCanvas) blurCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(192, 192);
    return blurCanvas;
  }

  function isVideo(el) {
    return el.tagName === 'VIDEO' || (typeof VideoFrame !== 'undefined' && el instanceof VideoFrame) || el.__isVideo === true;
  }

  function size(el) {
    return [el.videoWidth || el.naturalWidth || el.displayWidth || el.width, el.videoHeight || el.naturalHeight || el.displayHeight || el.height];
  }

  // frame = { x, y, zoom, mode }: x/y (0..1) pick which part stays visible when cropping,
  // zoom >= 1, mode 'fill' (crop to fill), 'fit' (whole picture, blurred sides) or 'auto'.
  function mediaLayout(el, W, H, frame, extraZoom, video) {
    frame = frame || {}; extraZoom = extraZoom || 1;
    const [w, h] = size(el);
    if (video === undefined) video = isVideo(el);
    let mode = frame.mode || 'auto';
    if (mode === 'auto') {
      // Photos with a very different shape are shown whole; videos fill the frame
      const ratio = (w / h) / (W / H);
      mode = !video && (ratio < 0.8 || ratio > 1.25) ? 'fit' : 'fill';
    }
    const zoom = (frame.zoom || 1) * extraZoom;
    const s = (mode === 'fit' ? Math.min(W / w, H / h) : Math.max(W / w, H / h)) * zoom;
    return { w, h, mode, dw: w * s, dh: h * s };
  }

  function drawMedia(x, el, W, H, frame, extraZoom, video) {
    frame = frame || {};
    const { w, h, mode, dw, dh } = mediaLayout(el, W, H, frame, extraZoom, video);
    if (!w || !h) return;
    const fx = frame.x == null ? 0.5 : frame.x, fy = frame.y == null ? 0.5 : frame.y;
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    if (mode === 'fit') {
      const b = getBlurCanvas();
      const bw = W >= H ? 192 : 108, bh = W >= H ? 108 : 192;
      b.width = bw; b.height = bh;
      const bx = b.getContext('2d');
      bx.filter = 'blur(6px) brightness(0.5)';
      const sb = Math.max(bw / w, bh / h) * 1.2;
      bx.drawImage(el, (bw - w * sb) / 2, (bh - h * sb) / 2, w * sb, h * sb);
      x.drawImage(b, 0, 0, W, H);
    }
    x.drawImage(el, (W - dw) * fx, (H - dh) * fy, dw, dh);
  }

  // ---------- captions ----------
  // cues: [{ s, e, words: [{ w, s, e }] }], style: { preset, size, y, box, caps, highlight }
  function findCue(cues, t) {
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (t < cues[m].s) hi = m - 1; else if (t >= cues[m].e) lo = m + 1; else return cues[m];
    }
    return null;
  }

  function layoutLines(x, words, maxWidth, space) {
    const lines = [];
    let line = [], width = 0;
    for (const w of words) {
      const ww = x.measureText(w.text).width;
      if (line.length && width + space + ww > maxWidth) { lines.push({ words: line, width }); line = []; width = 0; }
      w.width = ww;
      width += (line.length ? space : 0) + ww;
      line.push(w);
    }
    if (line.length) lines.push({ words: line, width });
    return lines;
  }

  function drawCaptions(x, W, H, cues, t, style) {
    if (!cues || !cues.length || !style) return;
    const cue = findCue(cues, t);
    if (!cue) return;
    const bold = style.preset === 'bold';
    const portrait = H > W;
    const unit = portrait ? W : H;
    const size = Math.round(unit * (bold ? (portrait ? 0.085 : 0.075) : (portrait ? 0.055 : 0.046)) * (style.size || 1));
    x.save();
    x.globalAlpha = 1;
    x.font = bold ? `900 ${size}px "Arial Black", Arial, Helvetica, sans-serif` : `600 ${size}px Arial, Helvetica, sans-serif`;
    x.textBaseline = 'middle';
    const words = cue.words.map(w => ({ text: style.caps ? w.w.toUpperCase() : w.w, s: w.s, e: w.e }));
    // Footage lines start with who is speaking, and each speaker has their own color
    if (cue.who) words.unshift({ text: (style.caps ? cue.who.toUpperCase() : cue.who) + ':', s: cue.s - 1, e: cue.s - 1 });
    const space = x.measureText(' ').width;
    const lines = layoutLines(x, words, W * (bold ? 0.86 : 0.84), space);
    const lineH = size * (bold ? 1.15 : 1.3);
    const blockH = lines.length * lineH;
    let y = Math.min(H - blockH / 2 - size * 0.4, Math.max(blockH / 2 + size * 0.4, (style.y || 0.88) * H)) - blockH / 2 + lineH / 2;
    // The word being spoken right now (for highlighting)
    let active = -1;
    words.forEach((w, i) => { if (t >= w.s - 0.02) active = i; });
    let wi = 0;
    for (const line of lines) {
      let lx = (W - line.width) / 2;
      if (style.box) {
        const padX = size * 0.35, padY = size * 0.14;
        x.fillStyle = 'rgba(0,0,0,0.62)';
        const bx = lx - padX, by = y - lineH / 2 + (lineH - size) / 2 - padY, bw = line.width + padX * 2, bh = size + padY * 2;
        const r = size * 0.18;
        x.beginPath();
        if (x.roundRect) x.roundRect(bx, by, bw, bh, r); else x.rect(bx, by, bw, bh);
        x.fill();
      }
      for (const w of line.words) {
        const isActive = bold && style.highlight && wi === active;
        if (bold || !style.box) {
          x.lineJoin = 'round';
          x.lineWidth = Math.max(2, size * (bold ? 0.16 : 0.1));
          x.strokeStyle = 'rgba(0,0,0,0.95)';
          x.strokeText(w.text, lx, y);
        }
        x.fillStyle = isActive ? style.highlight : (cue.color || '#ffffff');
        x.fillText(w.text, lx, y);
        lx += w.width + space;
        wi++;
      }
      y += lineH;
    }
    x.restore();
  }

  // ---------- watermark (your logo) ----------
  // cfg = { size: share of the video height, opacity 0..1, move: 'move' | 'tl' | 'tr' | 'bl' | 'br', every: seconds }
  // Moving: a different corner every few minutes, with a short fade, so it's hard to crop or blur out.
  const ORDER_WIDE = ['br', 'tl', 'tr', 'bl'];
  const ORDER_TALL = ['tl', 'ml', 'tr']; // Shorts: away from YouTube's buttons on the right and the title at the bottom
  function watermarkBox(W, H, t, cfg) {
    const tall = H > W;
    const size = Math.round((tall ? W * 1.35 : H) * (cfg.size || 0.1));
    const m = Math.round(Math.min(W, H) * 0.035);
    const every = cfg.every || 180, fade = 0.6;
    let spot = cfg.move && cfg.move !== 'move' ? cfg.move : null, alpha = cfg.opacity == null ? 0.65 : cfg.opacity;
    if (!spot) {
      const order = tall ? ORDER_TALL : ORDER_WIDE;
      const k = Math.floor(t / every), into = t - k * every;
      spot = order[k % order.length];
      if (k > 0 && into < fade) alpha *= into / fade;                 // fade in at the new corner
      if (every - into < fade) alpha *= Math.max(0, (every - into) / fade); // fade out before moving
    }
    const pos = {
      tl: [m, tall ? H * 0.09 : m], tr: [W - m - size, tall ? H * 0.09 : m],
      bl: [m, H - m - size], br: [W - m - size, H - m - size],
      ml: [m, H * 0.58],
    }[spot] || [W - m - size, H - m - size];
    return { x: Math.round(pos[0]), y: Math.round(pos[1]), size, alpha };
  }
  function drawWatermark(x, img, W, H, t, cfg) {
    if (!img) return;
    const b = watermarkBox(W, H, t, cfg);
    if (b.alpha <= 0.01) return;
    const r = (img.width || img.naturalWidth) / (img.height || img.naturalHeight) || 1;
    const w = r >= 1 ? b.size : b.size * r, h = r >= 1 ? b.size / r : b.size;
    x.save();
    x.globalAlpha = b.alpha;
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, b.x + (b.size - w) / 2, b.y + (b.size - h) / 2, w, h);
    x.restore();
  }

  // Where drawMedia puts the picture: { x, y, w, h } on the frame
  function mediaRect(el, W, H, frame, extraZoom, video) {
    frame = frame || {};
    const { dw, dh } = mediaLayout(el, W, H, frame, extraZoom, video);
    const fx = frame.x == null ? 0.5 : frame.x, fy = frame.y == null ? 0.5 : frame.y;
    return { x: (W - dw) * fx, y: (H - dh) * fy, w: dw, h: dh };
  }

  // ---------- blurring faces ----------
  // faces = { tracks: [{ id, pts: [[t, x, y, w, h], ...] }] } with x/y/w/h as shares of the picture
  // (0..1) and t in seconds of the file. Returns the boxes to blur at file time t.
  const HOLD = 0.7, GAP = 3;
  function faceBoxesAt(faces, t) {
    const out = [];
    if (!faces || !faces.tracks) return out;
    for (const tr of faces.tracks) {
      const p = tr.pts;
      if (!p || !p.length || t < p[0][0] - HOLD || t > p[p.length - 1][0] + HOLD) continue;
      let i = 0;
      while (i < p.length - 1 && p[i + 1][0] <= t) i++;
      const a = p[i], b = p[i + 1];
      if (t <= a[0] || !b) { if (Math.abs(t - a[0]) <= HOLD || (b && b[0] - a[0] <= GAP)) out.push(a.slice(1)); continue; }
      if (b[0] - a[0] > GAP) { if (t - a[0] <= HOLD) out.push(a.slice(1)); else if (b[0] - t <= HOLD) out.push(b.slice(1)); continue; }
      const k = (t - a[0]) / (b[0] - a[0]);
      out.push([1, 2, 3, 4].map(j => a[j] + (b[j] - a[j]) * k));
    }
    return out;
  }
  let blurTmp = null;
  // Blurs each box (an oval, made a bit bigger than the face) where the picture was drawn
  function blurBoxes(x, rect, boxes) {
    if (!boxes || !boxes.length) return;
    if (!blurTmp) blurTmp = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(16, 16);
    const W = x.canvas.width, H = x.canvas.height;
    for (const [bx, by, bw, bh] of boxes) {
      const cx = rect.x + (bx + bw / 2) * rect.w, cy = rect.y + (by + bh / 2) * rect.h;
      const rw = Math.max(12, bw * rect.w * 1.55), rh = Math.max(12, bh * rect.h * 1.7);
      const sx = Math.max(0, Math.floor(cx - rw / 2)), sy = Math.max(0, Math.floor(cy - rh / 2));
      const sw = Math.min(W - sx, Math.ceil(rw)), sh = Math.min(H - sy, Math.ceil(rh));
      if (sw < 2 || sh < 2) continue;
      const tw = Math.max(3, Math.round(sw / 10)), th = Math.max(3, Math.round(sh / 10));
      blurTmp.width = tw; blurTmp.height = th;
      const bt = blurTmp.getContext('2d');
      bt.imageSmoothingEnabled = true; bt.imageSmoothingQuality = 'low';
      bt.drawImage(x.canvas, sx, sy, sw, sh, 0, 0, tw, th);
      x.save();
      x.beginPath();
      x.ellipse(cx, cy, rw / 2, rh / 2, 0, 0, Math.PI * 2);
      x.clip();
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.filter = `blur(${Math.max(2, Math.round(Math.min(sw, sh) / 14))}px)`;
      x.drawImage(blurTmp, 0, 0, tw, th, sx - sw * 0.05, sy - sh * 0.05, sw * 1.1, sh * 1.1);
      x.filter = 'none';
      x.restore();
    }
  }

  // ---------- transitions between parts ----------
  const TRANSITIONS = {
    none: { label: 'None (quick soft cut)', d: 0.25 },
    black: { label: 'Fade through black', d: 1.0 },
    cross: { label: 'Crossfade', d: 0.7 },
    slide: { label: 'Slide', d: 0.6 },
    swirl: { label: 'Swirl', d: 0.8 },
  };
  const ease = p => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  // Black over the picture around a "fade through black" cut. dt = time since the cut (negative before it)
  function blackAt(kind, dt) {
    if (kind !== 'black') return 0;
    const half = TRANSITIONS.black.d / 2;
    if (dt < -half || dt > half) return 0;
    return dt < 0 ? (dt + half) / half : 1 - dt / half;
  }
  // Draws the last picture of the previous part on top of the new one, moving it out
  function drawTransition(x, W, H, kind, dt, prev) {
    const black = blackAt(kind, dt);
    if (black > 0) { x.save(); x.globalAlpha = Math.min(1, black); x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.restore(); return; }
    const T = TRANSITIONS[kind] || TRANSITIONS.none;
    if (!prev || kind === 'black' || dt < 0 || dt >= T.d) return;
    const p = dt / T.d, e = ease(p);
    x.save();
    if (kind === 'slide') {
      x.drawImage(prev, -W * e, 0, W, H);
      x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(W - W * e - 2, 0, 4, H); // a soft edge
    } else if (kind === 'swirl') {
      x.globalAlpha = 1 - e;
      x.translate(W / 2, H / 2); x.rotate(e * 1.2); const sc = 1 + e * 1.4; x.scale(sc, sc);
      x.filter = `blur(${Math.round(e * Math.min(W, H) / 60)}px)`;
      x.drawImage(prev, -W / 2, -H / 2, W, H);
      x.filter = 'none';
    } else {
      x.globalAlpha = 1 - (kind === 'cross' ? e : p);
      x.drawImage(prev, 0, 0, W, H);
    }
    x.restore();
  }

  // ---------- date and place card ----------
  // card = { date, place, anim: 'roll' | 'type', dur }, t = seconds since the card appears
  function drawInfoCard(x, W, H, card, t) {
    if (!card || t < 0) return;
    const dur = card.dur || 6;
    if (t > dur) return;
    const lines = [card.date, card.place].map(v => String(v || '').trim()).filter(Boolean);
    if (!lines.length) return;
    const tall = H > W, unit = tall ? W : H;
    const s1 = Math.round(unit * (tall ? 0.06 : 0.052)), s2 = Math.round(unit * (tall ? 0.042 : 0.036));
    const left = Math.round(tall ? W * 0.08 : W * 0.06);
    const bottom = Math.round(tall ? H * 0.72 : H * 0.8);
    const sizes = lines.map((_, i) => (i === 0 ? s1 : s2));
    const gap = Math.round(unit * 0.014);
    const blockH = sizes.reduce((a, b) => a + b * 1.25, 0) + gap * (lines.length - 1);
    const top = bottom - blockH;
    const out = Math.max(0, Math.min(1, (t - (dur - 0.6)) / 0.6)); // leaving
    x.save();
    x.globalAlpha = 1 - out;
    x.textBaseline = 'top';
    // a soft dark shade behind the text, so it reads on bright footage
    let tw = 0;
    lines.forEach((line, i) => { x.font = i === 0 ? `700 ${sizes[i]}px Arial, Helvetica, sans-serif` : `400 ${sizes[i]}px Arial, Helvetica, sans-serif`; tw = Math.max(tw, x.measureText(line).width); });
    const shade = Math.min(1, t / 0.5);
    const g = x.createLinearGradient(left - unit * 0.05, 0, left + tw + unit * 0.2, 0);
    g.addColorStop(0, `rgba(0,0,0,${0.55 * shade})`); g.addColorStop(0.7, `rgba(0,0,0,${0.35 * shade})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.fillRect(left - unit * 0.05, top - unit * 0.03, tw + unit * 0.25, blockH + unit * 0.06);
    // accent bar grows first
    const bar = Math.min(1, t / 0.35);
    x.fillStyle = '#c8102e';
    const bw = Math.max(4, Math.round(unit * 0.008));
    x.fillRect(left - bw * 3, top + blockH * (1 - bar) / 2, bw, blockH * bar);
    let y = top;
    lines.forEach((line, i) => {
      const size = sizes[i];
      x.font = i === 0 ? `700 ${size}px Arial, Helvetica, sans-serif` : `400 ${size}px Arial, Helvetica, sans-serif`;
      const lh = size * 1.25;
      const start = 0.3 + i * 0.35;
      let text = line, dy = 0;
      if (card.anim === 'type') {
        const n = Math.floor(Math.max(0, t - start) * 22);
        text = line.slice(0, n);
      } else {
        const p = ease(Math.max(0, Math.min(1, (t - start) / 0.55)));
        dy = (1 - p) * lh;
        x.save(); x.beginPath(); x.rect(left - 4, y - 2, W, lh + 4); x.clip(); // rolls up from behind a line
      }
      if (text) {
        x.lineJoin = 'round'; x.lineWidth = Math.max(3, size * 0.14); x.strokeStyle = 'rgba(0,0,0,0.75)';
        x.strokeText(text, left, y + dy);
        x.fillStyle = i === 0 ? '#ffffff' : '#e6e3dc';
        x.fillText(text, left, y + dy);
        if (card.anim === 'type' && text.length < line.length && Math.floor(t * 3) % 2 === 0) x.fillRect(left + x.measureText(text).width + 4, y + size * 0.1, Math.max(2, size * 0.08), size * 0.9);
      }
      if (card.anim !== 'type') x.restore();
      y += lh + gap;
    });
    x.restore();
  }

  root.CaseDraw = { drawMedia, mediaLayout, mediaRect, drawCaptions, watermarkBox, drawWatermark, faceBoxesAt, blurBoxes, TRANSITIONS, blackAt, drawTransition, drawInfoCard };
})(typeof self !== 'undefined' ? self : window);

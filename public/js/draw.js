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
        x.fillStyle = isActive ? style.highlight : '#ffffff';
        x.fillText(w.text, lx, y);
        lx += w.width + space;
        wi++;
      }
      y += lineH;
    }
    x.restore();
  }

  root.CaseDraw = { drawMedia, mediaLayout, drawCaptions };
})(typeof self !== 'undefined' ? self : window);

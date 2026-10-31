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

  root.CaseDraw = { drawMedia, mediaLayout };
})(typeof self !== 'undefined' ? self : window);

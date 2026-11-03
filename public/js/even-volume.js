// Evens out loudness in the previews: quiet recordings (like an interview room microphone) are
// turned up and loud ones turned down, so everything plays at about the same level. The final
// video does the same in the export (story-export-worker.js, level()).
//
// The element's own volume/muted are kept by this code (the app still sets them as before), and
// applied after the levelling, so turning the footage down under narration still works.

let ctx = null;
const TARGET = 0.07;          // level speech is brought to
const MIN = 0.5, MAX = 14;    // how far it may turn down or up
const GATE = 0.003;           // quieter than this is silence or room noise: not measured
const known = new Map();      // recording -> its measured level, so it starts right next time
const proto = HTMLMediaElement.prototype;
const dVol = Object.getOwnPropertyDescriptor(proto, 'volume');
const dMuted = Object.getOwnPropertyDescriptor(proto, 'muted');
const keyOf = u => String(u || '').split('?')[0];

export function evenVolume(el) {
  if (!el || el.__even || !(window.AudioContext || window.webkitAudioContext)) return;
  const st = { vol: dVol.get.call(el), muted: dMuted.get.call(el), level: null, key: '', node: null };
  el.__even = st;
  const apply = () => {
    if (st.node) {
      dVol.set.call(el, 1); dMuted.set.call(el, false);
      st.out.gain.value = st.muted ? 0 : st.vol;
    } else { dVol.set.call(el, st.vol); dMuted.set.call(el, st.muted); }
  };
  Object.defineProperty(el, 'volume', { configurable: true, get: () => st.vol, set: v => { st.vol = Math.max(0, Math.min(1, +v || 0)); apply(); } });
  Object.defineProperty(el, 'muted', { configurable: true, get: () => st.muted, set: v => { st.muted = !!v; apply(); } });
  el.crossOrigin = 'anonymous';

  // If the cloud doesn't allow this kind of loading, play it the normal way (without levelling)
  el.addEventListener('error', () => {
    if (st.node || !el.hasAttribute('crossorigin') || String(el.currentSrc || el.src).startsWith('blob:')) return;
    const src = el.src;
    el.removeAttribute('crossorigin');
    if (src) { el.src = src; el.load(); }
  });
  el.addEventListener('loadstart', () => {
    st.key = keyOf(el.currentSrc || el.src);
    st.level = known.get(st.key) || null;
    if (st.agc) st.agc.gain.value = st.level ? gainFor(st.level) : 1;
  });
  el.addEventListener('loadedmetadata', () => {
    if (st.node || !el.hasAttribute('crossorigin') && !String(el.currentSrc).startsWith('blob:')) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      st.node = ctx.createMediaElementSource(el);
      st.an = ctx.createAnalyser(); st.an.fftSize = 2048;
      st.agc = ctx.createGain(); st.agc.gain.value = st.level ? gainFor(st.level) : 1;
      st.out = ctx.createGain();
      const lim = ctx.createDynamicsCompressor(); // catches shouting after turning up
      lim.threshold.value = -9; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.2;
      st.node.connect(st.an);
      st.node.connect(st.agc); st.agc.connect(lim); lim.connect(st.out); st.out.connect(ctx.destination);
      st.buf = new Float32Array(st.an.fftSize);
      apply();
      setInterval(() => measure(el, st), 100);
    } catch (e) { console.warn('Volume levelling is off:', e); }
  });
  el.addEventListener('play', () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); });
}

const gainFor = level => Math.max(MIN, Math.min(MAX, TARGET / level));

function measure(el, st) {
  if (el.paused || el.seeking) return;
  st.an.getFloatTimeDomainData(st.buf);
  let sum = 0;
  for (let i = 0; i < st.buf.length; i++) sum += st.buf[i] * st.buf[i];
  const rms = Math.sqrt(sum / st.buf.length);
  if (rms < GATE) return;
  // follows the speech (rises quickly, falls slowly, so pauses don't make it pump)
  st.level = st.level == null ? rms : st.level + (rms > st.level ? 0.25 : 0.02) * (rms - st.level);
  known.set(st.key, st.level);
  st.agc.gain.setTargetAtTime(gainFor(st.level), ctx.currentTime, 0.25);
}

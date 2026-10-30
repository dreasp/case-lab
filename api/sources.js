// Footage sources: Pixabay (videos + photos) and Wikimedia Commons (real historical
// people, places, documents). Pexels can be added here later when they reopen API keys.

const PIXABAY = () => process.env.PIXABAY_BASE || 'https://pixabay.com/api';
const WIKI = () => process.env.WIKI_BASE || 'https://commons.wikimedia.org/w/api.php';
const UA = 'CaseLab/1.0 (personal video research tool)';
// Some image servers refuse requests that don't look like a normal browser
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': '*/*',
  'Referer': 'https://pixabay.com/',
};
const pixKey = () => String(process.env.PIXABAY_API_KEY || '').trim();
// Last Pixabay problem, shown on the check page
let lastPixabayError = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pixabay asks that identical searches are cached for 24 hours
const cache = new Map();
const DAY = 24 * 60 * 60 * 1000;
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < DAY) return hit.v;
  const v = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return v;
}

// Pixabay allows 100 requests per minute, so space them out
let lastPixabay = 0;
let pixChain = Promise.resolve();
function pixabayFetch(url) {
  const run = pixChain.then(async () => {
    const wait = lastPixabay + 700 - Date.now();
    if (wait > 0) await sleep(wait);
    lastPixabay = Date.now();
    for (let i = 0; i < 3; i++) {
      const r = await fetch(url, { headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Accept': 'application/json' } });
      if (r.status === 429) { await sleep(15000); continue; }
      if (!r.ok) {
        const body = (await r.text()).slice(0, 200).replace(/\s+/g, ' ');
        lastPixabayError = `Pixabay error ${r.status}: ${body}`;
        throw new Error(lastPixabayError);
      }
      const text = await r.text();
      try { return JSON.parse(text); } catch (e) {
        lastPixabayError = 'Pixabay sent something that is not JSON: ' + text.slice(0, 150).replace(/\s+/g, ' ');
        throw new Error(lastPixabayError);
      }
    }
    throw new Error('Pixabay rate limit reached. Try again in a minute.');
  });
  pixChain = run.catch(() => {});
  return run;
}

function cleanQuery(q) {
  return String(q || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 95);
}

async function pixabayVideos(q, n = 8) {
  const key = pixKey();
  if (!key || !q) return [];
  const url = `${PIXABAY()}/videos/?key=${key}&q=${encodeURIComponent(q)}&safesearch=true&per_page=${Math.max(3, n)}`;
  const data = await cached('v|' + q, () => pixabayFetch(url));
  return (data.hits || []).map(h => {
    const v = h.videos || {};
    const big = v.large && v.large.url ? v.large : null;
    const med = v.medium && v.medium.url ? v.medium : null;
    const best = big || med || v.small || v.tiny || {};
    const thumb = (med && med.thumbnail) || (v.small && v.small.thumbnail) || (v.tiny && v.tiny.thumbnail) ||
      (best.thumbnail) || (h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_640x360.jpg` : '');
    return {
      key: 'pxv-' + h.id, source: 'Pixabay', type: 'video', id: h.id,
      url: best.url, urlSmall: (med || best).url, width: best.width, height: best.height,
      duration: h.duration, thumb, page: h.pageURL, tags: h.tags,
      credit: `Video by ${h.user || 'unknown'} from Pixabay`,
    };
  }).filter(c => c.url).slice(0, n);
}

async function pixabayPhotos(q, n = 6) {
  const key = pixKey();
  if (!key || !q) return [];
  const url = `${PIXABAY()}/?key=${key}&q=${encodeURIComponent(q)}&image_type=photo&safesearch=true&per_page=${Math.max(3, n)}`;
  const data = await cached('p|' + q, () => pixabayFetch(url));
  return (data.hits || []).map(h => ({
    key: 'pxp-' + h.id, source: 'Pixabay', type: 'photo', id: h.id,
    url: h.largeImageURL || h.webformatURL, width: h.imageWidth, height: h.imageHeight,
    thumb: (h.webformatURL || '').replace('_640', '_340') || h.previewURL,
    page: h.pageURL, tags: h.tags,
    credit: `Image by ${h.user || 'unknown'} from Pixabay`,
  })).filter(c => c.url).slice(0, n);
}

// Look up one Pixabay item again (photo links expire after a day)
async function pixabayById(type, id) {
  const key = pixKey();
  const base = type === 'video' ? `${PIXABAY()}/videos/` : `${PIXABAY()}/`;
  const data = await cached(`id|${type}|${id}`, () => pixabayFetch(`${base}?key=${key}&id=${encodeURIComponent(id)}`));
  const h = (data.hits || [])[0];
  if (!h) return null;
  if (type === 'video') {
    const v = h.videos || {};
    // 720p is plenty for B-roll and much lighter to stream
    return (v.medium && v.medium.url) || (v.large && v.large.url) || (v.small && v.small.url) || null;
  }
  return h.largeImageURL || h.webformatURL || null;
}

const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function wikimedia(q, n = 5) {
  if (!q) return [];
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: q + ' filetype:bitmap',
    gsrnamespace: '6', gsrlimit: String(n * 2), prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1920',
  });
  const data = await cached('w|' + q, async () => {
    const r = await fetch(`${WIKI()}?${params}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`Wikimedia error ${r.status}`);
    return r.json();
  });
  const pages = Object.values((data.query && data.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const out = [];
  for (const p of pages) {
    const ii = (p.imageinfo || [])[0];
    if (!ii || !/^image\/(jpeg|png|webp|tiff|gif)/.test(ii.mime || '')) continue;
    const md = ii.extmetadata || {};
    const lic = stripHtml(md.LicenseShortName && md.LicenseShortName.value);
    // Only licenses that allow commercial use and editing
    if (/\b(NC|ND)\b|non-?commercial|no ?deriv|fair use/i.test(lic)) continue;
    if (!/public domain|^pd|cc0|cc[ -]by/i.test(lic)) continue;
    const artist = stripHtml(md.Artist && md.Artist.value) || 'Unknown author';
    const title = String(p.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '');
    out.push({
      key: 'wm-' + p.pageid, source: 'Wikimedia', type: 'photo', id: p.pageid,
      url: ii.thumburl || ii.url, width: ii.thumbwidth || ii.width, height: ii.thumbheight || ii.height,
      thumb: (ii.thumburl || ii.url).replace(/\/(\d+)px-/, '/400px-'),
      page: ii.descriptionurl, tags: title,
      credit: `"${title}" by ${artist}, ${lic}, via Wikimedia Commons`,
      needsCredit: !/public domain|^pd|cc0/i.test(lic),
    });
    if (out.length >= n) break;
  }
  return out;
}

// Hosts the media pass-through is allowed to fetch from
function allowedHost(u) {
  let host;
  try { host = new URL(u).hostname; } catch (e) { return false; }
  const extra = (process.env.MEDIA_EXTRA_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  return host === 'pixabay.com' || host.endsWith('.pixabay.com') ||
    host === 'upload.wikimedia.org' || host === 'i.vimeocdn.com' || extra.includes(host);
}

function pixabayKeyInfo() {
  const raw = String(process.env.PIXABAY_API_KEY || '');
  return { set: !!raw.trim(), length: raw.trim().length, hadSpaces: raw !== raw.trim() };
}

module.exports = { pixabayKeyInfo, BROWSER_HEADERS, getLastPixabayError: () => lastPixabayError, pixabayVideos, pixabayPhotos, pixabayById, wikimedia, allowedHost, cleanQuery, UA };

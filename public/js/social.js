// Posting a Short: post details (Gemini), YouTube and Instagram now or at a set time, and TikTok by
// hand (download the video, copy the caption). The server does the posting (api/social.js).

const $ = id => document.getElementById(id);
let X = null;
let status = null;          // { youtube: { ready, connected, name }, instagram: {...} }
let posts = [];             // posts of the open case
let postsFor = null;
let pollTimer = null;
const busy = new Set();     // shorts whose details are being written

const NAMES = { youtube: 'YouTube', instagram: 'Instagram' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const when = t => {
  const d = new Date(t);
  const h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${h}:${m} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
};
const hashtags = p => (p.hashtags || []).map(t => '#' + String(t).replace(/^#/, '')).join(' ');
const caption = p => [String(p.description || '').trim(), hashtags(p)].filter(Boolean).join('\n\n');

export function initSocial(helpers) {
  X = helpers;
  window.addEventListener('message', e => { if (e.origin === location.origin && /^social-/.test(e.data)) refreshStatus(); });
  window.addEventListener('focus', () => { if (!$('ctab-shorts').classList.contains('hidden')) refreshStatus(); });
  $('socialAccounts').addEventListener('click', async e => {
    const b = e.target.closest('[data-acc]');
    if (!b) return;
    const pf = b.dataset.pf;
    if (b.dataset.acc === 'connect') window.open(`/api/social/${pf}/connect`, '_blank', 'width=560,height=720');
    else if (confirm(`Disconnect ${NAMES[pf]}? Posts already scheduled on ${NAMES[pf]} stay scheduled.`)) {
      await X.api('social/disconnect', { platform: pf }).catch(err => alert(err.message));
      refreshStatus();
    }
  });
}

// Called when the Shorts tab opens
export async function refreshSocial() {
  await Promise.all([refreshStatus(), refreshPosts()]);
}
async function refreshStatus() {
  try { status = await X.api('social/status'); } catch (e) { status = null; }
  renderAccounts();
  X.rerender();
}
async function refreshPosts() {
  const c = X.cur();
  if (!c) return;
  try { posts = (await X.api('social/posts?project=' + encodeURIComponent(c.id))).posts || []; postsFor = c.id; } catch (e) { posts = []; }
  X.rerender();
  // keep the list fresh while something is uploading
  clearTimeout(pollTimer);
  if (posts.some(p => p.status === 'queued' || p.status === 'posting')) pollTimer = setTimeout(() => { if (!$('ctab-shorts').classList.contains('hidden')) refreshPosts(); }, 8000);
}

function renderAccounts() {
  const el = $('socialAccounts');
  if (!status) { el.innerHTML = ''; return; }
  el.innerHTML = `<span class="muted small-text">Accounts for posting:</span> ${['youtube', 'instagram'].map(pf => {
    const s = status[pf];
    if (!s.ready) return `<span class="acc off small-text" title="Add the keys on Render to turn this on">${NAMES[pf]}: not set up yet</span>`;
    return s.connected
      ? `<span class="acc on small-text">${NAMES[pf]}: ${X.esc(s.name)} <button class="btn ghost small" data-acc="disconnect" data-pf="${pf}" type="button">Disconnect</button></span>`
      : `<button class="btn small" data-acc="connect" data-pf="${pf}" type="button">Connect ${NAMES[pf]}</button>`;
  }).join(' ')} <span class="acc small-text muted">TikTok: by hand (download and copy the caption)</span>`;
}

const STATUS = {
  queued: 'Uploading…', posting: 'Posting…', scheduled: 'Scheduled', 'scheduled-remote': 'Scheduled on YouTube', posted: 'Posted', failed: 'Failed',
};

// The "Post it" section of a Short card
export function postHtml(c, sh) {
  const p = sh.post || {};
  const v = sh.video;
  const mine = postsFor === c.id ? posts.filter(x => x.short === sh.id) : [];
  const conn = pf => status && status[pf] && status[pf].connected;
  const anyConn = conn('youtube') || conn('instagram');
  const pick = sh.postTo || { youtube: true, instagram: true };
  const badge = mine.length ? ` · ${mine.filter(x => x.status === 'posted').length} posted, ${mine.filter(x => /scheduled/.test(x.status)).length} scheduled` : '';
  return `<details class="seg-vis short-post" data-post="${sh.id}" ${sh.postOpen ? 'open' : ''}><summary>Post it (YouTube, Instagram, TikTok)${badge}</summary>
    <div class="sp-body">
      <div class="small-text ${v ? '' : 'muted'}">${v
        ? `Exported video ready (${X.fmtH(v.duration || 0)}, ${when(v.at)}). <button class="btn ghost small" data-sp="download" type="button">Download</button>`
        : 'Export this Short first ("Preview and export"). The exported video is kept in the cloud so it can be posted from here.'}</div>
      <div class="sp-row"><button class="btn small" data-sp="write" type="button" ${busy.has(sh.id) ? 'disabled' : ''}>${busy.has(sh.id) ? 'Writing…' : p.titles ? 'Write new post details' : 'Write post details'}</button>
        <span class="muted small-text">Gemini writes 3 titles, a description and hashtags (well under 1 cent). You can edit them.</span></div>
      ${(p.titles || []).length ? `<div class="sp-titles small-text">${p.titles.map((t, i) => `<label><input type="radio" name="spt-${sh.id}" data-sp="title" data-i="${i}" ${t === p.title ? 'checked' : ''}> ${X.esc(t)}</label>`).join('')}</div>` : ''}
      <label class="small-text">Title (YouTube)<input data-pf="title" maxlength="100" value="${X.esc(p.title || '')}"></label>
      <label class="small-text">Description<textarea data-pf="description" rows="3">${X.esc(p.description || '')}</textarea></label>
      <label class="small-text">Hashtags (separated by spaces)<input data-pf="hashtags" value="${X.esc(hashtags(p))}"></label>
      <div class="sp-row"><button class="btn ghost small" data-sp="copy" type="button">Copy caption (description and hashtags)</button></div>
      <div class="sp-row small-text">Post to:
        ${['youtube', 'instagram'].map(pf => `<label class="${conn(pf) ? '' : 'muted'}"><input type="checkbox" data-sp="to" data-pf="${pf}" ${conn(pf) && pick[pf] ? 'checked' : ''} ${conn(pf) ? '' : 'disabled'}> ${NAMES[pf]}${conn(pf) ? '' : ' (connect it above)'}</label>`).join(' ')}
      </div>
      <div class="sp-row small-text">
        <label><input type="radio" name="spw-${sh.id}" data-sp="now" ${sh.postAt ? '' : 'checked'}> Now</label>
        <label><input type="radio" name="spw-${sh.id}" data-sp="later" ${sh.postAt ? 'checked' : ''}> At</label>
        <input type="datetime-local" data-sp="at" value="${X.esc(sh.postAt || '')}">
        <button class="btn primary small" data-sp="post" type="button" ${v && anyConn ? '' : 'disabled'}>${sh.postAt ? 'Schedule' : 'Post'}</button>
      </div>
      ${mine.length ? `<ul class="sp-posts small-text">${mine.map(x => `<li>
        <strong>${NAMES[x.platform]}</strong> · ${x.publishAt ? when(x.publishAt) : 'now'} · <span class="sp-st ${x.status}">${STATUS[x.status] || x.status}</span>
        ${x.link ? ` · <a href="${X.esc(x.link)}" target="_blank" rel="noopener">open</a>` : ''}
        ${x.error ? `<div class="${x.status === 'failed' ? 'sp-err' : 'muted'}">${X.esc(x.error)}</div>` : ''}
        ${x.status === 'failed' ? `<button class="btn ghost small" data-sp="retry" data-id="${x.id}" type="button">Try again</button>` : ''}
        ${x.status === 'scheduled' ? `<button class="btn ghost small" data-sp="remove" data-id="${x.id}" type="button">Cancel</button>`
          : x.status !== 'posting' && x.status !== 'queued' ? `<button class="btn ghost small" data-sp="remove" data-id="${x.id}" type="button" title="Removes it from this list only">Hide</button>` : ''}
        ${x.status === 'scheduled-remote' ? '<div class="muted">To change or cancel it, use YouTube Studio.</div>' : ''}
      </li>`).join('')}</ul>` : ''}
      <div class="muted small-text">TikTok: click Download (or open the app on your phone and download it there), then upload it in TikTok and paste the caption.${status && status.instagram && status.instagram.connected ? ' Scheduled Instagram posts go out when the time comes, as long as the app is kept awake.' : ''}</div>
    </div>
  </details>`;
}

const parseTags = v => String(v || '').split(/[\s,]+/).map(t => t.replace(/^#+/, '').trim()).filter(Boolean);

// Wires the post sections inside the Shorts list (event delegation)
export function wireSocialList(list, shortById) {
  const at = e => { const box = e.target.closest('[data-post]'); return box ? shortById(box.dataset.post) : null; };
  list.addEventListener('toggle', e => { if (!e.target.matches('.short-post')) return; const sh = shortById(e.target.dataset.post); if (sh) sh.postOpen = e.target.open; }, true);
  list.addEventListener('input', e => {
    const sh = at(e);
    const f = e.target.dataset.pf;
    if (!sh || !f || e.target.type === 'checkbox') return;
    sh.post = sh.post || {};
    if (f === 'hashtags') sh.post.hashtags = parseTags(e.target.value); else sh.post[f] = e.target.value;
    clearTimeout(list._pt); list._pt = setTimeout(() => X.save(), 600);
  });
  list.addEventListener('change', async e => {
    const sh = at(e);
    const k = e.target.dataset.sp;
    if (!sh || !k) return;
    if (k === 'title') { sh.post.title = sh.post.titles[+e.target.dataset.i]; }
    else if (k === 'to') { sh.postTo = { ...(sh.postTo || { youtube: true, instagram: true }), [e.target.dataset.pf]: e.target.checked }; }
    else if (k === 'now') sh.postAt = '';
    else if (k === 'later' || k === 'at') {
      const input = e.target.closest('[data-post]').querySelector('[data-sp="at"]');
      if (!input.value) { const d = new Date(Date.now() + 86400000); d.setMinutes(0, 0, 0); input.value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
      sh.postAt = input.value;
      const box = e.target.closest('[data-post]');
      box.querySelector('[data-sp="later"]').checked = true;
      box.querySelector('[data-sp="post"]').textContent = 'Schedule';
      return X.save();
    } else return;
    await X.save();
    X.rerender();
  });
  list.addEventListener('click', async e => {
    const b = e.target.closest('button[data-sp]');
    if (!b) return;
    const sh = at(e);
    if (!sh) return;
    const c = X.cur();
    const k = b.dataset.sp;
    if (k === 'write') return writeDetails(c, sh);
    if (k === 'copy') {
      const text = caption(sh.post || {});
      if (!text) return alert('Write the description first.');
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy caption (description and hashtags)'; }, 1500); } catch (err) { prompt('Copy the caption:', text); }
      return;
    }
    if (k === 'download') {
      try {
        const { url } = await X.api('social/download-url', { project: c.id, short: sh.id, name: (sh.post && sh.post.title) || sh.title });
        location.href = url;
      } catch (err) { alert('The download failed: ' + err.message); }
      return;
    }
    if (k === 'retry' || k === 'remove') {
      if (k === 'remove' && /Cancel/.test(b.textContent) && !confirm('Cancel this scheduled post?')) return;
      await X.api(`social/posts/${b.dataset.id}/${k}`, {}).catch(err => alert(err.message));
      return refreshPosts();
    }
    if (k === 'post') return post(c, sh, b);
  });
}

async function writeDetails(c, sh) {
  busy.add(sh.id); X.rerender();
  try {
    const transcript = X.clipsText(sh);
    const r = await X.api('case/short-post', { title: c.title, context: X.contextText(c), short: { title: sh.title, intro: sh.intro, outro: sh.outro, transcript } });
    if (!r.titles || !r.titles.length) throw new Error('Nothing came back. Try again in a moment.');
    sh.post = { titles: r.titles, title: r.titles[0], description: r.description, hashtags: r.hashtags };
    sh.postOpen = true;
    await X.save();
    if (X.refreshUsage) X.refreshUsage();
  } catch (e) { alert('Writing the post details failed: ' + e.message); }
  finally { busy.delete(sh.id); X.rerender(); }
}

async function post(c, sh, b) {
  const p = sh.post || {};
  const to = ['youtube', 'instagram'].filter(pf => status && status[pf] && status[pf].connected && (sh.postTo || { youtube: true, instagram: true })[pf]);
  if (!to.length) return alert('Pick where to post it.');
  if (!(p.title || '').trim() && to.includes('youtube')) return alert('Add a title first (or click "Write post details").');
  if (!(p.description || '').trim()) return alert('Add a description first (or click "Write post details").');
  let publishAt = null;
  if (sh.postAt) {
    publishAt = new Date(sh.postAt).getTime();
    if (!(publishAt > Date.now() + 60000)) return alert('Pick a time in the future.');
  }
  const again = posts.filter(x => x.short === sh.id && to.includes(x.platform) && x.status !== 'failed');
  if (again.length && !confirm(`This Short was already sent to ${[...new Set(again.map(x => NAMES[x.platform]))].join(' and ')}. Post it again?`)) return;
  if (!confirm(`${publishAt ? 'Schedule' : 'Post'} "${p.title || sh.title}" on ${to.map(x => NAMES[x]).join(' and ')}${publishAt ? ' for ' + when(publishAt) : ' now'}?`)) return;
  b.disabled = true; b.textContent = 'Sending…';
  try {
    await X.api('social/posts', {
      platforms: to, project: c.id, short: sh.id,
      title: (p.title || sh.title).trim(), caption: String(p.description || '').trim(), tags: p.hashtags || [], publishAt,
    });
  } catch (e) { alert('Posting failed: ' + e.message); }
  finally { await refreshPosts(); }
}

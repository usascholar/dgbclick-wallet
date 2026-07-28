// "Spend DD" merchant directory (#spend-modal): a display-only client of
// /api/directory — the screen fetches FRESH on every open (cheap; the server
// caches upstream) and never caches across opens. The payload is untrusted
// JSON: validateDirectory (tolerant, like history) drops malformed entries and
// guards the envelope, and every interpolated string goes through esc().
// Voting is server-truth only: no optimistic increments — the button shows
// what the POST answered. app.js wires this once with initDirectory(ctx).
import { validateDirectory } from '/validate.js';

// updatedAt is an ISO string; relTime answers "3h ago" style text or null
// when the stamp is missing/unparseable (the footer just skips it then).
function relTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString('en-CA');
}

// Voter identity: one random token per wallet installation, kept in
// localStorage and sent as x-voter-token on every directory call. This is
// what makes votes additive across wallets — without it the server only sees
// the shared IP and a second wallet would toggle the first wallet's vote off.
// Best-effort like every localStorage use here: private mode just means a
// session-scoped token (votes still work, keyed by IP as the server fallback
// only if storage is fully unavailable AND the token never sticks).
const VOTER_KEY = 'diginaut.voterId';
function voterToken() {
  let token = null;
  try { token = localStorage.getItem(VOTER_KEY); } catch { /* private mode */ }
  if (token && /^[0-9a-f]{32}$/.test(token)) return token;
  token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(VOTER_KEY, token); } catch { /* session-scoped */ }
  return token;
}

/** ctx is app.js's wiring bag: $, esc, fetchJson (the shared timeout +
 * friendly-error fetch helper — module-local in app.js, so it arrives here
 * by injection, same as treasury-ui.js receives rpc). */
export function initDirectory(ctx) {
  const $ = ctx.$;
  const esc = ctx.esc;
  const fetchJson = ctx.fetchJson;
  const voterHeaders = { 'x-voter-token': voterToken() };

  let directory = null; // last validated payload — the vote handler patches it

  // Link text for a merchant is its domain, never the raw URL string.
  const hostnameOf = (url) => {
    try { return new URL(url).hostname; } catch { return url; }
  };
  const listedLink = (listUrl, text) =>
    listUrl ? `<a href="${esc(listUrl)}" target="_blank" rel="noopener">${esc(text)}</a>` : '';

  // Exactly one state visible at a time: loading / error / empty / list.
  function show(state, errText = '') {
    $('spend-loading').style.display = state === 'loading' ? 'block' : 'none';
    $('spend-err').textContent = errText;
    $('spend-retry').style.display = state === 'error' ? 'inline-block' : 'none';
    $('spend-empty').style.display = state === 'empty' ? 'block' : 'none';
    $('spend-list').style.display = state === 'list' ? 'block' : 'none';
    $('spend-foot').style.display = state === 'list' ? 'block' : 'none';
  }

  function render() {
    const { merchants, updatedAt, listUrl } = directory;
    if (merchants.length === 0) {
      // launch state is a designed screen, not an error
      $('spend-empty').innerHTML =
        '<div class="t-head"><span class="t-name">No listings yet</span></div>' +
        `<div class="t-rows">DD is brand new and this list is just getting started. Accept DD at your site? ` +
        `${listedLink(listUrl, 'Get listed →') || 'ask to get listed where you found this wallet.'}</div>`;
      show('empty');
      return;
    }
    $('spend-list').innerHTML = merchants.map((m) =>
      `<div class="t-card spend-card"><div class="t-head"><span class="t-name">${esc(m.name)}</span>` +
      `<span class="t-status">${esc(m.category)}</span></div>` +
      `<div class="t-rows">${m.blurb ? `<div>${esc(m.blurb)}</div>` : ''}` +
      `<div><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(hostnameOf(m.url))}</a></div></div>` +
      `<div class="t-actions"><button type="button" class="secondary spend-vote${m.votedByYou ? ' voted' : ''}" ` +
      `data-spend-vote="${esc(m.id)}">▲ ${esc(m.votes)}</button></div>` +
      `<div class="err" data-spend-err="${esc(m.id)}" style="display:none"></div></div>`).join('');
    const updated = relTime(updatedAt);
    $('spend-foot').innerHTML =
      (updated ? `Updated ${esc(updated)}` : 'Directory') +
      (listUrl ? ` · ${listedLink(listUrl, 'Get listed →')}` : '');
    show('list');
  }

  async function loadDirectory() {
    show('loading');
    try {
      const json = await fetchJson('/api/directory', { headers: voterHeaders }, 20_000, 'the directory');
      directory = validateDirectory(json);
      render();
    } catch (err) {
      show('error', err.message);
    }
  }

  // One delegated handler for every vote button. The server's response is the
  // truth — the count/highlight updates only from what it answers.
  $('spend-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-spend-vote]');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.spendVote; // validated id pattern — selector-safe
    const errBox = $('spend-list').querySelector(`[data-spend-err="${id}"]`);
    btn.disabled = true;
    errBox.style.display = 'none';
    errBox.textContent = '';
    try {
      const res = await fetchJson('/api/directory/vote', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...voterHeaders },
        body: JSON.stringify({ id }),
      }, 20_000, 'the directory');
      const votes = Math.max(0, Number(res.votes) || 0);
      btn.textContent = `▲ ${votes}`;
      btn.classList.toggle('voted', !!res.voted);
      const m = directory?.merchants.find((x) => x.id === id);
      if (m) { m.votes = votes; m.votedByYou = !!res.voted; }
    } catch (err) {
      errBox.textContent = /429|rate|too many|slow/i.test(err.message)
        ? 'slow down — one vote at a time'
        : err.message;
      errBox.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });

  $('spend-retry').addEventListener('click', loadDirectory);
  $('act-spend').addEventListener('click', () => {
    $('spend-modal').classList.add('open');
    loadDirectory();
  });
}

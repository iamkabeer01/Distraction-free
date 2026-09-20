const DEFAULT_MODEL = 'gemini-3.6-flash';
const DEFAULT_CHECK_MINUTES = 2;
const MAX_ATTEMPTS = 5;

const $ = (id) => document.getElementById(id);

/* ── status glyphs ─────────────────────────────────────────────────────────
   Composed from circles, lines and polylines rather than traced icon paths,
   so every status reads as glyph + word and never as colour alone.          */
const GLYPH = {
  good: '<polyline points="2.5 6.2 4.9 8.6 9.5 3.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  critical:
    '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.7"/><line x1="3" y1="9" x2="9" y2="3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  warning:
    '<polygon points="6 1.4 11.2 10.6 0.8 10.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="6" y1="4.8" x2="6" y2="7.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="9.1" r=".8" fill="currentColor"/>',
  clock:
    '<circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5"/><polyline points="6 3.2 6 6.2 8.2 7.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  spinner:
    '<circle class="spin" cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-dasharray="19 9"/>',
};
const svg = (name) => `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">${GLYPH[name]}</svg>`;

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/* ── theme ──────────────────────────────────────────────────────────────── */

chrome.storage.local.get('theme', ({ theme }) => {
  if (theme) document.documentElement.dataset.theme = theme;
});

$('themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const current =
    root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  chrome.storage.local.set({ theme: next });
});

/* ── tabs ───────────────────────────────────────────────────────────────── */

const TAB_NAMES = ['monitor', 'settings', 'prompt'];

function showTab(name) {
  const index = TAB_NAMES.indexOf(name);
  if (index < 0) return;
  TAB_NAMES.forEach((n, i) => {
    const tab = $(`tab-${n}`);
    const panel = $(`panel-${n}`);
    const active = i === index;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  $('tabInk').style.transform = `translateX(${index * 100}%)`;
  if (name === 'settings') renderPromptPreview();
}

TAB_NAMES.forEach((n) => $(`tab-${n}`).addEventListener('click', () => showTab(n)));

$$('[data-goto]').forEach((el) => el.addEventListener('click', () => showTab(el.dataset.goto)));

document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const current = TAB_NAMES.findIndex((n) => $(`tab-${n}`).classList.contains('is-active'));
  const next = TAB_NAMES[(current + step + TAB_NAMES.length) % TAB_NAMES.length];
  showTab(next);
  $(`tab-${next}`).focus();
});

function $$(selector) {
  return Array.from(document.querySelectorAll(selector));
}

/* ── monitor ────────────────────────────────────────────────────────────── */

let filter = 'all';
let lastSignature = null;
let rowRefs = [];

$$('.chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    filter = chip.dataset.filter;
    $$('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    lastSignature = null; // force a rebuild with the new filter
    render();
  })
);

function bucketOf(entry) {
  if (entry.verdict === 'ALLOW') return 'ALLOW';
  if (entry.verdict === 'BLOCK') return 'BLOCK';
  if (entry.verdict === 'ERROR') return 'ERROR';
  return 'pending';
}

// -> { cls, glyph, text, title } ; cls changes force a row rebuild, text alone is patched in place
function statusOf(entry, remaining) {
  const now = Date.now();
  if (entry.verdict === 'ALLOW')
    return {
      cls: 'pill-good', glyph: 'good', text: 'FOCUSED',
      title: entry.hadScreenshot ? 'Checked with screenshot and page text' : 'Checked on page text only',
    };
  if (entry.verdict === 'BLOCK')
    return {
      cls: 'pill-critical', glyph: 'critical', text: 'BLOCKED',
      title: entry.hadScreenshot ? 'Checked with screenshot and page text' : 'Checked on page text only',
    };
  if (entry.verdict === 'ERROR')
    return {
      cls: 'pill-warning', glyph: 'warning', text: 'ERROR',
      title: `Gave up after ${entry.attempts} attempts: ${entry.error || 'unknown error'}`,
    };
  if (entry.checking)
    return { cls: 'pill-pending', glyph: 'spinner', text: 'checking', title: 'Asking Gemini right now' };
  if (entry.attempts && entry.nextAttemptAt)
    return {
      cls: 'pill-warning', glyph: 'warning',
      text: `retry ${formatDuration(Math.max(0, Math.round((entry.nextAttemptAt - now) / 1000)))}`,
      title: `Attempt ${entry.attempts} of ${MAX_ATTEMPTS} failed: ${entry.error || 'unknown error'}`,
    };
  if (entry.checkDue)
    return {
      cls: 'pill-pending', glyph: 'clock', text: 'on focus',
      title: 'A background tab cannot be screenshotted, so it is checked when you switch to it',
    };
  if (remaining > 0)
    return { cls: 'pill-pending', glyph: 'clock', text: formatDuration(remaining), title: 'Time left before this page is judged' };
  return { cls: 'pill-pending', glyph: 'clock', text: 'due now', title: 'Waiting for the next check cycle' };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

function buildRow(tab, entry, status, openSecs) {
  const li = document.createElement('li');

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'row';
  row.title = `${status.title}\n${tab.url}`;
  row.addEventListener('click', () => {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  });

  if (tab.favIconUrl) {
    const img = document.createElement('img');
    img.className = 'row-favicon';
    img.src = tab.favIconUrl;
    img.alt = '';
    img.onerror = () => img.replaceWith(letterMark(tab.url));
    row.appendChild(img);
  } else {
    row.appendChild(letterMark(tab.url));
  }

  const text = document.createElement('span');
  text.className = 'row-text';
  const title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = tab.title || entry.title || hostOf(tab.url);
  const meta = document.createElement('span');
  meta.className = 'row-meta';
  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.textContent = formatDuration(openSecs);
  meta.append(hostOf(tab.url) + ' · open ', dur);
  text.append(title, meta);

  const pill = document.createElement('span');
  pill.className = `pill ${status.cls}`;
  pill.innerHTML = svg(status.glyph);
  const pillText = document.createElement('span');
  pillText.textContent = status.text;
  pill.appendChild(pillText);

  row.append(text, pill);
  li.appendChild(row);
  return { li, dur, pillText };
}

function letterMark(url) {
  const span = document.createElement('span');
  span.className = 'row-favicon';
  span.style.cssText =
    'display:grid;place-items:center;background:var(--pending-tint);color:var(--ink-muted);font-size:9px;font-weight:700';
  span.textContent = (hostOf(url)[0] || '?').toUpperCase();
  return span;
}

function emptyState(message, hint) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-dasharray="49 14" transform="rotate(-8 16 16)"/>
      <circle cx="16" cy="16" r="3.4" fill="currentColor"/>
    </svg><strong></strong><span></span>`;
  li.querySelector('strong').textContent = message;
  li.querySelector('span').textContent = hint;
  return li;
}

function skeleton() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 3; i++) {
    const li = document.createElement('li');
    li.className = 'skeleton';
    li.innerHTML = '<span class="sk-bar w-icon"></span><span class="sk-bar w-text"></span><span class="sk-bar w-pill"></span>';
    li.style.animationDelay = `${i * 90}ms`;
    frag.appendChild(li);
  }
  return frag;
}

async function render() {
  const {
    tabTracking = {},
    distractedClosedCount = 0,
    checkMinutes = DEFAULT_CHECK_MINUTES,
    geminiApiKey = '',
  } = await chrome.storage.local.get(['tabTracking', 'distractedClosedCount', 'checkMinutes', 'geminiApiKey']);

  const list = $('tabList');
  $('noKeyAlert').hidden = !!geminiApiKey;

  const now = Date.now();
  const tracked = [];
  for (const tab of await chrome.tabs.query({})) {
    const entry = tabTracking[tab.id];
    if (!entry) continue;
    const sinceSecs = Math.floor((now - entry.currentUrlSince) / 1000);
    tracked.push({
      tab,
      entry,
      bucket: bucketOf(entry),
      openSecs: Math.floor((now - entry.openedAt) / 1000),
      remaining: Math.max(0, Math.round(checkMinutes * 60) - sinceSecs),
    });
  }

  const count = { ALLOW: 0, BLOCK: 0, ERROR: 0, pending: 0 };
  tracked.forEach((t) => count[t.bucket]++);
  const total = tracked.length;

  $('statAllow').textContent = count.ALLOW;
  $('statBlock').textContent = count.BLOCK;
  $('statClosed').textContent = distractedClosedCount;

  $('legAllow').textContent = count.ALLOW;
  $('legBlock').textContent = count.BLOCK;
  $('legError').textContent = count.ERROR;
  $('legPending').textContent = count.pending;

  const pct = (n) => (total ? (n / total) * 100 : 0);
  [['segAllow', 'ALLOW'], ['segBlock', 'BLOCK'], ['segError', 'ERROR'], ['segPending', 'pending']].forEach(
    ([id, key]) => {
      const seg = $(id);
      seg.hidden = count[key] === 0;
      seg.style.width = `${pct(count[key])}%`;
    }
  );
  const judged = count.ALLOW + count.BLOCK;
  $('meterHint').textContent = total
    ? judged
      ? `${judged} of ${total} judged`
      : `${total} waiting on a first verdict`
    : 'nothing checked yet';
  $('meter').setAttribute(
    'aria-label',
    `${count.ALLOW} focused, ${count.BLOCK} blocked, ${count.ERROR} errors, ${count.pending} pending of ${total} tracked tabs`
  );

  $('cAll').textContent = total;
  $('cBlock').textContent = count.BLOCK;
  $('cAllow').textContent = count.ALLOW;
  $('cPending').textContent = count.pending + count.ERROR;

  $('guardState').textContent = !geminiApiKey
    ? 'paused - no API key saved'
    : total
    ? `watching ${total} tab${total === 1 ? '' : 's'} · checks after ${checkMinutes}m`
    : 'no trackable tabs open';

  const visible = tracked.filter((t) =>
    filter === 'all' ? true : filter === 'pending' ? t.bucket === 'pending' || t.bucket === 'ERROR' : t.bucket === filter
  );
  visible.sort((a, b) => {
    const rank = { BLOCK: 0, ERROR: 1, pending: 2, ALLOW: 3 };
    return rank[a.bucket] - rank[b.bucket] || a.openSecs - b.openSecs;
  });

  const statuses = visible.map((t) => statusOf(t.entry, t.remaining));
  const signature = visible.map((t, i) => `${t.tab.id}:${statuses[i].cls}:${t.tab.title}`).join('|');

  if (signature === lastSignature) {
    // nothing structural changed - only the live counters move
    visible.forEach((t, i) => {
      const ref = rowRefs[i];
      if (!ref) return;
      ref.dur.textContent = formatDuration(t.openSecs);
      ref.pillText.textContent = statuses[i].text;
    });
    return;
  }
  lastSignature = signature;
  rowRefs = [];
  list.textContent = '';

  if (!visible.length) {
    list.appendChild(
      total
        ? emptyState('Nothing in this filter', 'Switch to All to see every tracked tab.')
        : emptyState('No tabs tracked yet', 'Open a page in a normal http tab and it shows up here.')
    );
    return;
  }

  const frag = document.createDocumentFragment();
  visible.forEach((t, i) => {
    const ref = buildRow(t.tab, t.entry, statuses[i], t.openSecs);
    ref.li.firstChild.style.animationDelay = `${Math.min(i, 8) * 28}ms`;
    rowRefs.push(ref);
    frag.appendChild(ref.li);
  });
  list.appendChild(frag);
}

$('tabList').appendChild(skeleton()); // on screen before the first async read resolves
render();
setInterval(render, 1000);

/* ── quick settings ─────────────────────────────────────────────────────── */

const quickMinutes = $('quickMinutes');
let quickTimer = null;
let savedMinutes = DEFAULT_CHECK_MINUTES;

function clampMinutes(value) {
  return Math.min(120, Math.max(1, Math.round(Number(value) || DEFAULT_CHECK_MINUTES)));
}

function commitMinutes() {
  const minutes = clampMinutes(quickMinutes.value);
  quickMinutes.value = minutes;
  $('checkMinutes').value = minutes;
  if (minutes === savedMinutes) return;
  savedMinutes = minutes;
  chrome.storage.local.set({ checkMinutes: minutes }, () => chrome.runtime.sendMessage({ type: 'rearmAll' }));
}

function nudgeMinutes(delta) {
  quickMinutes.value = clampMinutes(Number(quickMinutes.value) + delta);
  clearTimeout(quickTimer);
  quickTimer = setTimeout(commitMinutes, 600);
}

$('minusMinutes').addEventListener('click', () => nudgeMinutes(-1));
$('plusMinutes').addEventListener('click', () => nudgeMinutes(1));
quickMinutes.addEventListener('input', () => {
  clearTimeout(quickTimer);
  quickTimer = setTimeout(commitMinutes, 900);
});
quickMinutes.addEventListener('blur', commitMinutes);

const recheckBtn = $('recheckAll');
recheckBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'rearmAll' });
  recheckBtn.textContent = 'Rearmed';
  recheckBtn.disabled = true;
  lastSignature = null;
  setTimeout(() => {
    recheckBtn.textContent = 'Recheck all';
    recheckBtn.disabled = false;
  }, 1600);
});

/* ── settings ───────────────────────────────────────────────────────────── */

const apiKeyInput = $('apiKey');
const modelInput = $('model');
const minutesInput = $('checkMinutes');
const status = $('status');
const promptInput = $('systemPrompt');

promptInput.placeholder = DEFAULT_SYSTEM_PROMPT;

function renderPromptPreview() {
  const custom = promptInput.value.trim();
  $('promptBadge').textContent = custom ? 'Custom' : 'Default';
  $('promptPreview').textContent = custom || DEFAULT_SYSTEM_PROMPT;
}

function renderPromptCount() {
  const custom = promptInput.value.trim();
  $('promptCount').textContent = custom ? `${custom.length.toLocaleString()} characters` : 'using template';
}

chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'checkMinutes', 'systemPrompt'], (stored) => {
  apiKeyInput.value = stored.geminiApiKey || '';
  modelInput.value = stored.geminiModel || DEFAULT_MODEL;
  savedMinutes = clampMinutes(stored.checkMinutes);
  minutesInput.value = savedMinutes;
  quickMinutes.value = savedMinutes;
  promptInput.value = stored.systemPrompt || '';
  renderPromptPreview();
  renderPromptCount();
});

$('toggleKey').addEventListener('click', (e) => {
  const showing = apiKeyInput.type === 'text';
  apiKeyInput.type = showing ? 'password' : 'text';
  e.target.textContent = showing ? 'Show' : 'Hide';
  e.target.setAttribute('aria-pressed', String(!showing));
});

function say(el, message, tone) {
  el.textContent = message;
  el.className = `status ${tone}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => (el.textContent = ''), 8000);
}

const TRANSIENT_STATUS = [429, 500, 502, 503, 504];

// listing models is not enough: some models appear in the list but 404 on generateContent
async function testKeyAndModel(key, model, withThinkingConfig = true) {
  const generationConfig = { maxOutputTokens: 512 };
  if (withThinkingConfig) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }],
        generationConfig,
      }),
    });
    if (res.ok) return { ok: true, message: 'Key and model verified.' };

    const body = await res.text();
    if (withThinkingConfig && /thinking/i.test(body)) return testKeyAndModel(key, model, false);
    if (TRANSIENT_STATUS.includes(res.status)) {
      return { ok: false, saveable: true, message: `Model busy (HTTP ${res.status}). Key looks fine, saved anyway.` };
    }

    let detail = body.slice(0, 160);
    try {
      detail = JSON.parse(body).error.message.slice(0, 160);
    } catch {
      // non-JSON error body
    }
    return { ok: false, saveable: false, message: detail };
  } catch (e) {
    return { ok: false, saveable: false, message: e.message };
  }
}

const saveBtn = $('save');
saveBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || DEFAULT_MODEL;
  const minutes = clampMinutes(minutesInput.value);
  if (!key) {
    say(status, 'Enter an API key first.', 'bad');
    apiKeyInput.focus();
    return;
  }

  saveBtn.disabled = true;
  say(status, 'Testing key and model…', '');

  const result = await testKeyAndModel(key, model);

  if (result.ok || result.saveable) {
    await chrome.storage.local.set({ geminiApiKey: key, geminiModel: model, checkMinutes: minutes });
    chrome.runtime.sendMessage({ type: 'rearmAll' });
    savedMinutes = minutes;
    minutesInput.value = minutes;
    quickMinutes.value = minutes;
    lastSignature = null;
    say(status, result.message, result.ok ? 'ok' : 'warn');
  } else {
    say(status, `Not saved - ${result.message}`, 'bad');
  }
  saveBtn.disabled = false;
});

[apiKeyInput, modelInput, minutesInput].forEach((el) =>
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
  })
);

/* ── prompt ─────────────────────────────────────────────────────────────── */

const promptStatus = $('promptStatus');

promptInput.addEventListener('input', renderPromptCount);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('savePrompt').click();
});

$('savePrompt').addEventListener('click', async () => {
  const value = promptInput.value.trim();
  await chrome.storage.local.set({ systemPrompt: value });
  chrome.runtime.sendMessage({ type: 'rearmAll' });
  renderPromptPreview();
  renderPromptCount();
  lastSignature = null;
  say(promptStatus, value ? 'Custom prompt saved. Every tab will be judged again.' : 'Back on the built-in template.', 'ok');
});

$('loadTemplate').addEventListener('click', () => {
  promptInput.value = DEFAULT_SYSTEM_PROMPT;
  promptInput.focus();
  renderPromptCount();
  say(promptStatus, 'Template copied in. Edit it, then save.', '');
});

$('resetPrompt').addEventListener('click', async () => {
  promptInput.value = '';
  await chrome.storage.local.set({ systemPrompt: '' });
  chrome.runtime.sendMessage({ type: 'rearmAll' });
  renderPromptPreview();
  renderPromptCount();
  lastSignature = null;
  say(promptStatus, 'Reset. The built-in template is active again.', 'ok');
});

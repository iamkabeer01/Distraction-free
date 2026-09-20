// shared.js supplies DEFAULT_MODEL, DEFAULT_CHECK_MINUTES, MAX_ATTEMPTS, TRANSIENT_STATUS,
// DEFAULT_SYSTEM_PROMPT, geminiEndpoint and parseSkipHosts.

const $ = (id) => document.getElementById(id);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

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
  noaccess:
    '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="2.9" y1="9.1" x2="9.1" y2="2.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  lock:
    '<rect x="2.4" y="5.3" width="7.2" height="5.4" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.2 5.3V4a1.8 1.8 0 0 1 3.6 0v1.3" fill="none" stroke="currentColor" stroke-width="1.4"/>',
};
const svg = (name) => `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">${GLYPH[name]}</svg>`;

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

const clampMinutes = (value) =>
  Math.min(120, Math.max(1, Math.round(Number(value) || DEFAULT_CHECK_MINUTES)));

/* ── theme ──────────────────────────────────────────────────────────────── */

chrome.storage.local.get('theme', ({ theme }) => {
  if (theme) document.documentElement.dataset.theme = theme;
});

$('themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const current =
    root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.dataset.theme = current === 'dark' ? 'light' : 'dark';
  chrome.storage.local.set({ theme: root.dataset.theme });
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

/* ── monitor ────────────────────────────────────────────────────────────── */

let filter = 'all';
let lastSignature = null;
let rowRefs = [];

// Everything the monitor draws comes from this snapshot. It is refilled when storage
// changes rather than polled, so the 1s tick only advances the live counters.
let snap = { tracking: {}, tabs: [], closed: 0, minutes: DEFAULT_CHECK_MINUTES, hasKey: false, canUnblock: true };

$$('.chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    filter = chip.dataset.filter;
    $$('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    lastSignature = null; // force a rebuild with the new filter
    paint();
  })
);

function bucketOf(entry) {
  if (entry.verdict === 'SKIP' || entry.verdict === 'UNSUPPORTED') return 'SKIP';
  if (entry.verdict === 'ALLOW' || entry.verdict === 'UNBLOCK') return 'ALLOW';
  if (entry.verdict === 'BLOCK') return 'BLOCK';
  if (entry.verdict === 'ERROR') return 'ERROR';
  return 'pending';
}

// -> { cls, glyph, text, title } ; a cls change forces a row rebuild, text alone is patched in place
function statusOf(entry, remaining) {
  const now = Date.now();
  const by = entry.model ? ` Answered by ${entry.model}.` : '';
  const checkedWith = entry.thin
    ? `This page refused to be read, so it was judged on its URL and title.${by}`
    : `Judged on the page's main text.${by}`;

  if (entry.verdict === 'UNSUPPORTED')
    return {
      cls: 'pill-pending', glyph: 'noaccess', text: 'NO ACCESS',
      title: 'Chrome blocks extensions from reading this page, so it is left alone.',
    };
  if (entry.verdict === 'SKIP')
    return {
      cls: 'pill-pending', glyph: 'lock', text: 'PRIVATE',
      title: 'On your never-check list. Nothing from this page was read or sent.',
    };
  if (entry.verdict === 'UNBLOCK')
    return {
      cls: 'pill-pending', glyph: 'good', text: 'UNBLOCKED',
      title: 'You unblocked this page. It is left alone for an hour, then judged again.',
    };
  if (entry.verdict === 'ALLOW')
    return { cls: 'pill-good', glyph: 'good', text: 'FOCUSED', title: checkedWith };
  if (entry.verdict === 'BLOCK')
    return { cls: 'pill-critical', glyph: 'critical', text: 'BLOCKED', title: checkedWith };
  if (entry.verdict === 'ERROR')
    return {
      cls: 'pill-warning', glyph: 'warning', text: 'ERROR',
      title: `Gave up after ${entry.attempts ?? MAX_ATTEMPTS} attempts: ${entry.error || 'unknown error'}`,
    };
  if (entry.checking)
    return { cls: 'pill-pending', glyph: 'spinner', text: 'checking', title: 'Asking the model right now' };
  if (entry.attempts && entry.nextAttemptAt)
    return {
      cls: 'pill-warning', glyph: 'warning',
      text: `retry ${formatDuration(Math.max(0, Math.round((entry.nextAttemptAt - now) / 1000)))}`,
      title: `Attempt ${entry.attempts} of ${MAX_ATTEMPTS} failed: ${entry.error || 'unknown error'}`,
    };
  if (entry.checkDue)
    return {
      cls: 'pill-pending', glyph: 'clock', text: 'on focus',
      title: 'Judged when you switch to it, so a tab you never look at never spends a call',
    };
  if (remaining > 0)
    return {
      cls: 'pill-pending', glyph: 'clock', text: formatDuration(remaining),
      title: 'Time left before this page is judged',
    };
  return { cls: 'pill-pending', glyph: 'clock', text: 'due now', title: 'Waiting for the next check cycle' };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

function letterMark(url) {
  const span = document.createElement('span');
  span.className = 'row-favicon';
  span.style.cssText =
    'display:grid;place-items:center;background:var(--pending-tint);color:var(--ink-muted);font-size:9px;font-weight:700';
  span.textContent = (hostOf(url)[0] || '?').toUpperCase();
  return span;
}

function buildRow(tab, entry, status, openSecs) {
  const li = document.createElement('li');

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'row';
  row.title = `${status.title}\n${tab.url}`;
  row.addEventListener('click', async () => {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      // the tab closed between paint and click
    }
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
  if (entry.verdict === 'BLOCK' && snap.canUnblock) {
    row.classList.add('has-action');
    li.appendChild(unblockButton(tab));
  }
  return { li, dur, pillText };
}

/* ── unblocking ─────────────────────────────────────────────────────────────
   The popup only starts it. The worker switches to the tab, takes another look at
   the page, and argues there if it has to - a page that was never rendered has no
   text to judge, and this popup would close the moment the tab changed anyway.   */

function unblockButton(tab) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row-unblock';
  btn.textContent = 'Unblock';
  btn.title = 'Go to this page, check it once more, then unblock it';
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'startUnblock', tabId: tab.id });
    window.close();
  });
  return btn;
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
    li.innerHTML =
      '<span class="sk-bar w-icon"></span><span class="sk-bar w-text"></span><span class="sk-bar w-pill"></span>';
    li.style.animationDelay = `${i * 90}ms`;
    frag.appendChild(li);
  }
  return frag;
}

function paint() {
  const now = Date.now();
  const tracked = [];
  for (const tab of snap.tabs) {
    const entry = snap.tracking[tab.id];
    if (!entry) continue;
    const sinceSecs = Math.floor((now - entry.currentUrlSince) / 1000);
    tracked.push({
      tab,
      entry,
      bucket: bucketOf(entry),
      openSecs: Math.floor((now - entry.openedAt) / 1000),
      remaining: Math.max(0, Math.round(snap.minutes * 60) - sinceSecs),
    });
  }

  const count = { ALLOW: 0, BLOCK: 0, ERROR: 0, pending: 0, SKIP: 0 };
  tracked.forEach((t) => count[t.bucket]++);
  const checkable = tracked.length - count.SKIP; // skipped tabs are never judged, so they are not a share

  $('noKeyAlert').hidden = snap.hasKey;
  $('statAllow').textContent = count.ALLOW;
  $('statBlock').textContent = count.BLOCK;
  $('statClosed').textContent = snap.closed;
  $('legAllow').textContent = count.ALLOW;
  $('legBlock').textContent = count.BLOCK;
  $('legError').textContent = count.ERROR;
  $('legPending').textContent = count.pending;

  const pct = (n) => (checkable ? (n / checkable) * 100 : 0);
  [['segAllow', 'ALLOW'], ['segBlock', 'BLOCK'], ['segError', 'ERROR'], ['segPending', 'pending']].forEach(
    ([id, key]) => {
      const seg = $(id);
      seg.hidden = count[key] === 0;
      seg.style.width = `${pct(count[key])}%`;
    }
  );

  const judged = count.ALLOW + count.BLOCK;
  const privately = count.SKIP ? `, ${count.SKIP} private` : '';
  $('meterHint').textContent = checkable
    ? judged
      ? `${judged} of ${checkable} judged${privately}`
      : `${checkable} waiting on a first verdict${privately}`
    : count.SKIP
    ? `${count.SKIP} private, nothing to check`
    : 'nothing checked yet';
  $('meter').setAttribute(
    'aria-label',
    `${count.ALLOW} focused, ${count.BLOCK} blocked, ${count.ERROR} errors, ${count.pending} pending of ${checkable} checked tabs`
  );

  $('cAll').textContent = tracked.length;
  $('cBlock').textContent = count.BLOCK;
  $('cAllow').textContent = count.ALLOW;
  $('cPending').textContent = count.pending + count.ERROR;

  $('guardState').textContent = !snap.hasKey
    ? 'paused - no API key saved'
    : tracked.length
    ? `watching ${tracked.length} tab${tracked.length === 1 ? '' : 's'} · checks after ${snap.minutes}m`
    : 'no trackable tabs open';

  // The settings read that first fills this box can be late, fail, or never fire, and nothing
  // else ever writes it - so it re-asserts itself from the snapshot that does arrive, except
  // while the field has focus, which means the user is mid-edit.
  const minutesBox = $('quickMinutes');
  if (document.activeElement !== minutesBox) minutesBox.value = snap.minutes;

  const visible = tracked.filter((t) =>
    filter === 'all'
      ? true
      : filter === 'pending'
      ? t.bucket === 'pending' || t.bucket === 'ERROR'
      : t.bucket === filter
  );
  const rank = { BLOCK: 0, ERROR: 1, pending: 2, ALLOW: 3, SKIP: 4 };
  visible.sort((a, b) => rank[a.bucket] - rank[b.bucket] || a.openSecs - b.openSecs);

  const statuses = visible.map((t) => statusOf(t.entry, t.remaining));
  const signature = [
    snap.canUnblock, // flipping the switch adds or removes a button on every blocked row
    ...visible.map((t, i) => `${t.tab.id}:${statuses[i].cls}:${statuses[i].title}:${t.tab.title}`),
  ].join('|');
  const list = $('tabList');

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
      tracked.length
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

async function refresh() {
  const [stored, tabs] = await Promise.all([
    chrome.storage.local.get([
      'tabTracking', 'distractedClosedCount', 'checkMinutes', 'unblockEnabled',
      'provider', 'geminiApiKey', 'openrouterApiKey', 'ollamaApiKey',
    ]),
    chrome.tabs.query({}),
  ]);
  snap = {
    tracking: stored.tabTracking || {},
    tabs,
    closed: stored.distractedClosedCount || 0,
    minutes: clampMinutes(stored.checkMinutes),
    canUnblock: stored.unblockEnabled !== false, // absent means on
    // the alert is about the provider actually in use, not whichever key happens to exist
    hasKey: !!stored[`${normalizeProvider(stored.provider)}ApiKey`],
  };
  paint(); // paint's own signature check decides whether the list needs rebuilding
}

// the background writes tracking on every tab and verdict change, so one storage listener
// replaces polling chrome.tabs and chrome.storage twice a second
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') refresh();
});

$('tabList').appendChild(skeleton()); // on screen before the first async read resolves
refresh();
setInterval(paint, 1000); // advances durations and countdowns only

/* ── quick settings ─────────────────────────────────────────────────────── */

const quickMinutes = $('quickMinutes');
let quickTimer = null;
let savedMinutes = DEFAULT_CHECK_MINUTES;

function commitMinutes() {
  const minutes = clampMinutes(quickMinutes.value);
  quickMinutes.value = minutes;
  if (minutes === savedMinutes) return;
  savedMinutes = minutes;
  chrome.storage.local.set({ checkMinutes: minutes }, () => chrome.runtime.sendMessage({ type: 'rearmAll' }));
}

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
  setTimeout(() => {
    recheckBtn.textContent = 'Recheck all';
    recheckBtn.disabled = false;
  }, 1600);
});

/* ── settings ───────────────────────────────────────────────────────────── */

const apiKeyInput = $('apiKey');
const orKeyInput = $('openrouterApiKey');
const modelSelect = $('model');
const customModel = $('customModel');
const skipInput = $('skipHosts');
const status = $('status');
const unblockToggle = $('unblockEnabled');
const promptInput = $('systemPrompt');

promptInput.placeholder = DEFAULT_SYSTEM_PROMPT;

/* ── the list providers ─────────────────────────────────────────────────────
   Ollama Cloud and OpenRouter work the same way, so they share one widget: the
   dropdown IS the list, whatever is selected routes every request, and the rest
   queue behind it as fallbacks. Both catalogues churn, so the last entry opens a
   dialog rather than pretending the shipped list is closed.                    */

const ADD_NEW = '__add__';
const LIST_PROVIDERS = {
  ollama: {
    select: $('ollamaModel'), count: $('ollamaCount'), keyInput: $('ollamaApiKey'),
    known: OLLAMA_MODELS, fallback: DEFAULT_OLLAMA_MODELS,
    keyName: 'ollamaApiKey', listName: 'ollamaModels',
    catalogue: 'ollama.com/library', idPattern: '\\S+', // a plain model name, no vendor prefix
  },
  openrouter: {
    select: $('openrouterModel'), count: $('orCount'), keyInput: orKeyInput,
    known: OPENROUTER_MODELS, fallback: DEFAULT_OPENROUTER_MODELS,
    keyName: 'openrouterApiKey', listName: 'openrouterModels',
    catalogue: 'openrouter.ai/models', idPattern: '\\S+/\\S+', // always vendor/model
  },
};

const modelDialog = $('modelDialog');
const newModelId = $('newModelId');
let addingFor = null; // which provider the dialog is adding to

for (const [name, p] of Object.entries(LIST_PROVIDERS)) {
  p.labels = new Map(p.known.map((m) => [m.id, m.label]));
  p.models = [];
  p.chosen = '';
  p.select.addEventListener('change', () => {
    if (p.select.value !== ADD_NEW) {
      p.chosen = p.select.value;
      return;
    }
    addingFor = name;
    $('modelDialogTitle').textContent = `Add an ${PROVIDERS[name]} model`;
    $('newModelHelp').textContent =
      `Copy the id from ${p.catalogue}. It becomes the model in use; the one you had drops to a fallback.`;
    newModelId.pattern = p.idPattern;
    newModelId.value = '';
    newModelId.setCustomValidity('');
    modelDialog.showModal();
  });
}

function renderModels(name, selected) {
  const p = LIST_PROVIDERS[name];
  p.select.textContent = '';
  for (const id of p.models) p.select.add(new Option(p.labels.get(id) || id, id));
  p.select.add(new Option('Add another model…', ADD_NEW));
  p.chosen = p.models.includes(selected) ? selected : p.models[0] || '';
  p.select.value = p.chosen || ADD_NEW;
  p.count.textContent = `${p.models.length} model${p.models.length === 1 ? '' : 's'}`;
}

// required and pattern cover empty and the id shape natively; only "already in the list"
// needs saying, and setCustomValidity says it in the same browser bubble
newModelId.addEventListener('input', () => {
  const id = newModelId.value.trim();
  if (id !== newModelId.value) newModelId.value = id; // a reassignment would jump the caret
  const taken = addingFor && LIST_PROVIDERS[addingFor].models.includes(id);
  newModelId.setCustomValidity(taken ? 'That model is already in your list.' : '');
});

$('modelForm').addEventListener('submit', () => {
  if (!addingFor) return;
  const p = LIST_PROVIDERS[addingFor];
  const id = newModelId.value;
  p.models = [id, ...p.models]; // you added it because you want to use it
  renderModels(addingFor, id);
  say(status, `${id} selected. Save settings to test it and switch over.`, '');
});

$('cancelModel').addEventListener('click', () => modelDialog.close());
// cancel, Esc or a click outside: the dropdown must not stay parked on "Add another model…"
modelDialog.addEventListener('close', () => {
  if (addingFor) renderModels(addingFor, LIST_PROVIDERS[addingFor].chosen);
  addingFor = null;
});

/* ── provider ───────────────────────────────────────────────────────────── */

let provider = 'gemini';

function showProvider(next) {
  provider = normalizeProvider(next);
  $$('.seg').forEach((b) => {
    const on = b.dataset.provider === provider;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
  $$('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== provider));
}

$$('.seg').forEach((b) => b.addEventListener('click', () => showProvider(b.dataset.provider)));

const activeKeyInput = () => (provider === 'gemini' ? apiKeyInput : LIST_PROVIDERS[provider].keyInput);

/* ── gemini model list ──────────────────────────────────────────────────── */

// The list doubles as the automatic fallback order in the worker, so it is built from
// the same array. "Other" keeps the escape hatch for a model id Google ships later.
const CUSTOM = '__custom__';
for (const { id, label } of GEMINI_MODELS) modelSelect.add(new Option(label, id));
modelSelect.add(new Option('Other…', CUSTOM));

function chosenGeminiModel() {
  return modelSelect.value === CUSTOM ? customModel.value.trim() : modelSelect.value;
}

function showGeminiModel(id) {
  const known = GEMINI_MODELS.some((m) => m.id === id);
  modelSelect.value = known ? id : CUSTOM;
  customModel.hidden = known;
  customModel.value = known ? '' : id;
}

modelSelect.addEventListener('change', () => {
  customModel.hidden = modelSelect.value !== CUSTOM;
  if (!customModel.hidden) customModel.focus();
});

/* ── counters and the prompt preview ────────────────────────────────────── */

function renderPromptPreview() {
  const custom = promptInput.value.trim();
  $('promptBadge').textContent = custom ? 'Custom' : 'Default';
  $('promptPreview').textContent = custom || DEFAULT_SYSTEM_PROMPT;
}

function renderPromptCount() {
  const custom = promptInput.value.trim();
  $('promptCount').textContent = custom ? `${custom.length.toLocaleString()} characters` : 'using template';
}

function renderSkipCount() {
  const n = parseSkipHosts(skipInput.value).length;
  $('skipCount').textContent = `${n} site${n === 1 ? '' : 's'}`;
}

skipInput.addEventListener('input', renderSkipCount);

chrome.storage.local.get(
  [
    'provider', 'geminiApiKey', 'geminiModel', 'openrouterApiKey', 'openrouterModels',
    'ollamaApiKey', 'ollamaModels', 'checkMinutes', 'systemPrompt', 'skipHosts', 'unblockEnabled',
  ],
  (stored) => {
    showProvider(stored.provider);
    unblockToggle.checked = stored.unblockEnabled !== false;
    apiKeyInput.value = stored.geminiApiKey || '';
    showGeminiModel(stored.geminiModel || DEFAULT_MODEL);
    for (const [name, p] of Object.entries(LIST_PROVIDERS)) {
      p.keyInput.value = stored[p.keyName] || '';
      p.models = parseModelList(stored[p.listName] || p.fallback);
      renderModels(name, p.models[0]);
    }
    savedMinutes = clampMinutes(stored.checkMinutes);
    quickMinutes.value = savedMinutes;
    promptInput.value = stored.systemPrompt || '';
    skipInput.value = stored.skipHosts || '';
    renderPromptPreview();
    renderPromptCount();
    renderSkipCount();
  }
);

$$('[data-reveal]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const field = $(btn.dataset.reveal);
    const showing = field.type === 'text';
    field.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
    btn.setAttribute('aria-pressed', String(!showing));
  })
);

function say(el, message, tone) {
  el.textContent = message;
  el.className = `status ${tone}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => (el.textContent = ''), 8000);
}

const KEY_TEST_TIMEOUT_MS = 15000;

// Listing models is not enough: an id can appear in a catalogue and still fail on use.
// One real request is the only honest check, and it goes through the same request
// builder the worker uses, so a shape bug shows up here rather than silently at runtime.
async function testKeyAndModel(prov, model, apiKey, withThinkingConfig = true) {
  const { url, headers, body } = buildRequest(prov, {
    model,
    apiKey,
    withThinkingConfig,
    systemPrompt: 'Reply with exactly one word: OK.',
    userText: 'Say OK.',
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, message: `${PROVIDERS[prov]} key and model verified.` };

    const text = await res.text();
    if (prov === 'gemini' && withThinkingConfig && /thinking/i.test(text)) {
      return testKeyAndModel(prov, model, apiKey, false);
    }
    if (TRANSIENT_STATUS.has(res.status)) {
      return { ok: false, saveable: true, message: `Model busy (HTTP ${res.status}). Key looks fine, saved anyway.` };
    }

    let detail = text.slice(0, 160);
    try {
      detail = JSON.parse(text).error.message.slice(0, 160);
    } catch {
      // non-JSON error body
    }
    return { ok: false, saveable: false, message: detail };
  } catch (e) {
    return { ok: false, saveable: false, message: e.name === 'TimeoutError' ? 'No answer in 15s.' : e.message };
  }
}

// saved on the spot rather than on Save settings: it costs nothing and takes effect at once,
// and the storage write repaints the monitor through the same listener everything else uses
unblockToggle.addEventListener('change', () => {
  chrome.storage.local.set({ unblockEnabled: unblockToggle.checked });
  say(status, unblockToggle.checked ? 'Unblocking is on.' : 'Unblocking is off. Blocks now stand.', '');
});

const saveBtn = $('save');

saveBtn.addEventListener('click', async () => {
  const apiKey = activeKeyInput().value.trim();
  const skipHosts = skipInput.value.trim();
  const picked = provider === 'gemini' ? null : LIST_PROVIDERS[provider].select.value;
  const model =
    provider === 'gemini'
      ? chosenGeminiModel() || DEFAULT_MODEL
      : picked === ADD_NEW
      ? ''
      : picked;

  if (!apiKey) {
    say(status, `Enter your ${PROVIDERS[provider]} API key first.`, 'bad');
    activeKeyInput().focus();
    return;
  }
  if (!model) {
    say(status, 'Add at least one model id.', 'bad');
    LIST_PROVIDERS[provider].select.focus();
    return;
  }

  saveBtn.disabled = true;
  say(status, `Testing ${model}…`, '');

  const result = await testKeyAndModel(provider, model, apiKey);

  if (result.ok || result.saveable) {
    // only the active provider's credentials are written, so switching back keeps the other's
    const settings = { provider, skipHosts };
    if (provider === 'gemini') {
      settings.geminiApiKey = apiKey;
      settings.geminiModel = model;
      showGeminiModel(model);
    } else {
      const p = LIST_PROVIDERS[provider];
      settings[p.keyName] = apiKey;
      // the worker reads the first id as primary and the rest as its fallback chain
      settings[p.listName] = modelOrder(provider, model, p.models.join('\n')).join('\n');
    }
    await chrome.storage.local.set(settings);
    chrome.runtime.sendMessage({ type: 'rearmAll' });
    say(status, result.message, result.ok ? 'ok' : 'warn');
  } else {
    say(status, `Not saved - ${result.message}`, 'bad');
  }
  saveBtn.disabled = false;
});

[apiKeyInput, orKeyInput, customModel].forEach((el) =>
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

async function savePrompt(value, message) {
  await chrome.storage.local.set({ systemPrompt: value });
  chrome.runtime.sendMessage({ type: 'rearmAll' });
  renderPromptPreview();
  renderPromptCount();
  say(promptStatus, message, 'ok');
}

$('savePrompt').addEventListener('click', () => {
  const value = promptInput.value.trim();
  savePrompt(
    value,
    value ? 'Custom prompt saved. Every tab will be judged again.' : 'Back on the built-in template.'
  );
});

$('loadTemplate').addEventListener('click', () => {
  promptInput.value = DEFAULT_SYSTEM_PROMPT;
  promptInput.focus();
  renderPromptCount();
  say(promptStatus, 'Template copied in. Edit it, then save.', '');
});

$('resetPrompt').addEventListener('click', () => {
  promptInput.value = '';
  savePrompt('', 'Reset. The built-in template is active again.');
});

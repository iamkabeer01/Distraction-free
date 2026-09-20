const DEFAULT_MODEL = 'gemini-3.6-flash';
const DEFAULT_CHECK_MINUTES = 2;
const MAX_ATTEMPTS = 5;

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}

function statusCell(entry, remaining) {
  const td = document.createElement('td');
  const now = Date.now();

  if (entry.verdict === 'ERROR') {
    td.textContent = 'ERROR';
    td.className = 'verdict-error';
    td.title = `Gave up after ${entry.attempts} attempts: ${entry.error || 'unknown error'}`;
  } else if (entry.verdict) {
    td.textContent = entry.verdict;
    td.className = entry.verdict === 'BLOCK' ? 'verdict-block' : 'verdict-allow';
    td.title = entry.hadScreenshot ? 'checked with screenshot + page text' : 'checked on page text only';
  } else if (entry.checking) {
    td.textContent = 'checking now...';
    td.className = 'pending';
  } else if (entry.attempts && entry.nextAttemptAt) {
    td.textContent = `retry in ${formatDuration(Math.max(0, Math.floor((entry.nextAttemptAt - now) / 1000)))}`;
    td.className = 'verdict-error';
    td.title = `Attempt ${entry.attempts} of ${MAX_ATTEMPTS} failed: ${entry.error || 'unknown error'}`;
  } else if (entry.checkDue) {
    td.textContent = 'waiting for focus';
    td.className = 'pending';
    td.title = 'A background tab cannot be screenshotted - it is checked when you switch to it';
  } else if (remaining > 0) {
    td.textContent = `checking in ${formatDuration(remaining)}`;
    td.className = 'pending';
  } else {
    td.textContent = 'due now';
    td.className = 'pending';
  }
  return td;
}

async function render() {
  const {
    tabTracking = {},
    distractedClosedCount = 0,
    checkMinutes = DEFAULT_CHECK_MINUTES,
  } = await chrome.storage.local.get(['tabTracking', 'distractedClosedCount', 'checkMinutes']);
  const openTabs = await chrome.tabs.query({});
  const tbody = document.getElementById('tabList');
  tbody.innerHTML = '';
  const now = Date.now();

  for (const tab of openTabs) {
    const entry = tabTracking[tab.id];
    if (!entry) continue;

    const openSecs = Math.floor((now - entry.openedAt) / 1000);
    const sinceSecs = Math.floor((now - entry.currentUrlSince) / 1000);
    const remaining = Math.max(0, Math.round(checkMinutes * 60) - sinceSecs);

    const tr = document.createElement('tr');

    const siteTd = document.createElement('td');
    siteTd.className = 'site';
    siteTd.textContent = tab.title || entry.title || tab.url;
    siteTd.title = tab.url;

    const openTd = document.createElement('td');
    openTd.textContent = formatDuration(openSecs);

    tr.append(siteTd, openTd, statusCell(entry, remaining));
    tbody.appendChild(tr);
  }

  document.getElementById('distractedCount').textContent = distractedClosedCount;
}

render();
setInterval(render, 1000);

const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const minutesInput = document.getElementById('checkMinutes');
const status = document.getElementById('status');

chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'checkMinutes'], (stored) => {
  apiKeyInput.value = stored.geminiApiKey || '';
  modelInput.value = stored.geminiModel || DEFAULT_MODEL;
  minutesInput.value = stored.checkMinutes || DEFAULT_CHECK_MINUTES;
});

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
    if (withThinkingConfig && /thinking/i.test(body)) {
      return testKeyAndModel(key, model, false);
    }
    if (TRANSIENT_STATUS.includes(res.status)) {
      return { ok: false, saveable: true, message: `Model busy (HTTP ${res.status}). Key looks fine - saved.` };
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

const saveBtn = document.getElementById('save');
saveBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || DEFAULT_MODEL;
  const minutes = Math.max(1, Number(minutesInput.value) || DEFAULT_CHECK_MINUTES);
  if (!key) {
    status.style.color = 'red';
    status.textContent = 'Enter an API key first.';
    return;
  }

  saveBtn.disabled = true;
  status.style.color = '#555';
  status.textContent = 'Testing key and model...';

  const result = await testKeyAndModel(key, model);

  if (result.ok || result.saveable) {
    await chrome.storage.local.set({ geminiApiKey: key, geminiModel: model, checkMinutes: minutes });
    chrome.runtime.sendMessage({ type: 'rearmAll' });
    minutesInput.value = minutes;
    status.style.color = result.ok ? 'green' : '#ef6c00';
    status.textContent = result.message;
  } else {
    status.style.color = 'red';
    status.textContent = `Not saved - ${result.message}`;
  }
  saveBtn.disabled = false;
  setTimeout(() => (status.textContent = ''), 8000);
});

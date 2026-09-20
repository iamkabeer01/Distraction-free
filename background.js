importScripts('shared.js');
// shared.js: DEFAULT_SYSTEM_PROMPT, DEFAULT_MODEL, DEFAULT_CHECK_MINUTES, MAX_ATTEMPTS,
//            TRANSIENT_STATUS, geminiEndpoint, fenceSafe, cacheKeyFor, parseSkipHosts, hostIsSkipped

const RETRY_BACKOFF_MINUTES = [1, 2, 4, 8, 16]; // chrome.alarms will not fire faster than 1 minute
const STALE_CHECK_MS = 90 * 1000; // a check still flagged running after this was killed with the service worker
const REQUEST_TIMEOUT_MS = 15 * 1000; // two attempts must still fit inside the worker's idle budget

const cache = new Map(); // cacheKey -> {verdict}, in-memory only, never caches errors

// without this the worker silently swallows every failed await
self.addEventListener('unhandledrejection', (e) => console.error('[DF] unhandled rejection', e.reason));

async function getTracking() {
  const { tabTracking } = await chrome.storage.local.get('tabTracking');
  return tabTracking || {};
}

//  every tracking write is read-modify-write; serialize them or concurrent tab events clobber
// each other. Claims and counters ride the same chain, which is what makes them atomic.
let writeChain = Promise.resolve();
function updateTracking(mutate) {
  writeChain = writeChain.then(async () => {
    const tracking = await getTracking();
    try {
      mutate(tracking);
    } catch (e) {
      console.error('[DF] tracking update failed', e);
    }
    await chrome.storage.local.set({ tabTracking: tracking });
  });
  return writeChain;
}

// same chain, so two tabs closing at once cannot both read the old count and write count+1
function serialize(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error('[DF] serialized task failed', e));
  return writeChain;
}

async function getCheckMinutes() {
  const { checkMinutes } = await chrome.storage.local.get('checkMinutes');
  return Number(checkMinutes) > 0 ? Number(checkMinutes) : DEFAULT_CHECK_MINUTES;
}

async function isSkipped(url) {
  const { skipHosts } = await chrome.storage.local.get('skipHosts');
  const hosts = parseSkipHosts(skipHosts);
  if (!hosts.length) return false;
  try {
    return hostIsSkipped(new URL(url).hostname.toLowerCase(), hosts);
  } catch {
    return false;
  }
}

async function scheduleTabAlarm(tabId) {
  chrome.alarms.create(`check_${tabId}`, { delayInMinutes: await getCheckMinutes() });
}

// single entry point for "this tab now shows a different page" - full navigation or SPA nav
async function handleNavigation(tabId, url, title) {
  if (!url || !url.startsWith('http')) return;
  const minutes = await getCheckMinutes();
  // both mean "never ask the model": one because Chrome will not let us read the page,
  // the other because the user asked us not to
  const preVerdict = isRestrictedUrl(url) ? 'UNSUPPORTED' : (await isSkipped(url)) ? 'SKIP' : null;
  let changed = false;

  await updateTracking((tracking) => {
    const prev = tracking[tabId];
    changed = !prev || prev.url !== url;
    if (!changed) {
      if (title) prev.title = title;
      return;
    }
    tracking[tabId] = {
      openedAt: prev?.openedAt || Date.now(),
      url,
      title: title || '',
      currentUrlSince: Date.now(),
      verdict: preVerdict,
      distracted: false,
      error: null,
      model: null,
      thin: false,
      checkDue: false,
      attempts: 0,
      checking: null,
      claim: null,
      nextAttemptAt: preVerdict ? null : Date.now() + minutes * 60000,
    };
  });

  if (changed && !preVerdict) await scheduleTabAlarm(tabId); // restart the countdown for the new content
}

function sendMessageSafe(tabId, message, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      resolve(chrome.runtime.lastError ? null : response);
    });
  });
}

// content scripts are not retroactively injected into tabs that predate the extension load
async function extractFromTab(tabId) {
  const direct = await sendMessageSafe(tabId, { type: 'extractContent' });
  if (direct) return direct;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    console.warn('[DF] cannot inject into tab', tabId, e.message);
    return null;
  }
  return sendMessageSafe(tabId, { type: 'extractContent' });
}

async function checkTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // tab closed before the alarm fired
  }
  if (!tab.url || !tab.url.startsWith('http') || tab.discarded) return;

  // A tab you are not looking at is not spending your attention, so it does not spend a call
  // either - music left playing in a background tab included. Deferred, not skipped: it is
  // checked when you switch to it, so a tab closed unseen is never paid for at all.
  if (!tab.active || tab.status !== 'complete') {
    await updateTracking((t) => {
      const entry = t[tabId];
      if (entry && !entry.verdict && !entry.checkDue) entry.checkDue = true;
    });
    return;
  }

  // The claim is taken inside the serialized write, so of two callers racing here exactly one wins.
  // The winner's result is written back only while it still holds the claim, which is what stops a
  // slow verdict landing on a page the user navigated to in the meantime.
  const claim = crypto.randomUUID();
  let won = false;
  await updateTracking((t) => {
    const entry = t[tabId];
    if (!entry || entry.verdict) return; // a page is judged exactly once
    if (entry.checking && Date.now() - entry.checking < STALE_CHECK_MS) return;
    entry.checking = Date.now();
    entry.claim = claim;
    entry.checkDue = false;
    won = true;
  });
  if (!won) return;

  const cacheKey = cacheKeyFor(tab.url);
  const cached = cache.get(cacheKey);
  if (cached) {
    await recordSuccess(tabId, cached, false, claim);
    return;
  }

  // Plenty of pages refuse injection (the web store, other extensions, sandboxed frames).
  // URL and title are still enough to judge, so fall back to them instead of failing.
  const content = (await extractFromTab(tabId)) || { title: tab.title || '', thin: true };

  const result = await classify(content, tab.url);
  if (result.verdict === 'ERROR') {
    await recordFailure(tabId, result.error, claim);
    return;
  }
  cache.set(cacheKey, result);
  await recordSuccess(tabId, result, !!content.thin, claim);
}

async function recordSuccess(tabId, result, thin, claim) {
  let blocked = false;
  await updateTracking((tracking) => {
    const entry = tracking[tabId];
    if (!entry || entry.claim !== claim) return; // the page moved on while we were asking
    entry.verdict = result.verdict;
    entry.error = null;
    entry.thin = thin;
    entry.model = result.model || null;
    entry.checking = null;
    entry.claim = null;
    entry.checkDue = false;
    entry.nextAttemptAt = null;
    entry.distracted = result.verdict === 'BLOCK';
    blocked = entry.distracted;
  });
  // a tab with no content script (pdf viewer, blocked injection) rejects here
  if (blocked) chrome.tabs.sendMessage(tabId, { type: 'showBlockOverlay' }).catch(() => {});
}

async function recordFailure(tabId, error, claim) {
  let retryInMinutes = null;
  await updateTracking((tracking) => {
    const entry = tracking[tabId];
    if (!entry || entry.claim !== claim) return;
    entry.attempts = (entry.attempts || 0) + 1;
    entry.checking = null;
    entry.claim = null;
    entry.error = error;
    if (entry.attempts >= MAX_ATTEMPTS) {
      entry.verdict = 'ERROR'; // give up, stop retrying
      entry.nextAttemptAt = null;
    } else {
      retryInMinutes = RETRY_BACKOFF_MINUTES[entry.attempts - 1];
      entry.nextAttemptAt = Date.now() + retryInMinutes * 60000;
    }
  });
  console.warn('[DF] check failed:', error, retryInMinutes ? `- retrying in ${retryInMinutes}m` : '- giving up');
  if (retryInMinutes) chrome.alarms.create(`check_${tabId}`, { delayInMinutes: retryInMinutes });
}

// the per-tab alarm is one-shot: if the service worker dies mid-check, nothing would ever reschedule it
async function watchdog() {
  const tracking = await getTracking();
  const minutes = await getCheckMinutes();
  const now = Date.now();
  for (const [id, entry] of Object.entries(tracking)) {
    if (entry.verdict) continue;
    if (entry.checking && now - entry.checking < STALE_CHECK_MS) continue;
    const dueAt = entry.nextAttemptAt || entry.currentUrlSince + minutes * 60000;
    if (dueAt <= now) checkTab(Number(id));
  }
}

function buildPageBundle(content, tabUrl) {
  const lines = [`URL: ${fenceSafe(tabUrl)}`, `Page title: ${fenceSafe(content.title)}`];
  if (content.thin) {
    lines.push('', 'This page refused to be read. Judge it from the URL and title above.');
    return lines.join('\n');
  }
  if (content.youtube) {
    lines.push(
      `YouTube surface: ${fenceSafe(content.youtube.surface)}`,
      `Search query: ${fenceSafe(content.youtube.searchQuery) || '(none)'}`,
      `Video title: ${fenceSafe(content.youtube.videoTitle) || '(not a watch page)'}`,
      `Channel: ${fenceSafe(content.youtube.channel)}`,
      `Video description: ${fenceSafe(content.youtube.description)}`
    );
  }
  lines.push(
    `H1: ${fenceSafe(content.h1)}`,
    `og:title: ${fenceSafe(content.ogTitle)}`,
    `og:site_name: ${fenceSafe(content.ogSiteName)}`,
    `og:type: ${fenceSafe(content.ogType)}`,
    `meta description: ${fenceSafe(content.description)}`,
    `meta keywords: ${fenceSafe(content.keywords)}`
  );
  if (content.jsonLd?.length) {
    lines.push(`Structured data: ${fenceSafe(JSON.stringify(content.jsonLd).slice(0, 600))}`);
  }
  lines.push(
    '',
    'Main page text, with navigation, sidebars, forms and footers already stripped out:',
    fenceSafe(content.mainText) || '(the page exposed no readable text)'
  );
  return lines.join('\n');
}

async function getSystemPrompt() {
  const { systemPrompt } = await chrome.storage.local.get('systemPrompt');
  return (systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
}

// which provider is live, its key, and the candidate models in fallback order
async function getProviderConfig() {
  const stored = await chrome.storage.local.get([
    'provider', 'geminiApiKey', 'geminiModel', 'openrouterApiKey', 'openrouterModels',
  ]);
  const provider = normalizeProvider(stored.provider);

  if (provider === 'openrouter') {
    const list = stored.openrouterModels || DEFAULT_OPENROUTER_MODELS;
    return { provider, apiKey: stored.openrouterApiKey || '', list, primary: parseModelList(list)[0] || '' };
  }
  return { provider, apiKey: stored.geminiApiKey || '', list: '', primary: stored.geminiModel || DEFAULT_MODEL };
}

async function callModel(provider, model, apiKey, userText, withThinkingConfig) {
  const systemPrompt = await getSystemPrompt();
  const { url, headers, body } = buildRequest(provider, {
    model, apiKey, systemPrompt, userText, withThinkingConfig,
  });
  return fetch(url, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), // a hung request would otherwise die with the worker
    body: JSON.stringify(body),
  });
}

// the model that last answered; a busy model is not re-tried for every tab until settings change
let sessionModel = null;

// -> { verdict } | { error, tryNextModel }
async function askModel(provider, model, apiKey, userText) {
  let withThinkingConfig = true;
  let lastError = 'unknown';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await callModel(provider, model, apiKey, userText, withThinkingConfig);

      if (!res.ok) {
        const body = await res.text();
        lastError = `HTTP ${res.status}: ${body.slice(0, 160)}`;
        if (provider === 'gemini' && withThinkingConfig && /thinking/i.test(body)) {
          withThinkingConfig = false; // model predates thinkingConfig, same model can still answer
          continue;
        }
        // busy, over quota, retired, or an id this provider does not carry
        const modelsFault =
          TRANSIENT_STATUS.has(res.status) || res.status === 404 || (res.status === 400 && /model/i.test(body));
        return { error: lastError, tryNextModel: modelsFault };
      }

      const data = await res.json();
      const verdict = readVerdict(provider, data);
      if (verdict) return { verdict };
      lastError = `Empty reply (${finishReasonOf(provider, data)})`;
    } catch (e) {
      if (e.name === 'TimeoutError') {
        return { error: `${model} did not answer in ${REQUEST_TIMEOUT_MS / 1000}s`, tryNextModel: true };
      }
      return { error: e.message, tryNextModel: false }; // offline, DNS, aborted - no model helps
    }
  }
  return { error: lastError, tryNextModel: true };
}

async function classify(content, tabUrl) {
  const { provider, apiKey, primary, list } = await getProviderConfig();
  if (!apiKey) return { verdict: 'ERROR', error: `No ${PROVIDERS[provider]} API key saved` };

  const userText = `<page_signals>\n${buildPageBundle(content, tabUrl)}\n</page_signals>`;
  const candidates = modelOrder(provider, sessionModel || primary, list);
  if (!candidates.length) return { verdict: 'ERROR', error: 'No model configured' };

  let lastError = 'unknown';
  for (const model of candidates) {
    const result = await askModel(provider, model, apiKey, userText);
    if (result.verdict) {
      if (sessionModel !== model) console.info('[DF] answering with', model);
      sessionModel = model; // stay on whatever is actually up
      return { verdict: result.verdict, model };
    }
    lastError = `${model}: ${result.error}`;
    if (!result.tryNextModel) return { verdict: 'ERROR', error: lastError };
    console.warn('[DF]', lastError, '- trying the next model');
  }

  sessionModel = null; // everything was down; start again from the chosen model next time
  return { verdict: 'ERROR', error: `All models failed. Last: ${lastError}` };
}

async function seedExistingTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && tab.url.startsWith('http')) await handleNavigation(tab.id, tab.url, tab.title);
  }
}

// tab ids are reused across browser restarts, so stale entries would otherwise pile up forever
async function pruneTracking() {
  const openIds = new Set((await chrome.tabs.query({})).map((t) => String(t.id)));
  await updateTracking((tracking) => {
    for (const id of Object.keys(tracking)) {
      if (!openIds.has(id)) delete tracking[id];
    }
  });
  for (const alarm of await chrome.alarms.getAll()) {
    const match = alarm.name.match(/^check_(\d+)$/);
    if (match && !openIds.has(match[1])) chrome.alarms.clear(alarm.name);
  }
}

function scheduleDailyReset() {
  const next = new Date();
  next.setHours(12, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  chrome.alarms.create('dailyReset', { when: next.getTime(), periodInMinutes: 24 * 60 });
}

async function dailyReset() {
  // provider keys, models, checkMinutes, systemPrompt and skipHosts are intentionally left untouched
  await chrome.storage.local.set({ tabTracking: {}, distractedClosedCount: 0 });
  await seedExistingTabs(); // tabs still open need their tracking back
}

async function rearmAll() {
  cache.clear(); // verdicts were produced by the previous prompt/model
  sessionModel = null; // honour the model the user just picked
  for (const alarm of await chrome.alarms.getAll()) {
    if (alarm.name.startsWith('check_')) chrome.alarms.clear(alarm.name);
  }
  const minutes = await getCheckMinutes();
  const tabs = await chrome.tabs.query({});
  const unreadable = new Map(); // tabId -> pre-verdict that means "never ask the model"
  for (const tab of tabs) {
    if (!tab.url?.startsWith('http')) continue;
    if (isRestrictedUrl(tab.url)) unreadable.set(tab.id, 'UNSUPPORTED');
    else if (await isSkipped(tab.url)) unreadable.set(tab.id, 'SKIP');
  }

  await updateTracking((tracking) => {
    for (const tab of tabs) {
      const entry = tracking[tab.id];
      if (!entry) continue;
      const pre = unreadable.get(tab.id) || null;
      entry.currentUrlSince = Date.now();
      entry.verdict = pre;
      entry.error = null;
      entry.checkDue = false;
      entry.attempts = 0;
      entry.checking = null;
      entry.claim = null; // orphans any check still in flight under the old settings
      entry.distracted = false;
      entry.nextAttemptAt = pre ? null : Date.now() + minutes * 60000;
    }
  });

  for (const tab of tabs) {
    if (tab.url?.startsWith('http') && !unreadable.has(tab.id)) {
      chrome.alarms.create(`check_${tab.id}`, { delayInMinutes: minutes });
    }
  }
}

async function init() {
  scheduleDailyReset();
  chrome.alarms.create('watchdog', { periodInMinutes: 1 });
  await pruneTracking();
  await seedExistingTabs();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    await handleNavigation(tabId, tab.url, tab.title);
    const tracking = await getTracking();
    if (tracking[tabId]?.checkDue) checkTab(tabId);
  }
});

// SPA navigation, handled by the browser instead of a polling timer inside every open page
function handleSpaNavigation({ tabId, frameId, url }) {
  if (frameId !== 0) return;
  handleNavigation(tabId, url);
  // a verdict for the previous page must not keep blocking this one
  chrome.tabs.sendMessage(tabId, { type: 'pageChanged' }).catch(() => {});
}
chrome.webNavigation.onHistoryStateUpdated.addListener(handleSpaNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(handleSpaNavigation);

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tracking = await getTracking();
  if (tracking[tabId]?.checkDue) checkTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.alarms.clear(`check_${tabId}`);
  serialize(async () => {
    const tracking = await getTracking();
    if (tracking[tabId]?.distracted) {
      const { distractedClosedCount } = await chrome.storage.local.get('distractedClosedCount');
      await chrome.storage.local.set({ distractedClosedCount: (distractedClosedCount || 0) + 1 });
    }
    delete tracking[tabId];
    await chrome.storage.local.set({ tabTracking: tracking });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dailyReset') {
    dailyReset();
    return;
  }
  if (alarm.name === 'watchdog') {
    watchdog();
    return;
  }
  const match = alarm.name.match(/^check_(\d+)$/);
  if (match) checkTab(Number(match[1]));
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'closeTab' && sender.tab) chrome.tabs.remove(sender.tab.id);
  if (message.type === 'rearmAll') rearmAll();
});

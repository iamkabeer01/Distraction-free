(function () {
  if (window.__dfLoaded) return; // may be injected twice: declared in manifest + programmatic fallback
  window.__dfLoaded = true;

  const OVERLAY_ID = '__df_block_overlay__';
  const CARD_ID = '__df_block_card__';
  let repauseTimer = null;
  let shownState = null;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch {
      // extension was reloaded - this orphaned script has nothing to talk to
    }
  }

  function meta(...selectors) {
    for (const sel of selectors) {
      const value = document.querySelector(sel)?.content?.trim();
      if (value) return value;
    }
    return '';
  }

  function text(...selectors) {
    for (const sel of selectors) {
      const value = document.querySelector(sel)?.textContent?.trim();
      if (value) return value;
    }
    return '';
  }

  function structuredData() {
    const out = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent);
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          if (item && typeof item === 'object') {
            out.push({
              type: item['@type'] || '',
              name: item.name || item.headline || '',
              description: String(item.description || '').slice(0, 200),
            });
          }
        }
      } catch {
        // malformed JSON-LD is common in the wild
      }
      if (out.length >= 3) break;
    }
    return out;
  }

  function youtubeDetails() {
    if (!location.hostname.endsWith('youtube.com')) return null;
    const path = location.pathname;
    const surface =
      path === '/'
        ? 'home recommendation feed'
        : path.startsWith('/watch')
        ? 'single video watch page'
        : path.startsWith('/shorts')
        ? 'shorts feed'
        : path.startsWith('/results')
        ? 'search results'
        : path.startsWith('/feed/subscriptions')
        ? 'subscriptions feed'
        : path;
    return {
      surface,
      searchQuery: new URLSearchParams(location.search).get('search_query') || '',
      videoTitle: text('h1.ytd-watch-metadata', '#title h1', 'h1.title'),
      channel: text('ytd-channel-name#channel-name a', '#owner #channel-name a', '#upload-info #channel-name a'),
      description: text('#description-inline-expander', '#description').slice(0, 800),
    };
  }

  // Boilerplate never describes what is being consumed, and it is most of the markup.
  // Dropping it is what lets plain text alone carry the judgement.
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
    'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA', 'LABEL',
  ]);
  const SKIP_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar',
    'toolbar', 'tablist', 'dialog', 'alert',
  ]);

  // A TreeWalker reads the live DOM: cloning first would break innerText, because a
  // detached node has no layout and falls back to raw textContent.
  function mainText(limit) {
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    if (!root) return '';

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT; // rejects the subtree too
        if (node.hidden || node.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        if (SKIP_ROLES.has(node.getAttribute('role'))) return NodeFilter.FILTER_REJECT;
        // CSS-hidden text (MathML LaTeX annotations, collapsed menus, print-only blocks) would
        // otherwise eat the budget. Pruning the subtree early makes this cheaper, not dearer.
        if (node.checkVisibility && !node.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const parts = [];
    let length = 0;
    while (length < limit && walker.nextNode()) {
      if (walker.currentNode.nodeType !== Node.TEXT_NODE) continue;
      const chunk = walker.currentNode.nodeValue.replace(/\s+/g, ' ').trim();
      if (chunk.length < 2) continue; // lone bullets, separators, stray punctuation
      parts.push(chunk);
      length += chunk.length + 1;
    }
    return parts.join(' ').slice(0, limit);
  }

  function extractContent() {
    return {
      url: location.href,
      title: document.title,
      h1: text('h1'),
      ogTitle: meta('meta[property="og:title"]'),
      ogType: meta('meta[property="og:type"]'),
      ogSiteName: meta('meta[property="og:site_name"]'),
      description: meta('meta[property="og:description"]', 'meta[name="description"]'),
      keywords: meta('meta[name="keywords"]').slice(0, 300),
      jsonLd: structuredData(),
      youtube: youtubeDetails(),
      mainText: mainText(2400),
    };
  }

  function pauseMedia() {
    document.querySelectorAll('video, audio').forEach((el) => {
      try {
        if (!el.paused) el.pause();
      } catch {
        // some players wrap pause() and throw
      }
    });
  }

  // The page underneath is arbitrary, so the card carries its own fixed dark theme and
  // resets every inherited property. Three states share one card: the block itself, the
  // second look at it, and the argument you get when that look agrees it is entertainment.
  const STATES = {
    blocked: {
      accent: '#f5f5f2',
      title: 'You are wasting your time here.',
      body: 'This page was judged as time-wasting content. Playback is paused.',
      buttons: [['close', 'Close this tab', true]],
    },
    checking: {
      accent: '#f5f5f2',
      title: 'Taking another look…',
      body: 'Reading what is actually on this page before deciding whether to let you through.',
      buttons: [],
    },
    timeup: {
      accent: '#f5f5f2',
      title: 'Your time here is up.',
      body: '', // replaced with the live countdown on every poll
      buttons: [['close', 'Close this tab', true]],
    },
    warning: {
      accent: '#f07070',
      title: 'This is entertainment.',
      body:
        'You already know it is. Unblocking buys you an hour you will not remember tomorrow, ' +
        'and the thing you actually sat down to do will still be sitting there, untouched, when you look up.',
      buttons: [['keep', 'Keep it blocked', true], ['anyway', 'Waste it anyway', false]],
    },
  };

  const BTN_BASE =
    'all:initial;font-family:inherit;box-sizing:border-box;padding:11px 22px;border-radius:8px;' +
    'font-size:14px;font-weight:600;cursor:pointer;text-align:center;';
  const BTN = {
    primary: BTN_BASE + 'background:#1f6fc9;color:#ffffff;box-shadow:0 2px 10px rgba(31,111,201,.4);',
    ghost: BTN_BASE + 'background:transparent;color:#b9b8b0;border:1px solid rgba(255,255,255,.18);',
  };

  function renderCard(name) {
    const state = STATES[name] || STATES.blocked;
    const card = document.getElementById(CARD_ID);
    if (!card) return;
    shownState = name;
    card.innerHTML = `
      <svg width="46" height="46" viewBox="0 0 128 128" aria-hidden="true" style="all:initial;display:block;">
        <defs><linearGradient id="__dfg" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stop-color="#519bf5"/><stop offset="1" stop-color="#1857ae"/></linearGradient></defs>
        <rect width="128" height="128" rx="29" fill="url(#__dfg)"/>
        <circle cx="64" cy="64" r="28" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round"
                stroke-dasharray="148.5 27.4" transform="rotate(-8 64 64)"/>
        <circle cx="64" cy="64" r="13" fill="#fff"/>
      </svg>
      <div style="all:initial;font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.09em;
                  text-transform:uppercase;color:#8f8d86;">Distraction Free</div>
      <div style="all:initial;font-family:inherit;font-size:21px;font-weight:640;line-height:1.3;
                  color:${state.accent};"></div>
      <div style="all:initial;font-family:inherit;font-size:13px;line-height:1.5;color:#b9b8b0;"></div>
      <div style="all:initial;font-family:inherit;display:flex;gap:10px;margin-top:6px;
                  flex-wrap:wrap;justify-content:center;"></div>
    `;
    // textContent, not markup: the strings are ours but the card is built once, safely
    card.children[2].textContent = state.title;
    card.children[3].textContent = state.body;

    const row = card.children[4];
    for (const [id, label, primary] of state.buttons) {
      const btn = document.createElement('button');
      btn.id = '__df_' + id;
      btn.style.cssText = primary ? BTN.primary : BTN.ghost;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (id === 'close') send({ type: 'closeTab' });
        if (id === 'anyway') send({ type: 'unblockConfirmed' });
        if (id === 'keep') renderCard('blocked');
      });
      row.appendChild(btn);
    }
    row.firstChild?.focus();
  }

  function showOverlay(state) {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.cssText = `
        all: initial; position: fixed; inset: 0; width: 100vw; height: 100vh;
        background: rgba(10, 12, 16, 0.55); backdrop-filter: blur(26px) saturate(120%);
        -webkit-backdrop-filter: blur(26px) saturate(120%);
        z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      `;
      const card = document.createElement('div');
      card.id = CARD_ID;
      card.style.cssText =
        'all:initial;font-family:inherit;box-sizing:border-box;display:flex;flex-direction:column;' +
        'align-items:center;text-align:center;gap:14px;max-width:380px;padding:34px 32px 30px;' +
        'background:#1a1a19;border:1px solid rgba(255,255,255,.1);border-radius:16px;' +
        'box-shadow:0 24px 70px rgba(0,0,0,.55);color:#f5f5f2;';
      overlay.appendChild(card);
      document.documentElement.appendChild(overlay);
      repauseTimer = setInterval(pauseMedia, 1000); // players and ad breaks restart themselves
    }
    pauseMedia();
    if (shownState !== state) renderCard(state); // rebuilding it every poll would steal focus back
  }

  function removeOverlay() {
    clearInterval(repauseTimer);
    repauseTimer = null;
    shownState = null;
    document.getElementById(OVERLAY_ID)?.remove();
  }

  /* ── timed sites ────────────────────────────────────────────
     The background owns the budget; this reports whether the page is really being
     looked at and draws what it is told. Polling rather than a clock of its own,
     because every tab open on the site is spending the same five minutes.       */
  const PILL_ID = '__df_quota_pill__';
  const QUOTA_POLL_MS = 5000; // MAX_SLICE_MS in shared.js is the ceiling on one of these
  let quotaPoll = null;
  let quotaOff = false; // most pages are not timed, and must not keep asking on every tab switch

  // a tab behind another window or another tab is not spending your attention
  const watching = () => document.visibilityState === 'visible' && document.hasFocus();

  function ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? null : r));
      } catch {
        resolve(null); // extension reloaded out from under this script
      }
    });
  }

  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(total / 60);
    if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${mins}:${String(total % 60).padStart(2, '0')}`;
  }

  function showPill(text, urgent) {
    let el = document.getElementById(PILL_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = PILL_ID;
      el.style.cssText =
        'all:initial;position:fixed;top:14px;right:14px;z-index:2147483646;pointer-events:none;' +
        'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;font-weight:600;' +
        'padding:7px 13px;border-radius:999px;background:rgba(16,18,22,.88);' +
        'border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 22px rgba(0,0,0,.4);' +
        'font-variant-numeric:tabular-nums;letter-spacing:.02em;';
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.style.color = urgent ? '#f07070' : '#f5f5f2';
  }

  const removePill = () => document.getElementById(PILL_ID)?.remove();

  async function syncQuota() {
    if (quotaOff) return;
    const state = await ask({ type: 'quotaSync', running: watching() });
    if (!state?.timed) {
      clearInterval(quotaPoll); // not on the list, or no longer on it: stop asking
      quotaPoll = null;
      quotaOff = true;
      removePill();
      if (shownState === 'timeup') removeOverlay();
      return;
    }
    if (state.blocked) {
      removePill();
      showOverlay('timeup');
      const card = document.getElementById(CARD_ID);
      if (card) {
        card.children[3].textContent =
          `${state.site} opens again in ${clock(state.unblockInMs)}. ` +
          `Your ${Math.round(state.quotaMs / 60000)} minutes here are spent.`;
      }
      return;
    }
    if (shownState === 'timeup') removeOverlay(); // the cooldown ran out while this page sat here
    showPill(`${clock(state.remainingMs)} left`, state.remainingMs <= 60000);
  }

  syncQuota();
  quotaPoll = setInterval(syncQuota, QUOTA_POLL_MS);
  // a tab switch or an alt-tab has to stop the clock now, not at the next poll
  for (const event of ['visibilitychange', 'focus', 'blur']) addEventListener(event, syncQuota);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'extractContent') sendResponse(extractContent());
    if (message.type === 'showBlockOverlay') {
      showOverlay(message.state || 'blocked');
      sendResponse(true); // the sender retries a silent tab, so it has to hear back
    }
    // background saw an SPA navigation: a verdict for the previous page must not block this one
    if (message.type === 'pageChanged') {
      removeOverlay();
      if (quotaPoll) syncQuota(); // or clicking around an SPA would buy five free seconds a click
    }
  });
})();

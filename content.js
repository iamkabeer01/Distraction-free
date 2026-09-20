(function () {
  if (window.__dfLoaded) return; // may be injected twice: declared in manifest + programmatic fallback
  window.__dfLoaded = true;

  const OVERLAY_ID = '__df_block_overlay__';
  const CARD_ID = '__df_block_card__';
  let repauseTimer = null;

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
    renderCard(state);
  }

  function removeOverlay() {
    clearInterval(repauseTimer);
    repauseTimer = null;
    document.getElementById(OVERLAY_ID)?.remove();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'extractContent') sendResponse(extractContent());
    if (message.type === 'showBlockOverlay') {
      showOverlay(message.state || 'blocked');
      sendResponse(true); // the sender retries a silent tab, so it has to hear back
    }
    // background saw an SPA navigation: a verdict for the previous page must not block this one
    if (message.type === 'pageChanged') removeOverlay();
  });
})();

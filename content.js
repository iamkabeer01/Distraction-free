(function () {
  if (window.__dfLoaded) return; // may be injected twice: declared in manifest + programmatic fallback
  window.__dfLoaded = true;

  const OVERLAY_ID = '__df_block_overlay__';
  let repauseTimer = null;
  let urlTimer = null;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch {
      clearInterval(urlTimer); // extension was reloaded - this orphaned script should go quiet
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

  function extractContent() {
    const root = document.querySelector('main, article, [role="main"]') || document.body;
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
      mainText: (root?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3000),
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

  function showOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    pauseMedia();

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = `
      all: initial; position: fixed; inset: 0; width: 100vw; height: 100vh;
      background: rgba(10, 12, 16, 0.55); backdrop-filter: blur(26px) saturate(120%);
      -webkit-backdrop-filter: blur(26px) saturate(120%);
      z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    `;
    // the page underneath is arbitrary, so this card carries its own fixed dark theme
    overlay.innerHTML = `
      <div style="all:initial;font-family:inherit;box-sizing:border-box;display:flex;flex-direction:column;
                  align-items:center;text-align:center;gap:14px;max-width:380px;padding:34px 32px 30px;
                  background:#1a1a19;border:1px solid rgba(255,255,255,.1);border-radius:16px;
                  box-shadow:0 24px 70px rgba(0,0,0,.55);color:#f5f5f2;">
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
        <div style="all:initial;font-family:inherit;font-size:21px;font-weight:640;line-height:1.3;color:#f5f5f2;">
          You are wasting your time here.</div>
        <div style="all:initial;font-family:inherit;font-size:13px;line-height:1.5;color:#b9b8b0;">
          This page was judged as time-wasting content. Playback is paused.</div>
        <button id="__df_close_btn__" style="all:initial;font-family:inherit;box-sizing:border-box;
                margin-top:6px;padding:11px 26px;border-radius:8px;background:#1f6fc9;color:#ffffff;
                font-size:14px;font-weight:600;cursor:pointer;text-align:center;
                box-shadow:0 2px 10px rgba(31,111,201,.4);">Close this tab</button>
      </div>
    `;
    document.documentElement.appendChild(overlay);

    const btn = document.getElementById('__df_close_btn__');
    btn.addEventListener('click', () => send({ type: 'closeTab' }));
    btn.addEventListener('mouseenter', () => (btn.style.background = '#1a62b6'));
    btn.addEventListener('mouseleave', () => (btn.style.background = '#1f6fc9'));
    btn.focus();

    repauseTimer = setInterval(pauseMedia, 1000); // players and ad breaks restart themselves
  }

  function removeOverlay() {
    clearInterval(repauseTimer);
    repauseTimer = null;
    document.getElementById(OVERLAY_ID)?.remove();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'extractContent') sendResponse(extractContent());
    if (message.type === 'showBlockOverlay') showOverlay();
  });

  // ponytail: SPA sites never fire a real navigation - poll the URL instead of wiring per-site nav events
  let lastUrl = location.href;
  urlTimer = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      removeOverlay(); // a verdict for the previous page must not block this one
      send({ type: 'navigated', url: location.href });
    }
  }, 1000);

  send({ type: 'navigated', url: location.href });
})();

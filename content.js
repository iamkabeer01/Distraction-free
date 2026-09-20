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
      position: fixed; inset: 0; width: 100vw; height: 100vh;
      background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      z-index: 2147483647;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: #fff; font-family: system-ui, sans-serif; text-align: center;
    `;
    overlay.innerHTML = `
      <div style="font-size: 22px; margin-bottom: 24px; max-width: 480px; text-shadow: 0 1px 4px rgba(0,0,0,0.8);">You are wasting your time here.</div>
      <button id="__df_close_btn__" style="font-size: 16px; padding: 10px 24px; cursor: pointer; border: none; border-radius: 6px; background: #e53935; color: #fff;">Close site</button>
    `;
    document.documentElement.appendChild(overlay);
    document.getElementById('__df_close_btn__').addEventListener('click', () => send({ type: 'closeTab' }));

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

// =============================================
// HELPER — ISOLATED WORLD CONTENT SCRIPT
// Runs in Chrome's ISOLATED world with access
// to chrome.* APIs and cross-origin fetch
// permissions. The MAIN world can't reach the
// Cloudflare Worker directly due to ChatGPT's
// CSP, so this script acts as the bridge.
// =============================================

const SCRAPE_URL = 'https://scraper.ahmansonlab.workers.dev/';

// Listen for scrape requests from the MAIN world
document.addEventListener('sp-scrape-request', async (e) => {
  const urls = e.detail?.urls;
  if (!urls || urls.length === 0) return;

  try {
    const resp = await fetch(SCRAPE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls })
    });
    const data = await resp.json();

    // Send results back to MAIN world
    document.dispatchEvent(new CustomEvent('sp-scrape-response', {
      detail: { success: true, data }
    }));
  } catch (err) {
    document.dispatchEvent(new CustomEvent('sp-scrape-response', {
      detail: { success: false, error: err.message }
    }));
  }
});

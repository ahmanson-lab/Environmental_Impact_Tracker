// =============================================
// AI TOOL PANEL — MAIN WORLD CONTENT SCRIPT
// Runs on chatgpt.com, intercepts fetch for
// token tracking, resource estimation, and
// search source extraction.
// =============================================

// =============================================
// STATE
// =============================================

let currentModel = '—';
let currentDatacenter = null;

// Token tracking — per request
let lastInput = 0, lastOutput = 0, lastSearch = 0;

// Token tracking — session totals
let runInput = 0, runOutput = 0, runSearch = 0, runRequests = 0;

// Chart history
let perRequestHistory = [];
let sessionHistory = [];

// Estimated input tokens from request body
let pendingInputEstimate = 0;

// Are we currently streaming a response?
let isStreaming = false;
let streamOutputTokens = 0;

// Resource rates (per token)
const RES_PER_TOKEN = {
  energy: 0.00035,   // Wh
  co2:    0.000137,  // gCO₂e
  water:  0.00032,   // mL
};

// Model presets for environmental impact rates
const MODEL_PRESETS = {
  'low': {
    name: 'Lower Estimate',
    source: 'Google Cloud Blog, Aug 2025',
    sourceUrl: 'https://cloud.google.com/blog/products/infrastructure/measuring-the-environmental-impact-of-ai-inference/',
    sourceDetail: 'Self-reported by Google for Gemini on custom TPU hardware. Uses market-based carbon accounting (credits renewable energy purchases) and reflects some of the most optimized AI infrastructure in the world.',
    energy: 0.00012,
    co2:    0.000015,
    water:  0.00013,
  },
  'mid': {
    name: 'Middle Estimate',
    source: 'EcoLogits / Epoch AI / OpenAI',
    sourceUrl: 'https://ecologits.ai/latest/methodology/llm_inference/',
    sourceDetail: 'Derived from EcoLogits parametric model for GPT-4o, cross-referenced with Epoch AI analysis and OpenAI\'s disclosed 0.34 Wh per query. Models energy as a function of parameter count, batch size, and infrastructure overhead.',
    energy: 0.00035,
    co2:    0.000137,
    water:  0.00032,
  },
  'high': {
    name: 'Higher Estimate',
    source: 'Jegham et al., 2025',
    sourceUrl: 'https://arxiv.org/abs/2505.09598',
    sourceDetail: 'Independent academic benchmark of 30 models across OpenAI, Anthropic, Meta, and DeepSeek. Uses location-based carbon accounting (actual grid emissions, not renewable energy credits) and provider-specific infrastructure data.',
    energy: 0.00042,
    co2:    0.000180,
    water:  0.00039,
  },
  'custom': {
    name: 'Custom',
    source: 'User-defined rates',
    sourceUrl: null,
    sourceDetail: 'Enter your own per-token rates based on your preferred source.',
    energy: 0.00035,
    co2:    0.000137,
    water:  0.00032,
  },
};

let activePreset = 'mid';

const COLORS = {
  input:    { line: '#5570e6', fill: 'rgba(85, 112, 230, 0.1)' },
  output:   { line: '#4ade80', fill: 'rgba(74, 222, 128, 0.1)' },
  search:   { line: '#e545a0', fill: 'rgba(229, 69, 160, 0.1)' },
};

// Datacenter map (from original extension)
const DATACENTER_MAP = {
  'westus3': { name: 'West US 3', short: 'El Mirage, AZ', lat: 33.6132, lng: -112.3246 },
  'westus2': { name: 'West US 2', short: 'Quincy, WA', lat: 47.2343, lng: -119.8526 },
  'westus': { name: 'West US', short: 'Fresno, CA', lat: 36.7378, lng: -119.7871 },
  'westcentralus': { name: 'West Central US', short: 'Cheyenne, WY', lat: 41.1400, lng: -104.8202 },
  'eastus': { name: 'East US', short: 'Boydton, VA', lat: 36.6681, lng: -78.3875 },
  'eastus2': { name: 'East US 2', short: 'Boydton, VA', lat: 36.6681, lng: -78.3875 },
  'centralus': { name: 'Central US', short: 'Des Moines, IA', lat: 41.5868, lng: -93.6250 },
  'southcentralus': { name: 'South Central US', short: 'San Antonio, TX', lat: 29.4241, lng: -98.4936 },
  'northcentralus': { name: 'North Central US', short: 'Northlake, IL', lat: 41.9170, lng: -87.8984 },
  'westeurope': { name: 'West Europe', short: 'Amsterdam, NL', lat: 52.3676, lng: 4.9041 },
  'northeurope': { name: 'North Europe', short: 'Dublin, IE', lat: 53.3498, lng: -6.2603 },
  'uksouth': { name: 'UK South', short: 'London, UK', lat: 51.5074, lng: -0.1278 },
  'japaneast': { name: 'Japan East', short: 'Tokyo, JP', lat: 35.6762, lng: 139.6503 },
  'southeastasia': { name: 'Southeast Asia', short: 'Singapore', lat: 1.3521, lng: 103.8198 },
  'australiaeast': { name: 'Australia East', short: 'Sydney, AU', lat: -33.8688, lng: 151.2093 },
  'canadacentral': { name: 'Canada Central', short: 'Toronto, CA', lat: 43.6532, lng: -79.3832 },
  'francecentral': { name: 'France Central', short: 'Paris, FR', lat: 48.8566, lng: 2.3522 },
  'germanywestcentral': { name: 'Germany West Central', short: 'Frankfurt, DE', lat: 50.1109, lng: 8.6821 },
  'swedencentral': { name: 'Sweden Central', short: 'Stockholm, SE', lat: 59.3293, lng: 18.0686 },
  'koreacentral': { name: 'Korea Central', short: 'Seoul, KR', lat: 37.5665, lng: 126.9780 },
};

function lookupDatacenter(region) {
  if (!region) return null;
  const key = region.toLowerCase().replace(/[^a-z0-9]/g, '');
  return DATACENTER_MAP[key] || { name: region, short: region, lat: null, lng: null };
}

// =============================================
// INPUT TOKEN ESTIMATION
// =============================================

// Count words in a text string
function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// Scan the full conversation history on the page and estimate input tokens.
// Every message visible in the DOM (user + assistant) will be re-sent as
// context when the next prompt is submitted.
function estimateInputTokensFromDOM() {
  const allMessages = document.querySelectorAll('[data-message-author-role]');
  let totalWords = 0;

  allMessages.forEach(msg => {
    totalWords += countWords(msg.textContent);
  });

  // Rough estimate: ~1.3 tokens per English word
  return Math.round(totalWords * 1.3);
}

// Fallback: scan the latest assistant message in the DOM for citation links.
// ChatGPT renders search results as clickable links — we grab any outbound
// URLs from the most recent response regardless of SSE format.
function extractSearchUrlsFromDOM() {
  const urls = [];
  const queries = [];

  const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (assistantMsgs.length === 0) return { urls, queries };

  const latestMsg = assistantMsgs[assistantMsgs.length - 1];

  // Grab all links in the response that point to external sites
  const links = latestMsg.querySelectorAll('a[href]');
  links.forEach(link => {
    const href = link.href;
    if (!href) return;
    try {
      const u = new URL(href);
      // Skip internal ChatGPT links and anchors
      if (u.hostname.includes('chatgpt.com') || u.hostname.includes('openai.com')) return;
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
      urls.push(href);
    } catch (e) {}
  });

  console.log(`[ToolPanel] DOM scan found ${urls.length} external links in latest response`);
  return { urls: [...new Set(urls)], queries };
}

// =============================================
// FETCH INTERCEPTOR
// =============================================

const originalFetch = window.fetch;

window.fetch = async function(resource, init) {
  const url = resource instanceof Request ? resource.url : resource;

  // Intercept outgoing conversation requests
  if (typeof url === 'string' && url.includes('/conversation') && init && init.method === 'POST' && init.body) {
    try {
      // Estimate input tokens from the full conversation history visible on the page.
      // Everything already on screen gets re-sent as context for the new prompt.
      pendingInputEstimate = estimateInputTokensFromDOM();

      // Reset per-request streaming state
      isStreaming = true;
      streamOutputTokens = 0;
    } catch (e) {
      console.log('[ToolPanel] Could not estimate input tokens', e);
    }
  }

  const response = await originalFetch.apply(this, arguments);

  // Intercept streaming responses
  if (typeof url === 'string' && url.includes('/conversation') &&
      response.headers.get('content-type')?.includes('text/event-stream')) {

    const clonedResponse = response.clone();
    let collectedUrls = [];
    let searchQueries = [];
    let finishReasonSeen = false;

    (async () => {
      try {
        const reader = clonedResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') {
              onStreamComplete(collectedUrls, searchQueries);
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              processStreamEvent(parsed, collectedUrls, searchQueries);
            } catch (e) {}
          }
        }

        // If we never saw [DONE], finalize anyway
        if (isStreaming) {
          onStreamComplete(collectedUrls, searchQueries);
        }
      } catch (e) {
        console.log('[ToolPanel] Stream read error', e);
      }
    })();
  }

  return response;
};

function processStreamEvent(parsed, collectedUrls, searchQueries) {
  // Debug: log any event that looks search/tool/citation related
  const msg = parsed.v?.message;
  if (msg) {
    const role = msg.author?.role;
    const recipient = msg.recipient;
    const hasSearch = msg.metadata?.search_result_groups || msg.metadata?.citations || msg.metadata?._cite_metadata;
    if (role === 'tool' || recipient === 'web' || recipient === 'browser' || hasSearch) {
      console.log(`[ToolPanel] Search-related event (role=${role}, recipient=${recipient}):`,
        JSON.stringify(parsed).substring(0, 800));
    }
  }

  // Server-side metadata (datacenter, model)
  if (parsed.type === 'server_ste_metadata' && parsed.metadata) {
    if (parsed.metadata.cluster_region) {
      currentDatacenter = lookupDatacenter(parsed.metadata.cluster_region);
    }
    if (parsed.metadata.model_slug) {
      currentModel = parsed.metadata.model_slug;
    }
  }

  // Model slug from message metadata
  if (parsed.v?.message?.metadata?.model_slug) {
    currentModel = parsed.v.message.metadata.model_slug;
  }

  // Token count patches (array format)
  if (parsed.v && Array.isArray(parsed.v)) {
    for (const patch of parsed.v) {
      if (patch.p === '/message/metadata/token_count') {
        streamOutputTokens = patch.v || 0;
        updateLiveTokenCount();
      }
      // Finish details
      if (patch.p === '/message/metadata/finish_details') {
        // Stream finishing
      }
    }
  }

  // Extract search/browsing URLs from tool messages
  if (parsed.v?.message?.author?.role === 'tool') {
    console.log('[ToolPanel] Tool message:', JSON.stringify(parsed.v.message).substring(0, 500));
    const parts = parsed.v.message.content?.parts || [];
    for (const part of parts) {
      if (typeof part === 'string') {
        // Try to extract URLs from tool output
        const urlMatches = part.match(/https?:\/\/[^\s"<>\])}]+/g);
        if (urlMatches) {
          collectedUrls.push(...urlMatches);
        }
      }
      // Parts can also be objects with structured search results
      if (part && typeof part === 'object') {
        if (part.url) collectedUrls.push(part.url);
        if (part.result_url) collectedUrls.push(part.result_url);
      }
    }
  }

  // Extract search queries from search tool calls in assistant messages
  if (parsed.v?.message?.author?.role === 'assistant' && parsed.v?.message?.metadata?.search_result_groups) {
    console.log('[ToolPanel] Search result groups:', JSON.stringify(parsed.v.message.metadata.search_result_groups).substring(0, 500));
    for (const group of parsed.v.message.metadata.search_result_groups) {
      if (group.search_query) searchQueries.push(group.search_query);
      if (group.title) searchQueries.push(group.title);
      if (group.entries) {
        for (const entry of group.entries) {
          if (entry.url) collectedUrls.push(entry.url);
        }
      }
    }
  }

  // Also check top-level search_result_groups (without .v wrapper)
  if (parsed.v?.message?.metadata?.search_result_groups == null && parsed.v?.message?.metadata) {
    // Log any metadata fields that look search-related for debugging
    const meta = parsed.v.message.metadata;
    if (meta._cite_metadata || meta.citations || meta.search_result_groups) {
      console.log('[ToolPanel] Search metadata:', JSON.stringify(meta).substring(0, 500));
    }
  }

  // Citations from message metadata
  if (parsed.v?.message?.metadata?.citations) {
    for (const cite of parsed.v.message.metadata.citations) {
      if (cite.url) collectedUrls.push(cite.url);
      if (cite.title) { /* available for display */ }
    }
  }

  // _cite_metadata (another ChatGPT format for citations)
  if (parsed.v?.message?.metadata?._cite_metadata?.citation_format?.name === 'web_search') {
    console.log('[ToolPanel] Cite metadata:', JSON.stringify(parsed.v.message.metadata._cite_metadata).substring(0, 500));
  }

  // Search query from various metadata locations
  if (parsed.v?.message?.metadata?.query) {
    searchQueries.push(parsed.v.message.metadata.query);
  }
  if (parsed.v?.message?.metadata?.args?.query) {
    searchQueries.push(parsed.v.message.metadata.args.query);
  }

  // Search tool invocations — the assistant message that triggers search
  if (parsed.v?.message?.recipient === 'web' || parsed.v?.message?.recipient === 'browser') {
    const parts = parsed.v.message.content?.parts || [];
    for (const part of parts) {
      if (typeof part === 'string' && part.trim()) {
        searchQueries.push(part.trim());
      }
    }
  }
}

function updateLiveTokenCount() {
  // Update the live output count in the panel while streaming
  const el = document.getElementById('sp-tok-output');
  if (el) el.textContent = streamOutputTokens.toLocaleString();

  // Update total
  const total = pendingInputEstimate + streamOutputTokens;
  const totalEl = document.getElementById('sp-tok-total');
  if (totalEl) totalEl.textContent = total.toLocaleString();

  // Update input estimate
  const inEl = document.getElementById('sp-tok-input');
  if (inEl) inEl.textContent = pendingInputEstimate.toLocaleString();
}

function onStreamComplete(urls, queries) {
  isStreaming = false;

  // Finalize per-request counts
  lastInput = pendingInputEstimate;
  lastOutput = streamOutputTokens;

  // Fallback: if the stream didn't include a token_count patch,
  // estimate output tokens from the latest assistant message on the page
  if (lastOutput === 0) {
    const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMsgs.length > 0) {
      const latestMsg = assistantMsgs[assistantMsgs.length - 1];
      lastOutput = Math.round(countWords(latestMsg.textContent) * 1.3);
    }
  }

  lastSearch = 0; // Will be updated after scraping

  // Update per-request display
  document.getElementById('sp-tok-input').textContent = lastInput.toLocaleString();
  document.getElementById('sp-tok-output').textContent = lastOutput.toLocaleString();
  document.getElementById('sp-tok-search').textContent = '—';
  document.getElementById('sp-tok-total').textContent = (lastInput + lastOutput).toLocaleString();

  // Record per-request chart entry
  perRequestHistory.push({ inTok: lastInput, outTok: lastOutput, searchTok: 0 });
  drawChart('sp-per-request-chart', perRequestHistory);

  // Update session totals
  runInput += lastInput;
  runOutput += lastOutput;
  runRequests++;

  document.getElementById('sp-run-input').textContent = runInput.toLocaleString();
  document.getElementById('sp-run-output').textContent = runOutput.toLocaleString();
  document.getElementById('sp-run-search').textContent = runSearch.toLocaleString();
  document.getElementById('sp-run-total').textContent = (runInput + runOutput + runSearch).toLocaleString();
  document.getElementById('sp-run-requests').textContent = runRequests;

  // Session chart
  sessionHistory.push({ inTok: runInput, outTok: runOutput, searchTok: runSearch });
  drawChart('sp-session-chart', sessionHistory);

  // Update resources
  updateResourceDisplay();

  // Deduplicate URLs from SSE stream
  let uniqueUrls = [...new Set(urls)].filter(u => {
    try { new URL(u); return true; } catch { return false; }
  });

  console.log(`[ToolPanel] Stream complete. SSE extracted ${uniqueUrls.length} URLs, ${queries.length} queries`);

  if (uniqueUrls.length > 0) {
    displaySearchSources(uniqueUrls, queries);
    scrapeUrls(uniqueUrls);
  } else {
    // Fallback: wait for ChatGPT to finish rendering, then scan the DOM
    // for citation links in the latest assistant message
    setTimeout(() => {
      const domResult = extractSearchUrlsFromDOM();
      if (domResult.urls.length > 0) {
        console.log(`[ToolPanel] DOM fallback found ${domResult.urls.length} URLs`);
        displaySearchSources(domResult.urls, domResult.queries);
        scrapeUrls(domResult.urls);
      } else {
        document.getElementById('sp-search-block').style.display = 'none';
      }
    }, 2000);
  }

  // Reset for next request
  pendingInputEstimate = 0;
  streamOutputTokens = 0;
}

// =============================================
// SEARCH SOURCES & SCRAPING
// =============================================

function displaySearchSources(urls, queries) {
  const block = document.getElementById('sp-search-block');
  const queriesEl = document.getElementById('sp-search-queries');
  const listEl = document.getElementById('sp-search-source-list');
  block.style.display = 'block';

  if (queries.length > 0) {
    queriesEl.innerHTML = queries
      .map(q => `<span class="sp-search-query-tag">${escapeHtml(q)}</span>`)
      .join('');
  } else {
    queriesEl.innerHTML = '<span class="sp-no-data">No search queries detected</span>';
  }

  listEl.innerHTML = urls.map((url, i) => {
    let domain = '';
    try { domain = new URL(url).hostname; } catch(e) {}
    const shortUrl = url.length > 50 ? url.substring(0, 50) + '…' : url;
    return `
      <div class="sp-source-item" id="sp-source-${i}">
        <span class="sp-source-num">${i + 1}</span>
        <div>
          <span class="sp-source-domain">${escapeHtml(domain)}</span>
          <a class="sp-source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(shortUrl)}</a>
          <span class="sp-source-wc" id="sp-source-wc-${i}">Counting words…</span>
        </div>
      </div>
    `;
  }).join('') + '<div id="sp-source-totals" class="sp-source-totals">Scraping pages…</div>';
}

async function scrapeUrls(urls) {
  // The MAIN world can't fetch the Cloudflare Worker directly
  // (ChatGPT's CSP blocks it), so we dispatch a CustomEvent
  // that the ISOLATED world helper.js picks up, fetches, and
  // dispatches the result back.
  document.dispatchEvent(new CustomEvent('sp-scrape-request', {
    detail: { urls }
  }));
}

// Listen for scrape results from the ISOLATED world
document.addEventListener('sp-scrape-response', (e) => {
  const { success, data, error } = e.detail || {};

  if (!success) {
    console.error('[ToolPanel] Scrape failed:', error);
    const totalsEl = document.getElementById('sp-source-totals');
    if (totalsEl) {
      totalsEl.innerHTML = '<span class="sp-no-data">Could not reach word counter.</span>';
    }
    return;
  }

  data.results.forEach((result, i) => {
    const el = document.getElementById(`sp-source-wc-${i}`);
    if (el) {
      if (result.error) {
        el.textContent = `Error: ${result.error}`;
        el.style.color = '#ef4444';
      } else {
        el.innerHTML = `<strong>${result.word_count.toLocaleString()}</strong> words · ~<strong>${result.est_tokens.toLocaleString()}</strong> tokens`;
      }
    }
  });

  const totalsEl = document.getElementById('sp-source-totals');
  if (totalsEl) {
    totalsEl.innerHTML = `
      <span class="sp-source-totals-label">Total web content</span>
      <span class="sp-source-totals-value">${data.total_words.toLocaleString()} words · ~${data.total_est_tokens.toLocaleString()} tokens</span>
    `;
  }

  // Update search token counts
  updateSearchTokens(data.total_est_tokens);
});

function updateSearchTokens(estTokens) {
  lastSearch = estTokens;

  // Per-request display
  document.getElementById('sp-tok-search').textContent = estTokens.toLocaleString();
  const total = lastInput + lastOutput + estTokens;
  document.getElementById('sp-tok-total').textContent = total.toLocaleString();

  // Per-request chart update
  if (perRequestHistory.length > 0) {
    perRequestHistory[perRequestHistory.length - 1].searchTok = estTokens;
    drawChart('sp-per-request-chart', perRequestHistory);
  }

  // Session search total
  runSearch += estTokens;
  document.getElementById('sp-run-search').textContent = runSearch.toLocaleString();
  document.getElementById('sp-run-total').textContent = (runInput + runOutput + runSearch).toLocaleString();

  if (sessionHistory.length > 0) {
    sessionHistory[sessionHistory.length - 1].searchTok = runSearch;
    drawChart('sp-session-chart', sessionHistory);
  }

  updateResourceDisplay();
}

// =============================================
// RESOURCE CALCULATIONS
// =============================================

function getScaleCount() {
  const el = document.getElementById('sp-scale-count');
  return parseInt((el?.value || '1000000').replace(/[^0-9]/g, '')) || 1000000;
}

function updateResourceDisplay() {
  const sesTotal = runInput + runOutput + runSearch;

  // Session totals
  const sesEnergy = sesTotal * RES_PER_TOKEN.energy;
  const sesCo2 = sesTotal * RES_PER_TOKEN.co2;
  const sesWater = sesTotal * RES_PER_TOKEN.water;

  document.getElementById('sp-res-ses-energy').innerHTML = `${sesEnergy.toFixed(3)}<span class="sp-resource-card-unit">Wh</span>`;
  document.getElementById('sp-res-ses-co2').innerHTML = `${sesCo2.toFixed(4)}<span class="sp-resource-card-unit">gCO₂e</span>`;
  document.getElementById('sp-res-ses-water').innerHTML = `${sesWater.toFixed(3)}<span class="sp-resource-card-unit">mL</span>`;

  document.getElementById('sp-res-ses-energy-eq').textContent = sesEnergy < 1
    ? `≈ microwaving for ${(sesEnergy / 0.024).toFixed(1)} seconds`
    : `≈ charging a phone ${(sesEnergy / 20 * 100).toFixed(1)}%`;
  document.getElementById('sp-res-ses-co2-eq').textContent = `≈ driving a car ${(sesCo2 / 150 * 1000 * 3.281).toFixed(1)} feet`;
  document.getElementById('sp-res-ses-water-eq').textContent = sesWater < 5
    ? `≈ ${(sesWater / 5).toFixed(2)} teaspoons`
    : `≈ ${(sesWater / 15).toFixed(1)} tablespoons`;

  // At scale
  const scale = getScaleCount();
  const scaleEnergy = sesEnergy * scale / 1e6;
  const scaleCo2 = sesCo2 * scale / 1000;
  const scaleWater = sesWater * scale / 1000 * 0.2642;

  document.getElementById('sp-res-scale-energy').innerHTML = `${scaleEnergy.toLocaleString(undefined, {maximumFractionDigits: 1})}<span class="sp-resource-card-unit">MWh</span>`;
  document.getElementById('sp-res-scale-water').innerHTML = `${scaleWater.toLocaleString(undefined, {maximumFractionDigits: 0})}<span class="sp-resource-card-unit">gallons</span>`;

  if (scaleCo2 >= 1000) {
    document.getElementById('sp-res-scale-co2').innerHTML = `${(scaleCo2 / 1000).toLocaleString(undefined, {maximumFractionDigits: 1})}<span class="sp-resource-card-unit">metric tons CO₂e</span>`;
  } else {
    document.getElementById('sp-res-scale-co2').innerHTML = `${scaleCo2.toLocaleString(undefined, {maximumFractionDigits: 1})}<span class="sp-resource-card-unit">kg CO₂e</span>`;
  }

  // Equivalence labels
  const scaleCo2g = sesCo2 * scale;
  const drivingMiles = (scaleCo2g / 150) * 0.6214;
  document.getElementById('sp-res-scale-co2-eq').textContent = drivingMiles >= 1
    ? `≈ driving a car ${drivingMiles.toLocaleString(undefined, {maximumFractionDigits: 0})} miles`
    : `≈ driving a car ${(drivingMiles * 5280).toFixed(0)} feet`;

  const homesDay = scaleEnergy * 1000 / 28.77;
  document.getElementById('sp-res-scale-energy-eq').textContent = homesDay >= 1
    ? `≈ powering ${Math.round(homesDay).toLocaleString()} homes for a day`
    : `≈ powering a home for ${(homesDay * 24).toFixed(1)} hours`;

  const pools = scaleWater / 660430;
  document.getElementById('sp-res-scale-water-eq').textContent = pools >= 1
    ? `≈ ${pools.toFixed(1)} Olympic swimming pools`
    : `≈ ${Math.round(scaleWater).toLocaleString()} gallons of fresh water`;
}

// =============================================
// MODEL SELECTION
// =============================================

function renderModelCards() {
  const container = document.getElementById('sp-model-cards');
  if (!container) return;

  container.innerHTML = Object.entries(MODEL_PRESETS).map(([key, preset]) => {
    const isActive = key === activePreset;
    const isCustom = key === 'custom';
    return `
      <div class="sp-model-card ${isActive ? 'sp-model-active' : ''}" data-preset="${key}">
        <div class="sp-model-card-name">${preset.name}</div>
        <div class="sp-model-card-rates">
          <div class="sp-model-card-metric">
            <span class="sp-model-card-number">${preset.energy}</span>
            <span class="sp-model-card-unit">Wh</span>
          </div>
          <div class="sp-model-card-metric">
            <span class="sp-model-card-number">${preset.co2}</span>
            <span class="sp-model-card-unit">gCO₂e</span>
          </div>
          <div class="sp-model-card-metric">
            <span class="sp-model-card-number">${preset.water}</span>
            <span class="sp-model-card-unit">mL</span>
          </div>
        </div>
        ${!isCustom ? `<div class="sp-model-card-source">${preset.source}</div>` : '<div class="sp-model-card-source">Edit rates below</div>'}
      </div>
    `;
  }).join('');

  // Bind click handlers
  container.querySelectorAll('.sp-model-card').forEach(card => {
    card.addEventListener('click', () => {
      selectPreset(card.dataset.preset);
    });
  });
}

function selectPreset(key) {
  const preset = MODEL_PRESETS[key];
  if (!preset) return;

  activePreset = key;

  // Update RES_PER_TOKEN
  RES_PER_TOKEN.energy = preset.energy;
  RES_PER_TOKEN.co2 = preset.co2;
  RES_PER_TOKEN.water = preset.water;

  // Update rate input fields
  document.getElementById('sp-rate-energy').value = preset.energy;
  document.getElementById('sp-rate-co2').value = preset.co2;
  document.getElementById('sp-rate-water').value = preset.water;

  // Enable/disable rate inputs based on whether Custom is selected
  const isCustom = key === 'custom';
  document.getElementById('sp-rate-energy').readOnly = !isCustom;
  document.getElementById('sp-rate-co2').readOnly = !isCustom;
  document.getElementById('sp-rate-water').readOnly = !isCustom;

  // Update source text
  const sourceLinkEl = document.getElementById('sp-source-link');
  const sourceDetailEl = document.getElementById('sp-source-detail');
  if (sourceLinkEl) {
    if (preset.sourceUrl) {
      sourceLinkEl.href = preset.sourceUrl;
      sourceLinkEl.textContent = preset.source;
      sourceLinkEl.style.display = 'block';
    } else {
      sourceLinkEl.style.display = 'none';
    }
  }
  if (sourceDetailEl) {
    sourceDetailEl.textContent = preset.sourceDetail;
  }

  // Update Impact tab note
  const impactNameEl = document.getElementById('sp-impact-model-name');
  if (impactNameEl) impactNameEl.textContent = preset.name;

  // Update card active states
  document.querySelectorAll('.sp-model-card').forEach(c => {
    c.classList.toggle('sp-model-active', c.dataset.preset === key);
  });

  // Recalculate
  updateResourceDisplay();
}

// =============================================
// CHART DRAWING
// =============================================

function drawChart(canvasId, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || data.length === 0) return;
  const ctx = canvas.getContext('2d');

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const pad = { top: 12, right: 10, bottom: 20, left: 36 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  const allVals = data.flatMap(d => [d.inTok, d.outTok, d.searchTok || 0]);
  const maxVal = Math.max(...allVals, 1);
  const n = data.length;

  // Grid lines
  ctx.strokeStyle = '#e0e0e4';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = '#999';
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    const val = maxVal - (maxVal / 4) * i;
    const label = val >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val).toString();
    ctx.fillText(label, pad.left - 4, y + 3);
  }

  // X-axis labels
  ctx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const x = pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    ctx.fillText(i + 1, x, h - 3);
  }

  function getXY(i, val) {
    const x = pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = pad.top + plotH - (val / maxVal) * plotH;
    return { x, y };
  }

  function drawLine(key, color, fillColor) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const { x, y } = getXY(i, data[i][key] || 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (n > 1) {
      const last = getXY(n - 1, data[n - 1][key] || 0);
      const first = getXY(0, data[0][key] || 0);
      ctx.lineTo(last.x, pad.top + plotH);
      ctx.lineTo(first.x, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();
    }

    for (let i = 0; i < n; i++) {
      const { x, y } = getXY(i, data[i][key] || 0);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  drawLine('inTok', COLORS.input.line, COLORS.input.fill);
  drawLine('outTok', COLORS.output.line, COLORS.output.fill);
  drawLine('searchTok', COLORS.search.line, COLORS.search.fill);
}

function openChartModal(title, data) {
  const modal = document.getElementById('sp-chart-modal');
  document.getElementById('sp-chart-modal-title').textContent = title;
  modal.classList.add('sp-visible');
  requestAnimationFrame(() => {
    drawChart('sp-chart-modal-canvas', data);
  });
}

// =============================================
// UI CREATION
// =============================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function createUI() {
  // Toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'sp-toggle-btn';
  toggleBtn.title = 'Toggle Environmental Impact Panel';
  toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`;
  document.body.appendChild(toggleBtn);

  // Panel
  const panel = document.createElement('div');
  panel.id = 'sp-panel';
  panel.innerHTML = buildPanelHTML();
  document.body.appendChild(panel);

  // Chart modal
  const modal = document.createElement('div');
  modal.id = 'sp-chart-modal';
  modal.innerHTML = `
    <div id="sp-chart-modal-inner">
      <div id="sp-chart-modal-title"></div>
      <canvas id="sp-chart-modal-canvas" width="650" height="350"></canvas>
      <div id="sp-chart-modal-legend">
        <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-input)"></span>Input</span>
        <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-output)"></span>Output</span>
        <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-search)"></span>Search</span>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Wire up events
  bindEvents();
}

function buildPanelHTML() {
  return `
    <!-- Header -->
    <div id="sp-header">
      <h2>Environmental Impact Panel</h2>
      <button id="sp-close-btn" title="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>

    <!-- Tabs -->
    <div class="sp-tabs">
      <button class="sp-tab sp-active" data-tab="tokens">Tokens</button>
      <button class="sp-tab" data-tab="impact">Impact</button>
      <button class="sp-tab" data-tab="models">Models</button>
    </div>

    <!-- Content -->
    <div id="sp-content">

      <!-- ====== TOKENS TAB ====== -->
      <div class="sp-tab-panel sp-active" id="sp-tab-tokens">

        <!-- Last Request -->
        <div class="sp-block">
          <div class="sp-label">Last Request</div>
          <div class="sp-token-display">
            <div class="sp-token-row">
              <span class="sp-token-row-label"><span class="sp-dot" style="background:var(--sp-color-input)"></span>Input</span>
              <span class="sp-token-row-value" id="sp-tok-input">0</span>
            </div>
            <div class="sp-token-row">
              <span class="sp-token-row-label"><span class="sp-dot" style="background:var(--sp-color-output)"></span>Output</span>
              <span class="sp-token-row-value" id="sp-tok-output">0</span>
            </div>
            <div class="sp-token-row">
              <span class="sp-token-row-label"><span class="sp-dot" style="background:var(--sp-color-search)"></span>Search</span>
              <span class="sp-token-row-value" id="sp-tok-search">0</span>
            </div>
            <div class="sp-token-row sp-token-row-total">
              <span class="sp-token-row-label">Total</span>
              <span class="sp-token-row-value" id="sp-tok-total">0</span>
            </div>
          </div>
          <canvas id="sp-per-request-chart" class="sp-chart" height="100"></canvas>
          <div class="sp-chart-legend">
            <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-input)"></span>Input</span>
            <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-output)"></span>Output</span>
            <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-search)"></span>Search</span>
          </div>
          <div class="sp-description">
            Input tokens grow each turn as the model re-reads the full conversation. Search tokens estimate the web content the model ingested.
          </div>
        </div>

        <!-- Session Total -->
        <div class="sp-block">
          <div class="sp-label">Session Total</div>
          <div class="sp-token-display">
            <div class="sp-token-row">
              <span class="sp-token-row-label"><span class="sp-dot" style="background:var(--sp-color-input)"></span>Total input</span>
              <span class="sp-token-row-value" id="sp-run-input">0</span>
            </div>
            <div class="sp-token-row">
              <span class="sp-token-row-label"><span class="sp-dot" style="background:var(--sp-color-output)"></span>Total output</span>
              <span class="sp-token-row-value" id="sp-run-output">0</span>
            </div>
            <div class="sp-token-row">
              <span class="sp-token-row-label"><span class="sp-dot" style="background:var(--sp-color-search)"></span>Total search</span>
              <span class="sp-token-row-value" id="sp-run-search">0</span>
            </div>
            <div class="sp-token-row sp-token-row-total">
              <span class="sp-token-row-label">Grand total</span>
              <span class="sp-token-row-value" id="sp-run-total">0</span>
            </div>
            <div class="sp-token-row" style="margin-top:6px;">
              <span class="sp-token-row-label">Requests</span>
              <span class="sp-token-row-value" id="sp-run-requests">0</span>
            </div>
          </div>
          <canvas id="sp-session-chart" class="sp-chart" height="100"></canvas>
          <div class="sp-chart-legend">
            <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-input)"></span>Input</span>
            <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-output)"></span>Output</span>
            <span class="sp-legend-item"><span class="sp-legend-dot" style="background:var(--sp-color-search)"></span>Search</span>
          </div>
          <div class="sp-description">
            The cumulative cost of this conversation. Every request re-sends the full history, so input tokens accelerate.
          </div>
        </div>

        <!-- Search Sources -->
        <div class="sp-block" id="sp-search-block" style="display:none;">
          <div class="sp-label">Web Search Sources</div>
          <div class="sp-label" style="margin-top:4px;margin-bottom:6px;font-size:10px;">Queries</div>
          <div id="sp-search-queries" class="sp-search-queries"></div>
          <div class="sp-label" style="margin-top:8px;margin-bottom:6px;font-size:10px;">Sources</div>
          <div id="sp-search-source-list" class="sp-source-list"></div>
        </div>

      </div><!-- /tokens tab -->

      <!-- ====== RESOURCES TAB ====== -->
      <div class="sp-tab-panel" id="sp-tab-impact">

        <div class="sp-resource-section">
          <div class="sp-label">Session Total</div>
          <div class="sp-resource-card">
            <div class="sp-resource-card-header">
              <span class="sp-resource-card-icon">⚡</span>
              <span class="sp-resource-card-title">Energy</span>
            </div>
            <div class="sp-resource-card-value" id="sp-res-ses-energy">0<span class="sp-resource-card-unit">Wh</span></div>
            <div class="sp-resource-card-equiv" id="sp-res-ses-energy-eq"></div>
          </div>
          <div class="sp-resource-card">
            <div class="sp-resource-card-header">
              <span class="sp-resource-card-icon">🌿</span>
              <span class="sp-resource-card-title">CO₂ Emissions</span>
            </div>
            <div class="sp-resource-card-value" id="sp-res-ses-co2">0<span class="sp-resource-card-unit">gCO₂e</span></div>
            <div class="sp-resource-card-equiv" id="sp-res-ses-co2-eq"></div>
          </div>
          <div class="sp-resource-card">
            <div class="sp-resource-card-header">
              <span class="sp-resource-card-icon">💧</span>
              <span class="sp-resource-card-title">Water</span>
            </div>
            <div class="sp-resource-card-value" id="sp-res-ses-water">0<span class="sp-resource-card-unit">mL</span></div>
            <div class="sp-resource-card-equiv" id="sp-res-ses-water-eq"></div>
          </div>
        </div>

        <div class="sp-resource-section">
          <div class="sp-label">At Scale</div>
          <div class="sp-scale-row">
            <span class="sp-scale-label">Number of users</span>
            <input type="text" id="sp-scale-count" class="sp-scale-input" value="1,000,000">
          </div>
          <div class="sp-resource-card">
            <div class="sp-resource-card-header">
              <span class="sp-resource-card-icon">⚡</span>
              <span class="sp-resource-card-title">Energy</span>
            </div>
            <div class="sp-resource-card-value" id="sp-res-scale-energy">0<span class="sp-resource-card-unit">MWh</span></div>
            <div class="sp-resource-card-equiv" id="sp-res-scale-energy-eq"></div>
          </div>
          <div class="sp-resource-card">
            <div class="sp-resource-card-header">
              <span class="sp-resource-card-icon">🌿</span>
              <span class="sp-resource-card-title">CO₂ Emissions</span>
            </div>
            <div class="sp-resource-card-value" id="sp-res-scale-co2">0<span class="sp-resource-card-unit">kg CO₂e</span></div>
            <div class="sp-resource-card-equiv" id="sp-res-scale-co2-eq"></div>
          </div>
          <div class="sp-resource-card">
            <div class="sp-resource-card-header">
              <span class="sp-resource-card-icon">💧</span>
              <span class="sp-resource-card-title">Water</span>
            </div>
            <div class="sp-resource-card-value" id="sp-res-scale-water">0<span class="sp-resource-card-unit">gallons</span></div>
            <div class="sp-resource-card-equiv" id="sp-res-scale-water-eq"></div>
          </div>
          <div class="sp-resource-note">
            Estimates based on <strong id="sp-impact-model-name">Middle Estimate</strong> per-token rates.
          </div>
        </div>

      </div><!-- /resources tab -->

      <!-- ====== MODELS TAB ====== -->
      <div class="sp-tab-panel" id="sp-tab-models">

        <div class="sp-block">
          <div id="sp-model-cards"></div>
        </div>

        <div class="sp-block">
          <div class="sp-label">Per-Token Rates</div>
          <div id="sp-rates-editor">
            <div class="sp-rate-row">
              <label class="sp-rate-label">Energy/token</label>
              <div class="sp-rate-group">
                <input type="text" class="sp-rate-input" id="sp-rate-energy" value="0.00035">
                <span class="sp-rate-unit">Wh</span>
              </div>
            </div>
            <div class="sp-rate-row">
              <label class="sp-rate-label">CO₂/token</label>
              <div class="sp-rate-group">
                <input type="text" class="sp-rate-input" id="sp-rate-co2" value="0.000137">
                <span class="sp-rate-unit">gCO₂e</span>
              </div>
            </div>
            <div class="sp-rate-row">
              <label class="sp-rate-label">Water/token</label>
              <div class="sp-rate-group">
                <input type="text" class="sp-rate-input" id="sp-rate-water" value="0.00032">
                <span class="sp-rate-unit">mL</span>
              </div>
            </div>
          </div>
        </div>

        <div class="sp-block">
          <div class="sp-label">Source</div>
          <div id="sp-rates-source">
            <a class="sp-source-link-block" id="sp-source-link" href="https://ecologits.ai/latest/methodology/llm_inference/" target="_blank" rel="noopener">EcoLogits / Epoch AI / OpenAI</a>
            <div class="sp-source-detail" id="sp-source-detail">Derived from EcoLogits parametric model for GPT-4o, cross-referenced with Epoch AI analysis and OpenAI's disclosed 0.34 Wh per query. Models energy as a function of parameter count, batch size, and infrastructure overhead.</div>
          </div>
        </div>

      </div><!-- /models tab -->

    </div><!-- /content -->
  `;
}

// =============================================
// EVENT BINDING
// =============================================

function bindEvents() {
  const panel = document.getElementById('sp-panel');
  const toggleBtn = document.getElementById('sp-toggle-btn');
  const closeBtn = document.getElementById('sp-close-btn');

  // Toggle panel
  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('sp-collapsed');
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.add('sp-collapsed');
  });

  // Tab switching
  document.querySelectorAll('.sp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sp-tab').forEach(t => t.classList.remove('sp-active'));
      document.querySelectorAll('.sp-tab-panel').forEach(p => p.classList.remove('sp-active'));
      tab.classList.add('sp-active');
      document.getElementById('sp-tab-' + tab.dataset.tab).classList.add('sp-active');
    });
  });

  // Chart modal click-to-expand
  document.getElementById('sp-per-request-chart').addEventListener('click', () => {
    openChartModal('Last Request', perRequestHistory);
  });

  document.getElementById('sp-session-chart').addEventListener('click', () => {
    openChartModal('Session Total', sessionHistory);
  });

  const chartModal = document.getElementById('sp-chart-modal');
  chartModal.addEventListener('click', (e) => {
    if (e.target === chartModal) chartModal.classList.remove('sp-visible');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') chartModal.classList.remove('sp-visible');
  });

  // Scale input formatting
  const scaleInput = document.getElementById('sp-scale-count');
  scaleInput.addEventListener('input', () => {
    const raw = scaleInput.value.replace(/[^0-9]/g, '');
    if (raw) scaleInput.value = parseInt(raw).toLocaleString();
    updateResourceDisplay();
  });

  // Model cards — render and bind
  renderModelCards();
  selectPreset('mid');

  // Rates editor inputs — editable in Custom mode, read-only otherwise
  document.getElementById('sp-rate-energy').addEventListener('input', (e) => {
    if (activePreset !== 'custom') return;
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) { RES_PER_TOKEN.energy = val; MODEL_PRESETS.custom.energy = val; updateResourceDisplay(); }
  });
  document.getElementById('sp-rate-co2').addEventListener('input', (e) => {
    if (activePreset !== 'custom') return;
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) { RES_PER_TOKEN.co2 = val; MODEL_PRESETS.custom.co2 = val; updateResourceDisplay(); }
  });
  document.getElementById('sp-rate-water').addEventListener('input', (e) => {
    if (activePreset !== 'custom') return;
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) { RES_PER_TOKEN.water = val; MODEL_PRESETS.custom.water = val; updateResourceDisplay(); }
  });

  // URL change detection (SPA navigation)
  let lastUrl = window.location.href;
  setInterval(() => {
    if (lastUrl !== window.location.href) {
      lastUrl = window.location.href;
      // Don't reset session data on URL change — let user maintain session context
    }
  }, 1000);
}

// =============================================
// INIT
// =============================================

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(createUI, 800);
} else {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(createUI, 800);
  });
}

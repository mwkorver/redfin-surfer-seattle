/* Shared side panel functions. Loaded before sidepanel.js. */

function syncProperty(listing) {
  return sendProperty(listing, portfolioEtag)
    .catch(error => {
      if (error.status !== 428 && error.status !== 409) throw error;
      if (error.serverEtag) {
        portfolioEtag = error.serverEtag;
        return sendProperty(listing, portfolioEtag);
      }
      return fetchPortfolioEtag().then(etag => sendProperty(listing, etag));
    });
}

function fetchPortfolioEtag() {
  const url = buildApiUrl("properties");
  if (!url) return Promise.reject(new Error("API endpoint not configured"));
  return fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiToken}`
    }
  }).then(async response => {
    if (!response.ok) throw await createApiError(response);
    portfolioEtag = response.headers.get("ETag") || "";
    return portfolioEtag;
  });
}

function sendProperty(listing, etag) {
  const url = buildApiUrl("property");
  if (!url) return Promise.reject(new Error("API endpoint not configured"));
  const headers = {
    "Content-Type": "application/json"
  };
  if (apiToken) {
    headers["Authorization"] = `Bearer ${apiToken}`;
  }

  if (etag) {
    headers["If-Match"] = etag;
  }

  return fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      address: listing.address,
      price: listing.price,
      geo: listing.geo,
      mlsId: listing.mlsId,
      parcel: listing.parcel || null,
      report: listing.report || null,
      listingKey: listing.listingKey,
      redfinHomeId: listing.redfinHomeId,
      savedAt: listing.savedAt,
      cumulativeDaysOnMarket: listing.cumulativeDaysOnMarket,
      timestamp: new Date().toISOString()
    })
  }).then(async response => {
    if (!response.ok) throw await createApiError(response);
    portfolioEtag = response.headers.get("ETag") || portfolioEtag;
    return response.json();
  });
}

function buildApiUrl(route) {
  if (!apiEndpoint) return "";
  try {
    const base = new URL(apiEndpoint);
    base.pathname = base.pathname.replace(/\/(?:property|properties)\/?$/, "/");
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    base.search = "";
    base.hash = "";
    return new URL(route, base).toString();
  } catch (err) {
    console.error("[Diligence Sidecar] Invalid API endpoint URL:", apiEndpoint, err);
    return "";
  }
}

function normalizeConfiguredApiEndpoint(value) {
  const endpoint = String(value || "").trim();
  if (!endpoint || /^https?:\/\/(?:127\.0\.0\.1|localhost):9222\/mock-api\/?$/i.test(endpoint)) {
    return DEPLOYED_API_ENDPOINT;
  }
  return endpoint;
}

async function createApiError(response) {
  let details = {};
  try {
    details = await response.json();
  } catch (error) {
    // Ignore non-JSON error responses.
  }
  const error = new Error(details.message || `HTTP ${response.status}`);
  error.status = response.status;
  error.serverEtag = details.serverEtag || "";
  return error;
}

globalThis.SidepanelApi = Object.freeze({
  normalizeConfiguredApiEndpoint
});

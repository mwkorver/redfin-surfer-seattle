/**
 * Background Service Worker for Real Estate Due-Diligence Sidecar.
 * Handles side panel state, SPA navigation detection, and shared storage coordination.
 */

const DEPLOYED_API_ENDPOINT = "";

// Configure side panel behavior on installation
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Diligence Sidecar] Extension installed.");
  
  // Set the extension action button to open the side panel
  if (chrome.sidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(err => console.warn("[Diligence Sidecar] Failed to set sidePanel behavior:", err));
  }
});

// React to tab changes to enable/disable side panel dynamically
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url) return;

  try {
    const url = new URL(tab.url);
    const isTargetSite = url.hostname.includes('redfin.com');

    if (isTargetSite) {
      // Configure side panel for this specific tab
      if (chrome.sidePanel) {
        await chrome.sidePanel.setOptions({
          tabId: tabId,
          path: 'sidepanel/sidepanel.html',
          enabled: true
        });
      }

      // If the URL updated (SPA navigation), notify the content script to re-scrape
      if (changeInfo.url) {
        console.log("[Diligence Sidecar] SPA URL shift detected on tab:", tabId, changeInfo.url);
        
        // Wait slightly for DOM to settle, then notify content script
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { action: "PAGE_NAVIGATED" }).catch(err => {
            // Content script may not be loaded yet, which is expected
            console.log("[Diligence Sidecar] content.js not ready for message:", err.message);
          });
        }, 500);
      }
    } else {
      // Disable side panel for non-target websites
      if (chrome.sidePanel) {
        await chrome.sidePanel.setOptions({
          tabId: tabId,
          enabled: false
        }).catch(() => {}); // Swallow errors for tabs that closed
      }
    }
  } catch (err) {
    console.error("[Diligence Sidecar] Error in tabs.onUpdated:", err);
  }
});

// React to active tab changes to refresh side panel listing state
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) return;

    try {
      const url = new URL(tab.url);
      const isTargetSite = url.hostname.includes('redfin.com');

      if (isTargetSite) {
        // Request the content script in the active tab to re-evaluate
        chrome.tabs.sendMessage(activeInfo.tabId, { action: "PAGE_NAVIGATED" }).catch(() => {});
      } else if (url.protocol === 'http:' || url.protocol === 'https:') {
        // Clear the listing state when switching to an unsupported website
        chrome.storage.local.remove("current_listing").catch(() => {});
      }
    } catch (err) {
      console.warn("[Diligence Sidecar] Error processing active tab change:", err);
    }
  });
});

// Listen for message events from content script or side panel UI
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("[Diligence Sidecar] Background service worker received action:", request.action);

  if (request.action === "NEW_LISTING_DETECTED") {
    const listingData = request.data;

    chrome.storage.local.get(["hearted_listings", "pending_backend_deletes"], (res) => {
      const listings = res.hearted_listings || {};
      const listingKey = getListingKey(listingData);
      let existing = listings[listingKey] || {};
      Object.entries(listings).forEach(([storedKey, storedListing]) => {
        if (storedKey !== listingKey && getListingKey(storedListing) === listingKey) {
          existing = { ...storedListing, ...existing };
          delete listings[storedKey];
        }
      });
      const savedAt = existing.savedAt || new Date().toISOString();
      const normalizedListing = normalizeStoredListing(listingData, listingKey);

      listings[listingKey] = {
        ...existing,
        ...normalizedListing,
        analysisState: existing.report ? "complete" : "queued",
        savedAt,
        updatedAt: new Date().toISOString()
      };

      const pendingDeletes = (res.pending_backend_deletes || [])
        .filter(key => key !== listingKey);
      chrome.storage.local.set({
        current_listing: listings[listingKey],
        hearted_listings: listings,
        pending_backend_deletes: pendingDeletes
      }, () => {
        console.log("[Diligence Sidecar] Added listing to portfolio:", listingData.address?.streetAddress);

        if (!existing.report) {
          chrome.runtime.sendMessage({
            action: "TRIGGER_DILIGENCE_FOR_LISTING",
            listing: listings[listingKey]
          }).catch(err => {
            console.log("[Diligence Sidecar] Side panel not open for auto-diligence:", err.message);
          });
        }
      });
    });
    sendResponse({ success: true });
  } else if (request.action === "CLEAR_CURRENT_LISTING") {
    chrome.storage.local.remove("current_listing", () => {
      console.log("[Diligence Sidecar] Cleared active listing context.");
    });
    sendResponse({ success: true });
  } else if (request.action === "REMOVE_HEARTED_LISTING") {
    chrome.storage.local.get([
      "hearted_listings",
      "current_listing",
      "aws_api_url",
      "aws_api_token",
      "backend_sync_enabled",
      "pending_backend_deletes"
    ], (res) => {
      const listings = res.hearted_listings || {};
      const listingKey = request.listingKey || getListingKey(request.data || { url: request.url });
      const removedListing = listings[listingKey];
      delete listings[listingKey];

      const updates = { hearted_listings: listings };
      chrome.storage.local.set(updates, () => {
        if (getListingKey(res.current_listing) === listingKey) {
          chrome.storage.local.remove("current_listing");
        }
        console.log("[Diligence Sidecar] Removed listing from portfolio:", listingKey);
      });

      if (removedListing && res.backend_sync_enabled !== false && res.aws_api_token) {
        const endpoint = normalizeConfiguredApiEndpoint(res.aws_api_url);
        if (endpoint !== res.aws_api_url) {
          chrome.storage.local.set({ aws_api_url: endpoint });
        }
        deleteRemoteProperty(listingKey, endpoint, res.aws_api_token)
          .then(() => {
            console.log("[Diligence Sidecar] Removed listing from backend:", listingKey);
          })
          .catch(error => {
            console.error("[Diligence Sidecar] Backend removal failed:", listingKey, error);
            queuePendingBackendDelete(listingKey);
          });
      } else if (removedListing) {
        queuePendingBackendDelete(listingKey);
      }
    });
    sendResponse({ success: true });
  } else if (request.action === "FLUSH_PENDING_BACKEND_DELETES") {
    flushPendingBackendDeletes()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
  } else if (request.action === "HEART_CLICKED") {
    // Programmatically open the side panel since this action was triggered by a user gesture
    if (chrome.sidePanel && sender && sender.tab && sender.tab.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(err => {
        console.log("[Diligence Sidecar] Failed to open side panel programmatically:", err.message);
      });
    }

    sendResponse({ success: true });
  }
  return true; // Keep message channel active
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== "local") return;
  if (changes.backend_sync_enabled?.newValue === true) {
    flushPendingBackendDeletes().catch(error => {
      console.error("[Diligence Sidecar] Pending backend delete replay failed:", error);
    });
  }
});

function queuePendingBackendDelete(listingKey) {
  if (!listingKey) return;
  chrome.storage.local.get(["pending_backend_deletes"], res => {
    const pending = new Set(res.pending_backend_deletes || []);
    pending.add(listingKey);
    chrome.storage.local.set({ pending_backend_deletes: [...pending] });
  });
}

async function flushPendingBackendDeletes() {
  const state = await chrome.storage.local.get([
    "backend_sync_enabled",
    "pending_backend_deletes",
    "aws_api_url",
    "aws_api_token"
  ]);
  const pending = state.pending_backend_deletes || [];
  if (state.backend_sync_enabled === false || !state.aws_api_token || !pending.length) {
    return;
  }

  const endpoint = normalizeConfiguredApiEndpoint(state.aws_api_url);
  const failed = [];
  for (const listingKey of pending) {
    try {
      const current = await chrome.storage.local.get(["hearted_listings"]);
      if (current.hearted_listings?.[listingKey]) {
        continue;
      }
      await deleteRemoteProperty(listingKey, endpoint, state.aws_api_token);
    } catch (error) {
      failed.push(listingKey);
      console.error("[Diligence Sidecar] Deferred backend removal failed:", listingKey, error);
    }
  }
  await chrome.storage.local.set({ pending_backend_deletes: failed });
}

function getListingKey(listing) {
  if (!listing) return "";

  if (listing.listingKey?.startsWith("redfin/")) {
    return listing.listingKey;
  }

  try {
    const url = new URL(listing.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return path ? `redfin/${path}` : "";
  } catch (err) {
    return listing.mlsId
      ? `mls:${listing.mlsId}`
      : (listing.address?.streetAddress || listing.url || "");
  }
}

function normalizeStoredListing(listing, listingKey) {
  const normalized = {
    ...listing,
    listingKey,
    redfinHomeId: listing.redfinHomeId || getRedfinHomeId(listingKey)
  };
  delete normalized.url;
  return normalized;
}

function getRedfinHomeId(listingKey) {
  const match = String(listingKey || "").match(/\/home\/(\d+)(?:\/|$)/);
  return match ? match[1] : "";
}

async function deleteRemoteProperty(listingKey, endpoint, token) {
  const propertiesUrl = buildApiUrl(endpoint, "properties");
  const propertyUrl = new URL(buildApiUrl(endpoint, "property"));
  propertyUrl.searchParams.set("key", listingKey);

  const authHeaders = {
    "Authorization": `Bearer ${token}`
  };
  const listResponse = await fetch(propertiesUrl, { headers: authHeaders });
  if (!listResponse.ok) {
    throw await createApiError(listResponse);
  }

  const etag = listResponse.headers.get("ETag");
  if (!etag) {
    return;
  }

  const deleteResponse = await fetch(propertyUrl.toString(), {
    method: "DELETE",
    headers: {
      ...authHeaders,
      "If-Match": etag
    }
  });

  if (deleteResponse.status === 404) {
    return;
  }
  if (deleteResponse.status === 409 || deleteResponse.status === 428) {
    const error = await createApiError(deleteResponse);
    const retryEtag = error.serverEtag || await fetchPortfolioEtag(propertiesUrl, authHeaders);
    const retryResponse = await fetch(propertyUrl.toString(), {
      method: "DELETE",
      headers: {
        ...authHeaders,
        "If-Match": retryEtag
      }
    });
    if (!retryResponse.ok && retryResponse.status !== 404) {
      throw await createApiError(retryResponse);
    }
    return;
  }
  if (!deleteResponse.ok) {
    throw await createApiError(deleteResponse);
  }
}

async function fetchPortfolioEtag(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw await createApiError(response);
  return response.headers.get("ETag") || "";
}

function buildApiUrl(endpoint, route) {
  const base = new URL(endpoint);
  base.pathname = base.pathname.replace(/\/(?:property|properties)\/?$/, "/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.search = "";
  base.hash = "";
  return new URL(route, base).toString();
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

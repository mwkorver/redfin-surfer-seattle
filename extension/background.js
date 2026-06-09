/**
 * Background Service Worker for Real Estate Due-Diligence Sidecar.
 * Handles side panel state, SPA navigation detection, and shared storage coordination.
 */

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

    chrome.storage.local.get(["hearted_listings", "auto_diligence_on_heart"], (res) => {
      const listings = res.hearted_listings || {};
      const listingKey = getListingKey(listingData);
      const existing = listings[listingKey] || {};
      const savedAt = existing.savedAt || new Date().toISOString();

      listings[listingKey] = {
        ...existing,
        ...listingData,
        listingKey,
        savedAt,
        updatedAt: new Date().toISOString()
      };

      chrome.storage.local.set({
        current_listing: listings[listingKey],
        hearted_listings: listings
      }, () => {
        console.log("[Diligence Sidecar] Added listing to portfolio:", listingData.address?.streetAddress);

        if (res.auto_diligence_on_heart && !existing.report) {
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
    chrome.storage.local.get(["hearted_listings", "current_listing"], (res) => {
      const listings = res.hearted_listings || {};
      const listingKey = request.listingKey || getListingKey(request.data || { url: request.url });
      delete listings[listingKey];

      const updates = { hearted_listings: listings };
      chrome.storage.local.set(updates, () => {
        if (getListingKey(res.current_listing) === listingKey) {
          chrome.storage.local.remove("current_listing");
        }
        console.log("[Diligence Sidecar] Removed listing from portfolio:", listingKey);
      });
    });
    sendResponse({ success: true });
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

function getListingKey(listing) {
  if (!listing) return "";

  try {
    const url = new URL(listing.url);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch (err) {
    return listing.mlsId
      ? `mls:${listing.mlsId}`
      : (listing.address?.streetAddress || listing.url || "");
  }
}

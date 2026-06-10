/* Shared side panel functions. Loaded before sidepanel.js. */

function saveReport(listingKey, report) {
  const normalized = normalizeReport(report);
  storageWriteQueue = storageWriteQueue.then(() => {
    return new Promise(resolve => {
      chrome.storage.local.get(["hearted_listings", "diligence_history"], res => {
        const listings = res.hearted_listings || {};
        const history = res.diligence_history || {};
        if (!listings[listingKey]) {
          resolve(null);
          return;
        }

        const analysisUpdatedAt = new Date().toISOString();
        const savedListing = {
          ...listings[listingKey],
          report: normalized,
          analysisState: "complete",
          syncState: "pending",
          syncError: "",
          analysisUpdatedAt,
          updatedAt: analysisUpdatedAt
        };
        listings[listingKey] = savedListing;
        history[listings[listingKey].address.streetAddress] = normalized;
        portfolio = listings;

        chrome.storage.local.set({
          hearted_listings: listings,
          diligence_history: history
        }, () => resolve(savedListing));
      });
    });
  });
  return storageWriteQueue;
}

function saveSyncStatus(listingKey, updates) {
  storageWriteQueue = storageWriteQueue.then(() => {
    return new Promise(resolve => {
      chrome.storage.local.get(["hearted_listings"], res => {
        const listings = res.hearted_listings || {};
        if (!listings[listingKey]) {
          resolve(null);
          return;
        }

        listings[listingKey] = {
          ...listings[listingKey],
          ...updates
        };
        portfolio = listings;
        chrome.storage.local.set({ hearted_listings: listings }, () => {
          resolve(listings[listingKey]);
        });
      });
    });
  });
  return storageWriteQueue;
}

function saveParcel(listingKey, parcel) {
  storageWriteQueue = storageWriteQueue.then(() => {
    return new Promise(resolve => {
      chrome.storage.local.get(["hearted_listings"], res => {
        const listings = res.hearted_listings || {};
        if (!listings[listingKey]) {
          resolve();
          return;
        }

        listings[listingKey] = {
          ...listings[listingKey],
          parcel,
          updatedAt: new Date().toISOString()
        };
        portfolio = listings;
        chrome.storage.local.set({ hearted_listings: listings }, resolve);
      });
    });
  });
  return storageWriteQueue;
}

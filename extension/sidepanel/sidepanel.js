let portfolio = {};
let apiEndpoint = "";
let apiToken = "";
let portfolioEtag = "";
let apiConnectionValid = false;
let backendSyncEnabled = true;
let scoringWeights = { crime: 40, lightRail: 20, lotArea: 20, pricePerSqft: 20, riparian: 20 };
let connectionValidationTimer = null;
let connectionValidationId = 0;
let lightRailStationsPromise = null;
const DEPLOYED_API_ENDPOINT = "https://YOUR-LAMBDA-URL.lambda-url.us-west-2.on.aws/";
const runningListings = new Set();
const syncingListings = new Set();
const expandedListings = new Set();
const parcelResolutionPromises = new Map();
const scheduledListings = new Set();
let storageWriteQueue = Promise.resolve();
let backendSyncQueue = Promise.resolve();

const emptyState = document.getElementById("empty-state");
const portfolioView = document.getElementById("portfolio-view");
const propertyList = document.getElementById("property-list");
const propertyCount = document.getElementById("property-count");
const inputApiUrl = document.getElementById("input-api-url");
const inputApiToken = document.getElementById("input-api-token");
const chkBackendSync = document.getElementById("chk-backend-sync");
const connectionStatus = document.getElementById("connection-status");
const weightCrimeInput = document.getElementById("weight-crime");
const weightCrimeDisplay = document.getElementById("weight-crime-display");
const weightLightRailInput = document.getElementById("weight-lightrail");
const weightLightRailDisplay = document.getElementById("weight-lightrail-display");
const weightLotAreaInput = document.getElementById("weight-lotarea");
const weightLotAreaDisplay = document.getElementById("weight-lotarea-display");
const weightPriceSqftInput = document.getElementById("weight-pricesqft");
const weightPriceSqftDisplay = document.getElementById("weight-pricesqft-display");
const weightRiparianInput = document.getElementById("weight-riparian");
const weightRiparianDisplay = document.getElementById("weight-riparian-display");

document.addEventListener("DOMContentLoaded", () => {
  loadState();
  setupEventListeners();
});

function loadState() {
  chrome.storage.local.get([
    "hearted_listings",
    "diligence_history",
    "current_listing",
    "aws_api_url",
    "aws_api_token",
    "backend_sync_enabled",
    "mapPresent",
    "scoring_weights"
  ], (res) => {
    updateMapStatusUI(res.mapPresent);
    portfolio = {};
    Object.values(res.hearted_listings || {}).forEach(listing => {
      const listingKey = getListingKey(listing);
      if (listingKey) portfolio[listingKey] = normalizeStoredListing(listing, listingKey);
    });

    apiEndpoint = normalizeConfiguredApiEndpoint(res.aws_api_url);
    inputApiUrl.value = apiEndpoint;
    if (apiEndpoint !== (res.aws_api_url || "")) {
      chrome.storage.local.set({ aws_api_url: apiEndpoint });
    }
    apiToken = res.aws_api_token || "";
    inputApiToken.value = apiToken;
    backendSyncEnabled = res.backend_sync_enabled !== false;
    chkBackendSync.checked = backendSyncEnabled;
    if (res.backend_sync_enabled === undefined) {
      chrome.storage.local.set({ backend_sync_enabled: true });
    }

    const saved = res.scoring_weights || {};
    scoringWeights = { crime: saved.crime ?? 40, lightRail: saved.lightRail ?? 20, lotArea: saved.lotArea ?? 20, pricePerSqft: saved.pricePerSqft ?? 20, riparian: saved.riparian ?? 20 };
    applyWeightInputs();

    chrome.storage.local.remove("auto_diligence_on_heart");
    updateConnectionStatus();
    scheduleConnectionValidation();

    // Carry forward reports created by the previous single-property model.
    const history = res.diligence_history || {};
    Object.values(portfolio).forEach(listing => {
      if (!listing.report && history[listing.address?.streetAddress]) {
        listing.report = normalizeReport(history[listing.address.streetAddress]);
      }
    });

    chrome.storage.local.set({ hearted_listings: portfolio }, () => {
      renderPortfolio();
      schedulePortfolioEnrichment();
    });
  });
}

function setupEventListeners() {
  inputApiUrl.addEventListener("input", event => {
    apiEndpoint = event.target.value.trim();
    apiConnectionValid = false;
    chrome.storage.local.set({ aws_api_url: apiEndpoint });
    updateConnectionStatus();
    scheduleConnectionValidation();
  });

  inputApiToken.addEventListener("input", event => {
    apiToken = event.target.value.trim();
    apiConnectionValid = false;
    chrome.storage.local.set({ aws_api_token: apiToken });
    updateConnectionStatus();
    scheduleConnectionValidation();
  });

  chkBackendSync.addEventListener("change", event => {
    backendSyncEnabled = event.target.checked;
    apiConnectionValid = false;
    chrome.storage.local.set({ backend_sync_enabled: backendSyncEnabled });
    updateConnectionStatus();
    if (backendSyncEnabled) {
      scheduleConnectionValidation();
      chrome.runtime.sendMessage({ action: "FLUSH_PENDING_BACKEND_DELETES" }).catch(() => {});
    }
    renderPortfolio();
  });

  weightCrimeInput.addEventListener("input", () => {
    scoringWeights.crime = Number(weightCrimeInput.value);
    weightCrimeDisplay.textContent = `${scoringWeights.crime}%`;
    chrome.storage.local.set({ scoring_weights: scoringWeights });
    renderPortfolio();
  });

  weightLightRailInput.addEventListener("input", () => {
    scoringWeights.lightRail = Number(weightLightRailInput.value);
    weightLightRailDisplay.textContent = `${scoringWeights.lightRail}%`;
    chrome.storage.local.set({ scoring_weights: scoringWeights });
    renderPortfolio();
  });

  weightLotAreaInput.addEventListener("input", () => {
    scoringWeights.lotArea = Number(weightLotAreaInput.value);
    weightLotAreaDisplay.textContent = `${scoringWeights.lotArea}%`;
    chrome.storage.local.set({ scoring_weights: scoringWeights });
    renderPortfolio();
  });

  weightPriceSqftInput.addEventListener("input", () => {
    scoringWeights.pricePerSqft = Number(weightPriceSqftInput.value);
    weightPriceSqftDisplay.textContent = `${scoringWeights.pricePerSqft}%`;
    chrome.storage.local.set({ scoring_weights: scoringWeights });
    renderPortfolio();
  });

  weightRiparianInput.addEventListener("input", () => {
    scoringWeights.riparian = Number(weightRiparianInput.value);
    weightRiparianDisplay.textContent = `${scoringWeights.riparian}%`;
    chrome.storage.local.set({ scoring_weights: scoringWeights });
    renderPortfolio();
  });

  propertyList.addEventListener("click", event => {
    const detailsButton = event.target.closest(".details-toggle");
    const runButton = event.target.closest(".run-button");
    const row = event.target.closest(".property-row");
    if (!row) return;

    const listing = portfolio[row.dataset.listingKey];
    if (!listing) return;

    if (detailsButton) {
      event.stopPropagation();
      toggleAnalysisDetails(listing.listingKey);
      return;
    }

    if (runButton) {
      event.stopPropagation();
      triggerDiligence(listing);
      return;
    }

    const listingUrl = getListingUrl(listing);
    if (listingUrl) chrome.tabs.create({ url: listingUrl });
  });

  propertyList.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest(".details-toggle, .run-button")) return;
    const row = event.target.closest(".property-row");
    const listing = row && portfolio[row.dataset.listingKey];
    const listingUrl = listing && getListingUrl(listing);
    if (listingUrl) chrome.tabs.create({ url: listingUrl });
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "local") return;

    if (changes.hearted_listings) {
      portfolio = changes.hearted_listings.newValue || {};
      renderPortfolio();
      schedulePortfolioEnrichment();
    }

    if (changes.aws_api_url) {
      apiEndpoint = changes.aws_api_url.newValue || "";
      apiConnectionValid = false;
      inputApiUrl.value = apiEndpoint;
      updateConnectionStatus();
      scheduleConnectionValidation();
      renderPortfolio();
    }

    if (changes.aws_api_token) {
      apiToken = changes.aws_api_token.newValue || "";
      apiConnectionValid = false;
      inputApiToken.value = apiToken;
      updateConnectionStatus();
      scheduleConnectionValidation();
      renderPortfolio();
    }

    if (changes.backend_sync_enabled) {
      backendSyncEnabled = changes.backend_sync_enabled.newValue !== false;
      chkBackendSync.checked = backendSyncEnabled;
      apiConnectionValid = false;
      updateConnectionStatus();
      if (backendSyncEnabled) scheduleConnectionValidation();
      renderPortfolio();
    }

    if (changes.mapPresent) {
      updateMapStatusUI(changes.mapPresent.newValue);
    }

    if (changes.scoring_weights) {
      const saved = changes.scoring_weights.newValue || {};
      scoringWeights = { crime: saved.crime ?? 40, lightRail: saved.lightRail ?? 20, lotArea: saved.lotArea ?? 20, pricePerSqft: saved.pricePerSqft ?? 20, riparian: saved.riparian ?? 20 };
      applyWeightInputs();
      renderPortfolio();
    }
  });

  chrome.runtime.onMessage.addListener(request => {
    if (request.action === "TRIGGER_DILIGENCE_FOR_LISTING" && request.listing) {
      scheduleDiligence(request.listing);
    }
  });
}

function applyWeightInputs() {
  weightCrimeInput.value = String(scoringWeights.crime);
  weightCrimeDisplay.textContent = `${scoringWeights.crime}%`;
  weightLightRailInput.value = String(scoringWeights.lightRail);
  weightLightRailDisplay.textContent = `${scoringWeights.lightRail}%`;
  weightLotAreaInput.value = String(scoringWeights.lotArea);
  weightLotAreaDisplay.textContent = `${scoringWeights.lotArea}%`;
  weightPriceSqftInput.value = String(scoringWeights.pricePerSqft);
  weightPriceSqftDisplay.textContent = `${scoringWeights.pricePerSqft}%`;
  weightRiparianInput.value = String(scoringWeights.riparian);
  weightRiparianDisplay.textContent = `${scoringWeights.riparian}%`;
}

function schedulePortfolioEnrichment() {
  Object.values(portfolio).forEach(listing => {
    const refreshLightRail = needsLightRailAnalysis(listing);
    if (!listing.report || refreshLightRail) {
      scheduleDiligence(listing, refreshLightRail);
    }
  });
}

function needsLightRailAnalysis(listing) {
  return Boolean(
    listing?.report &&
    Number.isFinite(Number(listing.geo?.latitude)) &&
    Number.isFinite(Number(listing.geo?.longitude)) &&
    !Object.prototype.hasOwnProperty.call(listing.report, "nearestLightRail")
  );
}

function scheduleDiligence(sourceListing, force = false) {
  const listingKey = sourceListing.listingKey || getListingKey(sourceListing);
  if (!listingKey ||
      (!force && sourceListing.report) ||
      runningListings.has(listingKey) ||
      scheduledListings.has(listingKey)) {
    return;
  }

  scheduledListings.add(listingKey);

  // Let the newly saved local card paint before starting parcel/API work.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        scheduledListings.delete(listingKey);
        const currentListing = portfolio[listingKey];
        if (currentListing && (!currentListing.report || (force && needsLightRailAnalysis(currentListing)))) {
          triggerDiligence(currentListing);
        }
      }, 0);
    });
  });
}

function triggerDiligence(sourceListing) {
  const listing = JSON.parse(JSON.stringify(sourceListing));
  const listingKey = listing.listingKey || getListingKey(listing);
  if (!listingKey || runningListings.has(listingKey)) return;

  listing.listingKey = listingKey;
  runningListings.add(listingKey);
  listing.analysisState = "running";
  renderPortfolio();

  const work = ensureParcelForListing(listing)
    .then(parcel => {
      if (parcel) listing.parcel = parcel;
    })
    .then(() => {
      return simulateLocalDiligence(listing);
    });

  work
    .then(report => saveReport(listingKey, report))
    .then(savedListing => {
      queuePropertySync(savedListing);
      return savedListing;
    })
    .catch(error => {
      console.error("[Diligence Sidecar] Diligence failed:", error);
      return saveReport(listingKey, {
        aggregateScore: 0,
        summary: `Analysis failed: ${error.message}`,
        topics: [{
          key: "connection",
          label: "Connection",
          score: 0,
          weight: 1,
          status: "error"
        }]
      });
    })
    .finally(() => {
      runningListings.delete(listingKey);
      renderPortfolio();
    });
}

function queuePropertySync(listing) {
  const listingKey = listing?.listingKey;
  if (!listingKey || !listing.report || syncingListings.has(listingKey)) {
    return Promise.resolve();
  }

  if (!backendSyncEnabled) {
    return saveSyncStatus(listingKey, {
      syncState: "pending",
      syncError: "Backend synchronization is paused."
    });
  }

  if (!apiEndpoint || !apiToken) {
    return saveSyncStatus(listingKey, {
      syncState: "pending",
      syncError: "Configure the Lambda URL and token to enable automatic upload."
    });
  }

  syncingListings.add(listingKey);
  renderPortfolio();

  const queuedSync = backendSyncQueue.then(() => {
    const currentListing = portfolio[listingKey];
    if (!currentListing?.report) return null;
    if (!backendSyncEnabled) {
      return saveSyncStatus(listingKey, {
        syncState: "pending",
        syncError: "Backend synchronization is paused."
      }).then(() => null);
    }
    return saveSyncStatus(listingKey, {
      syncState: "syncing",
      syncError: ""
    }).then(() => syncProperty(portfolio[listingKey] || currentListing));
  }).then(result => {
    if (!result) return null;
    const syncedListing = portfolio[listingKey];
    return saveSyncStatus(listingKey, {
      syncState: "synced",
      syncError: "",
      registeredAt: new Date().toISOString(),
      syncedAnalysisUpdatedAt: syncedListing?.analysisUpdatedAt || ""
    });
  }).catch(error => {
    console.error("[Diligence Sidecar] Automatic backend sync failed:", error);
    if (error.status === 401) {
      apiConnectionValid = false;
      connectionStatus.textContent = "Invalid API token";
      connectionStatus.className = "status-indicator disconnected";
    }
    return saveSyncStatus(listingKey, {
      syncState: "failed",
      syncError: error.message || "Backend upload failed."
    });
  }).finally(() => {
    syncingListings.delete(listingKey);
    renderPortfolio();
  });

  backendSyncQueue = queuedSync.catch(() => {});
  return queuedSync;
}

function scheduleAutomaticSyncs() {
  if (!backendSyncEnabled) return;
  Object.values(portfolio).forEach(listing => {
    if (needsBackendSync(listing)) queuePropertySync(listing);
  });
}

function needsBackendSync(listing) {
  if (!listing?.report || syncingListings.has(listing.listingKey)) return false;
  return isAnalysisOutOfSync(listing);
}

function formatSyncStatus(listing) {
  if (syncingListings.has(listing.listingKey) || listing.syncState === "syncing") {
    return "Uploading analysis to Lambda...";
  }
  if (listing.syncState === "failed") {
    return `Automatic upload failed: ${listing.syncError || "retrying when the connection is restored"}`;
  }
  if (listing.syncState === "pending" || !backendSyncEnabled) {
    return backendSyncEnabled
      ? "Analysis is waiting for automatic upload."
      : "Analysis saved locally; backend synchronization is paused.";
  }
  if (listing.registeredAt) {
    const date = new Date(listing.registeredAt);
    const time = Number.isNaN(date.getTime())
      ? ""
      : ` at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    return `Analysis uploaded automatically${time}`;
  }
  if (!apiEndpoint || !apiToken) {
    return "Analysis saved locally; configure backend credentials for automatic upload.";
  }
  return "Analysis is waiting for automatic upload.";
}

function ensureParcelForListing(sourceListing) {
  const listing = JSON.parse(JSON.stringify(sourceListing));
  const listingKey = listing.listingKey || getListingKey(listing);
  if (!listingKey || isParcelResolutionComplete(listing.parcel)) {
    return Promise.resolve(listing.parcel || null);
  }
  if (parcelResolutionPromises.has(listingKey)) {
    return parcelResolutionPromises.get(listingKey);
  }

  listing.listingKey = listingKey;
  const resolution = resolveKingCountyParcel(listing)
    .then(parcel => {
      if (!parcel) return null;
      return saveParcel(listingKey, parcel).then(() => parcel);
    })
    .catch(error => {
      console.warn("[Diligence Sidecar] Automatic parcel enrichment failed:", error);
      return null;
    })
    .finally(() => {
      parcelResolutionPromises.delete(listingKey);
    });

  parcelResolutionPromises.set(listingKey, resolution);
  return resolution;
}

function isParcelResolutionComplete(parcel) {
  return Boolean(parcel?.fetchedAt || parcel?.lookupAttemptedAt);
}

function updateConnectionStatus() {
  if (!backendSyncEnabled) {
    apiConnectionValid = false;
    connectionStatus.textContent = "Backend sync paused";
    connectionStatus.className = "status-indicator disconnected";
    return;
  }
  const isConfigured = apiEndpoint && apiToken;
  apiConnectionValid = false;
  connectionStatus.textContent = isConfigured ? "Checking credentials..." : "Local analysis";
  connectionStatus.className = "status-indicator disconnected";
}

function scheduleConnectionValidation() {
  if (connectionValidationTimer) clearTimeout(connectionValidationTimer);
  const validationId = ++connectionValidationId;

  if (!backendSyncEnabled || !apiEndpoint || !apiToken) return;
  connectionValidationTimer = setTimeout(() => {
    validateConnection(validationId);
  }, 350);
}

function validateConnection(validationId) {
  if (!backendSyncEnabled) return;
  fetch(buildApiUrl("properties"), {
    headers: {
      "Authorization": `Bearer ${apiToken}`
    }
  }).then(async response => {
    if (validationId !== connectionValidationId) return;
    if (!response.ok) throw await createApiError(response);

    portfolioEtag = response.headers.get("ETag") || "";
    apiConnectionValid = true;
    connectionStatus.textContent = "AWS connected";
    connectionStatus.className = "status-indicator connected";
    renderPortfolio();
    scheduleAutomaticSyncs();
  }).catch(error => {
    if (validationId !== connectionValidationId) return;
    apiConnectionValid = false;
    connectionStatus.textContent = error.status === 401
      ? "Invalid API token"
      : `Connection failed (${error.status || "network"})`;
    connectionStatus.className = "status-indicator disconnected";
    renderPortfolio();
  });
}

function updateMapStatusUI(present) {
  const mapStatus = document.getElementById("map-status");
  if (!mapStatus) return;
  mapStatus.classList.toggle("active", present === true);
  mapStatus.title = present
    ? "Google Map detected on page (Active)"
    : "Map not detected on page";
}

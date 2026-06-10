let portfolio = {};
let apiEndpoint = "";
let apiToken = "";
let portfolioEtag = "";
const runningListings = new Set();
const registeringListings = new Set();
const expandedListings = new Set();
const parcelResolutionPromises = new Map();
let storageWriteQueue = Promise.resolve();

const emptyState = document.getElementById("empty-state");
const portfolioView = document.getElementById("portfolio-view");
const propertyList = document.getElementById("property-list");
const propertyCount = document.getElementById("property-count");
const inputApiUrl = document.getElementById("input-api-url");
const inputApiToken = document.getElementById("input-api-token");
const chkAutoDiligence = document.getElementById("chk-auto-diligence");
const connectionStatus = document.getElementById("connection-status");

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
    "auto_diligence_on_heart",
    "mapPresent"
  ], (res) => {
    updateMapStatusUI(res.mapPresent);
    portfolio = {};
    Object.values(res.hearted_listings || {}).forEach(listing => {
      const listingKey = getListingKey(listing);
      if (listingKey) portfolio[listingKey] = normalizeStoredListing(listing, listingKey);
    });

    if (res.current_listing?.address?.streetAddress) {
      const listingKey = getListingKey(res.current_listing);
      if (listingKey && !portfolio[listingKey]) {
        portfolio[listingKey] = {
          ...normalizeStoredListing(res.current_listing, listingKey),
          savedAt: new Date().toISOString()
        };
      }
    }

    apiEndpoint = res.aws_api_url || "";
    inputApiUrl.value = apiEndpoint;
    apiToken = res.aws_api_token || "";
    inputApiToken.value = apiToken;
    chkAutoDiligence.checked = res.auto_diligence_on_heart === true;
    updateConnectionStatus();

    // Carry forward reports created by the previous single-property model.
    const history = res.diligence_history || {};
    Object.values(portfolio).forEach(listing => {
      if (!listing.report && history[listing.address?.streetAddress]) {
        listing.report = normalizeReport(history[listing.address.streetAddress]);
      }
    });

    chrome.storage.local.set({ hearted_listings: portfolio }, () => {
      renderPortfolio();
      enrichPortfolioParcels();

      // Automatically run local analysis for any listing that doesn't have a report yet
      Object.values(portfolio).forEach(listing => {
        if (!listing.report && !runningListings.has(listing.listingKey)) {
          triggerDiligence(listing);
        }
      });
    });
  });
}

function setupEventListeners() {
  inputApiUrl.addEventListener("input", event => {
    apiEndpoint = event.target.value.trim();
    chrome.storage.local.set({ aws_api_url: apiEndpoint });
    updateConnectionStatus();
  });

  inputApiToken.addEventListener("input", event => {
    apiToken = event.target.value.trim();
    chrome.storage.local.set({ aws_api_token: apiToken });
    updateConnectionStatus();
  });

  chkAutoDiligence.addEventListener("change", event => {
    chrome.storage.local.set({ auto_diligence_on_heart: event.target.checked });
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
      enrichPortfolioParcels();

      // Automatically run local analysis for any newly added listing without a report
      Object.values(portfolio).forEach(listing => {
        if (!listing.report && !runningListings.has(listing.listingKey)) {
          triggerDiligence(listing);
        }
      });
    }

    if (changes.aws_api_url) {
      apiEndpoint = changes.aws_api_url.newValue || "";
      inputApiUrl.value = apiEndpoint;
      updateConnectionStatus();
      renderPortfolio();
    }

    if (changes.aws_api_token) {
      apiToken = changes.aws_api_token.newValue || "";
      inputApiToken.value = apiToken;
      updateConnectionStatus();
      renderPortfolio();
    }

    if (changes.mapPresent) {
      updateMapStatusUI(changes.mapPresent.newValue);
    }
  });

  chrome.runtime.onMessage.addListener(request => {
    if (request.action === "TRIGGER_DILIGENCE_FOR_LISTING" && request.listing) {
      triggerDiligence(request.listing);
    }
  });
}

function renderPortfolio() {
  const listings = Object.values(portfolio)
    .filter(listing => listing?.address?.streetAddress)
    .sort(compareListings);

  propertyCount.textContent = String(listings.length);
  emptyState.classList.toggle("hidden", listings.length > 0);
  portfolioView.classList.toggle("hidden", listings.length === 0);
  propertyList.replaceChildren();

  listings.forEach((listing, index) => {
    propertyList.appendChild(createPropertyCard(listing, index));
  });
}

function compareListings(a, b) {
  const aScore = getAggregateScore(a.report);
  const bScore = getAggregateScore(b.report);
  if (aScore === null && bScore !== null) return 1;
  if (aScore !== null && bScore === null) return -1;
  if (aScore !== bScore) return (bScore || 0) - (aScore || 0);
  return new Date(b.savedAt || 0) - new Date(a.savedAt || 0);
}

function createPropertyCard(listing, index) {
  const score = getAggregateScore(listing.report);
  const hasReport = score !== null;
  const card = document.createElement("section");
  card.className = `property-card${expandedListings.has(listing.listingKey) ? " expanded" : ""}`;

  const row = document.createElement("article");
  row.className = "property-row";
  row.dataset.listingKey = listing.listingKey;
  row.tabIndex = 0;
  row.setAttribute("aria-label", `${listing.address.streetAddress}, ${score === null ? "not scored" : `score ${score}`}`);

  const image = document.createElement("img");
  image.className = "property-image";
  image.alt = "";
  image.src = listing.image || createPlaceholderImage();

  const info = document.createElement("div");
  info.className = "property-info";

  const address = document.createElement("div");
  address.className = "property-address";
  address.textContent = listing.address.streetAddress;

  const location = document.createElement("div");
  location.className = "property-location";
  location.textContent = formatLocation(listing.address);

  const price = document.createElement("div");
  price.className = "property-price";
  price.textContent = formatPrice(listing);

  const topicSummary = document.createElement("div");
  topicSummary.className = "topic-summary";
  topicSummary.textContent = formatTopicSummary(listing.report);

  const runButton = document.createElement("button");
  runButton.className = "run-button";
  runButton.type = "button";
  runButton.disabled = runningListings.has(listing.listingKey);
  runButton.textContent = runningListings.has(listing.listingKey)
    ? "Analyzing..."
    : (listing.report ? "Re-run analysis" : "Run analysis");

  info.append(address, location, price, topicSummary, runButton);

  const scoreColumn = document.createElement("div");
  scoreColumn.className = "score-column";

  const scoreValue = document.createElement("div");
  scoreValue.className = `score-value ${scoreClass(score)}`;
  scoreValue.textContent = score === null ? "–" : String(score);

  const scoreLabel = document.createElement("div");
  scoreLabel.className = "score-label";
  scoreLabel.textContent = score === null ? "Pending" : `#${index + 1}`;

  scoreColumn.append(scoreValue, scoreLabel);

  if (hasReport) {
    const detailsButton = document.createElement("button");
    detailsButton.className = "details-toggle";
    detailsButton.type = "button";
    detailsButton.setAttribute("aria-expanded", String(expandedListings.has(listing.listingKey)));
    detailsButton.setAttribute("aria-label", `Show analysis details for ${listing.address.streetAddress}`);
    detailsButton.textContent = "⌄";
    scoreColumn.appendChild(detailsButton);
  }

  row.append(image, info, scoreColumn);
  card.appendChild(row);

  if (hasReport) {
    card.appendChild(createAnalysisDetails(listing));
  }

  return card;
}

function createAnalysisDetails(listing) {
  const details = document.createElement("div");
  details.className = "analysis-details";
  details.hidden = !expandedListings.has(listing.listingKey);

  if (listing.parcel) {
    const parcelRow = document.createElement("div");
    parcelRow.className = "parcel-detail";

    const parcelLabel = document.createElement("span");
    parcelLabel.className = "parcel-detail-label";
    parcelLabel.textContent = "King County parcel";

    const parcelValue = document.createElement("span");
    parcelValue.className = "parcel-detail-value";
    parcelValue.textContent = listing.parcel.parcelId || "Not found";

    const parcelMatch = document.createElement("span");
    parcelMatch.className = "parcel-detail-match";
    parcelMatch.textContent = formatParcelMatch(listing.parcel);

    parcelRow.append(parcelLabel, parcelValue, parcelMatch);
    appendParcelField(parcelRow, "Assessor address", listing.parcel.assessorAddress);
    appendParcelField(parcelRow, "Present use", listing.parcel.presentUse);
    appendParcelField(parcelRow, "Property name", listing.parcel.propertyName);
    appendParcelField(parcelRow, "Jurisdiction", listing.parcel.jurisdiction);
    appendParcelField(parcelRow, "Appraised value", formatCurrencyValue(listing.parcel.appraisedValue));
    appendParcelField(parcelRow, "Lot area", formatSquareFeet(listing.parcel.lotAreaSqFt));
    appendParcelField(parcelRow, "Levy code", listing.parcel.levyCode);
    appendParcelField(parcelRow, "Units", formatOptionalCount(listing.parcel.numberOfUnits));
    appendParcelField(parcelRow, "Buildings", formatOptionalCount(listing.parcel.numberOfBuildings));
    appendParcelField(parcelRow, "Boundary", listing.parcel.boundary ? listing.parcel.boundary.type : "");

    const parcelLinks = createParcelLinks(listing.parcel.links);
    if (parcelLinks) parcelRow.appendChild(parcelLinks);
    details.appendChild(parcelRow);
  }

  if (listing.report.summary) {
    const summary = document.createElement("p");
    summary.className = "analysis-summary";
    summary.textContent = listing.report.summary;
    details.appendChild(summary);
  }

  const topics = Array.isArray(listing.report.topics) ? listing.report.topics : [];
  topics.forEach(topic => {
    const topicRow = document.createElement("div");
    topicRow.className = "analysis-topic";

    const topicText = document.createElement("div");
    topicText.className = "analysis-topic-text";

    const topicName = document.createElement("span");
    topicName.className = "analysis-topic-name";
    topicName.textContent = topic.label;

    const topicStatus = document.createElement("span");
    topicStatus.className = "analysis-topic-status";
    const weightLabel = `${Math.round(Number(topic.weight) * 100)}% weight`;
    topicStatus.textContent = topic.status ? `${topic.status} · ${weightLabel}` : weightLabel;

    const topicScore = document.createElement("span");
    topicScore.className = `analysis-topic-score ${scoreClass(topic.score)}`;
    topicScore.textContent = String(Math.round(topic.score));

    topicText.append(topicName, topicStatus);
    topicRow.append(topicText, topicScore);
    details.appendChild(topicRow);
  });

  // Append S3 Registration Action Row
  const actionRow = document.createElement("div");
  actionRow.className = "action-row";

  if (listing.registeredAt) {
    const statusText = document.createElement("span");
    statusText.className = "registered-status";
    const dateStr = new Date(listing.registeredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    statusText.textContent = `Last synced to S3 at ${dateStr}`;
    actionRow.appendChild(statusText);
  }

  const regButton = document.createElement("button");
  regButton.className = "register-button";
  regButton.type = "button";
  regButton.textContent = (apiEndpoint && apiToken)
    ? (listing.registeredAt ? "Sync Update" : "Register Property (S3)")
    : "Set API URL & Token to Register";
  regButton.disabled = !apiEndpoint || !apiToken || registeringListings.has(listing.listingKey);
  if (registeringListings.has(listing.listingKey)) {
    regButton.textContent = "Syncing...";
  }

  regButton.addEventListener("click", (e) => {
    e.stopPropagation();
    registerProperty(listing);
  });
  actionRow.appendChild(regButton);

  details.appendChild(actionRow);

  return details;
}

function appendParcelField(container, label, value) {
  if (value === null || value === undefined || value === "") return;

  const field = document.createElement("div");
  field.className = "parcel-field";

  const fieldLabel = document.createElement("span");
  fieldLabel.className = "parcel-field-label";
  fieldLabel.textContent = label;

  const fieldValue = document.createElement("span");
  fieldValue.className = "parcel-field-value";
  fieldValue.textContent = String(value);

  field.append(fieldLabel, fieldValue);
  container.appendChild(field);
}

function createParcelLinks(links) {
  if (!links) return null;

  const definitions = [
    ["Parcel map", links.parcelViewer],
    ["Assessor report", links.assessorReport],
    ["Zoning", links.zoningCodes],
    ["Taxing districts", links.taxingDistricts]
  ].filter(([, url]) => url);
  if (!definitions.length) return null;

  const container = document.createElement("div");
  container.className = "parcel-links";

  definitions.forEach(([label, url]) => {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = label;
    container.appendChild(link);
  });

  return container;
}

function toggleAnalysisDetails(listingKey) {
  if (expandedListings.has(listingKey)) {
    expandedListings.delete(listingKey);
  } else {
    expandedListings.add(listingKey);
  }
  renderPortfolio();
}

function triggerDiligence(sourceListing) {
  const listing = JSON.parse(JSON.stringify(sourceListing));
  const listingKey = listing.listingKey || getListingKey(listing);
  if (!listingKey || runningListings.has(listingKey)) return;

  listing.listingKey = listingKey;
  runningListings.add(listingKey);
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

function registerProperty(listing) {
  const listingKey = listing.listingKey;
  if (!apiEndpoint || !apiToken || registeringListings.has(listingKey)) return;

  registeringListings.add(listingKey);
  renderPortfolio();

  syncProperty(listing)
    .then(() => {
      storageWriteQueue = storageWriteQueue.then(() => {
        return new Promise(resolve => {
          chrome.storage.local.get(["hearted_listings"], res => {
            const listings = res.hearted_listings || {};
            if (listings[listingKey]) {
              listings[listingKey].registeredAt = new Date().toISOString();
            }
            portfolio = listings;
            chrome.storage.local.set({ hearted_listings: listings }, resolve);
          });
        });
      });
      return storageWriteQueue;
    })
    .catch(error => {
      console.error("[Diligence Sidecar] AWS Registration failed:", error);
      alert(`Registration failed: ${error.message}`);
    })
    .finally(() => {
      registeringListings.delete(listingKey);
      renderPortfolio();
    });
}

function enrichPortfolioParcels() {
  Object.values(portfolio).forEach(listing => {
    ensureParcelForListing(listing);
  });
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
  return fetch(buildApiUrl("properties"), {
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
  const headers = {
    "Content-Type": "application/json"
  };
  if (apiToken) {
    headers["Authorization"] = `Bearer ${apiToken}`;
  }

  if (etag) {
    headers["If-Match"] = etag;
  }

  return fetch(buildApiUrl("property"), {
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
      timestamp: new Date().toISOString()
    })
  }).then(async response => {
    if (!response.ok) throw await createApiError(response);
    portfolioEtag = response.headers.get("ETag") || portfolioEtag;
    return response.json();
  });
}

function buildApiUrl(route) {
  const base = new URL(apiEndpoint);
  base.pathname = base.pathname.replace(/\/(?:property|properties)\/?$/, "/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  base.search = "";
  base.hash = "";
  return new URL(route, base).toString();
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

function simulateLocalDiligence(listing) {
  const isSeattle = (listing.address.city || "").toLowerCase() === "seattle" &&
    (listing.address.state || "").toUpperCase() === "WA";

  const permitPromise = isSeattle ? fetchSeattlePermits(listing) : Promise.resolve([]);
  const crimePromise = isSeattle ? fetchSeattleCrime(listing) : Promise.resolve([]);

  return Promise.all([permitPromise, crimePromise]).then(([permits, crimes]) => {
    const permitScore = scorePermits(permits);
    const crimeScore = scoreCrime(crimes);
    const topics = [
      createScoredTopic(
        "permits",
        permitScore,
        permits.length ? `${permits.length} records` : "No records"
      ),
      createScoredTopic(
        "crime",
        crimeScore,
        `${crimes.length} recent incidents`
      )
    ];

    return {
      aggregateScore: calculateAggregateScore(topics),
      summary: `Checked ${permits.length} permit records and ${crimes.length} recent crime incidents.`,
      topics,
      completedAt: new Date().toISOString()
    };
  });
}

function resolveKingCountyParcel(listing) {
  if (listing.parcel?.parcelId && listing.parcel.boundary && listing.parcel.assessorAddress) {
    return Promise.resolve(listing.parcel);
  }
  if (listing.parcel?.parcelId) {
    return enrichKingCountyParcel(listing.parcel);
  }

  const address = listing.address || {};
  if (!address.streetAddress || (address.state || "").toUpperCase() !== "WA") {
    return Promise.resolve(null);
  }

  const searchAddress = [
    address.streetAddress,
    address.city,
    address.state,
    address.zip
  ].filter(Boolean).join(" ");
  const url = `https://gismaps.kingcounty.gov/parcelviewer2/addSearchHandler.ashx?add=${encodeURIComponent(searchAddress)}`;

  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error(`Parcel HTTP ${response.status}`);
      return response.text();
    })
    .then(text => JSON.parse(text))
    .then(data => matchParcelResult(listing, data?.items))
    .then(parcel => {
      if (!parcel?.parcelId) return parcel;
      return enrichKingCountyParcel(parcel);
    })
    .catch(error => {
      console.warn("[Diligence Sidecar] King County parcel lookup failed:", error);
      return {
        parcelId: null,
        administrativeArea: "king-county-wa",
        source: "king-county-parcel-viewer",
        matchedBy: "address",
        confidence: "lookup-failed",
        searchedAddress: searchAddress,
        lookupAttemptedAt: new Date().toISOString()
      };
    });
}

function enrichKingCountyParcel(parcel) {
  return Promise.all([
    fetchKingCountyParcelSummary(parcel.parcelId),
    fetchKingCountyParcelBoundary(parcel.parcelId)
  ]).then(([summary, boundary]) => ({
    ...parcel,
    ...summary,
    boundary,
    links: createKingCountyParcelLinks(parcel.parcelId),
    fetchedAt: new Date().toISOString()
  }));
}

function fetchKingCountyParcelSummary(parcelId) {
  const url = `https://gismaps.kingcounty.gov/parcelviewer2/pvinfoquery.ashx?pin=${encodeURIComponent(parcelId)}`;
  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error(`Parcel summary HTTP ${response.status}`);
      return response.text();
    })
    .then(text => JSON.parse(text))
    .then(data => {
      const item = Array.isArray(data?.items) ? data.items[0] : null;
      if (!item) return {};

      return {
        assessorAddress: item.ADDRESS || "",
        presentUse: item.PRESENTUSE || "",
        propertyName: item.PROPNAME || "",
        jurisdiction: item.JURISDICTION || "",
        appraisedValue: parseOptionalNumber(item.APPVALUE),
        lotAreaSqFt: parseOptionalNumber(item.LOTSQFT),
        levyCode: item.LEVYCODE || "",
        numberOfUnits: parseOptionalNumber(item.NUMUNITS),
        numberOfBuildings: parseOptionalNumber(item.NUMBUILDINGS)
      };
    })
    .catch(error => {
      console.warn("[Diligence Sidecar] Parcel summary lookup failed:", error);
      return {};
    });
}

function fetchKingCountyParcelBoundary(parcelId) {
  const query = new URLSearchParams({
    where: `PIN='${parcelId}'`,
    outFields: "PIN",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson"
  });
  const url = `https://gismaps.kingcounty.gov/ArcGIS/rest/services/Property/KingCo_Parcels/MapServer/0/query?${query}`;

  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error(`Parcel boundary HTTP ${response.status}`);
      return response.json();
    })
    .then(data => data?.features?.[0]?.geometry || null)
    .catch(error => {
      console.warn("[Diligence Sidecar] Parcel boundary lookup failed:", error);
      return null;
    });
}

function createKingCountyParcelLinks(parcelId) {
  const encodedParcelId = encodeURIComponent(parcelId);
  return {
    parcelViewer: `https://gismaps.kingcounty.gov/parcelviewer2/?pin=${encodedParcelId}`,
    assessorReport: `https://blue.kingcounty.com/Assessor/eRealProperty/default.aspx?ParcelNbr=${encodedParcelId}`,
    zoningCodes: "https://kingcounty.gov/en/legacy/services/gis/PropResearch/kc_zoning.aspx",
    taxingDistricts: `https://district-conditions-report.kingcounty.gov/?PIN=${encodedParcelId}`
  };
}

function matchParcelResult(listing, items) {
  const address = listing.address || {};
  const results = Array.isArray(items) ? items : [];
  const searchedAddress = [
    address.streetAddress,
    address.city,
    address.state,
    address.zip
  ].filter(Boolean).join(" ");

  if (!results.length) {
    return {
      parcelId: null,
      administrativeArea: "king-county-wa",
      source: "king-county-parcel-viewer",
      matchedBy: "address",
      confidence: "not-found",
      searchedAddress,
      lookupAttemptedAt: new Date().toISOString()
    };
  }

  const targetStreet = normalizeParcelStreet(address.streetAddress);
  const targetZip = String(address.zip || "").slice(0, 5);
  const exactMatches = results.filter(item => {
    const streetMatches = normalizeParcelStreet(item.ADDRESS) === targetStreet;
    const zipMatches = !targetZip || String(item.ZIPCODE || "") === targetZip;
    return streetMatches && zipMatches;
  });
  const candidates = exactMatches.length ? exactMatches : results;
  const selected = candidates[0];
  const hasUnit = /(?:\bunit\b|\bapt\b|\bste\b|\bsuite\b|#)\s*[a-z0-9-]+/i.test(address.streetAddress);

  let confidence = "probable";
  if (candidates.length > 1) {
    confidence = "ambiguous";
  } else if (hasUnit) {
    confidence = "master-parcel";
  } else if (exactMatches.length === 1) {
    confidence = "exact";
  }

  return {
    parcelId: String(selected.PIN || ""),
    administrativeArea: "king-county-wa",
    source: "king-county-parcel-viewer",
    matchedBy: "address",
    confidence,
    matchedAddress: [selected.ADDRESS, selected.ZIPCODE].filter(Boolean).join(" "),
    searchedAddress,
    candidateCount: candidates.length
  };
}

function normalizeParcelStreet(value) {
  const suffixes = {
    STREET: "ST",
    AVENUE: "AVE",
    BOULEVARD: "BLVD",
    DRIVE: "DR",
    ROAD: "RD",
    LANE: "LN",
    COURT: "CT",
    PLACE: "PL",
    TERRACE: "TER",
    HIGHWAY: "HWY",
    PARKWAY: "PKWY",
    CIRCLE: "CIR"
  };

  return String(value || "")
    .toUpperCase()
    .replace(/(?:\bUNIT\b|\bAPT\b|\bSTE\b|\bSUITE\b|#)\s*[A-Z0-9-]+.*$/, "")
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(part => suffixes[part] || part)
    .join(" ");
}

function fetchSeattlePermits(listing) {
  const parts = listing.address.streetAddress.trim().split(/\s+/);
  if (parts.length < 2) return Promise.resolve([]);

  const streetNumber = parts[0].replace(/[^0-9A-Za-z]/g, "");
  const streetNamePart = parts.slice(1).find(part => {
    const word = part.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return !["N", "S", "E", "W", "NW", "NE", "SW", "SE", "UNIT", "APT", "STE", "SUITE"].includes(word);
  });
  const streetName = (streetNamePart || "").replace(/[^A-Za-z0-9]/g, "");
  if (!streetNumber || !streetName) return Promise.resolve([]);

  const where = `originaladdress1 like '%${streetNumber}%${streetName}%'`;
  const url = `https://data.seattle.gov/resource/76t5-zqzr.json?$limit=100&$where=${encodeURIComponent(where)}`;
  return fetch(url)
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`Permit HTTP ${response.status}`)))
    .then(data => Array.isArray(data) ? data : [])
    .catch(error => {
      console.warn("[Diligence Sidecar] Permit query failed:", error);
      return [];
    });
}

function fetchSeattleCrime(listing) {
  if (!Number.isFinite(Number(listing.geo?.latitude)) || !Number.isFinite(Number(listing.geo?.longitude))) {
    return Promise.resolve([]);
  }

  const latPrefix = Number(listing.geo.latitude).toFixed(2);
  const lonPrefix = Number(listing.geo.longitude).toFixed(2);
  const where = `latitude like '${latPrefix}%' and longitude like '${lonPrefix}%' and report_date_time > '2025-01-01T00:00:00.000'`;
  const url = `https://data.seattle.gov/resource/tazs-3rd5.json?$limit=500&$where=${encodeURIComponent(where)}`;
  return fetch(url)
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`Crime HTTP ${response.status}`)))
    .then(data => Array.isArray(data) ? data : [])
    .catch(error => {
      console.warn("[Diligence Sidecar] Crime query failed:", error);
      return [];
    });
}

function scorePermits(permits) {
  if (!permits.length) return 75;

  let score = 88;
  permits.forEach(permit => {
    const status = (permit.statuscurrent || "").toLowerCase();
    if (status === "expired" || status === "cancelled") score -= 8;
    if (status && !["completed", "reviews completed", "permit issued"].includes(status)) score -= 2;
  });
  return clampScore(score);
}

function scoreCrime(crimes) {
  if (crimes.length <= 5) return 95;
  if (crimes.length <= 20) return 78;
  if (crimes.length <= 50) return 58;
  return 35;
}

function createScoredTopic(key, score, status) {
  const config = DiligenceScoring.getTopic(key);
  if (!config) throw new Error(`Missing scoring configuration for topic: ${key}`);

  return {
    key,
    label: config.label,
    score: clampScore(score),
    weight: config.weight,
    status
  };
}

function normalizeReport(report) {
  const topics = Array.isArray(report?.topics)
    ? report.topics.filter(topic => hasNumericScore(topic.score)).map(topic => {
        const key = topic.key || topic.label;
        const config = DiligenceScoring.getTopic(key);
        return {
          key,
          label: config?.label || topic.label || topic.key || "Topic",
          score: clampScore(Number(topic.score)),
          weight: config?.weight || (Number(topic.weight) > 0 ? Number(topic.weight) : 1),
          status: topic.status || ""
        };
      })
    : [];

  if (!topics.length && hasNumericScore(report?.score)) {
    topics.push({
      key: "overall",
      label: "Overall",
      score: clampScore(Number(report.score)),
      weight: 1,
      status: report.summary || ""
    });
  }

  return {
    ...report,
    topics,
    aggregateScore: topics.length
      ? calculateAggregateScore(topics)
      : (hasNumericScore(report?.aggregateScore) ? clampScore(Number(report.aggregateScore)) : null)
  };
}

function calculateAggregateScore(topics) {
  const scoredTopics = topics.filter(topic => Number.isFinite(Number(topic.score)) && Number(topic.weight) > 0);
  const totalWeight = scoredTopics.reduce((sum, topic) => sum + Number(topic.weight), 0);
  if (!totalWeight) return null;

  const weightedTotal = scoredTopics.reduce((sum, topic) => {
    return sum + Number(topic.score) * Number(topic.weight);
  }, 0);
  return Math.round(weightedTotal / totalWeight);
}

function saveReport(listingKey, report) {
  const normalized = normalizeReport(report);
  storageWriteQueue = storageWriteQueue.then(() => {
    return new Promise(resolve => {
      chrome.storage.local.get(["hearted_listings", "diligence_history"], res => {
        const listings = res.hearted_listings || {};
        const history = res.diligence_history || {};
        if (!listings[listingKey]) {
          resolve();
          return;
        }

        listings[listingKey] = {
          ...listings[listingKey],
          report: normalized,
          updatedAt: new Date().toISOString()
        };
        history[listings[listingKey].address.streetAddress] = normalized;
        portfolio = listings;

        chrome.storage.local.set({
          hearted_listings: listings,
          diligence_history: history
        }, resolve);
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

function getAggregateScore(report) {
  if (!report) return null;
  if (hasNumericScore(report.aggregateScore)) return clampScore(Number(report.aggregateScore));
  if (Array.isArray(report.topics)) return calculateAggregateScore(report.topics);
  if (hasNumericScore(report.score)) return clampScore(Number(report.score));
  return null;
}

function hasNumericScore(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function formatTopicSummary(report) {
  if (!report) return "Waiting for analysis";
  const topics = Array.isArray(report.topics) ? report.topics : [];
  if (!topics.length) return report.summary || "Analysis complete";
  return topics.map(topic => `${topic.label} ${Math.round(topic.score)}`).join(" · ");
}

function formatLocation(address) {
  const stateZip = `${address.state || ""} ${address.zip || ""}`.trim();
  return [address.city, stateZip].filter(Boolean).join(", ");
}

function formatParcelMatch(parcel) {
  const labels = {
    exact: "Exact address match",
    probable: "Probable address match",
    ambiguous: "Multiple address matches",
    "master-parcel": "Building or master parcel",
    "not-found": "No address match",
    "lookup-failed": "Lookup unavailable"
  };
  return labels[parcel.confidence] || parcel.matchedAddress || "Address lookup";
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function formatCurrencyValue(value) {
  if (!Number.isFinite(Number(value))) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(Number(value));
}

function formatSquareFeet(value) {
  if (!Number.isFinite(Number(value))) return "";
  return `${new Intl.NumberFormat("en-US").format(Number(value))} sq ft`;
}

function formatOptionalCount(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "";
}

function formatPrice(listing) {
  if (!Number.isFinite(Number(listing.price)) || Number(listing.price) <= 0) return "Price unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: listing.priceCurrency || "USD",
    maximumFractionDigits: 0
  }).format(Number(listing.price));
}

function scoreClass(score) {
  if (score === null) return "pending";
  if (score >= 85) return "good";
  if (score >= 70) return "warn";
  return "bad";
}

function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(score) ? score : 0)));
}

function updateConnectionStatus() {
  const isConfigured = apiEndpoint && apiToken;
  connectionStatus.textContent = isConfigured ? "AWS configured" : "Local analysis";
  connectionStatus.className = `status-indicator ${isConfigured ? "connected" : "disconnected"}`;
}

function updateMapStatusUI(present) {
  const mapStatus = document.getElementById("map-status");
  if (!mapStatus) return;
  mapStatus.classList.toggle("active", present === true);
  mapStatus.title = present
    ? "Google Map detected on page (Active)"
    : "Map not detected on page";
}

function getListingKey(listing) {
  if (listing?.listingKey?.startsWith("redfin/")) {
    return listing.listingKey;
  }

  try {
    const url = new URL(listing.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return path ? `redfin/${path}` : "";
  } catch (error) {
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

function getListingUrl(listing) {
  if (!listing?.listingKey?.startsWith("redfin/")) return "";
  return `https://www.redfin.com/${listing.listingKey.slice("redfin/".length)}`;
}

function createPlaceholderImage() {
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="164" height="128" viewBox="0 0 164 128"><rect width="164" height="128" fill="#252b35"/><path d="M42 72l40-32 40 32v34H42z" fill="#3b4452"/><path d="M35 73l47-38 47 38" fill="none" stroke="#667085" stroke-width="8" stroke-linecap="round"/></svg>'
  );
}

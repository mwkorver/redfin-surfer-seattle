let portfolio = {};
let apiEndpoint = "";
const runningListings = new Set();
let storageWriteQueue = Promise.resolve();

const emptyState = document.getElementById("empty-state");
const portfolioView = document.getElementById("portfolio-view");
const propertyList = document.getElementById("property-list");
const propertyCount = document.getElementById("property-count");
const inputApiUrl = document.getElementById("input-api-url");
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
    "auto_diligence_on_heart"
  ], (res) => {
    portfolio = {};
    Object.values(res.hearted_listings || {}).forEach(listing => {
      const listingKey = getListingKey(listing);
      if (listingKey) portfolio[listingKey] = { ...listing, listingKey };
    });

    if (res.current_listing?.address?.streetAddress) {
      const listingKey = getListingKey(res.current_listing);
      if (listingKey && !portfolio[listingKey]) {
        portfolio[listingKey] = {
          ...res.current_listing,
          listingKey,
          savedAt: new Date().toISOString()
        };
      }
    }

    apiEndpoint = res.aws_api_url || "";
    inputApiUrl.value = apiEndpoint;
    chkAutoDiligence.checked = res.auto_diligence_on_heart === true;
    updateConnectionStatus();

    // Carry forward reports created by the previous single-property model.
    const history = res.diligence_history || {};
    Object.values(portfolio).forEach(listing => {
      if (!listing.report && history[listing.address?.streetAddress]) {
        listing.report = normalizeReport(history[listing.address.streetAddress]);
      }
    });

    chrome.storage.local.set({ hearted_listings: portfolio });
    renderPortfolio();
  });
}

function setupEventListeners() {
  inputApiUrl.addEventListener("input", event => {
    apiEndpoint = event.target.value.trim();
    chrome.storage.local.set({ aws_api_url: apiEndpoint });
    updateConnectionStatus();
  });

  chkAutoDiligence.addEventListener("change", event => {
    chrome.storage.local.set({ auto_diligence_on_heart: event.target.checked });
  });

  propertyList.addEventListener("click", event => {
    const runButton = event.target.closest(".run-button");
    const row = event.target.closest(".property-row");
    if (!row) return;

    const listing = portfolio[row.dataset.listingKey];
    if (!listing) return;

    if (runButton) {
      event.stopPropagation();
      triggerDiligence(listing);
      return;
    }

    if (listing.url) {
      chrome.tabs.create({ url: listing.url });
    }
  });

  propertyList.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".property-row");
    const listing = row && portfolio[row.dataset.listingKey];
    if (listing?.url) chrome.tabs.create({ url: listing.url });
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "local") return;

    if (changes.hearted_listings) {
      portfolio = changes.hearted_listings.newValue || {};
      renderPortfolio();
    }

    if (changes.aws_api_url) {
      apiEndpoint = changes.aws_api_url.newValue || "";
      inputApiUrl.value = apiEndpoint;
      updateConnectionStatus();
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
    propertyList.appendChild(createPropertyRow(listing, index));
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

function createPropertyRow(listing, index) {
  const score = getAggregateScore(listing.report);
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
  row.append(image, info, scoreColumn);
  return row;
}

function triggerDiligence(sourceListing) {
  const listing = JSON.parse(JSON.stringify(sourceListing));
  const listingKey = listing.listingKey || getListingKey(listing);
  if (!listingKey || runningListings.has(listingKey)) return;

  listing.listingKey = listingKey;
  runningListings.add(listingKey);
  renderPortfolio();

  const work = apiEndpoint
    ? executeAwsDiligence(listing, apiEndpoint)
    : simulateLocalDiligence(listing);

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

function executeAwsDiligence(listing, endpoint) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: listing.address,
      price: listing.price,
      geo: listing.geo,
      mlsId: listing.mlsId,
      url: listing.url,
      timestamp: new Date().toISOString()
    })
  }).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).then(normalizeReport);
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
      {
        key: "permits",
        label: "Permits",
        score: permitScore,
        weight: 0.45,
        status: permits.length ? `${permits.length} records` : "No records"
      },
      {
        key: "crime",
        label: "Crime",
        score: crimeScore,
        weight: 0.55,
        status: `${crimes.length} recent incidents`
      }
    ];

    return {
      aggregateScore: calculateAggregateScore(topics),
      summary: `Checked ${permits.length} permit records and ${crimes.length} recent crime incidents.`,
      topics,
      completedAt: new Date().toISOString()
    };
  });
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

function normalizeReport(report) {
  const topics = Array.isArray(report?.topics)
    ? report.topics.filter(topic => hasNumericScore(topic.score)).map(topic => ({
        key: topic.key || topic.label,
        label: topic.label || topic.key || "Topic",
        score: clampScore(Number(topic.score)),
        weight: Number(topic.weight) > 0 ? Number(topic.weight) : 1,
        status: topic.status || ""
      }))
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
  connectionStatus.textContent = apiEndpoint ? "AWS configured" : "Local analysis";
  connectionStatus.className = `status-indicator ${apiEndpoint ? "connected" : "disconnected"}`;
}

function getListingKey(listing) {
  try {
    const url = new URL(listing.url);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch (error) {
    return listing.mlsId
      ? `mls:${listing.mlsId}`
      : (listing.address?.streetAddress || listing.url || "");
  }
}

function createPlaceholderImage() {
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="164" height="128" viewBox="0 0 164 128"><rect width="164" height="128" fill="#252b35"/><path d="M42 72l40-32 40 32v34H42z" fill="#3b4452"/><path d="M35 73l47-38 47 38" fill="none" stroke="#667085" stroke-width="8" stroke-linecap="round"/></svg>'
  );
}

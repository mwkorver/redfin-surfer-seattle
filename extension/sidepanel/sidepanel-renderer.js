/* Shared side panel functions. Loaded before sidepanel.js. */

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
  const aScore = getDisplayScore(a.report);
  const bScore = getDisplayScore(b.report);
  if (aScore === null && bScore !== null) return 1;
  if (aScore !== null && bScore === null) return -1;
  if (aScore !== bScore) return (bScore || 0) - (aScore || 0);
  return new Date(b.savedAt || 0) - new Date(a.savedAt || 0);
}

function createPropertyCard(listing, index) {
  const score = getDisplayScore(listing.report);
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
    : (listing.report ? "Re-run analysis" : "Analysis queued");

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

  const nearestStations = Array.isArray(listing.report.nearestLightRail)
    ? listing.report.nearestLightRail
    : [];
  const hasLightRailTopic = Array.isArray(listing.report.topics) &&
    listing.report.topics.some(topic => topic.key === "lightRail");
  if (nearestStations.length || hasLightRailTopic) {
    details.appendChild(createLightRailDetails(
      nearestStations,
      listing.report.lightRailDataset
    ));
  }

  if (typeof listing.report.permitCount === "number") {
    details.appendChild(createPermitRow(listing.report.permitCount));
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
    const weights = typeof scoringWeights !== "undefined" ? scoringWeights : {};
    const displayWeight = weights[topic.key] != null ? weights[topic.key] : Math.round(Number(topic.weight) * 100);
    const weightLabel = `${displayWeight}% weight`;
    topicStatus.textContent = topic.status ? `${topic.status} · ${weightLabel}` : weightLabel;

    const topicScore = document.createElement("span");
    topicScore.className = `analysis-topic-score ${scoreClass(topic.score)}`;
    topicScore.textContent = topic.score !== null ? String(Math.round(Number(topic.score))) : "–";

    topicText.append(topicName, topicStatus);
    topicRow.append(topicText, topicScore);
    details.appendChild(topicRow);
  });

  // Append automatic backend synchronization status.
  const actionRow = document.createElement("div");
  actionRow.className = "action-row";

  const statusText = document.createElement("span");
  statusText.className = `sync-status ${listing.syncState || ""}`.trim();
  statusText.textContent = formatSyncStatus(listing);
  actionRow.appendChild(statusText);

  details.appendChild(actionRow);

  return details;
}

function createLightRailDetails(stations, dataset) {
  const section = document.createElement("section");
  section.className = "light-rail-details";

  const heading = document.createElement("div");
  heading.className = "light-rail-heading";
  heading.textContent = "Nearest Link stations";
  section.appendChild(heading);

  if (!stations.length) {
    const unavailable = document.createElement("div");
    unavailable.className = "light-rail-unavailable";
    unavailable.textContent = "Re-run analysis to calculate station distances.";
    section.appendChild(unavailable);
    return section;
  }

  stations.slice(0, 2).forEach((station, index) => {
    const row = document.createElement("div");
    row.className = "light-rail-station";

    const stationText = document.createElement("div");
    stationText.className = "light-rail-station-text";

    const name = document.createElement("span");
    name.className = "light-rail-station-name";
    name.textContent = `${index + 1}. ${station.name || "Unknown station"}`;

    const lines = document.createElement("span");
    lines.className = "light-rail-station-lines";
    lines.textContent = Array.isArray(station.lines) && station.lines.length
      ? station.lines.join(", ")
      : "Link light rail";

    const distance = document.createElement("span");
    distance.className = "light-rail-station-distance";
    distance.textContent = formatStationDistance(station);

    stationText.append(name, lines);
    row.append(stationText, distance);
    section.appendChild(row);
  });

  if (dataset?.feedVersion) {
    const source = document.createElement("div");
    source.className = "light-rail-source";
    source.textContent = `Sound Transit GTFS ${dataset.feedVersion}`;
    section.appendChild(source);
  }

  return section;
}

function formatStationDistance(station) {
  const miles = Number(station?.distanceMiles);
  const meters = Number(station?.distanceMeters);
  if (Number.isFinite(miles) && Number.isFinite(meters)) {
    return `${miles.toFixed(2)} mi (${Math.round(meters).toLocaleString()} m)`;
  }
  if (Number.isFinite(miles)) return `${miles.toFixed(2)} mi`;
  if (Number.isFinite(meters)) return `${Math.round(meters).toLocaleString()} m`;
  return "Distance unavailable";
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

function createPermitRow(count) {
  const row = document.createElement("div");
  row.className = "analysis-topic";

  const text = document.createElement("div");
  text.className = "analysis-topic-text";

  const name = document.createElement("span");
  name.className = "analysis-topic-name";
  name.textContent = "Permits";

  const status = document.createElement("span");
  status.className = "analysis-topic-status";
  status.textContent = count === 0 ? "No records found" : `${count} record${count === 1 ? "" : "s"} · data only`;

  text.append(name, status);

  const link = document.createElement("a");
  link.className = "permits-search-link";
  link.href = "https://www.seattle.gov/sdci/permits/find-a-permit";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Search →";

  row.append(text, link);
  return row;
}

function toggleAnalysisDetails(listingKey) {
  if (expandedListings.has(listingKey)) {
    expandedListings.delete(listingKey);
  } else {
    expandedListings.clear();
    expandedListings.add(listingKey);
  }
  renderPortfolio();
}

globalThis.SidepanelRenderer = Object.freeze({
  createLightRailDetails,
  formatStationDistance
});

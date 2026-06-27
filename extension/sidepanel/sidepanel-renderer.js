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
  if (listing.cumulativeDaysOnMarket != null) {
    const cdomSpan = document.createElement("span");
    cdomSpan.style.color = "var(--muted)";
    cdomSpan.style.fontSize = "10px";
    cdomSpan.style.fontWeight = "normal";
    cdomSpan.style.marginLeft = "6px";
    cdomSpan.textContent = `(${listing.cumulativeDaysOnMarket}d CDOM)`;
    price.appendChild(cdomSpan);
  }

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

const activeTabs = new Map();

function createAnalysisDetails(listing) {
  const details = document.createElement("div");
  details.className = "analysis-details";
  details.hidden = !expandedListings.has(listing.listingKey);

  const listingKey = listing.listingKey;
  if (!activeTabs.has(listingKey)) {
    activeTabs.set(listingKey, "scorecard");
  }
  const currentTab = activeTabs.get(listingKey);

  // Tabs Header
  const tabsHeader = document.createElement("div");
  tabsHeader.className = "details-tabs";

  const tabDefs = [
    { id: "scorecard", label: "Scorecard" },
    { id: "parcel", label: "Parcel & Zoning" },
    { id: "transit", label: "Transit & Crime" },
    { id: "permits", label: "Permits Log" }
  ];

  tabDefs.forEach(t => {
    const btn = document.createElement("button");
    btn.className = `tab-button${currentTab === t.id ? " active" : ""}`;
    btn.type = "button";
    btn.textContent = t.label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      activeTabs.set(listingKey, t.id);
      renderPortfolio();
    });
    tabsHeader.appendChild(btn);
  });

  details.appendChild(tabsHeader);

  // Render content based on currentTab
  if (currentTab === "scorecard") {
    details.appendChild(renderScorecardTab(listing));
  } else if (currentTab === "parcel") {
    details.appendChild(renderParcelTab(listing));
  } else if (currentTab === "transit") {
    details.appendChild(renderTransitTab(listing));
  } else if (currentTab === "permits") {
    details.appendChild(renderPermitsTab(listing));
  }

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

function renderScorecardTab(listing) {
  const container = document.createElement("div");
  container.className = "tab-content scorecard-tab";

  // Riparian banner
  const hasRiparianData = listing.report?.riparianStatus !== undefined || listing.report?.riparianStreams !== undefined;
  if (hasRiparianData) {
    const streamList = listing.report.riparianStreams || [];
    const banner = document.createElement("div");
    if (streamList.length > 0) {
      banner.className = "riparian-banner danger";
      const names = streamList.map(s => s.name).filter(Boolean).join(" · ") || "F-type stream";
      banner.textContent = `⚠ Riparian Stream within 165 ft: ${names}`;
    } else {
      banner.className = "riparian-banner success";
      banner.textContent = `✓ No riparian streams within 165 ft`;
    }
    container.appendChild(banner);
  } else {
    const banner = document.createElement("div");
    banner.className = "riparian-banner unknown";
    banner.textContent = `Riparian data unavailable. Re-run analysis.`;
    container.appendChild(banner);
  }

  // Summary text
  if (listing.report?.summary) {
    const summary = document.createElement("p");
    summary.className = "analysis-summary";
    summary.textContent = listing.report.summary;
    container.appendChild(summary);
  }

  // Topics list
  const topics = Array.isArray(listing.report?.topics) ? listing.report.topics : [];
  topics.forEach(topic => {
    const topicRow = document.createElement("div");
    topicRow.className = "analysis-topic-row";

    const topicMeta = document.createElement("div");
    topicMeta.className = "analysis-topic-meta";

    const topicName = document.createElement("span");
    topicName.className = "analysis-topic-name";
    topicName.textContent = topic.label;

    const topicStatus = document.createElement("span");
    topicStatus.className = "analysis-topic-status";
    const weights = typeof scoringWeights !== "undefined" ? scoringWeights : {};
    const displayWeight = weights[topic.key] != null ? weights[topic.key] : Math.round(Number(topic.weight) * 100);
    const weightLabel = `${displayWeight}% weight`;
    topicStatus.textContent = topic.status ? `${topic.status} · ${weightLabel}` : weightLabel;

    topicMeta.append(topicName, topicStatus);

    const topicBarContainer = document.createElement("div");
    topicBarContainer.className = "topic-bar-container";

    const topicBar = document.createElement("div");
    topicBar.className = `topic-bar ${scoreClass(topic.score)}`;
    topicBar.style.width = `${topic.score}%`;

    topicBarContainer.appendChild(topicBar);

    const topicScore = document.createElement("span");
    topicScore.className = `analysis-topic-score ${scoreClass(topic.score)}`;
    topicScore.textContent = topic.score !== null ? String(Math.round(Number(topic.score))) : "–";

    topicRow.append(topicMeta, topicBarContainer, topicScore);
    container.appendChild(topicRow);
  });

  return container;
}

function renderParcelTab(listing) {
  const container = document.createElement("div");
  container.className = "tab-content parcel-tab";

  if (!listing.parcel) {
    const fallback = document.createElement("div");
    fallback.className = "parcel-unavailable";
    fallback.textContent = "King County parcel data unavailable.";
    container.appendChild(fallback);
    return container;
  }

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

  // Listing price vs Appraisal
  if (listing.parcel.appraisedValue && listing.price) {
    const appraised = Number(listing.parcel.appraisedValue);
    const listed = Number(listing.price);
    const pctDiff = Math.round(((listed - appraised) / appraised) * 100);
    const diffLabel = pctDiff >= 0 ? `+${pctDiff}% vs Appraisal` : `${pctDiff}% vs Appraisal`;
    appendParcelField(parcelRow, "Appraised value", `${formatCurrencyValue(appraised)} (${diffLabel})`);
  } else {
    appendParcelField(parcelRow, "Appraised value", formatCurrencyValue(listing.parcel.appraisedValue));
  }

  appendLotAreaField(parcelRow, listing.parcel.lotAreaSqFt, listing.lotSqft);
  appendParcelField(parcelRow, "Levy code", listing.parcel.levyCode);
  appendParcelField(parcelRow, "Units", formatOptionalCount(listing.parcel.numberOfUnits));
  appendParcelField(parcelRow, "Buildings", formatOptionalCount(listing.parcel.numberOfBuildings));

  const parcelLinks = createParcelLinks(listing.parcel.links);
  if (parcelLinks) parcelRow.appendChild(parcelLinks);
  container.appendChild(parcelRow);

  return container;
}

function renderTransitTab(listing) {
  const container = document.createElement("div");
  container.className = "tab-content transit-tab";

  // Light Rail Section
  const nearestStations = Array.isArray(listing.report?.nearestLightRail)
    ? listing.report.nearestLightRail
    : [];
  container.appendChild(createLightRailDetails(
    nearestStations,
    listing.report?.lightRailDataset
  ));

  // Crime Section
  const crimeHeading = document.createElement("div");
  crimeHeading.className = "section-heading";
  crimeHeading.textContent = "Crime Diligence (Last 12 mos)";
  container.appendChild(crimeHeading);

  const crimeStats = listing.report?.crimeStats;
  const recentCrimes = listing.report?.recentCrimes;

  if (crimeStats && Object.keys(crimeStats).length > 0) {
    const statsContainer = document.createElement("div");
    statsContainer.className = "crime-stats-chips";
    Object.entries(crimeStats).forEach(([category, count]) => {
      const chip = document.createElement("span");
      chip.className = "crime-chip";
      const label = category.toLowerCase().replace(/ crime/g, "");
      chip.textContent = `${label}: ${count}`;
      statsContainer.appendChild(chip);
    });
    container.appendChild(statsContainer);
  }

  if (recentCrimes && recentCrimes.length > 0) {
    const crimeList = document.createElement("div");
    crimeList.className = "crime-recent-list";
    recentCrimes.forEach(c => {
      const item = document.createElement("div");
      item.className = "crime-recent-item";

      const dateMeta = document.createElement("span");
      dateMeta.className = "crime-recent-date";
      try {
        const d = new Date(c.date);
        dateMeta.textContent = d.toLocaleDateString([], { month: "short", day: "numeric" });
      } catch (e) {
        dateMeta.textContent = c.date ? String(c.date).substring(0, 10) : "";
      }

      const descContainer = document.createElement("div");
      descContainer.className = "crime-recent-desc-container";

      const category = document.createElement("div");
      category.className = "crime-recent-category";
      category.textContent = c.category;

      const desc = document.createElement("div");
      desc.className = "crime-recent-desc";
      desc.textContent = c.description;

      descContainer.append(category, desc);
      item.append(dateMeta, descContainer);
      crimeList.appendChild(item);
    });
    container.appendChild(crimeList);
  } else if (listing.report?.topics && listing.report.topics.some(t => t.key === "crime")) {
    const noRecords = document.createElement("div");
    noRecords.className = "crime-unavailable";
    noRecords.textContent = "No crime records found or analysis needs re-run.";
    container.appendChild(noRecords);
  }

  return container;
}

function renderPermitsTab(listing) {
  const container = document.createElement("div");
  container.className = "tab-content permits-tab";

  const permitHeading = document.createElement("div");
  permitHeading.className = "section-heading";
  permitHeading.textContent = `Seattle Building Permits (${listing.report?.permitCount || 0} Total)`;
  container.appendChild(permitHeading);

  const recentPermits = listing.report?.recentPermits;

  if (recentPermits && recentPermits.length > 0) {
    const permitList = document.createElement("div");
    permitList.className = "permit-list";
    recentPermits.forEach(p => {
      const card = document.createElement("div");
      card.className = "permit-item-card";

      const header = document.createElement("div");
      header.className = "permit-item-header";

      const permitNum = document.createElement("a");
      permitNum.className = "permit-item-num";
      permitNum.textContent = p.permitnum;
      if (p.link) {
        permitNum.href = p.link;
        permitNum.target = "_blank";
        permitNum.rel = "noreferrer";
      }

      const statusBadge = document.createElement("span");
      const statusClass = getPermitStatusClass(p.statuscurrent);
      statusBadge.className = `permit-status-badge ${statusClass}`;
      statusBadge.textContent = p.statuscurrent;

      header.append(permitNum, statusBadge);

      const type = document.createElement("div");
      type.className = "permit-item-type";
      type.textContent = p.permittypedesc;

      const desc = document.createElement("div");
      desc.className = "permit-item-desc";
      desc.textContent = p.description || "No description provided.";

      card.append(header, type, desc);
      permitList.appendChild(card);
    });
    container.appendChild(permitList);
  } else {
    const noRecords = document.createElement("div");
    noRecords.className = "permits-unavailable";
    noRecords.textContent = listing.report?.permitCount === 0
      ? "No building permit records found."
      : "Detailed building permits log unavailable. Re-run analysis.";
    container.appendChild(noRecords);
  }

  // Direct search link
  const searchRow = document.createElement("div");
  searchRow.className = "permit-search-row";

  const addr = listing.address || {};
  const addrParts = [addr.streetAddress, addr.city, addr.state, addr.zip].filter(Boolean).join(", ");
  const sdciUrl = addrParts
    ? `https://maps.seattle.gov/sdcipermithistory/search?address=${encodeURIComponent(addrParts).replace(/%20/g, "+")}`
    : "https://maps.seattle.gov/sdcipermithistory/";

  const searchLink = document.createElement("a");
  searchLink.className = "permits-search-btn";
  searchLink.href = sdciUrl;
  searchLink.target = "_blank";
  searchLink.rel = "noreferrer";
  searchLink.textContent = "Search SDCI Portal →";
  searchRow.appendChild(searchLink);
  container.appendChild(searchRow);

  return container;
}

function getPermitStatusClass(status) {
  const norm = String(status || "").toLowerCase();
  if (["completed", "reviews completed", "closed"].includes(norm)) {
    return "completed";
  }
  if (["permit issued", "in review", "active", "issued"].includes(norm)) {
    return "active";
  }
  if (["canceled", "expired", "cancelled", "withdrawn"].includes(norm)) {
    return "cancelled";
  }
  return "other";
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
    const displayName = station.status === "planned" ? `${station.name} (Planned)` : station.name;
    name.textContent = `${index + 1}. ${displayName || "Unknown station"}`;

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

function appendLotAreaField(container, parcelSqFt, redfinSqFt) {
  const parcelVal = Number(parcelSqFt);
  const redfinVal = Number(redfinSqFt);
  const hasParcel = Number.isFinite(parcelVal) && parcelVal > 0;
  const hasRedfin = Number.isFinite(redfinVal) && redfinVal > 0;
  if (!hasParcel && !hasRedfin) return;

  const field = document.createElement("div");
  field.className = "parcel-field";

  const fieldLabel = document.createElement("span");
  fieldLabel.className = "parcel-field-label";
  fieldLabel.textContent = "Lot area";

  const fieldValue = document.createElement("span");
  fieldValue.className = "parcel-field-value";

  if (hasParcel && hasRedfin) {
    const diff = Math.abs(parcelVal - redfinVal);
    const pct = diff / parcelVal;
    if (pct > 0.05 && diff > 100) {
      fieldValue.textContent = `${formatSquareFeet(parcelVal)} (KC) · ${formatSquareFeet(redfinVal)} (Redfin) ⚠`;
      fieldValue.title = "Lot size differs between King County parcel data and Redfin listing";
    } else {
      fieldValue.textContent = formatSquareFeet(parcelVal);
    }
  } else {
    fieldValue.textContent = formatSquareFeet(hasParcel ? parcelVal : redfinVal);
  }

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
  link.href = "https://maps.seattle.gov/sdcipermithistory/";
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

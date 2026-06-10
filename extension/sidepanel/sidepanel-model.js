/* Shared side panel functions. Loaded before sidepanel.js. */

function normalizeReport(report) {
  const topics = Array.isArray(report?.topics)
    ? report.topics.filter(topic => hasNumericScore(topic.score) && DiligenceScoring.getTopic(topic.key || topic.label)).map(topic => {
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
  const scoredTopics = topics.filter(topic => hasNumericScore(topic.score) && Number(topic.weight) > 0);
  const totalWeight = scoredTopics.reduce((sum, topic) => sum + Number(topic.weight), 0);
  if (!totalWeight) return null;

  const weightedTotal = scoredTopics.reduce((sum, topic) => {
    return sum + Number(topic.score) * Number(topic.weight);
  }, 0);
  return Math.round(weightedTotal / totalWeight);
}

function isAnalysisOutOfSync(listing) {
  if (!listing?.report) return false;
  if (listing.syncState === "pending" || listing.syncState === "failed") return true;
  const analysisUpdatedAt = listing.analysisUpdatedAt || listing.updatedAt || "";
  const syncedAnalysisUpdatedAt = listing.syncedAnalysisUpdatedAt || listing.registeredAt || "";
  if (!syncedAnalysisUpdatedAt) return true;
  return new Date(analysisUpdatedAt || 0) > new Date(syncedAnalysisUpdatedAt || 0);
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

globalThis.SidepanelModel = Object.freeze({
  normalizeReport,
  calculateAggregateScore,
  isAnalysisOutOfSync,
  getAggregateScore,
  hasNumericScore,
  formatTopicSummary,
  formatLocation,
  formatParcelMatch,
  parseOptionalNumber,
  formatCurrencyValue,
  formatSquareFeet,
  formatOptionalCount,
  formatPrice,
  scoreClass,
  clampScore,
  getListingKey,
  normalizeStoredListing,
  getRedfinHomeId,
  getListingUrl,
  createPlaceholderImage
});

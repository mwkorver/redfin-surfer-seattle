/* Shared side panel functions. Loaded before sidepanel.js. */

function simulateLocalDiligence(listing) {
  const isSeattle = (listing.address.city || "").toLowerCase() === "seattle" &&
    (listing.address.state || "").toUpperCase() === "WA";

  const permitPromise = isSeattle ? fetchSeattlePermits(listing) : Promise.resolve([]);
  const crimePromise = isSeattle ? fetchSeattleCrime(listing) : Promise.resolve([]);
  const lightRailPromise = findNearestLightRailStations(listing, 2);
  const cdomPromise = Promise.resolve(listing.cumulativeDaysOnMarket != null ? listing.cumulativeDaysOnMarket : null);
  const riparianPromise = fetchRiparianStreams(listing.parcel?.boundary);
  const oilTankPromise = isSeattle ? fetchSeattleOilTankRecords(listing) : Promise.resolve(null);

  return Promise.all([permitPromise, crimePromise, lightRailPromise, cdomPromise, riparianPromise, oilTankPromise]).then(([permits, crimes, lightRail, cdomValue, streams, oilTankRecords]) => {
    const nearestStations = lightRail.stations;
    const nearestStation = nearestStations[0] || null;
    const crimeScore = scoreCrime(crimes);
    const lightRailScore = scoreLightRailDistance(nearestStation?.distanceMeters);
    const lotAreaScore = scoreLotArea(listing.parcel?.lotAreaSqFt);
    const ppsf = (listing.sqft > 0 && listing.price > 0) ? listing.price / listing.sqft : null;
    const pricePerSqftScore = scorePricePerSqft(ppsf);

    const topics = [
      createScoredTopic("crime", crimeScore, `${crimes.length} recent incidents`)
    ];
    if (lightRailScore !== null) {
      topics.push(createScoredTopic(
        "lightRail",
        lightRailScore,
        nearestStations.length
          ? formatNearestStationStatus(nearestStations)
          : "Location unavailable"
      ));
    }
    if (lotAreaScore !== null) {
      const sqftLabel = listing.parcel?.lotAreaSqFt
        ? `${Math.round(listing.parcel.lotAreaSqFt).toLocaleString()} sq ft`
        : "Lot size from parcel";
      topics.push(createScoredTopic("lotArea", lotAreaScore, sqftLabel));
    }
    if (pricePerSqftScore !== null) {
      topics.push(createScoredTopic(
        "pricePerSqft",
        pricePerSqftScore,
        `$${Math.round(ppsf).toLocaleString()}/sq ft`
      ));
    }
    
    const cdomScore = scoreMlsCdom(cdomValue);
    if (cdomScore !== null) {
      topics.push(createScoredTopic(
        "mlsCdom",
        cdomScore,
        `${cdomValue} days on market`
      ));
    }

    // Records arrive already normalized and merged across SDCI sources; take the
    // 5 most recent for the log (full count is preserved in permitCount).
    const recentPermits = permits.slice(0, 5).map(p => ({
      permitnum: p.permitnum || "Unknown",
      permittypedesc: p.permittypedesc || "Unknown Type",
      statuscurrent: p.statuscurrent || "Unknown Status",
      description: (p.description || "").substring(0, 200),
      link: p.link || "",
      source: p.source || ""
    }));

    // Sort and extract top 5 recent crime incidents
    const sortedCrimes = [...crimes].sort((a, b) => {
      const dateA = new Date(a.report_date_time || a.offense_date || 0);
      const dateB = new Date(b.report_date_time || b.offense_date || 0);
      return dateB - dateA;
    });

    const recentCrimes = sortedCrimes.slice(0, 5).map(c => ({
      date: c.report_date_time || c.offense_date || "",
      category: c.offense_category || "Unknown Category",
      description: c.nibrs_offense_code_description || c.offense_sub_category || "Unknown Offense"
    }));

    // Calculate crime category breakdown
    const crimeStats = {};
    crimes.forEach(c => {
      const cat = c.offense_category || "Other";
      crimeStats[cat] = (crimeStats[cat] || 0) + 1;
    });

    // Format stream details
    const streamList = streams || [];
    const riparianStatus = formatRiparianStatus(streamList);

    return {
      aggregateScore: calculateAggregateScore(topics),
      summary: nearestStation
        ? `${crimes.length} recent crime incidents. Nearest Link stations: ${formatNearestStationSummary(nearestStations)}.`
        : `${crimes.length} recent crime incidents.`,
      topics,
      permitCount: permits.length,
      recentPermits,
      recentCrimes,
      crimeStats,
      riparianStreams: streamList.map(s => ({
        name: s.attributes?.WatercourseNameS || "Unknown Stream",
        type: s.attributes?.StreamType || "F"
      })),
      riparianStatus,
      oilTank: buildOilTankFinding(oilTankRecords, listing),
      nearestLightRail: nearestStations,
      lightRailDataset: lightRail.dataset,
      completedAt: new Date().toISOString()
    };
  });
}

function findNearestLightRailStations(listing, limit = 2) {
  const latitude = Number(listing.geo?.latitude);
  const longitude = Number(listing.geo?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return Promise.resolve({ stations: [], dataset: {} });
  }

  return loadLightRailStations().then(dataset => {
    const stations = dataset.features
      .map(feature => {
        const coordinates = feature.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

        const distanceMeters = haversineDistanceMeters(
          latitude,
          longitude,
          Number(coordinates[1]),
          Number(coordinates[0])
        );
        if (!Number.isFinite(distanceMeters)) return null;
        return {
          stationId: feature.properties?.stationId || "",
          name: feature.properties?.name || "Unknown station",
          lines: feature.properties?.lines || [],
          url: feature.properties?.url || "",
          status: feature.properties?.status || "existing",
          distanceMeters: Math.round(distanceMeters),
          distanceMiles: Number((distanceMeters / 1609.344).toFixed(2)),
          source: "sound-transit-gtfs",
          feedVersion: dataset.metadata.feedVersion || ""
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, Math.max(1, Number(limit) || 2));
    return {
      stations,
      dataset: dataset.metadata
    };
  }).catch(error => {
    console.warn("[Diligence Sidecar] Light rail station lookup failed:", error);
    return { stations: [], dataset: {} };
  });
}

function loadLightRailStations() {
  if (!lightRailStationsPromise) {
    const url = chrome.runtime.getURL("data/light_rail_stations.geojson");
    lightRailStationsPromise = fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`Station data HTTP ${response.status}`);
        return response.json();
      })
      .then(collection => ({
        features: Array.isArray(collection.features) ? collection.features : [],
        metadata: collection.metadata && typeof collection.metadata === "object"
          ? collection.metadata
          : {}
      }));
  }
  return lightRailStationsPromise;
}

function haversineDistanceMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  if (![latitudeA, longitudeA, latitudeB, longitudeB].every(Number.isFinite)) return NaN;
  const earthRadiusMeters = 6371008.8;
  const toRadians = degrees => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const startLatitude = toRadians(latitudeA);
  const endLatitude = toRadians(latitudeB);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(1 - haversine)
  );
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
  if (!/^\d{10}$/.test(parcel.parcelId)) {
    return Promise.resolve({ ...parcel, lookupAttemptedAt: new Date().toISOString() });
  }
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

// SDCI publishes its permit history across several Socrata datasets. The map at
// maps.seattle.gov/sdcipermithistory aggregates all of them, so querying only
// "Building Permits" (76t5-zqzr) misses electrical/trade/land-use permits and
// code complaints. Each source is normalized to a common record shape below.
const SEATTLE_PERMIT_SOURCES = [
  { id: "76t5-zqzr", source: "Building",   numField: "permitnum", typeFields: ["permittypedesc", "permittypemapped", "permitclass"], dateFields: [] },
  { id: "c4tj-daue", source: "Electrical", numField: "permitnum", typeFields: ["permittypemapped", "permitclass"], dateFields: ["issueddate", "applieddate", "completeddate"] },
  { id: "c87v-5hwh", source: "Trade",      numField: "permitnum", typeFields: ["permittypemapped", "permittype", "permitclass"], dateFields: ["issueddate", "applieddate", "completeddate"] },
  { id: "ht3q-kdvx", source: "Land Use",   numField: "permitnum", typeFields: ["permittypemapped", "permitclass"], dateFields: ["issueddate", "applieddate", "decisiondate"] },
  { id: "ez4a-iug7", source: "Complaint",  numField: "recordnum", typeFields: ["recordtypedesc", "recordtype"], dateFields: ["opendate"] }
];

// Socrata URL columns are returned inconsistently across these datasets: some as
// a plain string, others as a { url } object. Normalize to a string either way.
function normalizeSocrataLink(link) {
  if (!link) return "";
  if (typeof link === "string") return link;
  return link.url || "";
}

function firstNonEmptyField(record, fields) {
  for (const field of fields) {
    const value = record[field];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function normalizePermitRecord(record, config) {
  return {
    permitnum: record[config.numField] || "Unknown",
    permittypedesc: firstNonEmptyField(record, config.typeFields) || "Unknown Type",
    statuscurrent: record.statuscurrent || "Unknown Status",
    description: record.description || "",
    link: normalizeSocrataLink(record.link),
    date: firstNonEmptyField(record, config.dateFields),
    source: config.source
  };
}

function fetchSeattlePermitSource(config, parts) {
  const where = buildStreetAddressWhere("originaladdress1", parts);
  const url = `https://data.seattle.gov/resource/${config.id}.json?$limit=50&$where=${encodeURIComponent(where)}`;
  return fetch(url)
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`${config.source} HTTP ${response.status}`)))
    .then(data => Array.isArray(data)
      ? data.filter(record => matchesStreetAddress(record.originaladdress1, parts)).map(record => normalizePermitRecord(record, config))
      : [])
    .catch(error => {
      console.warn(`[Diligence Sidecar] ${config.source} permit query failed:`, error);
      return [];
    });
}

// Shared by the SDCI permit and SFD oil tank lookups. Returns null when the
// address cannot be split into a usable street number and street name.
const DIRECTIONALS = ["N", "S", "E", "W", "NW", "NE", "SW", "SE"];

function parseStreetAddressParts(streetAddress) {
  const parts = String(streetAddress || "").trim().split(/\s+/);
  if (parts.length < 2) return null;

  const streetNumber = parts[0].replace(/[^0-9A-Za-z]/g, "");
  const words = parts.slice(1).map(part => part.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  const streetNamePart = words.find(word => !DIRECTIONALS.includes(word) && !["UNIT", "APT", "STE", "SUITE"].includes(word));
  const streetName = streetNamePart || "";
  if (!streetNumber || !streetName) return null;
  // Directionals stop at the unit designator: "Unit B" is not a street direction.
  const unitIndex = words.findIndex(word => ["UNIT", "APT", "STE", "SUITE"].includes(word));
  const directionals = (unitIndex === -1 ? words : words.slice(0, unitIndex)).filter(word => DIRECTIONALS.includes(word));
  return { streetNumber, streetName, directionals };
}

function addOrdinalSuffix(value) {
  if (!/^\d+$/.test(value)) return value;
  const n = Number(value);
  const mod100 = n % 100;
  const mod10 = n % 10;
  const suffix = (mod100 >= 11 && mod100 <= 13) ? "TH"
    : mod10 === 1 ? "ST" : mod10 === 2 ? "ND" : mod10 === 3 ? "RD" : "TH";
  return `${value}${suffix}`;
}

// "97TH", "97" and (for a Redfin address typed as "14 TH") "14TH" all name the
// same street. The City writes numbered streets both ways.
function streetNameVariants(streetName) {
  const bare = stripOrdinalSuffix(streetName);
  return [...new Set([streetName, bare, addOrdinalSuffix(bare)])];
}

// SoQL predicate matching a street address. A bare like '%4747%4TH%' is a
// substring match and returns 4747 34TH AVE NE for a house on 4TH AVE NE, so:
// the number must start the field, and the street name must be a whole word in
// any of its ordinal spellings. The number is anchored without a trailing space
// because SDCI folds units into it ("3670-B DAYTON", "6729A 14TH"); the digit
// run-on that allows (3670 → 36701) is removed client-side by
// matchesStreetAddress. parts come from parseStreetAddressParts and are
// alphanumeric, so the string is injection-safe.
function buildStreetAddressWhere(field, parts) {
  const padded = `(' ' || upper(${field}) || ' ')`;
  const nameClauses = streetNameVariants(parts.streetName)
    .map(name => `${padded} like '% ${name} %'`)
    .join(" OR ");
  return `starts_with(upper(${field}), '${parts.streetNumber}') AND (${nameClauses})`;
}

// Precise check applied to each row the coarse predicate returns. The number
// must not run on into more digits, the street name must appear as a whole
// word, and every directional in the listing (NE, NW, ...) must be present so
// 7011 14TH AVE NW does not stand in for 7011 14TH AVE NE.
function matchesStreetAddress(datasetAddress, parts) {
  const upper = String(datasetAddress || "").toUpperCase();
  if (!new RegExp(`^${parts.streetNumber}(?![0-9])`).test(upper)) return false;
  const words = upper.replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const nameOk = streetNameVariants(parts.streetName).some(name => words.includes(name));
  if (!nameOk) return false;
  return (parts.directionals || []).every(direction => words.includes(direction));
}

const SEATTLE_OIL_TANK_DATASET_ID = "xvj2-ai6y";
const SEATTLE_OIL_TANK_DATASET_URL =
  "https://data.seattle.gov/Built-Environment/Underground-Storage-Tank-UST-Records-Residential/xvj2-ai6y";

// Seattle Fire Department records every residential heating-oil tank
// decommissioning permit (code 6103). Only decommissionings are in the dataset,
// so an empty result means either no tank ever existed or one was never dealt
// with; the finding has to say that rather than claim the ground is clean.
// Resolves to null (not []) when the answer is unknown, so the report can tell
// "no record" apart from "could not check".
function fetchSeattleOilTankRecords(listing) {
  const parts = parseStreetAddressParts(listing.address?.streetAddress);
  if (!parts) return Promise.resolve(null);

  const where = buildStreetAddressWhere("address", parts);
  const url = `https://data.seattle.gov/resource/${SEATTLE_OIL_TANK_DATASET_ID}.json?$limit=20&$where=${encodeURIComponent(where)}`;
  return fetch(url)
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`Oil tank HTTP ${response.status}`)))
    .then(data => Array.isArray(data) ? data.filter(record => matchesStreetAddress(record.address, parts)) : [])
    .catch(error => {
      console.warn("[Diligence Sidecar] Oil tank query failed:", error);
      return null;
    });
}

function stripOrdinalSuffix(value) {
  return String(value || "").replace(/\b(\d+)(ST|ND|RD|TH)\b/gi, "$1");
}

const STREET_WORD_ABBREVIATIONS = Object.freeze({
  AVENUE: "AVE", STREET: "ST", PLACE: "PL", ROAD: "RD", DRIVE: "DR", BOULEVARD: "BLVD",
  COURT: "CT", LANE: "LN", TERRACE: "TER", PARKWAY: "PKWY",
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
  NORTHWEST: "NW", NORTHEAST: "NE", SOUTHWEST: "SW", SOUTHEAST: "SE"
});

function normalizeStreetAddressForMatch(value) {
  return stripOrdinalSuffix(String(value || "").toUpperCase())
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(word => STREET_WORD_ABBREVIATIONS[word] || word)
    .join(" ");
}

// "exact" when the dataset row names the same address as the listing once both
// are normalized; "street" when only the number and street name agree, which the
// UI surfaces so the reader knows to confirm it.
function classifyOilTankMatch(listingStreetAddress, datasetAddress) {
  return normalizeStreetAddressForMatch(listingStreetAddress) === normalizeStreetAddressForMatch(datasetAddress)
    ? "exact"
    : "street";
}

function parseTankSizeGallons(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function normalizeOilTankRecord(record, listing) {
  const dateDecommissioned = String(record.date_decommissioned || "").slice(0, 10);
  const dateIssued = String(record.date_issued || "").slice(0, 10);
  const year = Number((dateDecommissioned || dateIssued).slice(0, 4));
  return {
    matchQuality: classifyOilTankMatch(listing.address?.streetAddress, record.address),
    permitNumber: record.permit_number || "",
    dateIssued,
    dateDecommissioned,
    year: Number.isFinite(year) && year > 0 ? year : null,
    tankSizeGallons: parseTankSizeGallons(record.tank_size),
    tankSizeRaw: record.tank_size || "",
    tankContent: record.tank_content || "",
    typeDecommissioned: record.type_decommissioned || "",
    fillMaterial: record.fill_material || "",
    company: record.company || "",
    datasetAddress: record.address || ""
  };
}

function buildOilTankFinding(records, listing) {
  const base = { matchQuality: null, recordCount: 0, datasetUrl: SEATTLE_OIL_TANK_DATASET_URL };
  if (!Array.isArray(records)) return { status: "unavailable", ...base };
  if (!records.length) return { status: "no-record", ...base };

  // Headline the exact match if there is one, then the most recent decommissioning.
  const normalized = records.map(record => normalizeOilTankRecord(record, listing));
  normalized.sort((a, b) => {
    if (a.matchQuality !== b.matchQuality) return a.matchQuality === "exact" ? -1 : 1;
    return (b.dateDecommissioned || b.dateIssued).localeCompare(a.dateDecommissioned || a.dateIssued);
  });

  return {
    status: "decommissioned",
    ...base,
    recordCount: normalized.length,
    ...normalized[0]
  };
}

function fetchSeattlePermits(listing) {
  const parts = parseStreetAddressParts(listing.address.streetAddress);
  if (!parts) return Promise.resolve([]);

  return Promise.all(
    SEATTLE_PERMIT_SOURCES.map(config => fetchSeattlePermitSource(config, parts))
  ).then(results => {
    const merged = results.flat();
    // Most-recent first; records without any date (e.g. building permits) sort last.
    merged.sort((a, b) => {
      const timeA = a.date ? Date.parse(a.date) : -Infinity;
      const timeB = b.date ? Date.parse(b.date) : -Infinity;
      return timeB - timeA;
    });
    return merged;
  });
}

function fetchSeattleCrime(listing) {
  if (!Number.isFinite(Number(listing.geo?.latitude)) || !Number.isFinite(Number(listing.geo?.longitude))) {
    return Promise.resolve([]);
  }

  const latPrefix = Number(listing.geo.latitude).toFixed(2);
  const lonPrefix = Number(listing.geo.longitude).toFixed(2);
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const where = `latitude like '${latPrefix}%' and longitude like '${lonPrefix}%' and report_date_time > '${cutoff}'`;
  const url = `https://data.seattle.gov/resource/tazs-3rd5.json?$limit=500&$where=${encodeURIComponent(where)}`;
  return fetch(url)
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`Crime HTTP ${response.status}`)))
    .then(data => Array.isArray(data) ? data : [])
    .catch(error => {
      console.warn("[Diligence Sidecar] Crime query failed:", error);
      return [];
    });
}

function scoreCrime(crimes) {
  if (crimes.length <= 5) return 95;
  if (crimes.length <= 20) return 78;
  if (crimes.length <= 50) return 58;
  return 35;
}

function scoreLightRailDistance(distanceMeters) {
  if (distanceMeters == null || !Number.isFinite(Number(distanceMeters))) return null;
  const distanceMiles = Number(distanceMeters) / 1609.344;
  const breakpoints = [
    [0,   100],
    [0.5,  90],
    [1.0,  78],
    [2.0,  58],
    [3.0,  40],
    [5.0,  25],
  ];
  if (distanceMiles >= breakpoints[breakpoints.length - 1][0]) {
    return breakpoints[breakpoints.length - 1][1];
  }
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [x0, y0] = breakpoints[i];
    const [x1, y1] = breakpoints[i + 1];
    if (distanceMiles <= x1) {
      const t = (distanceMiles - x0) / (x1 - x0);
      return Math.round(y0 + t * (y1 - y0));
    }
  }
}

function formatDistanceMiles(distanceMiles) {
  if (!Number.isFinite(Number(distanceMiles))) return "distance unavailable";
  return `${Number(distanceMiles).toFixed(2)} mi`;
}

function formatNearestStationStatus(stations) {
  return stations
    .map(station => {
      const displayName = station.status === "planned" ? `${station.name} (Planned)` : station.name;
      return `${displayName} ${formatDistanceMiles(station.distanceMiles)}`;
    })
    .join(" · ");
}

function formatNearestStationSummary(stations) {
  return stations
    .map(station => {
      const displayName = station.status === "planned" ? `${station.name} (Planned)` : station.name;
      return `${displayName} (${formatDistanceMiles(station.distanceMiles)})`;
    })
    .join(" and ");
}

function fetchRiparianStreams(boundaryGeoJson) {
  const arcgisPolygon = geojsonPolygonToArcGIS(boundaryGeoJson);
  if (!arcgisPolygon) return Promise.resolve([]);

  return queryFStreams(arcgisPolygon)
    .catch(error => {
      console.warn("[Diligence Sidecar] Riparian stream query failed:", error);
      return [];
    });
}

function geojsonPolygonToArcGIS(geojson) {
  if (!geojson) return null;
  if (geojson.type === "Polygon" && Array.isArray(geojson.coordinates)) {
    return { rings: geojson.coordinates, spatialReference: { wkid: 4326 } };
  }
  if (geojson.type === "MultiPolygon" && Array.isArray(geojson.coordinates)) {
    return { rings: geojson.coordinates.flat(1), spatialReference: { wkid: 4326 } };
  }
  return null;
}

function queryFStreams(parcelPolygon) {
  const body = new URLSearchParams({
    geometry: JSON.stringify(parcelPolygon),
    geometryType: "esriGeometryPolygon",
    spatialRel: "esriSpatialRelIntersects",
    distance: "165",
    units: "esriFeet",
    where: "StreamType='F'",
    outFields: "StreamType,FishHabitatCriteria,WatercourseNameS",
    inSR: "4326",
    returnGeometry: "false",
    f: "json"
  });
  return fetch("https://gismaps.kingcounty.gov/arcgis/rest/services/Environment/KingCo_SensitiveAreas/MapServer/21/query", {
    method: "POST",
    body
  })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`F streams HTTP ${r.status}`)))
    .then(data => Array.isArray(data?.features) ? data.features : []);
}

function scoreRiparian(streams) {
  return streams.length === 0 ? 90 : 30;
}

function formatRiparianStatus(streams) {
  if (!streams.length) return "No F-type streams within 165 ft";
  const names = [...new Set(
    streams.map(f => f.attributes?.WatercourseNameS).filter(Boolean)
  )];
  return names.length
    ? names.slice(0, 2).join(" · ")
    : `${streams.length} F-type stream${streams.length > 1 ? "s" : ""} nearby`;
}

function scoreLotArea(sqftValue) {
  const sqft = Number(sqftValue);
  if (!Number.isFinite(sqft) || sqft <= 0) return null;
  const breakpoints = [
    [0,      20],
    [2000,   45],
    [4000,   65],
    [6000,   80],
    [9600,   90],
    [20000,  98],
  ];
  for (let i = breakpoints.length - 1; i >= 0; i--) {
    if (sqft >= breakpoints[i][0]) return breakpoints[i][1];
  }
  return 20;
}

function scorePricePerSqft(ppsf) {
  const val = Number(ppsf);
  if (!Number.isFinite(val) || val <= 0) return null;
  const breakpoints = [
    [0,     95],
    [300,   80],
    [500,   62],
    [700,   42],
    [900,   25],
    [1200,  10],
  ];
  for (let i = breakpoints.length - 1; i >= 0; i--) {
    if (val >= breakpoints[i][0]) return breakpoints[i][1];
  }
  return 95;
}

function scoreMlsCdom(cdom) {
  if (cdom === null || cdom === undefined || !Number.isFinite(Number(cdom))) return null;
  const val = Number(cdom);
  if (val <= 7) return 98;
  if (val <= 30) return 88;
  if (val <= 60) return 75;
  if (val <= 120) return 55;
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

globalThis.SidepanelAnalysis = Object.freeze({
  haversineDistanceMeters,
  scoreCrime,
  scoreLightRailDistance,
  formatDistanceMiles
});

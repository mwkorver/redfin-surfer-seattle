/* Shared side panel functions. Loaded before sidepanel.js. */

function simulateLocalDiligence(listing) {
  const isSeattle = (listing.address.city || "").toLowerCase() === "seattle" &&
    (listing.address.state || "").toUpperCase() === "WA";

  const permitPromise = isSeattle ? fetchSeattlePermits(listing) : Promise.resolve([]);
  const crimePromise = isSeattle ? fetchSeattleCrime(listing) : Promise.resolve([]);
  const lightRailPromise = findNearestLightRailStations(listing, 2);
  const riparianPromise = listing.parcel?.parcelId && listing.parcel?.boundary
    ? fetchRiparianStreams(listing.parcel.boundary)
    : Promise.resolve(null);

  return Promise.all([permitPromise, crimePromise, lightRailPromise, riparianPromise]).then(([permits, crimes, lightRail, riparianStreams]) => {
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
    if (riparianStreams !== null) {
      topics.push(createScoredTopic(
        "riparian",
        scoreRiparian(riparianStreams),
        formatRiparianStatus(riparianStreams)
      ));
    }

    return {
      aggregateScore: calculateAggregateScore(topics),
      summary: nearestStation
        ? `${crimes.length} recent crime incidents. Nearest Link stations: ${formatNearestStationSummary(nearestStations)}.`
        : `${crimes.length} recent crime incidents.`,
      topics,
      permitCount: permits.length,
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
    .map(station => `${station.name} ${formatDistanceMiles(station.distanceMiles)}`)
    .join(" · ");
}

function formatNearestStationSummary(stations) {
  return stations
    .map(station => `${station.name} (${formatDistanceMiles(station.distanceMiles)})`)
    .join(" and ");
}

function fetchRiparianStreams(boundaryGeoJson) {
  const arcgisPolygon = geojsonPolygonToArcGIS(boundaryGeoJson);
  if (!arcgisPolygon) return Promise.resolve(null);

  return queryFStreams(arcgisPolygon)
    .catch(error => {
      console.warn("[Diligence Sidecar] Riparian stream query failed:", error);
      return null;
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

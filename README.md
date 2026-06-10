# redfin-surfer.seattle


## Why this project exists

This project grew out of my search for a home in Seattle.

It's also the kind of project that I probably wouldn't have built a few years ago. The value is real, but the effort required to build and maintain it would have outweighed the benefit for a tool used primarily by one person.

Modern AI-assisted development tools change that equation. They make it practical to build small, highly specialized applications like this one that solve narrow personal problems.


<img width="375" height="237" alt="image" src="https://github.com/user-attachments/assets/a7265870-4096-4cae-9273-59efc02e8bbc" />



## Status

This is a personal research prototype, not a maintained open-source project. This repository is published for reference and transparency.

A Chrome extension that adds a due-diligence side panel to Redfin property listings, scoped to Seattle and King County, WA. Heart a listing on Redfin and the panel automatically scores it across five topics, pulling data from several public sources. Optionally it also includes a Lamba function that saves data in parquet on S3. That is part is a stub for future projects that involving Redfin email notification. But extension works without it.

The `.seattle` suffix is intentional — the tool is designed as a city-specific instance of a reusable pattern. A `redfin-surfer.la` or `redfin-surfer.nyc` would wire up different data sources for the same side panel framework.

## Geographic scope

**This extension is built specifically for the Seattle metro area in King County, Washington.**

| Feature | Coverage |
|---|---|
| Parcel lookup and boundary | King County, WA (unincorporated + cities) |
| Riparian stream buffers | King County, WA (CAO Layer 21) |
| Crime incidents | City of Seattle only |
| Building permits | City of Seattle only |
| Light rail distances | Sound Transit Link network (Greater Seattle) |
| Redfin scraping | Any Redfin listing page |

Properties outside King County will still scrape Redfin data and score what they can, but parcel enrichment, riparian analysis, crime, and permit data will not be available.

## What the panel discovers and displays

### From the Redfin listing page

| Field | Notes |
|---|---|
| Street address | JSON-LD schema, DOM fallback |
| City, state, ZIP | JSON-LD schema, DOM fallback |
| Listing price | JSON-LD offers, DOM fallback |
| Latitude / longitude | JSON-LD geo, meta tags, map link fallback |
| Living area (sq ft) | JSON-LD `floorSize`, DOM fallback |
| Lot size (sq ft) | JSON-LD `lotSize`, DOM fallback; acres converted automatically |
| MLS ID | JSON-LD, `.mls-num` selector, body text scan |
| Primary listing image | JSON-LD, `og:image` meta fallback |

### From King County Parcel Viewer

| Field | Notes |
|---|---|
| Parcel ID (PIN) | Matched by address via King County address search |
| Parcel match confidence | exact / probable / ambiguous / master-parcel / not-found |
| Assessor address | King County parcel data |
| Present use | King County parcel data |
| Property name | King County parcel data |
| Jurisdiction | King County parcel data |
| Appraised value | King County Assessor |
| Lot area (sq ft) | King County parcel data; flagged if differs >5% from Redfin value |
| Levy code | King County parcel data |
| Number of units | King County parcel data |
| Number of buildings | King County parcel data |
| Parcel boundary polygon | ArcGIS `KingCo_Parcels/MapServer/0` in WGS84 |
| Links | Parcel map, Assessor report, Zoning codes, Taxing districts |

### From King County Sensitive Areas (ArcGIS)

Streams classified as fish-bearing (Type F) under the King County Critical Areas Ordinance are queried within a 165-foot geodesic buffer of the parcel boundary — the most conservative standard buffer distance under KCC 21A.24.325.

| Field | Notes |
|---|---|
| F-type streams within 165 ft | Present / absent |
| Stream type | S / F / N / Unclassified |
| Fish habitat criteria | Biological / Physical / Presumed |
| Watercourse name(s) | Where named in the dataset |

### From Seattle Open Data — Seattle properties only

| Field | Notes |
|---|---|
| Building permit records | Count and current status, matched by street address |
| Crime incidents | Count within ~0.01° lat/lon block, last 12 months |

### From Sound Transit GTFS

| Field | Notes |
|---|---|
| Nearest 1–2 Link stations | Haversine distance calculation |
| Station name and lines | e.g., "Northgate · 1 Line" |
| Distance | Miles and meters |
| GTFS feed version | Shown as data source label |

### Scored topics (displayed with weighted aggregate)

| Topic | Default weight | Scoring logic |
|---|---|---|
| Crime | 40% | ≤5 incidents → 95 · ≤20 → 78 · ≤50 → 58 · 50+ → 35 |
| Light Rail | 20% | Distance breakpoints: 0 mi → 100, 0.5 mi → 90, 1 mi → 78, 2 mi → 58, 3 mi → 40, 5+ mi → 25 |
| Lot Area | 20% | Breakpoints: 0–2k sqft → 20, 4k → 65, 6k → 80, 9.6k → 90, 20k+ → 98 |
| Price/Sq.Ft. | 20% | Breakpoints: <$300 → 95, $500 → 62, $700 → 42, $900 → 25, $1200+ → 10 |
| Riparian | 20% | No F streams within 165 ft → 90 · F streams present → 30 |

Topic weights are adjustable in the side panel settings. The aggregate score is a weighted average of all available topics.

> **Note:** The scoring framework and topic structure are in place, but the breakpoint values and weights above are placeholder numbers — they have not been calibrated against real data or validated against outcomes. Treat scores as a rough relative ranking tool, not an authoritative assessment.

## Backend (optional)

The extension works fully offline — all analysis runs in the browser and the portfolio is stored in `chrome.storage.local`. A backend Lambda function is available to sync your portfolio across devices. See [backend/README.md](backend/README.md) for setup instructions.

Without backend credentials configured, the panel shows **"Analysis saved locally; configure backend credentials for automatic upload."** No network requests are made to the Lambda.

The longer-term purpose of the backend is to support a notification service: Redfin sends email alerts when hearted properties change state (price reductions, back on market, status changes, etc.). The plan is to parse those emails on the backend and cross-reference them against the synced portfolio to push targeted alerts for properties you have hearted, rather than every listing update Redfin sends.

## Known limitations

**Condos and multi-unit buildings** — The parcel lookup matches the master parcel PIN for the building, not an individual unit. Lot area, appraised value, and present use will reflect the whole parcel, not your specific unit. The panel flags this with a "master-parcel" confidence label.

**Crime data is approximate** — Seattle crime incidents are matched by truncating coordinates to two decimal places (~1 km² block), not a true radius search. Results may include incidents from adjacent blocks or miss incidents near the edge of the block.

**Riparian scoring is binary** — A stream 10 ft from the parcel and one 164 ft away both score the same. The score reflects presence or absence within the 165 ft buffer, not proximity.

**Light rail station data needs periodic refresh** — Stations are bundled from a Sound Transit GTFS snapshot. As new stations open, run the refresh script in `backend/` and reload the extension:

```bash
cd backend
python3 scripts/download_light_rail_stations.py
```

## Installation

Requires Chrome 114 or later (Manifest V3 side panel API).

1. Clone this repo
2. Open `chrome://extensions` and enable Developer Mode
3. Click **Load unpacked** and select the `extension/` folder
4. Open a Redfin property listing and click the extension icon to open the side panel
5. Heart a listing to trigger automatic analysis
6. If a parcel lookup fails or you want fresh data, use the **Re-run analysis** button on any property card

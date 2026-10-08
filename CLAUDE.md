# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Extension tests (Node built-in test runner)
```bash
npm test                          # run all extension tests
node --test extension/tests/*.test.js  # equivalent
```

### Backend tests (Python unittest)
```bash
cd backend && python3 -m unittest discover -s tests -v
cd backend && python3 -m unittest tests.test_app.TestClassName.test_method_name  # single test
cd backend && python3 -m unittest tests.test_light_rail_stations  # single module
```

### Backend build and deploy (AWS SAM)
```bash
cd backend && sam build
cd backend && sam deploy --guided   # first deploy; subsequent: sam deploy
```

### Refresh Sound Transit station data
```bash
cd backend && python3 scripts/download_light_rail_stations.py
# then upload canonical layer before deploying:
aws s3 cp data/light_rail_stations.geojson \
  s3://redfin-surfer-<your-account-id>-us-west-2-an/reference/light_rail_stations.geojson \
  --content-type application/geo+json
```

## Architecture

### Two-component system
- **Chrome Extension (MV3)** — runs in the browser, scrapes Redfin, performs local diligence, renders the side panel.
- **AWS Lambda backend** — a single Python 3.12 function exposed via a public Function URL, backed by DuckDB-generated Parquet in S3.

### Extension component roles

| File | Role |
|---|---|
| `content.js` + `shared/parser.js` | Injected into Redfin pages. Scrapes listing data (price, address, geo, MLS ID, Redfin home ID) and intercepts heart-button clicks. Sends `NEW_LISTING_DETECTED` to the background worker. |
| `background.js` | Service worker. Owns the `hearted_listings` portfolio in `chrome.storage.local`. Handles SPA navigation detection, backend delete operations (with retry + tombstone queue), and routes `TRIGGER_DILIGENCE_FOR_LISTING` to the side panel. |
| `sidepanel/` | Side panel UI loaded in this script order: `shared/scoring.js` → `sidepanel-model.js` → `sidepanel-api.js` → `sidepanel-analysis.js` → `sidepanel-storage.js` → `sidepanel-renderer.js` → `sidepanel.js`. Each file exposes plain functions to the shared global scope (no bundler). |

### Side panel script responsibilities
- `scoring.js` — topic definitions and weights (crime 60%, lightRail 40%).
- `sidepanel-model.js` — `normalizeReport`, `calculateAggregateScore`, listing key helpers.
- `sidepanel-api.js` — `syncProperty` / `sendProperty`; handles 428/409 ETag retries when syncing to backend.
- `sidepanel-analysis.js` — `simulateLocalDiligence`: fetches Seattle crime & permit data, finds nearest Sound Transit stations via haversine distance, scores and assembles the diligence report.
- `sidepanel-storage.js` — persists reports and sync state to `chrome.storage.local` via a serial write queue.
- `sidepanel-renderer.js` — DOM rendering of the ranked property list.
- `sidepanel.js` — top-level coordinator: loads state on open, wires event listeners, drives the diligence → save → sync pipeline.

### Listing key format
`redfin/<state>/<city>/.../<street>/home/<redfinHomeId>` — derived from the Redfin URL path. Used as the canonical portfolio key in both `chrome.storage.local` and the backend Parquet file.

### Backend (Lambda + DuckDB + S3)
`backend/property_api/app.py` is the single handler. Routes:
- `GET /properties` — list portfolio (excludes tombstoned rows), returns ETag.
- `GET /property?key=…` — single property.
- `POST /property` / `PUT /property` — upsert; requires an `If-Match` header after the first write (428 with `serverEtag` if missing). The header's value no longer guards the write; see Concurrency model.
- `DELETE /property?key=…` — writes a tombstone row; same ETag concurrency rules.
- `GET /stations` — full Sound Transit station GeoJSON.
- `GET /nearest-stations?latitude=…&longitude=…&limit=…` — proximity lookup via DuckDB spatial extension.

The Lambda caches the Parquet portfolio and the station GeoJSON in `/tmp`. The station layer is also bundled inside the Lambda artifact (`data/light_rail_stations.geojson`) as a fallback when S3 is unreachable.

### Concurrency model
The whole portfolio is one Parquet file, and every save or delete changes a single listing. The Lambda (`update_portfolio` in `app.py`) downloads the file, applies the change, and uploads with S3 `IfMatch` set to the ETag *it* just downloaded; if another writer got there first it starts over from the newer file, up to `MAX_WRITE_ATTEMPTS` times, and only then returns 409. The client's `If-Match` must be present but its value is not compared, so a stale client ETag is not a conflict. The extension still retries 428/409 a few times with backoff (never a 409 `deleted`). Background deletes that fail are queued in `pending_backend_deletes` and replayed when backend sync is re-enabled.

### External data sources (extension-side)
- Seattle crime incidents: `data.seattle.gov`
- Seattle building permits: `data.seattle.gov`
- King County parcel data: `gismaps.kingcounty.gov`
- Sound Transit stations: fetched from backend `/nearest-stations` or computed locally from bundled GeoJSON in `extension/data/`.

### Extension test harness
Tests in `extension/tests/` use Node's built-in `node:test` runner. Extension scripts are loaded into a `vm.createContext` sandbox to avoid needing a browser environment — no Jest, no Babel, no bundler.

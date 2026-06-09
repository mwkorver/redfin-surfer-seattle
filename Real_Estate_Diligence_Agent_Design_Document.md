# Open Source Real Estate Due-Diligence Agent
## Project Design Document: Geographically Scoped, Two-Stage Serverless AWS + Iceberg Architecture

### Problem Statement
Home buyers face a human memory problem rather than a search problem. Existing platforms help users discover listings but do not help them systematically evaluate, compare, and remember findings across dozens of candidate properties over time. 

Because real estate data structures, permit registries, and environmental hazards are highly fragmented across municipal boundaries, a national-scale agent faces prohibitive data-integration and LLM-token costs. However, since home buyers restrict their search to a single prescribed metropolitan area or county, a localized architectural approach can radically optimize data retrieval, cut token overhead, and deliver hyper-nuanced regional insights.

### Vision
Build an open-source, bring-your-own-AWS-account property diligence agent optimized for a prescribed target geography. The system acts as a persistent, context-aware sidecar that collects hyper-local evidence, tracks findings, remembers decisions, and ranks properties in real time as the user browses.

---

### User Stories
* As a buyer, I want a side-by-side dashboard that automatically reacts to the active Redfin listing page I am viewing in real time.
* As a buyer, I want a zero-compute passive triage layer that surfaces obvious preference conflicts (like high HOA fees) directly from the webpage metadata before hitting AWS.
* As a buyer, I want to click the "Heart" (Save) button on Redfin to automatically trigger a deep diligence workflow.
* As a buyer, I want localized permit, parcel, flood, zoning, and landslide/slope data automatically collected and cross-referenced.
* As a buyer, I want the system to instantly flash an alert if I navigate back to a property I previously rejected, reminding me why I crossed it off my list.
* As a buyer, I want a live-ranked leaderboard of my top candidate properties visible alongside my active browsing session.
* As a buyer, I want my dashboard to automatically update when a "hearted" property shifts to a pending or sold state in the real world.

---

### Architecture Components

```
                     ┌────── [ Redfin Browser Tab ] ───────┐
                     │       (Passive DOM Scrape)          │
                     │                 │                   │
                     ▼                 ▼ (If "Hearted")    ▼ (Status Alert)
            [ Local Cache ]   [ API Gateway / Lambda ]  [ Gmail Filter ]
            (Stage 1 Match)            │                   │
                                       ▼                   ▼
                            [ Step Functions ] ◄─── [ Amazon SES ]
                                       │             (Inbound to S3)
                                       ▼
                         [ Amazon Athena / Iceberg ]
```

#### 1. Real-Time Extension UI (The Sidecar)
* Uses Chrome’s `sidePanel` and `tabs` APIs to embed a persistent dashboard directly inside the browser window.
* Listens to URL shifts to capture basic property identifiers (Address, Price, MLS ID) from the active DOM.

#### 2. The Storage Layer (Serverless Apache Iceberg Lakehouse)
* Managed entirely via **AWS Glue Data Catalog** and **Amazon S3**.
* **Pre-Cached Local Base Layers:** Open-source local GIS layers (county parcels, zoning shapes, LIDAR slope maps) are pre-loaded into S3 as read-only **GeoParquet** reference tables during stack initialization.
* **Append-Only Ledger Tables:** `Properties`, `Evidence`, `Findings`, `Tasks`, `Decisions`, and `User Preferences` are modeled as Iceberg tables to leverage time-travel queries and snapshot isolation.

#### 3. Compute & Compute Orchestration (Local Adapters & Step Functions)
* **The Agent Harness:** Built using **AWS Step Functions** to maintain process state outside of the foundation model, keeping the LLM entirely stateless.
* **Local Ingestion Modules:** Targeted Lambda adapters built for the prescribed geography's specific public endpoints (e.g., local county GIS REST APIs, city permit portals).
* **Inbound Email Ingestion:** An **Amazon SES** inbound receipt rule configured on a custom subdomain to catch auto-forwarded update emails from Gmail and drop them directly into an S3 processing bucket.

#### 4. The Inference Layer (Amazon Bedrock)
* Uses `anthropic.claude-3-5-sonnet` strictly for structured translation, planning, and evaluation—never as an authoritative database.
* Instead of sending massive unformatted documents, a Lambda function pre-filters the data using spatial joins against the local GeoParquet base layers. The LLM evaluates the property against a highly condensed context paired with a static, localized zoning/risk rulebook.

---

### Two-Stage Data Workflows

#### Stage 1: Passive DOM Triage & Cache Lookup (Zero AWS Cost)
1. The user navigates to a listing page. The side panel captures the address and metadata.
2. The extension instantly queries its local browser cache:
   * **If a match is found:** The dashboard displays the stored triage score, local extracted facts, and past decisions.
   * **If a match is not found:** The extension matches the raw scraped DOM metadata (e.g., price, HOA dues, square footage) against the user's localized preference thresholds locally in the browser. It surfaces an instant, surface-level compatibility assessment while keeping the AWS compute layer completely idle.

#### Stage 2: Deep Diligence Trigger ("Hearting" a Property)
When a user "Hearts" (saves) a listing on Redfin, or explicitly clicks "Deep Dive" in the side panel, the heavy-lifting serverless infrastructure is kicked off asynchronously:

```
[ "Heart" Triggered ] ──► [ Spatial Join (Athena/DuckDB) ] ──► [ Local Base Layers ]
                                                                      │
                                                                      ▼
[ Deep Diligence ] ◄─── [ Bedrock Assessment ] ◄─────────── [ Consolidate Facts ]
```

* **Spatial Triage:** An in-memory **DuckDB** instance inside an AWS Lambda function matches the property's coordinates against the pre-cached GeoParquet environmental and hazard layers to identify immediate red flags (e.g., flood zones, landslide hazards) within seconds.
* **Deep Local Diligence:** Step Functions fan out parallel async Lambda queries to pull historical building permits and analyze comparable neighborhood sales.
* **Consolidation & Synthesis:** The collected evidence is consolidated and sent to Bedrock along with the local municipal rulebook. The resulting structured JSON risk profile is written to the Iceberg lakehouse, and the UI dynamically updates.

#### Stage 3: Real-Time Market Status Tracking (Email Loop)
1. Redfin fires an automated email alert when a user's saved property shifts status (*Pending, Sold, Price Dropped*).
2. A automated **Gmail Filter** detects the alert and auto-forwards it to the dedicated **Amazon SES** inbound address.
3. SES drops the raw payload into S3, triggering an ingestion Lambda that parses the text, matches the property ID against the Iceberg `Properties` table, and appends the state change to the `Decisions` ledger.
4. The Chrome Side Panel reads the updated Iceberg snapshot on its next render loop, instantly flashing the new real-world status on the leaderboard.

---

### Competitive & Architectural Positioning
The system does not compete with Redfin's discovery experience; it provides a dedicated diligence layer alongside it.

By bounding the application to a prescribed geography and enforcing a strict two-stage trigger pattern, the system scales at near-zero idle cost. Relying on fixed regional rulebooks means an exceptionally small, low-cost model can perform the evaluation work of a far more expensive, general-purpose LLM. The entire infrastructure footprint is defined via an **AWS CDK (Cloud Development Kit)** stack, allowing any lone developer or home buyer to establish a localized enterprise-grade research engine for pennies a month on their own personal AWS account.

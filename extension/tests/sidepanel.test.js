const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");

function createContext(overrides = {}) {
  const context = vm.createContext({
    console,
    Date,
    Intl,
    Math,
    Number,
    Object,
    Promise,
    Set,
    URL,
    URLSearchParams,
    ...overrides
  });
  return context;
}

function loadScript(context, relativePath) {
  const filename = path.join(extensionRoot, relativePath);
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
}

function loadModel(context) {
  loadScript(context, "shared/scoring.js");
  loadScript(context, "sidepanel/sidepanel-model.js");
}

test("weighted analysis score uses configured topic weights", () => {
  const context = createContext();
  loadModel(context);

  const score = context.SidepanelModel.calculateAggregateScore([
    { score: 80, weight: 0.35 },
    { score: 60, weight: 0.40 },
    { score: 100, weight: 0.25 }
  ]);

  assert.equal(score, 77);
});

test("sync reconciliation selects missing and newer analyses", () => {
  const context = createContext();
  loadModel(context);
  const isOutOfSync = context.SidepanelModel.isAnalysisOutOfSync;

  assert.equal(isOutOfSync({}), false);
  assert.equal(isOutOfSync({ report: {}, syncState: "pending" }), true);
  assert.equal(isOutOfSync({
    report: {},
    analysisUpdatedAt: "2026-06-10T12:00:00Z",
    syncedAnalysisUpdatedAt: "2026-06-10T11:00:00Z"
  }), true);
  assert.equal(isOutOfSync({
    report: {},
    analysisUpdatedAt: "2026-06-10T11:00:00Z",
    syncedAnalysisUpdatedAt: "2026-06-10T12:00:00Z"
  }), false);
});

test("light rail distance scoring uses a smooth curve and excludes missing data", () => {
  const context = createContext();
  loadModel(context);
  loadScript(context, "sidepanel/sidepanel-analysis.js");

  const meters = context.SidepanelAnalysis.haversineDistanceMeters(
    47.676091,
    -122.3095326,
    47.676595,
    -122.315976
  );

  assert.ok(meters > 450 && meters < 550); // ~0.31 mi

  // Smooth curve: no step jumps at breakpoints
  const score = context.SidepanelAnalysis.scoreLightRailDistance(meters);
  assert.ok(score >= 93 && score <= 95, `expected ~94, got ${score}`);

  // Breakpoint anchors
  assert.equal(context.SidepanelAnalysis.scoreLightRailDistance(0), 100);
  assert.equal(context.SidepanelAnalysis.scoreLightRailDistance(1609.344), 78);  // 1.0 mi
  assert.equal(context.SidepanelAnalysis.scoreLightRailDistance(3218.688), 58); // 2.0 mi
  assert.equal(context.SidepanelAnalysis.scoreLightRailDistance(8046.72), 25);  // 5.0 mi

  // Missing geo data returns null (excluded from aggregate)
  assert.equal(context.SidepanelAnalysis.scoreLightRailDistance(null), null);
  assert.equal(context.SidepanelAnalysis.scoreLightRailDistance(undefined), null);
});

test("topics with null scores are excluded from the aggregate", () => {
  const context = createContext();
  loadModel(context);

  const score = context.SidepanelModel.calculateAggregateScore([
    { score: 60, weight: 0.60 },
    { score: null, weight: 0.40 }
  ]);

  assert.equal(score, 60);
});

test("station renderer displays two names, lines, miles, meters, and feed version", () => {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.className = "";
      this.textContent = "";
    }

    append(...children) {
      this.children.push(...children);
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }
  }

  const context = createContext({
    document: {
      createElement(tagName) {
        return new Element(tagName);
      }
    }
  });
  loadScript(context, "sidepanel/sidepanel-renderer.js");

  const section = context.SidepanelRenderer.createLightRailDetails([
    {
      name: "Roosevelt",
      lines: ["1 Line", "2 Line"],
      distanceMiles: 0.30,
      distanceMeters: 486
    },
    {
      name: "U District",
      lines: ["1 Line", "2 Line"],
      distanceMiles: 1.11,
      distanceMeters: 1789
    }
  ], {
    feedVersion: "SC-Spring-2026.9"
  });
  const text = flattenText(section);

  assert.match(text, /Roosevelt/);
  assert.match(text, /U District/);
  assert.match(text, /0\.30 mi \(486 m\)/);
  assert.match(text, /1\.11 mi \(1,789 m\)/);
  assert.match(text, /SC-Spring-2026\.9/);
});

test("saving a report persists completed analysis as pending backend sync", async () => {
  const listingKey = "redfin/WA/Seattle/Test/home/123";
  const storage = {
    hearted_listings: {
      [listingKey]: {
        listingKey,
        address: { streetAddress: "123 Test St" }
      }
    },
    diligence_history: {}
  };
  const chrome = {
    storage: {
      local: {
        get(_keys, callback) {
          callback(structuredClone(storage));
        },
        set(updates, callback) {
          Object.assign(storage, structuredClone(updates));
          callback?.();
        }
      }
    }
  };
  const context = createContext({ chrome, structuredClone });
  loadModel(context);
  vm.runInContext(
    "let portfolio = {}; let storageWriteQueue = Promise.resolve();",
    context
  );
  loadScript(context, "sidepanel/sidepanel-storage.js");

  const saved = await vm.runInContext(
    `saveReport(${JSON.stringify(listingKey)}, {
      topics: [{ key: "permits", score: 80, weight: 1, status: "ok" }],
      summary: "done"
    })`,
    context
  );

  assert.equal(saved.analysisState, "complete");
  assert.equal(saved.syncState, "pending");
  assert.equal(storage.hearted_listings[listingKey].report.summary, "done");
  assert.ok(storage.hearted_listings[listingKey].analysisUpdatedAt);
});

test("side panel scripts load in browser order without missing globals", () => {
  const element = {
    addEventListener() {},
    classList: { toggle() {} },
    value: "",
    checked: false,
    textContent: ""
  };
  const context = createContext({
    document: {
      addEventListener() {},
      getElementById() {
        return element;
      }
    },
    chrome: {
      runtime: {
        getURL(value) {
          return value;
        },
        onMessage: { addListener() {} },
        sendMessage() {
          return Promise.resolve();
        }
      },
      storage: {
        local: {
          get() {},
          set() {},
          remove() {}
        },
        onChanged: { addListener() {} }
      },
      tabs: { create() {} }
    },
    clearTimeout,
    fetch() {
      throw new Error("fetch should not run while scripts load");
    },
    requestAnimationFrame() {},
    setTimeout
  });

  [
    "shared/scoring.js",
    "sidepanel/sidepanel-model.js",
    "sidepanel/sidepanel-api.js",
    "sidepanel/sidepanel-analysis.js",
    "sidepanel/sidepanel-storage.js",
    "sidepanel/sidepanel-renderer.js",
    "sidepanel/sidepanel.js"
  ].forEach(filename => loadScript(context, filename));

  assert.equal(typeof context.SidepanelModel.normalizeReport, "function");
  assert.equal(typeof context.SidepanelAnalysis.haversineDistanceMeters, "function");
  assert.equal(typeof context.SidepanelRenderer.createLightRailDetails, "function");
});

function flattenText(element) {
  return [element.textContent, ...element.children.map(flattenText)]
    .filter(Boolean)
    .join(" ");
}

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

test("PropertyParser.extractCdom handles script parsing, specific selector, and dialog ul list item pair", () => {
  const mockDocument = {
    querySelectorAll(selector) {
      if (selector === "script") {
        return [
          { textContent: '{"homeId": 42, "cumulativeDaysOnMarket": 42}' }
        ];
      }
      return [];
    },
    querySelector(selector) {
      return null;
    },
    body: {
      get innerText() {
        return "";
      }
    }
  };

  const context = createContext({
    document: mockDocument,
    console,
    window: {
      location: {
        href: "https://www.redfin.com/WA/Seattle/300-NW-47th-St-98107/home/42"
      }
    }
  });

  loadScript(context, "shared/parser.js");

  // 1. Script parsing (should take priority)
  const cdomFromScript = vm.runInContext("PropertyParser.extractCdom()", context);
  assert.equal(cdomFromScript, 42);

  // 2. Specific selector (with script returning null)
  mockDocument.querySelectorAll = (selector) => {
    if (selector === "script") return [];
    return [];
  };
  mockDocument.querySelector = (selector) => {
    if (selector === "#bp-dialog-content") {
      return null;
    }
    if (selector === "#bp-dialog-content > div.DialogContent__body > div > div:nth-child(16) > ul:nth-child(1) > li:nth-child(2)") {
      return { textContent: "45 days" };
    }
    return null;
  };
  const cdomFromSpecific = vm.runInContext("PropertyParser.extractCdom()", context);
  assert.equal(cdomFromSpecific, 45);

  // 3. Dialog list traversal (with script and specific selector returning null)
  mockDocument.querySelector = (selector) => {
    if (selector === "#bp-dialog-content") {
      return {
        querySelectorAll(sel) {
          if (sel === "li") {
            return [
              { textContent: "Cumulative Days on Market" },
              { textContent: "48 days" }
            ];
          }
          return [];
        }
      };
    }
    return null;
  };
  mockDocument.querySelectorAll = (selector) => {
    return [];
  };
  const cdomFromDialogList = vm.runInContext("PropertyParser.extractCdom()", context);
  assert.equal(cdomFromDialogList, 48);

  // 4. Priority check (cumulativeDaysOnMarket should be chosen over daysOnMarket fallback)
  mockDocument.querySelectorAll = (selector) => {
    if (selector === "script") {
      return [
        { textContent: '{"homeId": 42, "daysOnMarket": 88, "cumulativeDaysOnMarket": 37}' }
      ];
    }
    return [];
  };
  mockDocument.querySelector = (selector) => null;
  const cdomPriority = vm.runInContext("PropertyParser.extractCdom()", context);
  assert.equal(cdomPriority, 37);

  // 5. Sub-day unit check (should return 0 instead of matching hours/minutes as days)
  mockDocument.querySelectorAll = (selector) => [];
  mockDocument.querySelector = (selector) => null;
  mockDocument.body = {
    get innerText() {
      return "Time on Redfin: 18 hours";
    }
  };
  const cdomSubDayHours = vm.runInContext("PropertyParser.extractCdom()", context);
  assert.equal(cdomSubDayHours, 0);

  mockDocument.body = {
    get innerText() {
      return "18 hours on Redfin";
    }
  };
  const cdomSubDayHoursPre = vm.runInContext("PropertyParser.extractCdom()", context);
  assert.equal(cdomSubDayHoursPre, 0);

  mockDocument.body = {
    get innerText() {
      return "Time on Redfin: 5 days";
    }
  };
  const cdomDaysMatch = vm.runInContext("PropertyParser.extractCdom()", context);
  assert.equal(cdomDaysMatch, 5);
});

function flattenText(element) {
  return [element.textContent, ...element.children.map(flattenText)]
    .filter(Boolean)
    .join(" ");
}

test("validateConnection handles null/empty/invalid settings gracefully without throwing", () => {
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
      throw new Error("fetch should not be called with null/empty/invalid settings");
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

  assert.equal(typeof context.validateConnection, "function");

  assert.doesNotThrow(() => {
    context.validateConnection(1);
  });
});

test("planned stations format status and summary correctly", () => {
  const context = createContext();
  loadScript(context, "sidepanel/sidepanel-analysis.js");

  const stations = [
    { name: "Delridge", distanceMiles: 0.5, status: "planned" },
    { name: "Beacon Hill", distanceMiles: 1.2, status: "existing" }
  ];

  const statusText = context.formatNearestStationStatus(stations);
  const summaryText = context.formatNearestStationSummary(stations);

  assert.equal(statusText, "Delridge (Planned) 0.50 mi · Beacon Hill 1.20 mi");
  assert.equal(summaryText, "Delridge (Planned) (0.50 mi) and Beacon Hill (1.20 mi)");
});



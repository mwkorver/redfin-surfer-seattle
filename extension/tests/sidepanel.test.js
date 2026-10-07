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

test("getPermitStatusClass maps permit status correctly", () => {
  const context = createContext();
  loadScript(context, "sidepanel/sidepanel-renderer.js");

  assert.equal(context.getPermitStatusClass("Completed"), "completed");
  assert.equal(context.getPermitStatusClass("reviews completed"), "completed");
  assert.equal(context.getPermitStatusClass("Closed"), "completed");
  
  assert.equal(context.getPermitStatusClass("Permit Issued"), "active");
  assert.equal(context.getPermitStatusClass("in review"), "active");
  
  assert.equal(context.getPermitStatusClass("Canceled"), "cancelled");
  assert.equal(context.getPermitStatusClass("EXPIRED"), "cancelled");
  
  assert.equal(context.getPermitStatusClass("something-else"), "other");
  assert.equal(context.getPermitStatusClass(null), "other");
});

test("permit records normalize across SDCI datasets with differing schemas", () => {
  const context = createContext();
  loadScript(context, "sidepanel/sidepanel-analysis.js");

  // Socrata URL columns come back as a plain string in some datasets and a
  // { url } object in others; both must normalize to a string.
  assert.equal(context.normalizeSocrataLink("https://example.com/a"), "https://example.com/a");
  assert.equal(context.normalizeSocrataLink({ url: "https://example.com/b" }), "https://example.com/b");
  assert.equal(context.normalizeSocrataLink(null), "");

  // Config shapes mirror SEATTLE_PERMIT_SOURCES (a const, so not reachable on
  // the vm global). These guard normalizePermitRecord's field-mapping logic.
  const electricalCfg = { source: "Electrical", numField: "permitnum", typeFields: ["permittypemapped", "permitclass"], dateFields: ["issueddate", "applieddate", "completeddate"] };
  const complaintCfg = { source: "Complaint", numField: "recordnum", typeFields: ["recordtypedesc", "recordtype"], dateFields: ["opendate"] };

  // Electrical permit: standard permitnum schema, link as a plain string.
  const electrical = context.normalizePermitRecord({
    permitnum: "6959721-EL",
    permittypemapped: "Electrical",
    statuscurrent: "Expired",
    description: "6.00kWDC Rooftop Photovoltaic Solar Installation",
    link: "https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=6959721-EL",
    issueddate: "2023-04-18"
  }, electricalCfg);
  assert.equal(electrical.permitnum, "6959721-EL");
  assert.equal(electrical.permittypedesc, "Electrical");
  assert.equal(electrical.source, "Electrical");
  assert.equal(electrical.date, "2023-04-18");
  assert.equal(electrical.link, "https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=6959721-EL");

  // Code complaint: different field names (recordnum / recordtypedesc / opendate)
  // and link as a { url } object.
  const complaint = context.normalizePermitRecord({
    recordnum: "009496-25CP",
    recordtype: "Complaint",
    recordtypedesc: "Construction",
    statuscurrent: "Under Investigation",
    description: "Grading violation - no permit",
    link: { url: "https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=009496-25CP" },
    opendate: "2025-07-25T00:00:00.000"
  }, complaintCfg);
  assert.equal(complaint.permitnum, "009496-25CP");
  assert.equal(complaint.permittypedesc, "Construction");
  assert.equal(complaint.source, "Complaint");
  assert.equal(complaint.date, "2025-07-25T00:00:00.000");
  assert.equal(complaint.link, "https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=009496-25CP");
});

test("createAnalysisDetails renders tab buttons", () => {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.className = "";
      this.textContent = "";
      this.hidden = false;
      this.dataset = {};
    }

    append(...children) {
      this.children.push(...children);
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    addEventListener(event, callback) {}
  }

  const context = createContext({
    document: {
      createElement(tagName) {
        return new Element(tagName);
      }
    },
    expandedListings: new Set(["test-listing-key"]),
    formatSyncStatus(listing) {
      return "synced";
    },
    renderPortfolio() {}
  });

  loadScript(context, "shared/scoring.js");
  loadScript(context, "sidepanel/sidepanel-model.js");
  loadScript(context, "sidepanel/sidepanel-renderer.js");

  const listing = {
    listingKey: "test-listing-key",
    report: {
      topics: [],
      riparianStreams: [],
      riparianStatus: "No F-type streams"
    }
  };

  const details = context.createAnalysisDetails(listing);
  assert.equal(details.className, "analysis-details");
  assert.equal(details.hidden, false);

  const tabsHeader = details.children.find(c => c.className === "details-tabs");
  assert.ok(tabsHeader);
  assert.equal(tabsHeader.children.length, 4);
  assert.equal(tabsHeader.children[0].textContent, "Scorecard");
  assert.equal(tabsHeader.children[1].textContent, "Parcel & Zoning");
  assert.equal(tabsHeader.children[2].textContent, "Transit & Crime");
  assert.equal(tabsHeader.children[3].textContent, "Permits Log");
});




function fakeHeartButton(attributes = {}, classes = []) {
  const classSet = new Set(classes);
  return {
    innerText: attributes.innerText || "",
    className: attributes.className || "",
    classList: { contains: name => classSet.has(name) },
    clicked: 0,
    click() { this.clicked += 1; },
    getAttribute(name) {
      return attributes[name] === undefined ? null : attributes[name];
    }
  };
}

function loadParserWithButtons(buttons) {
  const context = createContext({
    document: { querySelectorAll: () => buttons }
  });
  loadScript(context, "shared/parser.js");
  // parser.js declares PropertyParser with const, so it is a lexical binding on the
  // script scope rather than a property of the sandbox global.
  return vm.runInContext("PropertyParser", context);
}

test("findPageHeartButton returns the save control backing each heart state", () => {
  const unrelated = fakeHeartButton({ "aria-label": "Share" });

  const savedButton = fakeHeartButton({ "aria-label": "Remove from favorites" });
  const saved = loadParserWithButtons([unrelated, savedButton]);
  assert.equal(saved.findPageHeartButton(), savedButton);
  assert.equal(saved.getPageHeartState(), "saved");

  const unsavedButton = fakeHeartButton({ "aria-label": "Save this home" });
  const unsaved = loadParserWithButtons([unrelated, unsavedButton]);
  assert.equal(unsaved.findPageHeartButton(), unsavedButton);
  assert.equal(unsaved.getPageHeartState(), "unsaved");

  const none = loadParserWithButtons([unrelated]);
  assert.equal(none.findPageHeartButton(), null);
  assert.equal(none.getPageHeartState(), "unknown");
});

test("delete button renders only for the listing open in the active tab", () => {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.className = "";
      this.textContent = "";
      this.attributes = {};
      this.dataset = {};
      this.style = {};
    }

    append(...children) {
      this.children.push(...children);
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    setAttribute(name, value) {
      this.attributes[name] = value;
    }

    addEventListener() {}
  }

  function flatten(node, collected = []) {
    collected.push(node);
    node.children.forEach(child => flatten(child, collected));
    return collected;
  }

  const listing = {
    listingKey: "redfin/WA/Seattle/2544-NE-90th-St-98115/home/318529",
    address: { streetAddress: "2544 NE 90th St", city: "Seattle", state: "WA", zip: "98115" },
    price: 900000
  };

  function renderWithCurrent(currentListingKey) {
    const context = createContext({
      document: { createElement: tagName => new Element(tagName) },
      encodeURIComponent,
      currentListingKey,
      deletingListings: new Set(),
      deleteErrors: new Map(),
      expandedListings: new Set(),
      runningListings: new Set()
    });
    loadScript(context, "shared/scoring.js");
    loadScript(context, "sidepanel/sidepanel-model.js");
    loadScript(context, "sidepanel/sidepanel-renderer.js");
    const card = vm.runInContext("createPropertyCard", context)(listing, 0);
    return {
      card,
      deleteButtons: flatten(card).filter(node => node.className === "delete-button")
    };
  }

  const open = renderWithCurrent(listing.listingKey);
  assert.equal(open.deleteButtons.length, 1);
  assert.match(open.card.className, /\bcurrent\b/, "the open listing is highlighted");
  assert.equal(open.card.children[0].attributes["aria-current"], "true");

  const elsewhere = renderWithCurrent("redfin/WA/Seattle/somewhere-else/home/999");
  assert.equal(elsewhere.deleteButtons.length, 0);
  assert.doesNotMatch(elsewhere.card.className, /\bcurrent\b/);
  assert.equal(renderWithCurrent("").deleteButtons.length, 0);
});

function loadContentScript(heartButton, dialogState = {}, options = {}) {
  const messages = [];
  const fetches = [];
  let clickListener = null;

  const listingPath = "/WA/Seattle/2544-NE-90th-St-98115/home/318529";
  const location = { pathname: "/city/WA/Seattle", href: "https://www.redfin.com/city/WA/Seattle" };

  const document = {
    createElement: () => ({ textContent: "", appendChild() {}, setAttribute() {} }),
    documentElement: { appendChild() {} },
    body: {},
    addEventListener(type, callback) {
      if (type === "click") clickListener = callback;
    },
    querySelectorAll: selector => (selector === "button" ? [heartButton] : []),
    querySelector: selector => (selector === '[role="dialog"]' ? dialogState.dialog || null : null)
  };

  const window = { location, document };
  window.top = window;

  let messageListener = null;
  const context = createContext({
    console,
    document,
    window,
    setTimeout: callback => {
      callback();
      return 0;
    },
    clearTimeout() {},
    setInterval: () => 0,
    MutationObserver: class {
      observe() {}
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            messageListener = callback;
          }
        },
        sendMessage(message) {
          messages.push(message);
          return Promise.resolve();
        }
      },
      storage: {
        local: {
          set: () => Promise.resolve(),
          get: () => Promise.resolve({ hearted_listings: options.hearted || {} })
        }
      }
    },
    fetch: (url, init) => {
      fetches.push({ url, init });
      return Promise.resolve(options.serverResponse || { ok: true, text: () => Promise.resolve("<html></html>") });
    },
    DOMParser: class {
      parseFromString() {
        return { querySelectorAll: selector => (selector === "button" ? (options.serverButtons || []) : []) };
      }
    }
  });

  loadScript(context, "shared/parser.js");
  loadScript(context, "content.js");

  // The page is only treated as a listing detail view after load, so the initial
  // extraction pass does not need a full listing DOM.
  location.pathname = listingPath;
  location.href = `https://www.redfin.com${listingPath}`;
  messages.length = 0;

  return {
    messages,
    fetches,
    removeIfNoLongerHearted: () => vm.runInContext("removeListingIfNoLongerHearted", context)(),
    getClickListener: () => clickListener,
    unheart(listingKey) {
      return new Promise(resolve => {
        messageListener({ action: "UNHEART_LISTING", listingKey }, {}, resolve);
      });
    }
  };
}

test("un-heart leaves the listing in place when Redfin does not clear the heart", async () => {
  const stuckButton = fakeHeartButton({ "aria-label": "Remove from favorites" });
  const page = loadContentScript(stuckButton);

  const result = await page.unheart("redfin/WA/Seattle/2544-NE-90th-St-98115/home/318529");

  assert.equal(result.success, false);
  assert.equal(result.reason, "not_unhearted");
  assert.equal(stuckButton.clicked, 1);
  assert.deepEqual(page.messages.filter(m => m.action === "REMOVE_HEARTED_LISTING"), []);
});

test("un-heart completes through Redfin's remove-from-favorites dialog", async () => {
  const attributes = { "aria-label": "Remove from favorites" };
  const dialogState = {};

  const removeButton = {
    innerText: "Remove from Favorites",
    className: "",
    classList: { contains: () => false },
    clicked: 0,
    getAttribute: () => null,
    click() {
      this.clicked += 1;
      attributes["aria-label"] = "Save this home";
      dialogState.dialog = null;
    }
  };

  const heartButton = {
    innerText: "",
    className: "",
    classList: { contains: () => false },
    clicked: 0,
    getAttribute: name => (attributes[name] === undefined ? null : attributes[name]),
    click() {
      this.clicked += 1;
      // Redfin answers a click on a saved heart with a confirm dialog.
      dialogState.dialog = { querySelectorAll: () => [removeButton] };
    }
  };

  const page = loadContentScript(heartButton, dialogState);
  const listingKey = "redfin/WA/Seattle/2544-NE-90th-St-98115/home/318529";
  const result = await page.unheart(listingKey);

  assert.equal(result.success, true);
  assert.equal(heartButton.clicked, 1);
  assert.equal(removeButton.clicked, 1);

  const removals = page.messages.filter(m => m.action === "REMOVE_HEARTED_LISTING");
  assert.equal(removals.length, 1);
  assert.equal(removals[0].listingKey, listingKey);
});

test("un-heart refuses to touch a heart belonging to a different listing", async () => {
  const savedButton = fakeHeartButton({ "aria-label": "Remove from favorites" });
  const page = loadContentScript(savedButton);

  const result = await page.unheart("redfin/WA/Seattle/some-other-house/home/999999");

  assert.equal(result.success, false);
  assert.equal(result.reason, "wrong_page");
  assert.equal(savedButton.clicked, 0);
  assert.deepEqual(page.messages.filter(m => m.action === "REMOVE_HEARTED_LISTING"), []);
});

test("un-heart removes the listing once cleared, without re-entering the click pipeline", async () => {
  const attributes = { "aria-label": "Remove from favorites" };
  const classSet = new Set();
  const togglingButton = {
    innerText: "",
    className: "",
    classList: { contains: name => classSet.has(name) },
    clicked: 0,
    getAttribute: name => (attributes[name] === undefined ? null : attributes[name]),
    click() {
      this.clicked += 1;
      attributes["aria-label"] = "Save this home";
      // Mirror the real DOM: our synthetic click reaches the capturing listener.
      page.getClickListener()({ target: this, composedPath: () => [] });
    }
  };

  const page = loadContentScript(togglingButton);
  const listingKey = "redfin/WA/Seattle/2544-NE-90th-St-98115/home/318529";
  const result = await page.unheart(listingKey);

  assert.equal(result.success, true);

  const removals = page.messages.filter(m => m.action === "REMOVE_HEARTED_LISTING");
  assert.equal(removals.length, 1);
  assert.equal(removals[0].listingKey, listingKey);

  // The capturing listener must ignore the click the panel just dispatched.
  assert.deepEqual(page.messages.filter(m => m.action === "HEART_CLICKED"), []);
});

test("oil tank helpers parse sizes, classify address matches, and pick a headline record", () => {
  const context = createContext();
  loadScript(context, "sidepanel/sidepanel-analysis.js");

  // The dataset writes tank sizes as free text.
  assert.equal(context.parseTankSizeGallons("300 GALLON"), 300);
  assert.equal(context.parseTankSizeGallons("300 GALS"), 300);
  assert.equal(context.parseTankSizeGallons("265 GALLON"), 265);
  assert.equal(context.parseTankSizeGallons(""), null);
  assert.equal(context.parseTankSizeGallons(undefined), null);

  // Redfin sends mixed case with full words; the dataset is uppercase and
  // abbreviated, and sometimes drops the street suffix entirely.
  assert.equal(context.classifyOilTankMatch("8105 Greenwood Ave N", "8105 GREENWOOD AVE N"), "exact");
  assert.equal(context.classifyOilTankMatch("8105 Greenwood Avenue North", "8105 GREENWOOD AVE N"), "exact");
  assert.equal(context.classifyOilTankMatch("1938 NW 97th St", "1938 NW 97TH ST"), "exact");
  assert.equal(context.classifyOilTankMatch("1938 NW 97th St", "1938 NW 97"), "street");

  // The address split feeding both the permit and oil tank queries.
  // Objects cross the vm realm boundary, so compare fields rather than prototypes.
  const greenwood = context.parseStreetAddressParts("8105 Greenwood Ave N");
  assert.equal(greenwood.streetNumber, "8105");
  assert.equal(greenwood.streetName, "GREENWOOD");
  const ninetySeventh = context.parseStreetAddressParts("1938 NW 97th St");
  assert.equal(ninetySeventh.streetNumber, "1938");
  assert.equal(ninetySeventh.streetName, "97TH");
  assert.equal(context.parseStreetAddressParts("Greenwood"), null);

  const listing = { address: { streetAddress: "8105 Greenwood Ave N" } };
  const older = {
    address: "8105 GREENWOOD AVE N", permit_number: "3-31220",
    date_issued: "2000-03-06T00:00:00.000", date_decommissioned: "2000-03-01T00:00:00.000",
    tank_size: "300 GALS", type_decommissioned: "Abandonment in Place"
  };
  const newer = {
    address: "8105 GREENWOOD AVE N", permit_number: "3-121622",
    date_issued: "2020-10-16T00:00:00.000", date_decommissioned: "2020-10-15T00:00:00.000",
    tank_size: "265 GALLON", type_decommissioned: "Removal", company: "3 KINGS ENVIRONMENTAL INC"
  };

  const finding = context.buildOilTankFinding([older, newer], listing);
  assert.equal(finding.status, "decommissioned");
  assert.equal(finding.recordCount, 2);
  assert.equal(finding.permitNumber, "3-121622");
  assert.equal(finding.year, 2020);
  assert.equal(finding.tankSizeGallons, 265);
  assert.equal(finding.matchQuality, "exact");
  assert.equal(finding.dateIssued, "2020-10-16");

  // An exact match outranks a more recent street-only match.
  const elsewhere = { ...newer, address: "8105 GREENWOOD", date_decommissioned: "2024-01-01T00:00:00.000" };
  assert.equal(context.buildOilTankFinding([elsewhere, older], listing).permitNumber, "3-31220");

  assert.equal(context.buildOilTankFinding([], listing).status, "no-record");
  assert.equal(context.buildOilTankFinding(null, listing).status, "unavailable");
});

test("oil tank section renders the permit record with its caveat, and says what no record means", () => {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.className = "";
      this.textContent = "";
    }

    appendChild(child) {
      this.children.push(child);
      return child;
    }
  }

  function allText(node) {
    return [node.textContent, ...node.children.map(allText)].join(" ");
  }

  const context = createContext({
    document: { createElement: tagName => new Element(tagName) }
  });
  loadScript(context, "sidepanel/sidepanel-renderer.js");
  const createOilTankSection = vm.runInContext("createOilTankSection", context);
  const createOilTankBanner = vm.runInContext("createOilTankBanner", context);

  const decommissioned = {
    status: "decommissioned", matchQuality: "exact", recordCount: 1,
    permitNumber: "3-31220", dateIssued: "2000-03-06", year: 2000,
    tankSizeGallons: 300, typeDecommissioned: "",
    datasetUrl: "https://data.seattle.gov/d/xvj2-ai6y"
  };
  const text = allText(createOilTankSection(decommissioned));
  assert.match(text, /The buried oil tank is already decommissioned/);
  assert.match(text, /decommissioned 2000 · 300 gal/);
  assert.match(text, /A permit record, not an inspection of the ground today\./);
  assert.match(text, /exact address match/);
  assert.match(text, /permit \(3-31220\) for this address, issued 2000-03-06\./);
  assert.match(createOilTankBanner(decommissioned).textContent, /decommissioned 2000 · 300 gal · exact address match/);

  const streetOnly = { ...decommissioned, matchQuality: "street" };
  assert.match(allText(createOilTankSection(streetOnly)), /at this street number was decommissioned/);
  assert.match(allText(createOilTankSection(streetOnly)), /confirm the address/);

  const noRecord = { status: "no-record", matchQuality: null, recordCount: 0, datasetUrl: "https://data.seattle.gov/d/xvj2-ai6y" };
  assert.match(allText(createOilTankSection(noRecord)), /does not mean there is no tank/);
  assert.equal(createOilTankBanner(noRecord).textContent, "No oil tank decommissioning permit on file");

  assert.match(createOilTankBanner(undefined).textContent, /unavailable/);
});

test("address predicates anchor the number and match the street as a whole word", async () => {
  const context = createContext();
  loadScript(context, "sidepanel/sidepanel-analysis.js");

  // A bare like '%4747%4TH%' also matches 4747 34TH AVE NE. The predicate pins
  // the number to the start of the field and the street name to word
  // boundaries, in every ordinal spelling the City uses.
  const parts = context.parseStreetAddressParts("4747 4th Ave NE");
  const numbered = context.buildStreetAddressWhere("originaladdress1", parts);
  assert.match(numbered, /^starts_with\(upper\(originaladdress1\), '4747'\) AND \(/);
  assert.match(numbered, /like '% 4TH %'/);
  assert.match(numbered, /like '% 4 %'/);
  assert.doesNotMatch(numbered, /%4747%/);

  // Named streets have no ordinal, so only one name clause.
  const named = context.buildStreetAddressWhere("address", context.parseStreetAddressParts("8105 Greenwood Ave N"));
  assert.equal((named.match(/ like /g) || []).length, 1);
  assert.match(named, /like '% GREENWOOD %'/);

  // The precise client-side check behind the coarse predicate.
  assert.equal(context.matchesStreetAddress("4747 4TH AVE NE", parts), true);
  assert.equal(context.matchesStreetAddress("4747 34TH AVE NE", parts), false, "substring of the street name");
  assert.equal(context.matchesStreetAddress("47470 4TH AVE NE", parts), false, "number runs on");
  assert.equal(context.matchesStreetAddress("4747 4TH AVE NW", parts), false, "wrong directional");

  // SDCI folds the unit into the number; those are the same house.
  const unitB = context.parseStreetAddressParts("3670 Dayton Ave N Unit B");
  assert.deepEqual([...unitB.directionals], ["N"]);
  assert.equal(context.matchesStreetAddress("3670-B DAYTON AVE N", unitB), true);
  assert.equal(context.matchesStreetAddress("3670A DAYTON AVE N", unitB), true);
  assert.equal(context.matchesStreetAddress("36701 DAYTON AVE N", unitB), false);

  // A Redfin address typed as "14 TH" still finds "14TH".
  const typo = context.parseStreetAddressParts("7011 14 TH Ave NE");
  assert.equal(typo.streetName, "14");
  assert.equal(context.matchesStreetAddress("7011 14TH AVE NE", typo), true);
  assert.equal(context.matchesStreetAddress("7011 14TH AVE NW", typo), false);

  // Both lookups go through the predicate and the filter.
  const requested = [];
  const fetching = createContext({
    fetch: url => {
      requested.push(decodeURIComponent(url));
      const rows = url.includes("xvj2-ai6y")
        ? [{ address: "1938 NW 97" }, { address: "1938 NW 97TH ST" }, { address: "19380 NW 97TH ST" }]
        : [
          { originaladdress1: "1938 NW 97TH ST", permitnum: "A", recordnum: "A" },
          { originaladdress1: "1938 NE 97TH ST", permitnum: "B", recordnum: "B" }
        ];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) });
    }
  });
  loadScript(fetching, "sidepanel/sidepanel-analysis.js");
  const listing = { address: { streetAddress: "1938 NW 97th St" } };
  const permits = await fetching.fetchSeattlePermits(listing);
  const tanks = await fetching.fetchSeattleOilTankRecords(listing);
  assert.ok(requested.length >= 6, "expected five SDCI sources plus the oil tank dataset");
  for (const url of requested) {
    assert.match(url, /starts_with\(upper\((originaladdress1|address)\), '1938'\)/);
    assert.match(url, /like '% 97TH %'/);
    assert.match(url, /like '% 97 %'/);
  }
  assert.deepEqual(permits.map(p => p.permitnum), ["A", "A", "A", "A", "A"], "NE row filtered out of every source");
  assert.deepEqual(tanks.map(t => t.address), ["1938 NW 97", "1938 NW 97TH ST"], "run-on number filtered out");
});

test("the delete row follows the active tab, and ignores slow or failed replies", async () => {
  const scrolls = [];
  const renderedRow = {
    dataset: { listingKey: "redfin/WA/Seattle/2544-NE-90th-St-98115/home/318529" },
    closest: () => ({ scrollIntoView: options => scrolls.push(options) })
  };
  const element = {
    addEventListener() {},
    classList: { toggle() {} },
    replaceChildren() {},
    appendChild() {},
    querySelectorAll: () => [renderedRow],
    value: "",
    checked: false,
    textContent: ""
  };
  let activeTab = null;
  let reply = () => Promise.resolve(null);
  const context = createContext({
    document: { addEventListener() {}, getElementById: () => element, createElement: () => ({ ...element }) },
    chrome: {
      runtime: { getURL: v => v, onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() },
      storage: { local: { get() {}, set() {}, remove() {} }, onChanged: { addListener() {} } },
      tabs: {
        create() {},
        query: (_options, callback) => callback(activeTab ? [activeTab] : []),
        sendMessage: (_tabId, message) => reply(message)
      }
    },
    clearTimeout, setTimeout, requestAnimationFrame() {},
    fetch() { throw new Error("no fetch expected"); }
  });
  [
    "shared/scoring.js", "sidepanel/sidepanel-model.js", "sidepanel/sidepanel-api.js",
    "sidepanel/sidepanel-analysis.js", "sidepanel/sidepanel-storage.js",
    "sidepanel/sidepanel-renderer.js", "sidepanel/sidepanel.js"
  ].forEach(filename => loadScript(context, filename));

  const refresh = vm.runInContext("refreshCurrentListingKey", context);
  const current = () => vm.runInContext("currentListingKey", context);
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const listingUrl = "https://www.redfin.com/WA/Seattle/2544-NE-90th-St-98115/home/318529";
  const listingKey = "redfin/WA/Seattle/2544-NE-90th-St-98115/home/318529";

  // Hearted listing page in the active tab.
  activeTab = { id: 7, url: listingUrl };
  reply = message => {
    assert.equal(message.action, "GET_CURRENT_LISTING");
    return Promise.resolve({ success: true, data: { url: listingUrl } });
  };
  refresh(); await settle();
  assert.equal(current(), listingKey);
  assert.equal(scrolls.length, 1, "the open listing's card is scrolled into view");
  assert.equal(scrolls[0].block, "nearest");

  // Asking again about the same listing does not move the list a second time.
  refresh(); await settle();
  assert.equal(scrolls.length, 1);

  // The page answers null when its heart is not filled.
  reply = () => Promise.resolve({ success: true, data: null });
  refresh(); await settle();
  assert.equal(current(), "");

  // A non-Redfin active tab is never asked.
  activeTab = { id: 8, url: "https://example.com/" };
  reply = () => { throw new Error("must not message a non-Redfin tab"); };
  refresh(); await settle();
  assert.equal(current(), "");

  // No content script (e.g. a tab opened before the extension loaded).
  activeTab = { id: 9, url: listingUrl };
  reply = () => Promise.reject(new Error("Receiving end does not exist"));
  refresh(); await settle();
  assert.equal(current(), "");

  // A slow reply from an earlier tab must not overwrite a newer answer.
  let releaseSlow;
  reply = () => new Promise(resolve => { releaseSlow = () => resolve({ success: true, data: { url: listingUrl } }); });
  refresh();
  reply = () => Promise.resolve({ success: true, data: null });
  refresh(); await settle();
  releaseSlow(); await settle();
  assert.equal(current(), "");
  assert.equal(scrolls.length, 1, "leaving a listing never scrolls");
});

test("a portfolio listing is removed only when the live page and Redfin's server both show it un-hearted", async () => {
  const listingKey = "redfin/WA/Seattle/2544-NE-90th-St-98115/home/318529";
  const unsaved = () => fakeHeartButton({ "aria-label": "Favorite this home" });
  const saved = () => fakeHeartButton({ "aria-label": "Unfavorite this home" });
  const removals = page => page.messages.filter(m => m.action === "REMOVE_HEARTED_LISTING");

  // Both empty, and the listing is in the panel: remove it.
  let page = loadContentScript(unsaved(), {}, { hearted: { [listingKey]: {} }, serverButtons: [unsaved()] });
  assert.equal(await page.removeIfNoLongerHearted(), true);
  assert.equal(removals(page).length, 1);
  assert.equal(removals(page)[0].listingKey, listingKey);
  assert.equal(page.fetches[0].init.credentials, "include", "must read the page as the signed-in user");

  // The live heart is empty but the server says it is a favorite: this is the
  // in-app navigation case where the heart has not caught up yet. Keep it.
  page = loadContentScript(unsaved(), {}, { hearted: { [listingKey]: {} }, serverButtons: [saved()] });
  assert.equal(await page.removeIfNoLongerHearted(), false);
  assert.deepEqual(removals(page), []);

  // No heart at all on the server copy is not evidence either way.
  page = loadContentScript(unsaved(), {}, { hearted: { [listingKey]: {} }, serverButtons: [] });
  assert.equal(await page.removeIfNoLongerHearted(), false);
  assert.deepEqual(removals(page), []);

  // Not in the panel: nothing to do, and no need to fetch the page.
  page = loadContentScript(unsaved(), {}, { hearted: {}, serverButtons: [unsaved()] });
  assert.equal(await page.removeIfNoLongerHearted(), false);
  assert.equal(page.fetches.length, 0);

  // The server copy could not be read: leave it alone.
  page = loadContentScript(unsaved(), {}, {
    hearted: { [listingKey]: {} },
    serverButtons: [unsaved()],
    serverResponse: { ok: false, text: () => Promise.resolve("") }
  });
  assert.equal(await page.removeIfNoLongerHearted(), false);
  assert.deepEqual(removals(page), []);
});

test("State Plane projection matches EPSG:2926 reference points", () => {
  const context = createContext();
  loadScript(context, "sidepanel/sidepanel-analysis.js");

  // Reference values from pyproj (EPSG:4152 -> EPSG:2926), i.e. the projection
  // alone without the ~1 m WGS84 -> NAD83(HARN) datum shift.
  [
    [47.68101430203843, -122.30964399613288, 1276776.8551046075, 251901.0773067394],
    [47.6062, -122.3321, 1270714.8171141008, 224723.4903684985],
    [47.5, -122.29, 1280365.1904777866, 185792.98080974005]
  ].forEach(([latitude, longitude, expectedX, expectedY]) => {
    const [x, y] = context.projectToWashingtonNorthStatePlane(latitude, longitude);
    assert.ok(Math.abs(x - expectedX) < 0.01, `easting ${x} vs ${expectedX}`);
    assert.ok(Math.abs(y - expectedY) < 0.01, `northing ${y} vs ${expectedY}`);
  });
});

test("side sewer map link centers on Seattle listings only", () => {
  const context = createContext();
  loadScript(context, "sidepanel/sidepanel-analysis.js");

  const url = context.createSideSewerMapUrl({
    address: { streetAddress: "1703 NE 73rd St", city: "Seattle", state: "WA", zip: "98115" },
    geo: { latitude: 47.68101430203843, longitude: -122.30964399613288 }
  });
  assert.equal(
    url,
    "https://experience.arcgis.com/experience/95749d0993164eefa99300182e99bd43" +
      "#widget_282=active_datasource_id:dataSource_7,center:1276776.86%2C251901.08%2C2926,scale:250"
  );

  assert.equal(context.createSideSewerMapUrl({
    address: { city: "Bellevue", state: "WA" },
    geo: { latitude: 47.61, longitude: -122.2 }
  }), null);
  assert.equal(context.createSideSewerMapUrl({ address: { city: "Seattle", state: "WA" }, geo: {} }), null);
});

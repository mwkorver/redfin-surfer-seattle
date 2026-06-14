/**
 * Utility for parsing real estate property metadata from listing pages.
 * Inspects JSON-LD script tags and falls back to DOM selectors if needed.
 */
const PropertyParser = {
  resolveImageUrl(imgVal) {
    if (!imgVal) return "";
    if (typeof imgVal === "string") return imgVal;
    if (Array.isArray(imgVal)) {
      return this.resolveImageUrl(imgVal[0]);
    }
    if (typeof imgVal === "object") {
      return imgVal.url || imgVal.contentUrl || "";
    }
    return "";
  },

  extractMetadata() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    let data = null;

    for (const script of scripts) {
      try {
        const json = JSON.parse(script.textContent);
        const properties = this.findPropertiesInSchema(json);
        if (properties && properties.length > 0) {
          // Pick the first valid property representation that has coordinates or address
          const bestMatch = properties.find(p => p.address && p.geo) || properties[0];
          data = bestMatch;
          break; 
        }
      } catch (e) {
        console.warn("[Diligence Sidecar] Error parsing JSON-LD script tag", e);
      }
    }

    // If no data found via schema, initialize empty container
    if (!data) {
      data = {};
    }

    // Apply fallbacks for missing values
    if (!data.address || !data.address.streetAddress) {
      const fbAddr = this.fallbackAddress();
      if (fbAddr) {
        data.address = Object.assign(data.address || {}, fbAddr);
      }
    }
    if (!data.price) {
      data.price = this.fallbackPrice();
    }
    if (!data.geo) {
      data.geo = this.fallbackGeo();
    }
    if (!data.image) {
      data.image = this.fallbackImage();
    }
    if (!data.url) {
      data.url = window.location.href;
    }
    if (!data.mlsId) {
      data.mlsId = this.fallbackMlsId();
    }
    if (!data.sqft) {
      data.sqft = this.fallbackSqft();
    }
    if (!data.lotSqft) {
      data.lotSqft = this.fallbackLotSqft();
    }
    data.cumulativeDaysOnMarket = this.extractCdom(data);

    // Clean up coordinates
    if (data.geo) {
      if (isNaN(data.geo.latitude) || isNaN(data.geo.longitude)) {
        data.geo = null;
      }
    }

    // Ensure state, city and zip exist in address
    if (data.address) {
      data.address.streetAddress = data.address.streetAddress || "";
      data.address.city = data.address.city || "";
      data.address.state = data.address.state || "";
      data.address.zip = data.address.zip || "";
    } else {
      data.address = { streetAddress: "", city: "", state: "", zip: "" };
    }

    return data;
  },

  /**
   * Recursively search Schema.org structure to find Residence, Place or Product nodes
   */
  findPropertiesInSchema(obj) {
    if (!obj || typeof obj !== 'object') return [];

    let results = [];

    // Traverse arrays
    if (Array.isArray(obj)) {
      for (const item of obj) {
        results = results.concat(this.findPropertiesInSchema(item));
      }
      return results;
    }

    const type = obj['@type'];
    const hasAddress = obj.address && (obj.address.streetAddress || typeof obj.address === 'string' || obj.address.addressLocality);
    
    // Check if this object is a housing/real estate/residence type or a product/listing containing address
    let isPropertyType = false;
    if (type) {
      const typeList = Array.isArray(type) ? type : [type];
      isPropertyType = typeList.some(t => {
        if (typeof t !== 'string') return false;
        return [
          'SingleFamilyResidence', 
          'Residence', 
          'Place', 
          'House', 
          'Apartment', 
          'Accommodation', 
          'Product',
          'RealEstateListing'
        ].some(val => val.toLowerCase() === t.toLowerCase());
      });
    }

    if (isPropertyType || (hasAddress && (obj.geo || obj.offers))) {
      const extracted = {
        schemaType: Array.isArray(type) ? type.join(', ') : (type || 'Unknown'),
        name: obj.name || '',
        description: obj.description || '',
        url: obj.url || window.location.href,
        image: this.resolveImageUrl(obj.image)
      };

      // Parse Address
      if (obj.address) {
        if (typeof obj.address === 'string') {
          extracted.address = { streetAddress: obj.address };
        } else {
          extracted.address = {
            streetAddress: obj.address.streetAddress || '',
            city: obj.address.addressLocality || '',
            state: obj.address.addressRegion || '',
            zip: obj.address.postalCode || ''
          };
        }
      }

      // Parse Geo Coordinates
      if (obj.geo) {
        extracted.geo = {
          latitude: parseFloat(obj.geo.latitude),
          longitude: parseFloat(obj.geo.longitude)
        };
      }

      // Parse Price
      if (obj.offers) {
        const offersObj = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
        if (offersObj.price) {
          extracted.price = parseFloat(String(offersObj.price).replace(/[^0-9.]/g, ''));
        }
        extracted.priceCurrency = offersObj.priceCurrency || 'USD';
      }

      // Parse floor size (living area sq ft)
      if (obj.floorSize) {
        const fs = obj.floorSize;
        const raw = typeof fs === 'number' ? fs : (typeof fs === 'object' ? parseFloat(fs.value) : NaN);
        if (!isNaN(raw) && raw > 0) extracted.sqft = raw;
      }

      // Parse lot size (sq ft); convert from sq meters if unit indicates metric
      if (obj.lotSize) {
        const ls = obj.lotSize;
        let raw = typeof ls === 'number' ? ls : (typeof ls === 'object' ? parseFloat(ls.value) : NaN);
        if (!isNaN(raw) && raw > 0) {
          const unit = typeof ls === 'object' ? (ls.unitCode || ls.unitText || '') : '';
          if (['MTK', 'MTR', 'm2', 'SQM'].includes(unit)) raw = Math.round(raw * 10.7639);
          extracted.lotSqft = raw;
        }
      }

      results.push(extracted);
    }

    // Recurse children properties (excluding circular/deep nested standard literals)
    for (const key in obj) {
      if (
        obj.hasOwnProperty(key) && 
        typeof obj[key] === 'object' && 
        !['address', 'geo', 'offers', 'image'].includes(key)
      ) {
        results = results.concat(this.findPropertiesInSchema(obj[key]));
      }
    }

    return results;
  },

  /**
   * DOM Scraping Fallback: Address
   */
  fallbackAddress() {
    // Redfin selector
    const rfTitle = document.querySelector('h1.title-style');
    if (rfTitle) {
      const sub = document.querySelector('[data-rf-test-id="abp-cityStateZip"]');
      const addressText = rfTitle.textContent.trim();
      const subText = sub ? sub.textContent.trim() : '';
      
      // Try to parse city state zip from subtext
      const zipMatch = subText.match(/^(.*?),\s*([A-Z]{2})\s*(\d{5})/);
      return {
        streetAddress: addressText,
        city: zipMatch ? zipMatch[1] : subText,
        state: zipMatch ? zipMatch[2] : '',
        zip: zipMatch ? zipMatch[3] : ''
      };
    }

    // Meta og:title (often has "Address, City, State Zip | Redfin")
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const content = ogTitle.getAttribute('content');
      const match = content.match(/^(.*?),\s*(.*?),\s*([A-Z]{2})\s*(\d{5})/);
      if (match) {
        return {
          streetAddress: match[1],
          city: match[2],
          state: match[3],
          zip: match[4]
        };
      }
    }

    // Try document title
    const match = document.title.match(/^(.*?),\s*(.*?),\s*([A-Z]{2})\s*(\d{5})/);
    if (match) {
      return {
        streetAddress: match[1],
        city: match[2],
        state: match[3],
        zip: match[4]
      };
    }

    return null;
  },

  /**
   * DOM Scraping Fallback: Price
   */
  fallbackPrice() {
    // Redfin selector
    const rfPrice = document.querySelector('[data-rf-test-id="abp-price"] .statsValue, [data-rf-test-id="abp-price"]');
    if (rfPrice) {
      const clean = rfPrice.textContent.replace(/[^0-9.]/g, '');
      if (clean) return parseFloat(clean);
    }

    // Meta product price
    const ogPrice = document.querySelector('meta[property="product:price:amount"]');
    if (ogPrice) {
      const val = parseFloat(ogPrice.getAttribute('content'));
      if (!isNaN(val)) return val;
    }

    return null;
  },

  /**
   * DOM Scraping Fallback: Coordinates
   */
  fallbackGeo() {
    // Meta location tags
    const latMeta = document.querySelector('meta[property="place:location:latitude"], meta[name="geo.position"]');
    const lonMeta = document.querySelector('meta[property="place:location:longitude"]');
    
    if (latMeta && lonMeta) {
      const latVal = latMeta.getAttribute('content') || '';
      const lonVal = lonMeta.getAttribute('content') || '';
      return {
        latitude: parseFloat(latVal.split(';')[0]),
        longitude: parseFloat(lonVal)
      };
    }

    // Check mapping coordinates inside map links or script configs
    const mapLinks = document.querySelectorAll('a[href*="maps.google.com"], a[href*="maps/dir"]');
    for (const link of mapLinks) {
      const href = link.getAttribute('href');
      const match = href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || href.match(/daddr=(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (match) {
        return {
          latitude: parseFloat(match[1]),
          longitude: parseFloat(match[2])
        };
      }
    }

    return null;
  },

  /**
   * DOM Scraping Fallback: Primary Image
   */
  fallbackImage() {
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) {
      return ogImage.getAttribute('content');
    }
    
    // First high resolution image
    const imgs = document.querySelectorAll('img[src*="http"]');
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (src && (src.includes('media') || src.includes('photo') || src.includes('mls'))) {
        return src;
      }
    }
    
    return null;
  },

  /**
   * DOM Scraping Fallback: Home square footage (living area)
   */
  fallbackSqft() {
    const rfSqFt = document.querySelector('[data-rf-test-id="abp-sqFt"] .statsValue, [data-rf-test-id="abp-sqFt"]');
    if (rfSqFt) {
      const val = parseFloat(rfSqFt.textContent.replace(/[^0-9.]/g, ''));
      if (!isNaN(val) && val > 0) return val;
    }
    return null;
  },

  /**
   * DOM Scraping Fallback: Lot size in sq ft
   */
  fallbackLotSqft() {
    const el = document.querySelector('[data-rf-test-id="abp-lotSize"] .statsValue, [data-rf-test-id="abp-lotSize"]');
    if (el) {
      const text = el.textContent;
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (!isNaN(val) && val > 0) {
        // Convert acres to sq ft if the text contains "Acres" or "acres"
        if (/acres?/i.test(text)) return Math.round(val * 43560);
        return val;
      }
    }
    return null;
  },

  /**
   * DOM Scraping Fallback: MLS ID
   */
  fallbackMlsId() {
    // Redfin selector
    const rfMls = document.querySelector('.mls-num, [data-rf-test-id="abp-mls"]');
    if (rfMls) {
      const id = rfMls.textContent.replace(/[^0-9A-Za-z]/g, '');
      if (id) return id;
    }

    // General text scanning
    const bodyText = document.body.innerText;
    const match = bodyText.match(/MLS\s*#?\s*:?\s*([0-9A-Za-z\-]+)/i);
    if (match) {
      return match[1];
    }

    return null;
  },

  /**
   * Checks if the active listing page is currently "Hearted" or "Favorited" by the user.
   */
  getPageHeartState() {
    let foundFavoriteButton = false;

    // Scan all button elements on the page
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.innerText.toLowerCase();
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const className = btn.className.toLowerCase();
      const testId = (btn.getAttribute('data-testid') || '').toLowerCase();

      // Check if this button is a Favorite/Save button
      const isFavSaveBtn = 
        label.includes('favorite') || 
        label.includes('save') || 
        label.includes('remove') ||
        testId.includes('save') ||
        className.includes('favorite-button') ||
        className.includes('save-button') ||
        text === 'save' ||
        text === 'saved' ||
        text === 'favorite' ||
        text === 'favorited';

      if (isFavSaveBtn) {
        foundFavoriteButton = true;
        // Determine if it is currently in a HEARTED / SAVED state.
        if (
          label.includes('remove') || 
          label.includes('unfavorite') ||
          label.includes('saved') ||
          text.includes('favorited') || 
          text.includes('saved') ||
          btn.classList.contains('is-favorite') ||
          btn.classList.contains('active') ||
          btn.getAttribute('aria-pressed') === 'true'
        ) {
          console.log("[Diligence Sidecar] Found active saved button:", label || text || className);
          return "saved";
        }
      }
    }

    return foundFavoriteButton ? "unsaved" : "unknown";
  },

  isPageHearted() {
    return this.getPageHeartState() === "saved";
  },

  getCurrentHomeId() {
    if (typeof window === 'undefined' || !window.location) return null;
    const match = window.location.href.match(/\/home\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
  },

  getDialogContainer() {
    if (typeof document === 'undefined') return null;

    const candidates = [
      document.querySelector('#bp-dialog-content'),
      document.querySelector('div[role="dialog"]'),
      document.querySelector('.bp-DialogContainer'),
      document.querySelector('.bp-dialog'),
      document.querySelector('.DialogContent__body')?.closest('div'),
      document.querySelector('.Dialog__body')?.closest('div')
    ].filter(Boolean);

    const bodyDivs = document.querySelectorAll('body > div');
    for (const div of bodyDivs) {
      if (div.id === 'bp-dialog-content' || div.getAttribute('role') === 'dialog') {
        if (!candidates.includes(div)) candidates.push(div);
        continue;
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(div);
        const isFixedOrAbsolute = style.position === 'fixed' || style.position === 'absolute';
        const zIndex = parseInt(style.zIndex, 10);
        const hasHighZIndex = !isNaN(zIndex) && zIndex >= 99;
        
        const className = div.className && typeof div.className === 'string' ? div.className.toLowerCase() : '';
        const hasDialogClass = className.includes('dialog') || className.includes('modal');
        const hasCloseButton = div.querySelector(".Dialog__close, button[aria-label*='close'], .close");
        
        if (isFixedOrAbsolute && (hasHighZIndex || hasDialogClass || hasCloseButton)) {
          if (!candidates.includes(div)) candidates.push(div);
        }
      }
    }

    for (const cand of candidates) {
      if (cand) {
        if (typeof cand.getBoundingClientRect === 'function' && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          const rect = cand.getBoundingClientRect();
          const style = window.getComputedStyle(cand);
          if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
            return cand;
          }
        } else {
          // Fallback for environment constraints where UI metrics are not supported
          return cand;
        }
      }
    }

    return null;
  },

  isDialogForCurrentListing(dialog, data) {
    if (!dialog) return false;
    if (!data || !data.address || !data.address.streetAddress) {
      // Return true if no metadata is available (e.g. mock test environment)
      return true;
    }

    const streetAddress = data.address.streetAddress.trim().toLowerCase();
    const dialogText = (dialog.textContent || "").toLowerCase();

    // Direct exact street address matching
    if (dialogText.includes(streetAddress)) {
      return true;
    }

    // Split street address and check street number and primary name fragments
    const parts = streetAddress.split(/\s+/).filter(Boolean);
    if (parts.length > 0) {
      const streetNum = parts[0];
      if (!dialogText.includes(streetNum)) {
        return false;
      }
      if (parts.length > 1) {
        const streetNamePart = parts[1];
        if (!dialogText.includes(streetNamePart)) {
          return false;
        }
      }
      return true;
    }

    return false;
  },

  extractCumulativeCdomOnly(data) {
    // 1. Specific selector check
    const specificSelector = "#bp-dialog-content > div.DialogContent__body > div > div:nth-child(16) > ul:nth-child(1) > li:nth-child(2)";
    const specificEl = document.querySelector(specificSelector);
    if (specificEl) {
      const text = (specificEl.textContent || "").trim();
      const textLower = text.toLowerCase();
      const hasSubDayUnit = textLower.includes("hour") || textLower.includes("hr") || textLower.includes("minute") || textLower.includes("min") || textLower.includes("second") || textLower.includes("sec");
      const num = parseInt(text.replace(/[^0-9]/g, ""), 10);
      if (!isNaN(num)) {
        console.log("[Diligence Sidecar] Found CDOM in specific selector:", num);
        return hasSubDayUnit ? 0 : num;
      }
    }

    // 2. Dialog list traversal for "cumulative days on market" or "cdom" (checking every list item)
    const dialog = this.getDialogContainer();
    if (dialog && this.isDialogForCurrentListing(dialog, data)) {
      const dialogLis = dialog.querySelectorAll("li");
      for (let i = 0; i < dialogLis.length; i++) {
        const text = (dialogLis[i].textContent || "").trim().toLowerCase();
        if (text.includes("cumulative days on market") || text.includes("cdom")) {
          const hasSubDayUnit = text.includes("hour") || text.includes("hr") || text.includes("minute") || text.includes("min") || text.includes("second") || text.includes("sec");
          // If the number is in the same element
          const match = text.match(/\b\d+\b/);
          if (match) {
            const num = parseInt(match[0], 10);
            if (!isNaN(num)) {
              console.log("[Diligence Sidecar] Found CDOM in dialog li text:", num);
              return hasSubDayUnit ? 0 : num;
            }
          }
          // Otherwise check the next sibling li
          if (i + 1 < dialogLis.length) {
            const nextText = (dialogLis[i + 1].textContent || "").trim();
            const nextTextLower = nextText.toLowerCase();
            const hasSubDayUnitNext = nextTextLower.includes("hour") || nextTextLower.includes("hr") || nextTextLower.includes("minute") || nextTextLower.includes("min") || nextTextLower.includes("second") || nextTextLower.includes("sec");
            const num = parseInt(nextText.replace(/[^0-9]/g, ""), 10);
            if (!isNaN(num)) {
              console.log("[Diligence Sidecar] Found CDOM in dialog next sibling li:", num);
              return (hasSubDayUnit || hasSubDayUnitNext) ? 0 : num;
            }
          }
        }
      }
    }

    // 3. Body regex for "cumulative days on market" or "cdom"
    const bodyText = document.body.innerText || "";
    const regexes = [
      /cumulative\s+days\s+on\s+market\s*:?\s*(\d+)\s*(hour|hr|minute|min|day|wk|month|yr)s?/i,
      /\bcdom\b\s*:?\s*(\d+)\s*(hour|hr|minute|min|day|wk|month|yr)s?/i,
      /(\d+)\s*(hour|hr|minute|min|day|wk|month|yr)s?\s+(?:cumulative\s+days\s+on\s+market|cdom)/i,
      /cumulative\s+days\s+on\s+market\s*:?\s*(\d+)/i,
      /\bcdom\b\s*:?\s*(\d+)/i
    ];
    for (const regex of regexes) {
      const match = bodyText.match(regex);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num)) {
          const unit = match[2] ? match[2].toLowerCase() : "";
          if (["hour", "hr", "minute", "min"].includes(unit)) {
            console.log("[Diligence Sidecar] Found sub-day unit in body regex:", match[0]);
            return 0;
          }
          console.log("[Diligence Sidecar] Extracted cumulative days on market / cdom via body regex:", num);
          return num;
        }
      }
    }

    // 4. Element scan for "cumulative days on market" or "cdom"
    const elements = document.querySelectorAll('span, div, td, li, p');
    for (const el of elements) {
      const text = (el.textContent || '').trim().toLowerCase();
      if ((text.includes("cumulative days on market") || text.includes("cdom")) && text.length < 120) {
        const hasSubDayUnit = text.includes("hour") || text.includes("hr") || text.includes("minute") || text.includes("min") || text.includes("second") || text.includes("sec");
        const selfMatch = text.match(/\b\d+\b/);
        if (selfMatch) {
          const num = parseInt(selfMatch[0], 10);
          if (!isNaN(num)) {
            console.log("[Diligence Sidecar] Found CDOM in element self-text:", num);
            return hasSubDayUnit ? 0 : num;
          }
        }

        let valText = "";
        if (el.nextElementSibling) {
          valText = el.nextElementSibling.textContent;
        } 
        if (!valText || !valText.trim()) {
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(el);
            if (index !== -1 && index + 1 < siblings.length) {
              valText = siblings[index + 1].textContent;
            } else {
              const nextParentSibling = parent.nextElementSibling;
              if (nextParentSibling) {
                valText = nextParentSibling.textContent;
              }
            }
          }
        }
        if (valText) {
          const valTextLower = valText.toLowerCase();
          const hasSubDayUnitVal = valTextLower.includes("hour") || valTextLower.includes("hr") || valTextLower.includes("minute") || valTextLower.includes("min") || valTextLower.includes("second") || valTextLower.includes("sec");
          const cleanText = valText.replace(/[^0-9]/g, '');
          if (cleanText) {
            const num = parseInt(cleanText, 10);
            if (!isNaN(num)) {
              console.log("[Diligence Sidecar] Found CDOM in sibling/parent text:", num);
              return (hasSubDayUnit || hasSubDayUnitVal) ? 0 : num;
            }
          }
        }
      }
    }

    // 5. Script tag check fallback for "cumulativeDaysOnMarket"
    const currentHomeId = this.getCurrentHomeId();
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const content = script.textContent || "";
      if (content.includes("cumulativeDaysOnMarket")) {
        if (currentHomeId && !content.includes(currentHomeId)) {
          continue; // Skip script tags belonging to other listings in this SPA session
        }
        const match = content.match(/"cumulativeDaysOnMarket"\s*:\s*(\d+)/i) || 
                      content.match(/cumulativeDaysOnMarket\s*:\s*(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num)) {
            console.log("[Diligence Sidecar] Found cumulativeDaysOnMarket in script state fallback:", num);
            return num;
          }
        }
      }
    }

    return null;
  },

  extractFallbackCdomOnly(data) {
    // 1. Dialog list traversal for "days on market" or "time on redfin" (checking every list item)
    const dialog = this.getDialogContainer();
    if (dialog && this.isDialogForCurrentListing(dialog, data)) {
      const dialogLis = dialog.querySelectorAll("li");
      for (let i = 0; i < dialogLis.length; i++) {
        const text = (dialogLis[i].textContent || "").trim().toLowerCase();
        if (text.includes("days on market") || text.includes("time on redfin")) {
          const hasSubDayUnit = text.includes("hour") || text.includes("hr") || text.includes("minute") || text.includes("min") || text.includes("second") || text.includes("sec");
          const match = text.match(/\b\d+\b/);
          if (match) {
            const num = parseInt(match[0], 10);
            if (!isNaN(num)) {
              console.log("[Diligence Sidecar] Found fallback in dialog li text:", num);
              return hasSubDayUnit ? 0 : num;
            }
          }
          if (i + 1 < dialogLis.length) {
            const nextText = (dialogLis[i + 1].textContent || "").trim();
            const nextTextLower = nextText.toLowerCase();
            const hasSubDayUnitNext = nextTextLower.includes("hour") || nextTextLower.includes("hr") || nextTextLower.includes("minute") || nextTextLower.includes("min") || nextTextLower.includes("second") || nextTextLower.includes("sec");
            const num = parseInt(nextText.replace(/[^0-9]/g, ""), 10);
            if (!isNaN(num)) {
              console.log("[Diligence Sidecar] Found fallback in dialog next sibling li:", num);
              return (hasSubDayUnit || hasSubDayUnitNext) ? 0 : num;
            }
          }
        }
      }
    }

    // 2. Body regex for "days on market" or "time on redfin"
    const bodyText = document.body.innerText || "";
    const regexes = [
      /days\s+on\s+market\s*:?\s*(\d+)\s*(hour|hr|minute|min|day|wk|month|yr)s?/i,
      /time\s+on\s+redfin\s*:?\s*(\d+)\s*(hour|hr|minute|min|day|wk|month|yr)s?/i,
      /(\d+)\s*(hour|hr|minute|min|day|wk|month|yr)s?\s+(?:on\s+redfin|days\s+on\s+market)/i,
      /days\s+on\s+market\s*:?\s*(\d+)/i,
      /time\s+on\s+redfin\s*:?\s*(\d+)/i
    ];
    for (const regex of regexes) {
      const match = bodyText.match(regex);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num)) {
          const unit = match[2] ? match[2].toLowerCase() : "";
          if (["hour", "hr", "minute", "min"].includes(unit)) {
            console.log("[Diligence Sidecar] Found sub-day unit in body regex:", match[0]);
            return 0;
          }
          console.log("[Diligence Sidecar] Extracted fallback days on market/time on redfin via body regex:", num);
          return num;
        }
      }
    }

    // 3. Element scan for "days on market" or "time on redfin"
    const elements = document.querySelectorAll('span, div, td, li, p');
    for (const el of elements) {
      const text = (el.textContent || '').trim().toLowerCase();
      if ((text.includes("days on market") || text.includes("time on redfin")) && text.length < 120) {
        const hasSubDayUnit = text.includes("hour") || text.includes("hr") || text.includes("minute") || text.includes("min") || text.includes("second") || text.includes("sec");
        const selfMatch = text.match(/\b\d+\b/);
        if (selfMatch) {
          const num = parseInt(selfMatch[0], 10);
          if (!isNaN(num)) {
            console.log("[Diligence Sidecar] Found fallback in element self-text:", num);
            return hasSubDayUnit ? 0 : num;
          }
        }

        let valText = "";
        if (el.nextElementSibling) {
          valText = el.nextElementSibling.textContent;
        } 
        if (!valText || !valText.trim()) {
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(el);
            if (index !== -1 && index + 1 < siblings.length) {
              valText = siblings[index + 1].textContent;
            } else {
              const nextParentSibling = parent.nextElementSibling;
              if (nextParentSibling) {
                valText = nextParentSibling.textContent;
              }
            }
          }
        }
        if (valText) {
          const valTextLower = valText.toLowerCase();
          const hasSubDayUnitVal = valTextLower.includes("hour") || valTextLower.includes("hr") || valTextLower.includes("minute") || valTextLower.includes("min") || valTextLower.includes("second") || valTextLower.includes("sec");
          const cleanText = valText.replace(/[^0-9]/g, '');
          if (cleanText) {
            const num = parseInt(cleanText, 10);
            if (!isNaN(num)) {
              console.log("[Diligence Sidecar] Found fallback in sibling/parent text:", num);
              return (hasSubDayUnit || hasSubDayUnitVal) ? 0 : num;
            }
          }
        }
      }
    }

    // 4. Script tag check fallback for "daysOnMarket"
    const currentHomeId = this.getCurrentHomeId();
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const content = script.textContent || "";
      if (content.includes("daysOnMarket")) {
        if (currentHomeId && !content.includes(currentHomeId)) {
          continue; // Skip script tags belonging to other listings in this SPA session
        }
        const match = content.match(/"daysOnMarket"\s*:\s*(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num)) {
            console.log("[Diligence Sidecar] Found daysOnMarket fallback in script state fallback:", num);
            return num;
          }
        }
      }
    }

    return null;
  },

  extractCdom(data) {
    // Priority 1: Search specifically for actual "Cumulative Days on Market"
    const actualCdom = this.extractCumulativeCdomOnly(data);
    if (actualCdom !== null) {
      return actualCdom;
    }

    // Priority 2: Fallback to "Days on Market" / "Time on Redfin"
    const fallbackCdom = this.extractFallbackCdomOnly(data);
    if (fallbackCdom !== null) {
      return fallbackCdom;
    }

    console.log("[Diligence Sidecar] CDOM not found on page.");
    return null;
  }
};


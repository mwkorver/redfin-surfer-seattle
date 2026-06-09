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
  isPageHearted() {
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
          return true;
        }
      }
    }

    return false;
  }
};

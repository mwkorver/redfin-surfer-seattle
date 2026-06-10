// Helper to determine if the active page is a property detail view
function isPropertyDetailPage() {
  const path = window.location.pathname;
  return path.includes('/home/');
}

function isTopFrame() {
  return window === window.top;
}

// Helper to find the closest element representing a favorite/heart button (button or custom div)
function findHeartButton(target) {
  if (!target) return null;

  let el = target;
  while (el && el !== document.body) {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const className = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';
    const testId = (el.getAttribute('data-testid') || el.getAttribute('data-rf-test-id') || '').toLowerCase();
    const text = el.innerText ? el.innerText.trim().toLowerCase() : '';

    const isMatch = 
      label.includes('favorite') || 
      label.includes('save') || 
      label.includes('remove') ||
      className.includes('favorite-button') ||
      className.includes('heart-icon') ||
      className.includes('favorite') || 
      className.includes('save') ||
      testId.includes('save') ||
      testId.includes('favorite') ||
      text === 'save' ||
      text === 'saved' ||
      text === 'favorite' ||
      text === 'favorited';

    if (isMatch) {
      // Exclude large cards/containers that accidentally match class names
      if (!className.includes('card') && !className.includes('container') && !className.includes('row')) {
        return el;
      }
    }
    el = el.parentElement;
  }
  return null;
}

function findHeartButtonFromEvent(event) {
  const direct = findHeartButton(event.target);
  if (direct) return direct;

  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    const heartButton = findHeartButton(node);
    if (heartButton) return heartButton;
  }
  return null;
}

// Helper to find the listing card container and its primary link for a given heart button
function findCardContainer(button, eventPath = []) {
  if (!button) return null;

  const pathElements = eventPath.filter(node => node instanceof Element);
  const directCandidates = [button, ...pathElements];
  for (const candidate of directCandidates) {
    const result = findSingleListingContainer(candidate);
    if (result) return result;
  }

  let popup = button.closest(
    '[role="dialog"], [role="article"], [data-rf-test-id*="map"], [class*="MapCard"], [class*="mapCard"], [class*="Popup"], [class*="popup"]'
  );
  while (popup && popup !== document.body) {
    const result = findSingleListingContainer(popup);
    if (result) return result;
    popup = popup.parentElement;
  }

  return findNearestListingContainer(button);
}

function findSingleListingContainer(start) {
  if (!start) return null;

  let card = start;
  let bestCard = null;
  let firstLinkHref = null;
  while (card && card !== document.body) {
    const currentLink = card.querySelector('a[href*="/home/"]');
    if (currentLink) {
      if (!firstLinkHref) {
        firstLinkHref = currentLink.href;
      }
      // If we find an ancestor container containing multiple different /home/ links, stop.
      const allLinks = Array.from(card.querySelectorAll('a[href*="/home/"]'));
      const hasMultipleDifferentLinks = allLinks.some(l => l.href !== firstLinkHref);
      if (hasMultipleDifferentLinks) {
        break;
      }

      bestCard = card;
      const className = (card.className && typeof card.className === 'string') ? card.className.toLowerCase() : '';
      const hasCardClass = (className.includes('homecard') || className.includes('card') || className.includes('tile'));
      if (hasCardClass && !className.includes('content')) {
        break; // Found the explicit card container
      }
    }
    card = card.parentElement;
  }
  
  if (!bestCard) return null;
  
  const link = getUniqueListingLinks(bestCard)[0];
  return { card: bestCard, link: link };
}

function findNearestListingContainer(button) {
  const links = Array.from(document.querySelectorAll('a[href*="/home/"]'))
    .filter(link => isElementVisible(link));
  if (!links.length) return null;

  const buttonRect = button.getBoundingClientRect();
  const buttonX = buttonRect.left + buttonRect.width / 2;
  const buttonY = buttonRect.top + buttonRect.height / 2;
  let nearest = null;
  let nearestDistance = Infinity;

  links.forEach(link => {
    const rect = link.getBoundingClientRect();
    const linkX = rect.left + rect.width / 2;
    const linkY = rect.top + rect.height / 2;
    const distance = Math.hypot(linkX - buttonX, linkY - buttonY);
    if (distance < nearestDistance) {
      nearest = link;
      nearestDistance = distance;
    }
  });

  if (!nearest || nearestDistance > 700) return null;
  const card = findCommonListingContainer(button, nearest) || nearest.parentElement;
  return card ? { card, link: nearest } : null;
}

function findCommonListingContainer(button, link) {
  let node = button.parentElement;
  while (node && node !== document.body) {
    if (node.contains(link)) return node;
    node = node.parentElement;
  }
  return null;
}

function getUniqueListingLinks(container) {
  const seen = new Set();
  return Array.from(container.querySelectorAll('a[href*="/home/"]')).filter(link => {
    const key = getRedfinListingKey(link.href);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isElementVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden";
}

// Debounce helper to prevent multiple rapid runs
let extractTimeout = null;

function runAndSend(delay = 800) {
  if (!isTopFrame()) return;

  if (extractTimeout) {
    clearTimeout(extractTimeout);
  }

  extractTimeout = setTimeout(() => {
    try {
      if (!isPropertyDetailPage()) {
        chrome.runtime.sendMessage({
          action: "CLEAR_CURRENT_LISTING"
        }).catch(() => {});
        return;
      }

      const heartState = PropertyParser.getPageHeartState();
      if (heartState !== "saved") {
        console.log(`[Diligence Sidecar] Listing save state is ${heartState}. Skipping extraction.`);
        chrome.runtime.sendMessage({
          action: "CLEAR_CURRENT_LISTING"
        }).catch(() => {});
        return;
      }

      const data = PropertyParser.extractMetadata();
      
      // Calculate geographic scope constraint (Seattle & King County, WA)
      const state = (data.address?.state || "").toUpperCase();
      const zip = data.address?.zip || "";
      const city = (data.address?.city || "").toLowerCase();
      data.inTargetGeography = state === "WA" && (zip.startsWith("980") || zip.startsWith("981") || city === "seattle");

      console.log("[Diligence Sidecar] Extracted metadata for saved listing:", data);
      
      chrome.runtime.sendMessage({
        action: "NEW_LISTING_DETECTED",
        data: data
      }).catch(err => {
        console.log("[Diligence Sidecar] Message sending deferred:", err.message);
      });
    } catch (e) {
      console.error("[Diligence Sidecar] Extraction error:", e);
    }
  }, delay);
}

// Initial extraction when content script loads
runAndSend(1000);

// Listen for messages from the service worker / side panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("[Diligence Sidecar] Content script received message:", request.action);
  
  if (request.action === "GET_CURRENT_LISTING") {
    if (!isTopFrame()) return false;
    try {
      if (!isPropertyDetailPage()) {
        sendResponse({ success: true, data: null });
        return;
      }
      const heartState = PropertyParser.getPageHeartState();
      if (heartState !== "saved") {
        sendResponse({ success: true, data: null });
      } else {
        const data = PropertyParser.extractMetadata();
        
        // Calculate geographic scope constraint (Seattle & King County, WA)
        const state = (data.address?.state || "").toUpperCase();
        const zip = data.address?.zip || "";
        const city = (data.address?.city || "").toLowerCase();
        data.inTargetGeography = state === "WA" && (zip.startsWith("980") || zip.startsWith("981") || city === "seattle");

        sendResponse({ success: true, data: data });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  } else if (request.action === "PAGE_NAVIGATED") {
    if (!isTopFrame()) return false;
    // SPA navigation happened, wait slightly for the DOM to render new info
    runAndSend(1200);
    sendResponse({ success: true });
  }
  return true; // Keep message channel open for async response
});

// Watch for clicks on "Save" or "Favorite" (Heart) buttons to auto-trigger deep diligence.
// We use capturing phase (useCapture = true) to intercept clicks before elements can stop propagation.
document.addEventListener('click', (e) => {
  try {
    const target = e.target;
    if (!target) return;

    // Check if the clicked button looks like a Redfin Save/Favorite button
    const eventPath = typeof e.composedPath === "function" ? e.composedPath() : [];
    const button = findHeartButtonFromEvent(e);
    const isHeartButton = !!button;

    if (isHeartButton) {
      const mapCardInfo = isMapPresentOnPage()
        ? findCardContainer(button, eventPath)
        : null;

      if (mapCardInfo) {
        handleListingCardHeartToggle(button, mapCardInfo);
      } else if (isPropertyDetailPage()) {
        const previousHeartState = PropertyParser.getPageHeartState();
        console.log("[Diligence Sidecar] User clicked Save/Heart button on listing details page.");
        // Open the panel from the user gesture, then re-evaluate after Redfin applies the state.
        chrome.runtime.sendMessage({
          action: "HEART_CLICKED"
        }).catch(err => {
          console.log("[Diligence Sidecar] Heart clicked notification deferred:", err.message);
        });

        waitForPageHeartState(previousHeartState).then(heartState => {
          if (heartState === "saved") {
            runAndSend(0);
          } else if (
            heartState === "unsaved" ||
            (previousHeartState === "saved" && heartState === "unknown")
          ) {
            chrome.runtime.sendMessage({
              action: "REMOVE_HEARTED_LISTING",
              url: window.location.href
            }).catch(() => {});
          }
        });
      } else {
        const containerInfo = findCardContainer(button, eventPath);
        if (containerInfo) {
          handleListingCardHeartToggle(button, containerInfo);
        } else {
          console.warn("[Diligence Sidecar] Heart click did not resolve to a Redfin listing.");
        }
      }
    }
  } catch (err) {
    console.error("[Diligence Sidecar] Error in click listener:", err);
  }
}, true); // useCapture = true to intercept stopped event propagation

function handleListingCardHeartToggle(button, containerInfo) {
  const { card, link } = containerInfo;
  const listingKey = getRedfinListingKey(link.href);
  const wasSaved = isHeartButtonSaved(button);
  console.log("[Diligence Sidecar] Intercepted heart click on listing card:", listingKey);

  waitForCardHeartState(link.href, wasSaved).then(observedState => {
    const isSaved = observedState === null || observedState === wasSaved
      ? !wasSaved
      : observedState;

    if (isSaved) {
      const cardData = parseListingCard(card);
      if (cardData) {
        observedSavedListings.add(listingKey);
        console.log("[Diligence Sidecar] Parsed listing card data:", cardData);
        chrome.runtime.sendMessage({ action: "HEART_CLICKED" }).catch(() => {});
        chrome.runtime.sendMessage({
          action: "NEW_LISTING_DETECTED",
          data: cardData
        }).catch(() => {});
      }
    } else if (wasSaved) {
      observedSavedListings.delete(listingKey);
      console.log("[Diligence Sidecar] Listing card was removed from saved properties.");
      chrome.runtime.sendMessage({
        action: "REMOVE_HEARTED_LISTING",
        url: link.href
      }).catch(() => {});
    }
  });
}

function waitForPageHeartState(previousState) {
  const delays = [350, 800, 1500];

  return new Promise(resolve => {
    const check = index => {
      setTimeout(() => {
        const state = PropertyParser.getPageHeartState();
        if (state !== "unknown" && state !== previousState) {
          resolve(state);
        } else if (index === delays.length - 1) {
          resolve(state);
        } else {
          check(index + 1);
        }
      }, delays[index]);
    };
    check(0);
  });
}

function isHeartButtonSaved(button) {
  if (!button) return false;
  const label = (button.getAttribute('aria-label') || '').toLowerCase();
  const text = (button.innerText || "").toLowerCase();
  return label.includes('remove') ||
    label.includes('unfavorite') ||
    label.includes('saved') ||
    text.includes('favorited') ||
    text.includes('saved') ||
    button.classList.contains('is-favorite') ||
    button.classList.contains('active') ||
    button.getAttribute('aria-pressed') === 'true' ||
    button.getAttribute('aria-checked') === 'true';
}

function waitForCardHeartState(listingUrl, previousSaved) {
  const delays = [350, 800, 1500];

  return new Promise(resolve => {
    const check = index => {
      setTimeout(() => {
        const button = findCardHeartButton(listingUrl);
        if (button) {
          const saved = isHeartButtonSaved(button);
          if (saved !== previousSaved || index === delays.length - 1) {
            resolve(saved);
            return;
          }
        } else if (index === delays.length - 1) {
          resolve(null);
          return;
        }
        check(index + 1);
      }, delays[index]);
    };
    check(0);
  });
}

function findCardHeartButton(listingUrl) {
  const listingKey = getRedfinListingKey(listingUrl);
  const links = Array.from(document.querySelectorAll('a[href*="/home/"]'));
  const link = links.find(candidate => getRedfinListingKey(candidate.href) === listingKey);
  if (!link) return null;

  let container = link.parentElement;
  while (container && container !== document.body) {
    const buttons = Array.from(container.querySelectorAll('button, [role="button"]'));
    const heartButton = buttons.find(candidate => findHeartButton(candidate) === candidate);
    if (heartButton) return heartButton;
    container = container.parentElement;
  }
  return null;
}

const observedSavedListings = new Set();

// Helper to parse card metadata on Redfin search result lists
function parseListingCard(cardElement) {
  const link = cardElement.querySelector('a[href*="/home/"]');
  if (!link) return null;

  const url = link.href;
  const data = {
    url: url,
    price: null,
    image: null,
    address: { streetAddress: "", city: "", state: "", zip: "" }
  };

  // Parse Address from URL (state, city, street, zip, homeId)
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 5) {
      data.address.state = pathParts[0].toUpperCase();
      data.address.city = decodeURIComponent(pathParts[1]).replace(/-/g, ' ');
      
      const streetPart = decodeURIComponent(pathParts[2]);
      const zipMatch = streetPart.match(/^(.*?)-(\d{5})$/);
      if (zipMatch) {
        data.address.streetAddress = zipMatch[1].replace(/-/g, ' ');
        data.address.zip = zipMatch[2];
      } else {
        data.address.streetAddress = streetPart.replace(/-/g, ' ');
      }
      data.mlsId = pathParts[4];
    }
  } catch (e) {
    console.warn("Failed to parse card address from URL:", url, e);
  }

  // Parse Price from card text content
  const text = cardElement.innerText;
  const priceMatch = text.match(/\$[0-9,]+/);
  if (priceMatch) {
    data.price = parseFloat(priceMatch[0].replace(/[^0-9.]/g, ''));
  }

  // Parse Image (resilient to lazy loading, srcset, and transparent gif placeholders)
  let imageUrl = null;
  const img = cardElement.querySelector('img');
  if (img) {
    // 1. Try srcset (highly common on Redfin for responsive images)
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const firstSrc = srcset.split(',')[0].trim().split(' ')[0];
      if (firstSrc && !firstSrc.startsWith('data:')) {
        imageUrl = firstSrc;
      }
    }

    // 2. Try picture source sibling if inside <picture>
    if (!imageUrl) {
      const picture = img.closest('picture');
      if (picture) {
        const source = picture.querySelector('source');
        if (source) {
          const sourceSrcset = source.getAttribute('srcset');
          if (sourceSrcset) {
            const firstSrc = sourceSrcset.split(',')[0].trim().split(' ')[0];
            if (firstSrc && !firstSrc.startsWith('data:')) {
              imageUrl = firstSrc;
            }
          }
        }
      }
    }

    // 3. Try common lazy-loading data attributes
    if (!imageUrl) {
      const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
      if (dataSrc && !dataSrc.startsWith('data:')) {
        imageUrl = dataSrc;
      }
    }

    // 4. Fallback to standard src, but only if it's not a data-uri spacer GIF
    if (!imageUrl) {
      const src = img.src || img.getAttribute('src');
      if (src && !src.startsWith('data:')) {
        imageUrl = src;
      }
    }
  }

  // 5. Try background-image styles in the card container
  if (!imageUrl) {
    const bgEl = cardElement.querySelector('[style*="background-image"]');
    if (bgEl) {
      const style = bgEl.getAttribute('style');
      const match = style.match(/url\(['"]?(.*?)['"]?\)/);
      if (match && match[1] && !match[1].startsWith('data:')) {
        imageUrl = match[1];
      }
    }
  }

  // Clean relative urls / protocol relative urls
  if (imageUrl) {
    if (imageUrl.startsWith('//')) {
      imageUrl = 'https:' + imageUrl;
    } else if (imageUrl.startsWith('/')) {
      imageUrl = window.location.origin + imageUrl;
    }
  }

  data.image = imageUrl;

  // Calculate scope boundary
  const state = (data.address.state || "").toUpperCase();
  const zip = data.address.zip || "";
  const city = (data.address.city || "").toLowerCase();
  data.inTargetGeography = state === "WA" && (zip.startsWith("980") || zip.startsWith("981") || city === "seattle");

  return data;
}

// Setup MutationObserver to monitor changes to the favorite/save buttons
const heartObserver = new MutationObserver((mutations) => {
  try {
    let stateChanged = false;
    for (const mutation of mutations) {
      const target = mutation.target;
      if (!target) continue;

      const button = findHeartButton(target);
      if (button) {
        if (isPropertyDetailPage()) {
          stateChanged = true;
        }
      }
    }

    if (stateChanged) {
      // Settle briefly for state to fully apply, then check status
      runAndSend(250);
    }
  } catch (err) {
    console.error("[Diligence Sidecar] Error in MutationObserver:", err);
  }
});

// Observe attribute changes on the document body (restricted to specific button attributes)
heartObserver.observe(document.body, {
  attributes: true,
  childList: true,
  subtree: true,
  attributeFilter: ['aria-label', 'class', 'aria-pressed', 'aria-checked']
});

function getRedfinListingKey(urlValue) {
  try {
    const url = new URL(urlValue);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return path ? `redfin/${path}` : "";
  } catch (error) {
    return "";
  }
}

// Map presence detection logic
function isMapPresentOnPage() {
  const selector = '.GoogleMap, .map-canvas, #map-canvas, .InlineMap, #lightboxMap, [data-rf-test-id="map"], .mapContainer, .inline-map, .gm-style';
  const el = document.querySelector(selector);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}


let lastMapStatus = null;
function checkAndSendMapStatus() {
  if (!isTopFrame()) return;

  try {
    const currentStatus = isMapPresentOnPage();
    if (currentStatus !== lastMapStatus) {
      lastMapStatus = currentStatus;
      chrome.storage.local.set({ mapPresent: currentStatus }).catch(() => {});
    }
  } catch (e) {
    // Fail-safe
  }
}

// Run map presence check every 1000ms
setInterval(checkAndSendMapStatus, 1000);
checkAndSendMapStatus();

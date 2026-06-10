// Helper to determine if the active page is a property detail view
function isPropertyDetailPage() {
  const path = window.location.pathname;
  return path.includes('/home/');
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

// Helper to find the listing card container and its primary link for a given heart button
function findCardContainer(button) {
  if (!button) return null;
  
  let card = button.parentElement;
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
  
  const link = bestCard.querySelector('a[href*="/home/"]');
  return { card: bestCard, link: link };
}

// Debounce helper to prevent multiple rapid runs
let extractTimeout = null;

function runAndSend(delay = 800) {
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
    const button = findHeartButton(target);
    const isHeartButton = !!button;

    if (isHeartButton) {
      if (isPropertyDetailPage()) {
        console.log("[Diligence Sidecar] User clicked Save/Heart button on listing details page.");
        // Open the panel from the user gesture, then re-evaluate after Redfin applies the state.
        chrome.runtime.sendMessage({
          action: "HEART_CLICKED"
        }).catch(err => {
          console.log("[Diligence Sidecar] Heart clicked notification deferred:", err.message);
        });

        setTimeout(() => {
          const heartState = PropertyParser.getPageHeartState();
          if (heartState === "saved") {
            runAndSend(0);
          } else if (heartState === "unsaved") {
            chrome.runtime.sendMessage({
              action: "REMOVE_HEARTED_LISTING",
              url: window.location.href
            }).catch(() => {});
          }
        }, 350);
      } else {
        const containerInfo = findCardContainer(button);
        if (containerInfo) {
          const { card, link } = containerInfo;
          console.log("[Diligence Sidecar] Intercepted heart click on search card.");
          
          // Wait briefly for Redfin state toggle to apply
          setTimeout(() => {
            const label = (button.getAttribute('aria-label') || '').toLowerCase();
            const text = button.innerText.toLowerCase();
            const isSaved = 
              label.includes('remove') || 
              label.includes('unfavorite') || 
              text.includes('favorited') ||
              button.classList.contains('is-favorite') ||
              button.getAttribute('aria-pressed') === 'true' ||
              button.getAttribute('aria-checked') === 'true';

            if (isSaved) {
              const cardData = parseListingCard(card);
              if (cardData) {
                console.log("[Diligence Sidecar] Parsed search card data:", cardData);
                // Trigger auto-open sidebar
                chrome.runtime.sendMessage({ action: "HEART_CLICKED" }).catch(() => {});
                // Send listing details to side panel
                chrome.runtime.sendMessage({ action: "NEW_LISTING_DETECTED", data: cardData }).catch(() => {});
              }
            } else {
              console.log("[Diligence Sidecar] Search card was removed from saved properties.");
              chrome.runtime.sendMessage({
                action: "REMOVE_HEARTED_LISTING",
                url: link.href
              }).catch(() => {});
            }
          }, 350);
        }
      }
    }
  } catch (err) {
    console.error("[Diligence Sidecar] Error in click listener:", err);
  }
}, true); // useCapture = true to intercept stopped event propagation

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

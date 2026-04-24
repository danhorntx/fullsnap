// content.js — FullSnap Content Script

'use strict';

async function captureFullPage(opts = {}) {
  const hideAds = opts.hideAds ?? false;

  // ── Canonical scroll element ──────────────────────────────────────────────
  const scroller = document.scrollingElement || document.documentElement;

  // ── Page metrics (initial — will be re-measured after pre-scroll) ─────────
  const pageWidth  = Math.max(scroller.scrollWidth,  document.body?.scrollWidth  ?? 0);
  let   pageHeight = Math.max(scroller.scrollHeight, document.body?.scrollHeight ?? 0);
  const vpWidth    = window.innerWidth;
  const vpHeight   = window.innerHeight;
  const dpr        = window.devicePixelRatio || 1;

  // ── Save state ────────────────────────────────────────────────────────────
  const origScrollY = window.scrollY;
  const origScrollX = window.scrollX;

  // ── Disable smooth-scroll; hide scrollbars via CSS only ──────────────────
  // NOTE: We deliberately do NOT set overflow:hidden on html/body.
  // Doing so disables window.scrollTo() on many SPAs (NYTimes, Wired, etc.)
  // causing every capture to be identical.  Scrollbars are hidden with
  // CSS only, which has no effect on programmatic scrolling.
  const setupStyle = document.createElement('style');
  setupStyle.id = '__fullsnap_setup';
  setupStyle.textContent = [
    'html,body{scroll-behavior:auto!important}',
    '::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}',
    '*{scrollbar-width:none!important}',
  ].join('\n');
  document.head.appendChild(setupStyle);

  let noAnimStyle    = null;
  let analysis       = null;   // hoisted so cleanupAndRestore can always see it
  let hiddenFixedEls = [];
  const screenshots  = [];

  try {
    // ══ PHASE 1: Site Analysis + two-pass pre-scroll ══════════════════════
    // analyzeSite() pre-scrolls twice, optionally injects ad CSS between
    // the passes, and returns adaptive capture settings plus the style/DOM
    // objects it created so cleanupAndRestore can undo them.
    bgSend({ action: 'CAPTURE_STATUS', label: 'Analyzing page…' });

    analysis = await analyzeSite(pageHeight, vpHeight, dpr, hideAds);
    if (window.__fullSnapCancelled) { cleanupAndRestore(); return; }

    // ══ PHASE 2: Re-measure ═══════════════════════════════════════════════
    // Re-read scrollHeight after both passes have triggered lazy content and
    // ad containers have been collapsed (if hideAds).
    //
    // When hideAds is true the page has genuinely shrunk (ad gaps removed).
    // Using Math.max would keep the pre-collapse height and cause a large blank
    // region at the bottom of the captured image.  Use the current height only.
    //
    // Without ad hiding we still want the maximum seen, because lazy-loaded
    // images can temporarily expand then contract the page during pre-scroll.
    const currentHeight = Math.max(
      scroller.scrollHeight,
      document.body?.scrollHeight ?? 0
    );
    pageHeight = hideAds
      ? currentHeight
      : Math.max(pageHeight, currentHeight);

    // Build scroll positions with overlap AFTER the final pageHeight is known.
    const positions = buildScrollPositions(pageHeight, vpHeight, analysis.overlapPx);

    // ══ PHASE 3: Freeze animations + parallax backgrounds ════════════════
    noAnimStyle = document.createElement('style');
    noAnimStyle.id = '__fullsnap_noanim';
    noAnimStyle.textContent = [
      // Freeze CSS transitions and keyframe animations
      '*,*::before,*::after{',
      '  animation-duration:0.001ms!important;',
      '  animation-delay:-1ms!important;',
      '  transition-duration:0.001ms!important;',
      '  transition-delay:0ms!important;',
      '}',
      // Convert fixed/parallax CSS backgrounds to normal scroll so they
      // don't shift position between consecutive captured frames.
      '*{background-attachment:scroll!important}',
    ].join('\n');
    document.head.appendChild(noAnimStyle);
    await sleep(60);

    // ══ PHASE 4: Capture pass ═════════════════════════════════════════════
    for (let i = 0; i < positions.length; i++) {
      if (window.__fullSnapCancelled) { cleanupAndRestore(); return; }

      scrollTo(positions[i]);
      await waitForPaint(analysis.scrollSettleMs);

      // Read actual scroll position — some pages snap or clamp the value.
      const actualY = window.scrollY;

      await waitForViewportImages(3000);

      // Fixed / sticky element strategy derived from site analysis:
      //
      //  i === 0 → keep fixed elements visible so the nav bar / floating
      //            widget appears exactly once at the top of the final image.
      //
      //  i >= 1, perFrameFixedHide === true  → re-scan + re-hide every frame.
      //            Required for sites (NYTimes, etc.) whose nav bar is added
      //            to the DOM dynamically after the first scroll, or whose JS
      //            continuously overrides visibility.
      //
      //  i >= 1, perFrameFixedHide === false → hide once at i === 1.
      //            Sufficient for sites with a static fixed header.
      if (i > 0) {
        if (analysis.perFrameFixedHide) {
          // Restore elements hidden in the previous frame so their original
          // styles are clean, then do a fresh scan for this position.
          restoreFixedElements(hiddenFixedEls);
          hiddenFixedEls = hideFixedElements();
          await waitForPaint(60);
        } else if (i === 1) {
          hiddenFixedEls = hideFixedElements();
          await waitForPaint(80);
        }
      }

      if (window.__fullSnapCancelled) { cleanupAndRestore(); return; }

      const resp = await bgSend({ action: 'CAPTURE_SCREENSHOT' });
      if (!resp || resp.error) throw new Error(resp?.error ?? 'captureVisibleTab failed');

      screenshots.push({ scrollY: actualY, dataUrl: resp.dataUrl });
      bgSend({ action: 'CAPTURE_PROGRESS', current: i + 1, total: positions.length });

      // Chrome enforces ≤ 2 captureVisibleTab/sec; captureIntervalMs is safe.
      await sleepCheckCancel(analysis.captureIntervalMs);
    }

    cleanupAndRestore();
    if (window.__fullSnapCancelled) return;

    await bgSend({
      action: 'CAPTURE_COMPLETE',
      screenshots,
      pageInfo: { pageWidth, pageHeight, vpWidth, vpHeight, dpr, hostname: location.hostname },
    });

  } catch (err) {
    cleanupAndRestore();
    await bgSend({ action: 'CAPTURE_ERROR', error: err.message });
    throw err;
  }

  // ── Restore everything ───────────────────────────────────────────────────
  function cleanupAndRestore() {
    restoreFixedElements(hiddenFixedEls);
    noAnimStyle?.remove();
    // Undo ad-space collapsing and remove the ad-hide stylesheet —
    // both were created inside analyzeSite and returned on the analysis object.
    restoreCollapsed(analysis?.collapsedEls ?? []);
    analysis?.adHideStyle?.remove();
    setupStyle?.remove();
    scrollTo(origScrollY, origScrollX);
  }

  // ── Scoped scroll helper ─────────────────────────────────────────────────
  function scrollTo(top, left = 0) {
    try {
      window.scrollTo({ top, left, behavior: 'instant' });
    } catch (_) {
      window.scrollTo(left, top);
    }
  }
}

// ── Site Analysis ─────────────────────────────────────────────────────────────

/**
 * Two-pass pre-scroll analysis.  Returns an adaptive config plus any DOM/style
 * objects created during analysis (for cleanup by cleanupAndRestore).
 *
 * Pass 1 (100 ms/step) — triggers IntersectionObserver lazy-loaders and
 *   monitors the fixed-element count to detect dynamic navbars.
 *
 * Between passes — if hideAds is true:
 *   1. Inject AD_HIDE_CSS to remove ad elements from layout.
 *   2. Walk each hidden ad element's parent chain and collapse any container
 *      whose remaining children are all hidden — eliminating blank ad-shaped
 *      gaps without touching editorial content.
 *   3. Short settle so the page reflows before we measure final height.
 *
 * Pass 2 (80 ms/step) — faster verification scroll confirming everything is
 *   rendered and settled (images loaded, ad gaps gone, lazy footers present).
 */
async function analyzeSite(pageHeight, vpHeight, dpr, hideAds = false) {
  const scrollToY = (top) => {
    try { window.scrollTo({ top, behavior: 'instant' }); }
    catch (_) { window.scrollTo(0, top); }
  };

  // ── Adaptive defaults ────────────────────────────────────────────────────
  const cfg = {
    perFrameFixedHide: false,
    captureIntervalMs: 550,
    scrollSettleMs:    200,
    // 8 logical-px overlap at 1× DPR, 16 px at 2×.
    // Larger overlap gives the alignment corrector more stable pixels to
    // anchor on, reducing sensitivity to parallax-displaced content.
    // 16 logical-px overlap at 1× DPR, 32 px at 2×.
    // A larger overlap gives the pixel-comparison alignment corrector in the
    // stitcher more stable reference pixels, reducing seam errors on sites with
    // JS-driven parallax (e.g. Wired.com hero images).
    overlapPx:         Math.ceil(dpr) * 16,
    // Returned for cleanupAndRestore — set below if ads are hidden.
    adHideStyle:       null,
    collapsedEls:      [],
  };

  // ── Quick page survey ────────────────────────────────────────────────────
  const imageCount = document.querySelectorAll('img').length;
  const videoCount = document.querySelectorAll('video').length;
  const heavyPage  = imageCount > 25 || videoCount > 1;
  if (heavyPage) cfg.scrollSettleMs = 260;

  // ── Build sample positions (full-viewport steps) ─────────────────────────
  const samplePositions = [];
  let y = 0;
  while (y + vpHeight < pageHeight) { samplePositions.push(y); y += vpHeight; }
  samplePositions.push(Math.max(0, pageHeight - vpHeight));

  // ── PASS 1: Lazy-loader trigger + dynamic-navbar detection ───────────────
  scrollToY(0);
  await sleep(250);
  const baselineCount = countFixedElements();

  const checkEvery = Math.max(1, Math.floor(samplePositions.length / 5));
  let fixedChanges = 0;

  for (let i = 0; i < samplePositions.length; i++) {
    if (window.__fullSnapCancelled) return cfg;
    scrollToY(samplePositions[i]);
    await sleep(100); // relaxed pace fires IntersectionObserver callbacks

    if (i > 0 && i % checkEvery === 0) {
      const current = countFixedElements();
      if (current !== baselineCount) fixedChanges++;
    }
  }

  if (fixedChanges > 0) {
    cfg.perFrameFixedHide = true;
    cfg.scrollSettleMs    = Math.max(cfg.scrollSettleMs, 260);
  }

  // Return to top; shorter settle because pass 2 will do a final check.
  scrollToY(0);
  await sleep(heavyPage ? 1200 : 900);

  // ── Between passes: ad hiding + container collapse ───────────────────────
  if (hideAds) {
    // 1. Inject the ad-hide stylesheet.
    const styleEl = document.createElement('style');
    styleEl.id = '__fullsnap_adblock';
    styleEl.textContent = AD_HIDE_CSS;
    document.head.appendChild(styleEl);
    cfg.adHideStyle = styleEl;

    // 2. Wait for the browser to apply display:none to ad elements.
    await sleep(350);

    // 3. Collapse parent containers that are now visually empty so the blank
    //    space left by hidden ads disappears from the captured image.
    cfg.collapsedEls = collapseEmptyAdContainers();

    // 4. Give the page a final reflow after container collapse.
    await sleep(250);
  }

  // ── PASS 2: Verification scroll ──────────────────────────────────────────
  // Faster (80 ms/step) — confirms all images loaded, ad gaps collapsed,
  // and any dynamically-appended footer content is present.
  for (let i = 0; i < samplePositions.length; i++) {
    if (window.__fullSnapCancelled) return cfg;
    scrollToY(samplePositions[i]);
    await sleep(80);
  }

  scrollToY(0);
  await sleep(heavyPage ? 800 : 600);

  return cfg;
}

/**
 * Count all position:fixed and position:sticky elements in the live DOM.
 * Skips our own injected style nodes.
 * Capped at 3 000 elements to keep performance acceptable on DOM-heavy pages.
 */
function countFixedElements() {
  let count = 0;
  const all   = document.body.querySelectorAll('*');
  const limit = Math.min(all.length, 3000);
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    if (el.id?.startsWith('__fullsnap')) continue;
    const pos = window.getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') count++;
  }
  return count;
}

/**
 * Build the ordered list of scroll-Y positions for the capture pass.
 *
 * overlapPx shrinks the step so consecutive screenshots share a strip of
 * pixels.  The stitcher places each shot at its actual scrollY, so the
 * shared strip is simply painted twice (harmless) but any small scroll error
 * is covered rather than exposed as a gap.
 */
function buildScrollPositions(pageHeight, vpHeight, overlapPx = 0) {
  const step = Math.max(1, vpHeight - overlapPx);
  const positions = [];
  let y = 0;
  while (y + vpHeight < pageHeight) {
    positions.push(y);
    y += step;
  }
  const lastPos = Math.max(0, pageHeight - vpHeight);
  if (!positions.length || positions[positions.length - 1] !== lastPos) {
    positions.push(lastPos);
  }
  return positions;
}

// ── Ad container collapsing ───────────────────────────────────────────────────

/**
 * querySelectorAll-compatible version of the ad selectors.
 * Used to locate ad elements whose parent containers should be collapsed.
 */
// var (not const) so re-injecting content.js into an already-loaded tab does
// not throw "Identifier has already been declared" in strict mode.
var AD_SELECTOR_QSA = [
  'ins.adsbygoogle',
  '[id*="google_ads" i]', '[id*="google-ads" i]',
  '[class*="advertisement" i]', '[class*="advert" i]',
  '[class*="ad-unit" i]',   '[class*="ad_unit" i]',
  '[class*="ad-container" i]', '[class*="ad_container" i]',
  '[class*="ad-wrapper" i]',   '[class*="ad_wrapper" i]',
  '[class*="ad-slot" i]',      '[class*="ad_slot" i]',
  '[class*="dfp-ad" i]',       '[class*="dfp-slot" i]',
  '[class*="AdUnit" i]',       '[class*="ad-module" i]',
  '[data-ad]', '[data-ad-unit]', '[data-ad-slot]', '[data-ad-client]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="pubmatic.com"]',
  'iframe[src*="rubiconproject.com"]',
  'iframe[src*="openx.net"]',
  'iframe[src*="criteo.net"]',
  'iframe[src*="taboola.com"]',
  'iframe[src*="outbrain.com"]',
].join(', ');

/**
 * After AD_HIDE_CSS has been applied (ad elements are display:none), walk
 * each ad element's parent chain and collapse any ancestor that now has no
 * visible children.  This removes the blank gap the hidden ad left behind.
 *
 * Stops bubbling when it hits an element that still has visible children
 * (editorial content is safe) or reaches <body>.
 *
 * Returns a restore list so cleanupAndRestore can undo the changes.
 */
function collapseEmptyAdContainers() {
  const collapsed = [];
  const seen      = new Set();

  let adEls;
  try {
    adEls = [...document.querySelectorAll(AD_SELECTOR_QSA)];
  } catch (_) {
    return collapsed; // selector parse error on unusual pages
  }

  for (const adEl of adEls) {
    let node = adEl.parentElement;

    while (node && node !== document.body) {
      if (seen.has(node)) break;
      seen.add(node);

      if (node.id?.startsWith('__fullsnap')) break;

      // If the browser already considers it hidden (e.g. it matched our CSS
      // directly), no need to track — the stylesheet removal will restore it.
      if (window.getComputedStyle(node).display === 'none') break;

      // Count children that are still visible after ad hiding.
      const hasVisibleChild = [...node.children].some((child) => {
        if (child.id?.startsWith('__fullsnap')) return false;
        return window.getComputedStyle(child).display !== 'none';
      });

      if (hasVisibleChild) break; // editorial content present — stop here

      // All children hidden: collapse this container and keep bubbling.
      collapsed.push({
        el:           node,
        origDisplay:  node.style.display,
        origPriority: node.style.getPropertyPriority('display'),
      });
      node.style.setProperty('display', 'none', 'important');
      node = node.parentElement;
    }
  }

  return collapsed;
}

function restoreCollapsed(collapsed) {
  collapsed.forEach(({ el, origDisplay, origPriority }) => {
    if (origDisplay) el.style.setProperty('display', origDisplay, origPriority);
    else             el.style.removeProperty('display');
  });
}

// ── Fixed / sticky element handling ──────────────────────────────────────────

/**
 * Find all position:fixed and position:sticky elements and hide them with
 * visibility:hidden (preserves layout; just removes them visually).
 * Returns a restore list for cleanupAndRestore / per-frame refresh.
 */
function hideFixedElements() {
  const hidden = [];
  document.body.querySelectorAll('*').forEach((el) => {
    if (el.id?.startsWith('__fullsnap')) return;
    const pos = window.getComputedStyle(el).position;
    if (pos !== 'fixed' && pos !== 'sticky') return;
    hidden.push({
      el,
      origValue:    el.style.visibility,
      origPriority: el.style.getPropertyPriority('visibility'),
    });
    el.style.setProperty('visibility', 'hidden', 'important');
  });
  return hidden;
}

function restoreFixedElements(hidden) {
  hidden.forEach(({ el, origValue, origPriority }) => {
    if (origValue) el.style.setProperty('visibility', origValue, origPriority);
    else           el.style.removeProperty('visibility');
  });
}

// ── Generic helpers ───────────────────────────────────────────────────────────

function waitForPaint(ms) {
  // Two rAF calls before the timer: JS scroll-handler parallax typically
  // updates on the first frame, but some sites chain a second rAF for their
  // layout math.  Waiting for both ensures transforms have fully settled
  // before we fire captureVisibleTab.
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setTimeout(resolve, ms)
      )
    )
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep in small increments so the Stop button can interrupt quickly. */
async function sleepCheckCancel(ms) {
  const chunk = 100;
  let rem = ms;
  while (rem > 0) {
    if (window.__fullSnapCancelled) return;
    await sleep(Math.min(chunk, rem));
    rem -= chunk;
  }
}

/** Poll until all <img> elements in the viewport report complete, or timeout. */
async function waitForViewportImages(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const allDone = [...document.querySelectorAll('img')].every((img) => {
      const r = img.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= window.innerHeight) return true;
      if (!img.currentSrc && !img.src) return true;
      return img.complete;
    });
    if (allDone) return;
    await sleep(100);
  }
}

// ── Ad-hide CSS ───────────────────────────────────────────────────────────────
// Applied before capture when the user enables "Hide Ads".
// Targets ad containers by class/ID pattern, data attributes, and known
// ad-network iframe src URLs.  Uses display:none so the element is fully
// removed from layout (no blank space where the ad used to be).
// var for the same re-injection safety reason as AD_SELECTOR_QSA above.
var AD_HIDE_CSS = `
/* ── Standard ad elements ── */
ins.adsbygoogle,
[id*="google_ads" i], [id*="google-ads" i],

/* ── Class/ID keyword patterns ── */
[class*="advertisement" i], [class*="advert" i],
[class*="ad-unit" i],       [class*="ad_unit" i],
[class*="ad-container" i],  [class*="ad_container" i],
[class*="ad-wrapper" i],    [class*="ad_wrapper" i],
[class*="ad-slot" i],       [class*="ad_slot" i],
[class*="dfp-ad" i],        [class*="dfp-slot" i],
[class*="banner-ad" i],     [class*="leaderboard-ad" i],
[class*="AdUnit" i],        [class*="ad-module" i],
[id*="advertisement" i],    [id*="dfp" i],

/* ── Data attribute patterns ── */
[data-ad], [data-ad-unit], [data-ad-slot], [data-ad-client],
[data-advertising], [data-ad-rendered],

/* ── ARIA patterns ── */
[aria-label*="advertisement" i], [aria-label*="sponsored" i],

/* ── Sponsored / native-ad labels ── */
[class*="sponsored-content" i], [class*="native-ad" i],
[class*="promoted-content" i],  [class*="promo-ad" i],

/* ── Known ad-network iframes (src pattern matching) ── */
iframe[src*="doubleclick.net"],
iframe[src*="googlesyndication.com"],
iframe[src*="amazon-adsystem.com"],
iframe[src*="moatads.com"],
iframe[src*="adnxs.com"],
iframe[src*="pubmatic.com"],
iframe[src*="rubiconproject.com"],
iframe[src*="openx.net"],
iframe[src*="criteo.net"],
iframe[src*="taboola.com"],
iframe[src*="outbrain.com"],
iframe[src*="sharethrough.com"],
iframe[src*="33across.com"],
iframe[src*="spotxchange.com"],
iframe[src*="adsafeprotected.com"],
iframe[src*="media.net"]
{
  display: none !important;
}
`.trim();

function bgSend(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(chrome.runtime.lastError ? null : (resp ?? null));
      });
    } catch (_) {
      resolve(null);
    }
  });
}

// ── Element Picker ─────────────────────────────────────────────────────────────

/**
 * Show a crosshair overlay so the user can click any element on the page.
 * Automatically finds the nearest scrollable ancestor for the clicked element.
 * Pressing Escape cancels without capturing.
 */
async function startPickerMode(opts = {}) {
  // ── Build overlay ──────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = '__fullsnap_picker_overlay';
  Object.assign(overlay.style, {
    position:      'fixed',
    inset:         '0',
    zIndex:        '2147483647',
    cursor:        'crosshair',
    pointerEvents: 'all',
  });

  const highlight = document.createElement('div');
  highlight.id = '__fullsnap_picker_highlight';
  Object.assign(highlight.style, {
    position:       'fixed',
    pointerEvents:  'none',
    border:         '2px solid #4285f4',
    background:     'rgba(66,133,244,0.12)',
    borderRadius:   '4px',
    zIndex:         '2147483646',
    transition:     'all 0.04s ease',
    display:        'none',
    boxSizing:      'border-box',
  });

  const label = document.createElement('div');
  label.id = '__fullsnap_picker_label';
  Object.assign(label.style, {
    position:    'fixed',
    top:         '12px',
    left:        '50%',
    transform:   'translateX(-50%)',
    background:  'rgba(21,21,40,0.96)',
    color:       '#e8e8f0',
    fontFamily:  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:    '13px',
    fontWeight:  '500',
    padding:     '9px 18px',
    borderRadius:'24px',
    border:      '1px solid #2a2a50',
    zIndex:      '2147483647',
    pointerEvents:'none',
    whiteSpace:  'nowrap',
    boxShadow:   '0 4px 16px rgba(0,0,0,0.4)',
  });
  label.textContent = '🖱 Click a scrollable element to capture  •  Esc to cancel';

  document.body.appendChild(overlay);
  document.body.appendChild(highlight);
  document.body.appendChild(label);

  // ── Helper: find nearest scrollable ancestor ───────────────────────────────
  function findScrollableAncestor(el) {
    let node = el;
    while (node && node !== document.body) {
      const style    = window.getComputedStyle(node);
      const overflow = style.overflow + style.overflowY;
      if (
        (overflow.includes('scroll') || overflow.includes('auto')) &&
        node.scrollHeight > node.clientHeight + 2
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return el; // no scrollable ancestor found; capture element's bounds as crop
  }

  return new Promise((resolve, reject) => {
    let targetEl = null;

    // ── Highlight on hover ─────────────────────────────────────────────────
    overlay.addEventListener('mousemove', (e) => {
      // Temporarily disable pointer-events on overlay so elementFromPoint
      // hits the actual page element beneath.
      overlay.style.pointerEvents = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = 'all';

      if (!under || under.id?.startsWith('__fullsnap')) return;

      targetEl = findScrollableAncestor(under);
      const rect = targetEl.getBoundingClientRect();
      Object.assign(highlight.style, {
        display: 'block',
        left:    rect.left   + 'px',
        top:     rect.top    + 'px',
        width:   rect.width  + 'px',
        height:  rect.height + 'px',
      });
    });

    // ── Click: capture the highlighted element ─────────────────────────────
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();

      if (!targetEl) {
        reject(new Error('No element selected'));
        return;
      }

      captureScrollableElement(targetEl, opts)
        .then(resolve)
        .catch(reject);
    });

    // ── Escape: cancel ────────────────────────────────────────────────────
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cleanup();
        chrome.runtime.sendMessage({ action: 'CAPTURE_ERROR', error: 'Element selection cancelled.' });
        resolve();
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true });

    function cleanup() {
      overlay.remove();
      highlight.remove();
      label.remove();
      document.removeEventListener('keydown', onKeyDown, { capture: true });
    }
  });
}

// ── Scrollable Element Capture ────────────────────────────────────────────────

/**
 * Scroll through a specific element's content, capturing the viewport each
 * step, then stitch only the element's rectangle in the preview.
 *
 * Strategy:
 *   1. Scroll the page so the element's top edge sits near the viewport top.
 *   2. Record the element's bounding rect (cropX/Y/W/H in physical pixels).
 *   3. Scroll INSIDE the element, taking a captureVisibleTab shot each step.
 *   4. Send CAPTURE_COMPLETE with cropX/Y/W/H in pageInfo so the preview
 *      stitcher knows to crop each shot to the element's region.
 */
async function captureScrollableElement(el, opts = {}) {
  const hideAds    = opts.hideAds ?? false;
  const dpr        = window.devicePixelRatio || 1;
  const elClientW  = el.clientWidth;
  const elClientH  = el.clientHeight;
  const elScrollH  = el.scrollHeight;

  // ── Save state ─────────────────────────────────────────────────────────────
  const origScrollTop  = el.scrollTop;
  const origPageScrollY = window.scrollY;
  const origPageScrollX = window.scrollX;

  // ── Position page so element's top is at/near viewport top ────────────────
  const pageRect = el.getBoundingClientRect();
  const targetPageScrollY = Math.max(0, origPageScrollY + pageRect.top - 10);
  try {
    window.scrollTo({ top: targetPageScrollY, left: 0, behavior: 'instant' });
  } catch (_) {
    window.scrollTo(0, targetPageScrollY);
  }
  await sleep(200);

  // Record element position in the viewport after page scroll
  const viewRect = el.getBoundingClientRect();
  const cropX    = Math.max(0, Math.round(viewRect.left * dpr));
  const cropY    = Math.max(0, Math.round(viewRect.top  * dpr));
  const cropW    = Math.round(elClientW * dpr);
  const cropH    = Math.round(elClientH * dpr);

  // ── Optional: hide ads inside element ─────────────────────────────────────
  let adStyle = null;
  if (hideAds) {
    adStyle = document.createElement('style');
    adStyle.textContent = AD_HIDE_CSS;
    document.head.appendChild(adStyle);
    await sleep(300);
  }

  // ── Freeze animations ──────────────────────────────────────────────────────
  const noAnimStyle = document.createElement('style');
  noAnimStyle.id    = '__fullsnap_noanim';
  noAnimStyle.textContent = [
    '*,*::before,*::after{',
    '  animation-duration:0.001ms!important;',
    '  animation-delay:-1ms!important;',
    '  transition-duration:0.001ms!important;',
    '  transition-delay:0ms!important;',
    '}',
  ].join('\n');
  document.head.appendChild(noAnimStyle);
  await sleep(40);

  // Hide fixed elements so they don't appear on every captured frame
  const hiddenFixedEls = hideFixedElements();
  await waitForPaint(80);

  // ── Build scroll positions within the element ──────────────────────────────
  const overlapPx = Math.ceil(dpr) * 8;
  const step      = Math.max(1, elClientH - overlapPx);
  const positions = [];
  let sy = 0;
  while (sy + elClientH < elScrollH) {
    positions.push(sy);
    sy += step;
  }
  const lastPos = Math.max(0, elScrollH - elClientH);
  if (!positions.length || positions[positions.length - 1] !== lastPos) {
    positions.push(lastPos);
  }

  const screenshots = [];

  // Reset element to top
  el.scrollTop = 0;
  await waitForPaint(120);

  try {
    for (let i = 0; i < positions.length; i++) {
      if (window.__fullSnapCancelled) break;

      el.scrollTop = positions[i];
      await waitForPaint(200);
      const actualScrollTop = el.scrollTop;

      const resp = await bgSend({ action: 'CAPTURE_SCREENSHOT' });
      if (!resp || resp.error) throw new Error(resp?.error ?? 'captureVisibleTab failed');

      screenshots.push({ scrollY: actualScrollTop, dataUrl: resp.dataUrl });
      bgSend({ action: 'CAPTURE_PROGRESS', current: i + 1, total: positions.length });

      await sleepCheckCancel(550);
    }
  } finally {
    // ── Restore everything ─────────────────────────────────────────────────
    restoreFixedElements(hiddenFixedEls);
    noAnimStyle.remove();
    adStyle?.remove();
    el.scrollTop = origScrollTop;
    try {
      window.scrollTo({ top: origPageScrollY, left: origPageScrollX, behavior: 'instant' });
    } catch (_) {
      window.scrollTo(origPageScrollX, origPageScrollY);
    }
  }

  if (window.__fullSnapCancelled) return;

  await bgSend({
    action: 'CAPTURE_COMPLETE',
    screenshots,
    pageInfo: {
      pageWidth:  elClientW,
      pageHeight: elScrollH,
      vpWidth:    elClientW,
      vpHeight:   elClientH,
      dpr,
      hostname:   location.hostname,
      // Crop coordinates (physical pixels) so the preview stitcher can extract
      // just the element's region from each full-viewport screenshot.
      cropX,
      cropY,
      cropW,
      cropH,
    },
  });
}

# FullSnap — Developer Handoff

**Version:** 1.1.0  
**GitHub:** https://github.com/danhorntx/fullsnap  
**Owner:** danhorntx@gmail.com  
**Last updated:** April 2026

> Built across two Claude Cowork sessions. This document is the single source of truth for picking up development.

---

## What This Is

FullSnap is a Chrome Extension (Manifest V3) that replicates GoFullPage. It scrolls through a page capturing viewport-sized screenshots, stitches them together on a canvas with DPR-aware alignment correction, and opens a preview tab with export options (PNG, JPEG, PDF, clipboard) and a crop tool.

---

## File Map

```
fullsnap-extension/
├── manifest.json        MV3 manifest — permissions, shortcut, web_accessible_resources
├── popup.html           Extension popup UI
├── popup.js             Popup logic — state machine, countdown ring, progress, prefs
├── background.js        Service worker — orchestrates capture, stores data, opens preview
├── content.js           Injected into target tab — scrolls, captures, element picker
├── preview.html         Preview page (new tab) — toolbar + canvas
├── preview.js           Preview logic — stitching, crop tool, all exports
├── jspdf.umd.min.js     Bundled jsPDF (no CDN)
├── icons/               icon16/32/48/128.png
└── HANDOFF.md           This file
```

---

## Feature Summary

### Popup (`popup.html` + `popup.js`)

| Control | What it does |
|---------|-------------|
| **Capture Full Page** | Scrolls + captures the active tab top-to-bottom |
| **Pick Scrollable Element** | User clicks any scrollable div; that element is captured independently |
| **Hide Ads** | CSS injection collapses common ad selectors before capture. Persisted in `chrome.storage.local` |
| **Capture Delay** | Dropdown: 0 / 3 / 5 / 10 s. Triggers animated SVG countdown ring. Persisted in `chrome.storage.local` |
| **Progress display** | Section counter, real-time ETA (measured from actual pace), phase labels |
| **Stop** | Cancels countdown OR mid-capture scroll loop |
| **Keyboard shortcut** | Alt+Shift+P — fires `INITIATE_CAPTURE` via `chrome.commands` |

Progress states the popup handles: `starting`, `countdown`, `selecting`, `loading`, `capturing`, `complete`, `error`.

### Preview Page (`preview.html` + `preview.js`)

Toolbar (always visible, fixed at top):

| Button | Behavior |
|--------|----------|
| **Undo Crop** | Hidden until crop applied. Restores original full-page view from `OffscreenCanvas` snapshot |
| **Crop** | Enters crop mode — swaps export buttons for Apply + Cancel in toolbar |
| **Copy** | Copies canvas as PNG to clipboard |
| **PNG** | Downloads PNG |
| **JPEG** | Downloads JPEG with white background composite; quality slider 60–100% step 5 |
| **PDF** | Downloads PDF via jsPDF |

Crop mode: dark overlay, drag to select, live pixel readout. Enter = apply, Esc = cancel. All export buttons disabled while crop mode is open. Undo always restores original (snapshot saved only once, before first crop).

---

## Architecture

### Message Flow

```
Popup  ──INITIATE_CAPTURE──►  background.js
                                  │
                           countdown (if delay > 0)
                                  │
                    chrome.scripting.executeScript(content.js)
                                  │
                    content.js: captureFullPage()
                                  │
                    ◄──CAPTURE_SCREENSHOT──  (captureVisibleTab per section)
                                  │
                    ◄──CAPTURE_PROGRESS──    (popup progress bar)
                                  │
                    ◄──CAPTURE_COMPLETE──    (all screenshots + pageInfo)
                                  │
                         captureStore.set(id, data)
                         chrome.tabs.create(preview.html?id=...)
                                  │
                    preview.js: GET_CAPTURE_DATA
                                  │
                             stitch canvas
```

### Progress Tracking

Background writes to `chrome.storage.session` (`fullsnapProgress`). Popup reads on open + watches via `chrome.storage.onChanged`. No polling.

### Canvas Stitching (`preview.js → stitch()`)

1. `capturedDpr = firstImg.width / vpWidth` — derives physical pixel ratio from actual image
2. Each screenshot placed at `scrollY * capturedDpr` physical pixels on the canvas
3. **Alignment correction** — before placing each frame, samples the middle-60% of the overlap zone (last `16 × DPR` px of previous / first `16 × DPR` px of new). Searches ±12 physical pixels for minimum pixel diff (capped at 150 per channel to suppress parallax outliers). Corrects accumulated scroll drift.
4. **Canvas height cap** — capped to `(lastShot.scrollY + vpHeight) × capturedDpr` to prevent blank whitespace when page shrank mid-capture (e.g. after hiding ads)
5. **Element capture** — when `pageInfo.cropX/Y/W/H` present, uses `ctx.drawImage(img, cropX, cropY, cropW, drawH, ...)` to extract only the element's region from each full-viewport screenshot

---

## Critical Gotchas

### `var` vs `const` in `content.js`
`content.js` can be injected multiple times into the same tab (e.g. element picker after a full-page capture). `const` at top level throws `SyntaxError: Identifier has already been declared` on re-injection. **All top-level declarations use `var`.** Function declarations are idempotent and safe.

### `captureVisibleTab` rate limit
Chrome enforces ~2 captures/second. Minimum gap between captures is `captureIntervalMs = 550ms`. Do not lower this — it causes silent capture failures on some machines.

### Service worker keep-alive
A `setInterval` pings `chrome.runtime.getPlatformInfo` every 20 seconds during capture to prevent the service worker from being suspended mid-scroll. Started in `startKeepAlive()`, stopped in `stopKeepAlive()`.

### CSS parallax
`background-attachment: scroll !important` injected before capture freezes CSS parallax backgrounds. JS parallax settled with `waitForPaint()` = double `requestAnimationFrame` + `setTimeout(0)` after each scroll step.

### Fixed/sticky elements (NYTimes-style navbars)
Two-pass pre-scroll analysis detects `position: fixed/sticky` elements. They are set to `visibility: hidden` before each frame capture and restored after. If the count of fixed elements changes between passes, `perFrameFixedHide = true` is set, meaning re-hiding happens every single frame.

### Canvas height cap (NYTimes blank space bug)
When Hide Ads collapses containers, `scrollHeight` shrinks but scroll positions had been calculated against the original larger height. Extra frames at the bottom all capture the same final position → white space. Fixed in two places: (1) `content.js` uses current height only (not max) when `hideAds` is true; (2) `preview.js` caps canvas to `lastShot.scrollY + vpHeight`.

### Undo Crop memory
Uses `OffscreenCanvas` (raw bitmap) rather than `canvas.toDataURL()` (base64). Snapshot taken only once before the first crop — subsequent crops do not overwrite it, so undo always returns to the original full-page view.

### `backdrop-filter` placement
`backdrop-filter: blur(22px)` is applied only to `#toolbar` (a `position: fixed` element). It is **never** applied to scrolling containers — doing so causes continuous GPU repaints on mobile.

---

## Design System

Both `popup.html` and `preview.html` share a consistent visual language. Do not break these without updating both.

| Token | Value |
|-------|-------|
| Background | `#07070d` — OLED near-black |
| Glass surface | `rgba(255,255,255,0.045)` |
| Glass hover | `rgba(255,255,255,0.072)` |
| Border | `rgba(255,255,255,0.07)` |
| Border highlight | `rgba(255,255,255,0.13)` |
| Accent | `#3b82f6` — electric cobalt |
| Accent dim | `rgba(59,130,246,0.14)` |
| Text primary | `#eeeef6` |
| Text secondary | `#8888aa` |
| Muted | `#47475e` |
| Success | `#22c55e` |
| Danger | `#f87171` |
| Ease fluid | `cubic-bezier(0.32, 0.72, 0, 1)` |
| Ease spring | `cubic-bezier(0.34, 1.56, 0.64, 1)` |
| Font stack | `'SF Pro Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif` |

**Key patterns:**
- **Double-Bezel (Doppelrand)** — major interactive containers use an outer shell (accent-tinted, hairline border, 3px padding) wrapping an inner core (gradient, inner highlight shadow). Applied to the popup CTA button and the logo mark.
- **Button-in-Button** — primary CTAs contain a nested icon square (left) and a nested arrow circle (right), both with their own background + border.
- **Toolbar glass** — `backdrop-filter` on the fixed preview toolbar only. Never on scrolling content.
- **All transitions** — custom cubic-bezier only. No `linear` or `ease-in-out`.

---

## Git Workflow Note

The mounted workspace volume (`/mnt/...`) has filesystem restrictions that block git's internal locking. **To commit and push from a Cowork session:**

```bash
# Copy changed files to temp
cp -r "/path/to/fullsnap-extension" /tmp/fullsnap
rm -rf /tmp/fullsnap/.git   # strip any stale .git copy

# Init fresh, commit, push
cd /tmp/fullsnap
git init && git config user.name "danhorntx" && git config user.email "danhorntx@gmail.com"
git branch -m main
git remote add origin https://danhorntx:TOKEN@github.com/danhorntx/fullsnap.git
git add . && git commit -m "your message"
git push origin main
```

---

## Known Limitations / Next Work

| Area | Issue |
|------|-------|
| Wired.com stitching | Overlap increased to 16×DPR, search ±12px, strip 80 rows. Still possible minor misalign on very aggressive JS animations at scroll boundaries |
| Element picker width | Captures full viewport + crops element region. Narrow elements capture full-width background — not wrong, just occasionally unexpected |
| Very tall pages | No canvas chunking/tiling. Pages above ~50,000px may hit browser canvas size limits on some systems |
| PDF pagination | jsPDF single-image-per-page. A 10,000px page produces one extremely tall PDF page rather than paginated output |
| Wired lazy-load | Two-pass pre-scroll triggers `IntersectionObserver` lazy-loaders. Most load correctly; edge case exists if a section lazy-loads during the capture pass (not pre-scroll pass) |

---

## Loading the Extension

1. Go to `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. **Load unpacked** → select the `fullsnap-extension/` folder
4. The FullSnap icon appears in the toolbar

To reload after code changes: click the refresh ↺ icon on the extension card.

---

## Resuming Development

Read `content.js` and `preview.js` first — they contain the bulk of the logic (~700–900 lines each). Key sections are marked with `// ──` comment banners for navigation.

The full session transcripts with all diffs and decisions are stored locally in the Claude Cowork session directory if deeper context is needed.

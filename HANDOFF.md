# FullSnap — Developer Handoff

**Version:** 1.1.0  
**Last updated:** April 2026  
**Extension folder:** `fullsnap-extension/`

---

## What This Is

FullSnap is a Chrome Extension (Manifest V3) that replicates GoFullPage's full-page screenshot functionality. It scrolls through a page capturing viewport-sized screenshots, stitches them together on a canvas, and presents a preview page with export options (PNG, JPEG, PDF, clipboard copy) and a crop tool.

---

## File Map

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest. Version 1.1.0. Permissions: activeTab, tabs, scripting, storage, unlimitedStorage. Keyboard shortcut: Alt+Shift+P |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup logic — progress states, countdown ring animation, preference persistence |
| `background.js` | Service worker — orchestrates capture, manages delay countdown, opens preview tab |
| `content.js` | Injected into target tab — scrolls & captures, element picker mode |
| `preview.html` | Preview page opened after capture |
| `preview.js` | Preview logic — canvas stitching, crop tool, all exports |
| `jspdf.umd.min.js` | Bundled jsPDF (no CDN dependency) |
| `icons/` | Extension icons |

---

## Feature Summary

### Popup
- **Capture Full Page** — scrolls the active tab top-to-bottom, captures viewport-sized PNGs, stitches them
- **Pick Scrollable Element** — user clicks any scrollable element (e.g. a chat panel, overflow div); that element is captured independently
- **Hide Ads** — injects CSS to collapse common ad selectors before capture; persisted in `chrome.storage.local`
- **Capture Delay** — dropdown: 0 / 3 / 5 / 10 seconds; triggers animated SVG countdown ring; persisted in `chrome.storage.local`
- **Progress display** — section count, real-time ETA (measured from actual pace), phase labels
- **Stop button** — cancels both active countdown and mid-capture scroll loop

### Preview Page
Toolbar (always visible at top, fixed):
- **Undo Crop** — hidden until a crop is applied; restores the original full-page view
- **Crop** — enters crop mode; swaps export buttons for Apply Crop + Cancel in the toolbar
- **Copy** — copies PNG to clipboard
- **PNG** — downloads PNG
- **JPEG** — downloads JPEG with white background compositing; quality slider (60–100%, step 5)
- **PDF** — downloads PDF via jsPDF

Crop mode:
- Dark overlay covers the canvas; user drags to select region
- Pixel dimensions readout updates live in selection corner
- Enter key = apply crop; Escape = cancel
- Applying saves an OffscreenCanvas snapshot of the pre-crop state (only once — undo always returns to original full-page)

---

## Architecture Notes

### Capture Flow
1. Popup sends `INITIATE_CAPTURE` or `PICK_ELEMENT` to background
2. Background optionally runs countdown (`runWithDelay`), then calls `initiateCapture` or `startElementPicker`
3. Background injects `content.js` via `chrome.scripting.executeScript({ files: ['content.js'] })`
4. Background calls `captureFullPage(opts)` or `startPickerMode(opts)` via `executeScript({ func, args })`
5. Content script sends `CAPTURE_SCREENSHOT` messages to background for each viewport capture (`captureVisibleTab`)
6. On completion, content script sends `CAPTURE_COMPLETE` with all screenshot dataURLs + pageInfo
7. Background stores data in `captureStore` Map (keyed by timestamp), opens `preview.html?id=...`
8. Preview page sends `GET_CAPTURE_DATA` to retrieve and delete its entry from the store

### Progress Tracking
- Background writes to `chrome.storage.session` (`fullsnapProgress`)
- Popup watches via `chrome.storage.onChanged` — no polling needed
- On popup open, existing progress is read from session storage to resume in-flight display

### Canvas Stitching (preview.js)
- `capturedDpr` is derived from `firstImg.width / vpWidth` (physical pixels vs CSS pixels)
- Each screenshot is placed at `scrollY * capturedDpr` physical pixels on the canvas
- **Alignment correction**: Before placing each frame, samples the middle-60% overlap zone (last 16× DPR pixels of the previous frame / first 16× DPR pixels of the new frame). Searches ±12 physical pixels for the offset that minimizes pixel diff (capped at 150 per channel to suppress parallax outliers). Corrects scroll drift by up to ±12px.
- **Canvas height cap**: Canvas height is capped to `(lastShot.scrollY + vpHeight) * capturedDpr` to prevent blank whitespace at the bottom when the page shrank mid-capture (e.g. after hiding ads)
- **Element capture**: When `pageInfo.cropX/Y/W/H` are present, each frame is drawn using `ctx.drawImage(img, cropX, cropY, cropW, drawH, 0, destYPhys, canvasW, drawH)` to extract only the element's region

### Key Gotchas

**`var` vs `const` in content.js top-level**  
`content.js` can be injected multiple times into the same tab (e.g. element picker after a full-page capture). `const` at the top level of a script throws `SyntaxError: Identifier has already been declared` on re-injection. All top-level declarations in `content.js` that might conflict use `var`. Function declarations are safe (idempotent).

**`captureVisibleTab` rate limit**  
Chrome enforces ~2 captures/second. `captureIntervalMs` is set to 550ms minimum between captures.

**Service worker lifecycle**  
A `setInterval` keep-alive pings `chrome.runtime.getPlatformInfo` every 20 seconds during capture to prevent the service worker from being suspended mid-capture.

**CSS parallax**  
`background-attachment: scroll !important` is injected before capture to freeze CSS parallax. JS parallax is handled by `waitForPaint` (double `requestAnimationFrame` + `setTimeout`) after each scroll step.

**Fixed/sticky elements (e.g. NYTimes navbar)**  
A two-pass pre-scroll analysis detects elements whose `position` is `fixed` or `sticky`. These are temporarily set to `visibility: hidden` before each capture frame and restored after.

**Wired.com image stitching**  
Overlap zone increased to 16× DPR pixels (was 8×). Alignment search window is ±12px (was ±8px). Comparison strip is 80 rows (was 64). This handles aggressive lazy-loading where images pop in slightly late at scroll boundaries.

---

## Known Limitations / Potential Next Work

- Element picker uses full-viewport capture + crop extraction. It does not resize the viewport, so captured content width = full page width (the element's left offset is cropped away). This is fine for most use cases but may look odd for very narrow elements.
- Very tall pages (50,000+ px) can approach canvas size limits on some systems. No chunking/tiling is currently implemented.
- PDF export via jsPDF is single-image-per-page — very tall screenshots result in a very tall single page rather than paginated output.
- JPEG export composites onto a white background canvas before encoding (PNGs with transparency would otherwise get a black fill).
- Wired.com stitching is improved but may still show minor misaligns on certain scroll positions due to aggressive JS animation on article images.

---

## How to Load the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the `fullsnap-extension/` folder
5. The FullSnap icon appears in the toolbar

To reload after code changes: click the refresh icon on the extension card in `chrome://extensions`.

---

## Resuming Development

Read `content.js` and `preview.js` first — they contain the most logic. Both files are long (~700–900 lines each). Key sections are marked with `// ──` comment banners.

The summary in this file and the session transcript should be enough to get oriented. If you need the full session transcript with all diffs and error messages, it was generated in a Claude Cowork session (April 2026).

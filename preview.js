// preview.js — FullSnap Preview Page

'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusWrap   = document.getElementById('status-wrap');
const statusMsg    = document.getElementById('status-msg');
const progressBar  = document.getElementById('progress-bar');
const errorWrap    = document.getElementById('error-wrap');
const errorMsg     = document.getElementById('error-msg');
const canvasWrap   = document.getElementById('canvas-wrap');
const canvas       = document.getElementById('canvas');
const infoEl       = document.getElementById('info');
const toastEl      = document.getElementById('toast');

const btnUndoCrop     = document.getElementById('btn-undo-crop');
const btnCrop         = document.getElementById('btn-crop');
const btnCopy         = document.getElementById('btn-copy');
const btnPng          = document.getElementById('btn-png');
const btnJpeg         = document.getElementById('btn-jpeg');
const rngQuality      = document.getElementById('rng-quality');
const qualityLabel    = document.getElementById('quality-label');
const btnPdf          = document.getElementById('btn-pdf');

const cropOverlay        = document.getElementById('crop-overlay');
const cropInstruction    = document.getElementById('crop-instruction');
const cropSelection      = document.getElementById('crop-selection');
const cropDims           = document.getElementById('crop-dims');
const actionsEl          = document.getElementById('actions');
const cropToolbarActions = document.getElementById('crop-toolbar-actions');
const cropToolbarHint    = document.getElementById('crop-toolbar-hint');
const btnCropConfirm     = document.getElementById('btn-crop-confirm');
const btnCropCancel      = document.getElementById('btn-crop-cancel');

// ── Module state ──────────────────────────────────────────────────────────────
let capturedDpr    = 1;   // set during stitch; used by crop tool for coord mapping
let isCropMode     = false;
let cropRect       = null; // { x, y, w, h } in canvas CSS pixels

// Snapshot of the canvas taken immediately before the first crop is applied,
// so Undo Crop can restore the original full-page image.
let precropSnapshot = null; // { width, height, styleWidth, styleHeight, infoText, offscreen }

function savePreCropSnapshot() {
  // Only save once — undo always goes back to the original full-page view.
  if (precropSnapshot) return;
  const oc = new OffscreenCanvas(canvas.width, canvas.height);
  oc.getContext('2d').drawImage(canvas, 0, 0);
  precropSnapshot = {
    width:       canvas.width,
    height:      canvas.height,
    styleWidth:  canvas.style.width,
    styleHeight: canvas.style.height,
    infoText:    infoEl.textContent,
    offscreen:   oc,
  };
}

function restorePreCropSnapshot() {
  if (!precropSnapshot) return;
  const s = precropSnapshot;
  canvas.width  = s.width;
  canvas.height = s.height;
  canvas.style.width  = s.styleWidth;
  canvas.style.height = s.styleHeight;
  canvas.getContext('2d').drawImage(s.offscreen, 0, 0);
  infoEl.textContent = s.infoText;
  precropSnapshot = null;
  btnUndoCrop.style.display = 'none';
  showToast('Crop undone — showing full page', 'success');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const params    = new URLSearchParams(window.location.search);
  const captureId = params.get('id');
  if (!captureId) return showError('No capture ID found in URL.');

  setStatus('Retrieving screenshot data…', 5);

  const data = await fetchFromBackground(captureId);
  if (!data) return showError(
    'Screenshot data not found. The capture may have failed or the background was restarted. Please try capturing again.'
  );

  const { screenshots, pageInfo } = data;
  await stitch(screenshots, pageInfo);
});

// ── Fetch from background ─────────────────────────────────────────────────────
function fetchFromBackground(captureId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'GET_CAPTURE_DATA', captureId }, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp ?? null);
    });
  });
}

// ── Stitching ─────────────────────────────────────────────────────────────────
async function stitch(screenshots, pageInfo) {
  const { pageHeight, vpWidth, vpHeight } = pageInfo;
  // Optional crop region (physical px) for element captures
  const hasCrop = pageInfo.cropX !== undefined;

  setStatus('Stitching section 1…', 5);

  // Derive the actual DPR from the first screenshot's pixel dimensions.
  const firstImg    = await loadImage(screenshots[0].dataUrl);
  capturedDpr       = firstImg.width / (hasCrop ? pageInfo.cropW / (window.devicePixelRatio || 1) : vpWidth);

  // Physical canvas size.
  // For the full-page case we cap canvasH to the range actually captured:
  // (lastScrollY + vpHeight) × dpr.  This prevents a large blank strip at the
  // bottom when ad-hiding caused the page to shrink after the initial
  // pageHeight measurement (the pageInfo value may be over-tall).
  const lastShot   = screenshots[screenshots.length - 1];
  const capturedH  = Math.ceil((lastShot.scrollY + vpHeight) * capturedDpr);

  const canvasW = hasCrop ? pageInfo.cropW : firstImg.width;
  const canvasH = hasCrop
    ? Math.ceil(pageInfo.pageHeight * (pageInfo.cropH / vpHeight))
    : Math.min(Math.ceil(pageHeight * capturedDpr), capturedH);

  canvas.width  = canvasW;
  canvas.height = canvasH;

  // Logical (CSS) display size — for full-page, derive from capped canvas height
  // so the CSS size stays in sync with the physical pixel canvas.
  const displayW = hasCrop ? pageInfo.vpWidth  : vpWidth;
  const displayH = hasCrop
    ? pageInfo.pageHeight
    : Math.round(canvasH / capturedDpr);   // physical → logical
  canvas.style.width  = displayW + 'px';
  canvas.style.height = displayH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // When the capture was for a specific element, derive the DPR from crop dims
  const effectiveDpr = hasCrop
    ? pageInfo.cropH / vpHeight   // physical crop height / logical viewport height
    : capturedDpr;

  // Draw first section
  let prevImg     = firstImg;
  let prevScrollY = screenshots[0].scrollY;
  drawSection(ctx, prevImg, Math.round(prevScrollY * effectiveDpr), canvasW, canvasH,
              hasCrop ? pageInfo : null);

  // Pre-load next image in the background
  let nextImgPromise = screenshots.length > 1
    ? loadImage(screenshots[1].dataUrl)
    : Promise.resolve(null);

  for (let i = 1; i < screenshots.length; i++) {
    const { scrollY } = screenshots[i];

    setStatus(
      `Stitching section ${i + 1} of ${screenshots.length}…`,
      5 + ((i + 1) / screenshots.length) * 92
    );

    const afterNextPromise = i + 1 < screenshots.length
      ? loadImage(screenshots[i + 1].dataUrl)
      : Promise.resolve(null);

    const img = await nextImgPromise;
    nextImgPromise = afterNextPromise;

    const nominalDestY = Math.round(scrollY * effectiveDpr);
    const delta = hasCrop
      ? 0  // element scroll positions are precise; skip alignment for element captures
      : await findAlignmentDelta(prevImg, img, prevScrollY, scrollY, vpHeight, capturedDpr);

    drawSection(ctx, img, nominalDestY + delta, canvasW, canvasH,
                hasCrop ? pageInfo : null);

    prevImg     = img;
    prevScrollY = scrollY;
    await tick();
  }

  // ── Show result ────────────────────────────────────────────────────────────
  statusWrap.style.display = 'none';
  canvasWrap.style.display = 'flex';
  infoEl.textContent =
    `${Math.round(displayW)} × ${Math.round(displayH)} px  •  ${screenshots.length} section${screenshots.length !== 1 ? 's' : ''} captured`;

  enableButtons(pageInfo);
}

/**
 * Draw one captured screenshot section onto the canvas.
 *
 * When cropInfo is provided (element capture), each screenshot is the full
 * viewport — we extract just the element's rectangle before drawing.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement}         img
 * @param {number}                   destYPhys  physical Y on canvas to draw at
 * @param {number}                   canvasW
 * @param {number}                   canvasH
 * @param {object|null}              cropInfo   pageInfo with cropX/Y/W/H, or null
 */
function drawSection(ctx, img, destYPhys, canvasW, canvasH, cropInfo) {
  if (cropInfo) {
    // Source: crop the element's region out of the full-viewport screenshot
    const { cropX, cropY, cropW, cropH } = cropInfo;
    const maxH    = canvasH - destYPhys;
    if (maxH <= 0) return;
    const drawH   = Math.min(cropH, maxH);
    ctx.drawImage(img, cropX, cropY, cropW, drawH, 0, destYPhys, canvasW, drawH);
  } else {
    const maxH  = canvasH - destYPhys;
    if (maxH <= 0) return;
    const drawH = Math.min(img.height, maxH);
    ctx.drawImage(img, 0, 0, img.width, drawH, 0, destYPhys, canvasW, drawH);
  }
}

// ── Alignment verification ─────────────────────────────────────────────────────
/**
 * Compare the shared overlap zone between consecutive screenshots.
 * Returns a vertical physical-pixel correction (+ = push section lower).
 *
 * See full comment in previous version for algorithm details.
 */
async function findAlignmentDelta(imgPrev, imgCurr, scrollPrev, scrollCurr, vpHeight, dpr) {
  // ±12 px search window (was ±8).  Wired-style hero images and JS parallax
  // can produce misalignments up to ~10–11 physical pixels; raising the cap
  // finds the true minimum without meaningfully slowing the comparison.
  const MAX_PX   = 12;
  const DIFF_CAP = 150;

  const overlapLogical = (scrollPrev + vpHeight) - scrollCurr;
  const overlapH = Math.round(overlapLogical * dpr);
  if (overlapH < 8) return 0;

  const skipH    = Math.floor(overlapH * 0.20);
  const midH     = overlapH - 2 * skipH;
  const compareH = Math.min(midH, 80); // more rows → more stable score
  if (compareH < 4) return 0;

  const w = Math.min(imgPrev.width, imgCurr.width);

  const prevSrcY = imgPrev.height - overlapH + skipH;
  if (prevSrcY < 0 || prevSrcY + compareH > imgPrev.height) return 0;

  const tmpPrev = new OffscreenCanvas(w, compareH);
  const ctxPrev = tmpPrev.getContext('2d');
  ctxPrev.drawImage(imgPrev, 0, prevSrcY, imgPrev.width, compareH, 0, 0, w, compareH);
  const dataPrev = ctxPrev.getImageData(0, 0, w, compareH).data;

  const currSrcY  = skipH;
  const readH     = compareH + MAX_PX;
  const safeReadH = Math.min(readH, imgCurr.height - currSrcY);
  if (safeReadH < compareH) return 0;

  const tmpCurr = new OffscreenCanvas(w, readH);
  const ctxCurr = tmpCurr.getContext('2d');
  ctxCurr.drawImage(imgCurr, 0, currSrcY, imgCurr.width, safeReadH, 0, 0, w, safeReadH);
  const dataCurr = ctxCurr.getImageData(0, 0, w, readH).data;

  const stride = Math.max(1, Math.floor(w / 80));
  let bestDelta = 0;
  let bestScore = Infinity;

  for (let delta = -MAX_PX; delta <= MAX_PX; delta++) {
    const prevRow0 = Math.max(0, -delta);
    const currRow0 = Math.max(0,  delta);
    const cmpH     = compareH - Math.abs(delta);
    if (cmpH < 4) continue;

    let total = 0, count = 0;
    for (let y = 0; y < cmpH; y += 2) {
      for (let x = 0; x < w; x += stride) {
        const pi = ((prevRow0 + y) * w + x) * 4;
        const ci = ((currRow0 + y) * w + x) * 4;
        if (pi + 2 < dataPrev.length && ci + 2 < dataCurr.length) {
          total += Math.min(
            Math.abs(dataPrev[pi]   - dataCurr[ci])
          + Math.abs(dataPrev[pi+1] - dataCurr[ci+1])
          + Math.abs(dataPrev[pi+2] - dataCurr[ci+2]),
            DIFF_CAP
          );
          count++;
        }
      }
    }

    const score = count > 0 ? total / count : Infinity;
    if (score < bestScore) { bestScore = score; bestDelta = delta; }
  }

  return bestDelta;
}

// ── Export buttons ────────────────────────────────────────────────────────────
function enableButtons(pageInfo) {
  [btnCrop, btnCopy, btnPng, btnJpeg, btnPdf].forEach((b) => (b.disabled = false));
  rngQuality.disabled = false;

  const host     = pageInfo.hostname ? pageInfo.hostname.replace(/[^a-z0-9.-]/gi, '-') : '';
  const fileBase = `fullsnap${host ? '-' + host : ''}-${Date.now()}`;

  // ── Quality slider ────────────────────────────────────────────────────────
  rngQuality.addEventListener('input', () => {
    qualityLabel.textContent = rngQuality.value + '%';
  });

  // ── Copy ──────────────────────────────────────────────────────────────────
  btnCopy.addEventListener('click', async () => {
    try {
      const blob = await canvasToBlob(canvas, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Copied to clipboard!', 'success');
    } catch (err) {
      showToast('Copy failed: ' + err.message, 'error');
    }
  });

  // ── PNG ───────────────────────────────────────────────────────────────────
  btnPng.addEventListener('click', () => {
    const a    = document.createElement('a');
    a.download = `${fileBase}.png`;
    a.href     = canvas.toDataURL('image/png');
    a.click();
    showToast('PNG downloaded!', 'success');
  });

  // ── JPEG ──────────────────────────────────────────────────────────────────
  btnJpeg.addEventListener('click', () => {
    const quality = parseInt(rngQuality.value, 10) / 100;
    // JPEG doesn't support transparency; fill a white background first
    const tmp     = document.createElement('canvas');
    tmp.width     = canvas.width;
    tmp.height    = canvas.height;
    const tmpCtx  = tmp.getContext('2d');
    tmpCtx.fillStyle = '#ffffff';
    tmpCtx.fillRect(0, 0, tmp.width, tmp.height);
    tmpCtx.drawImage(canvas, 0, 0);
    const a    = document.createElement('a');
    a.download = `${fileBase}.jpg`;
    a.href     = tmp.toDataURL('image/jpeg', quality);
    a.click();
    showToast(`JPEG downloaded (${rngQuality.value}% quality)!`, 'success');
  });

  // ── PDF ───────────────────────────────────────────────────────────────────
  btnPdf.addEventListener('click', () => {
    try {
      exportPDF(canvas, pageInfo, fileBase);
      showToast('PDF downloaded!', 'success');
    } catch (err) {
      showToast('PDF export failed: ' + err.message, 'error');
    }
  });

  // ── Undo Crop ─────────────────────────────────────────────────────────────
  btnUndoCrop.addEventListener('click', restorePreCropSnapshot);

  // ── Crop ──────────────────────────────────────────────────────────────────
  btnCrop.addEventListener('click', () => {
    if (isCropMode) {
      exitCropMode();
    } else {
      enterCropMode();
    }
  });
}

// ── PDF export ────────────────────────────────────────────────────────────────
function exportPDF(canvas, pageInfo, fileBase) {
  if (!window.jspdf) throw new Error('jsPDF library not loaded');
  const { jsPDF } = window.jspdf;

  const imgData = canvas.toDataURL('image/jpeg', 0.88);
  const px2mm   = 25.4 / 96;
  const { vpWidth, pageHeight } = pageInfo;
  const mmW = vpWidth    * px2mm;
  const mmH = pageHeight * px2mm;

  const doc = new jsPDF({
    orientation: mmW > mmH ? 'landscape' : 'portrait',
    unit:        'mm',
    format:      [mmW, mmH],
    compress:    true,
  });
  doc.addImage(imgData, 'JPEG', 0, 0, mmW, mmH, '', 'FAST');
  doc.save(`${fileBase ?? ('fullsnap-' + Date.now())}.pdf`);
}

// ── Crop tool ─────────────────────────────────────────────────────────────────

function enterCropMode() {
  isCropMode = true;
  cropRect   = null;
  btnCrop.classList.add('btn-active');
  btnCrop.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
    Cancel Crop`;

  // Swap toolbar: hide export buttons, show crop confirm/cancel
  actionsEl.style.display          = 'none';
  cropToolbarActions.style.display = 'flex';
  cropToolbarHint.textContent      = 'Drag to select a region';
  btnCropConfirm.disabled          = true;

  // Position the overlay exactly over the canvas
  // (canvas-wrap is position:relative, so offsetLeft/Top are relative to it)
  cropOverlay.style.left   = canvas.offsetLeft   + 'px';
  cropOverlay.style.top    = canvas.offsetTop    + 'px';
  cropOverlay.style.width  = canvas.offsetWidth  + 'px';
  cropOverlay.style.height = canvas.offsetHeight + 'px';

  cropInstruction.style.display = 'block';
  cropOverlay.style.display     = 'block';
  cropSelection.style.display   = 'none';
  cropDims.textContent          = '';

  cropOverlay.addEventListener('mousedown', onCropMouseDown);
  btnCropConfirm.addEventListener('click', applyCrop, { once: true });
  btnCropCancel.addEventListener('click',  exitCropMode, { once: true });

  // Keyboard shortcuts: Enter = apply crop, Escape = cancel
  document.addEventListener('keydown', onCropKey);
}

function onCropKey(e) {
  if (e.key === 'Escape') {
    exitCropMode();
  } else if (e.key === 'Enter') {
    // Only apply if a valid selection exists
    if (cropRect && cropRect.w > 4 && cropRect.h > 4) {
      applyCrop();
    }
  }
}

function exitCropMode() {
  isCropMode = false;
  cropRect   = null;
  btnCrop.classList.remove('btn-active');
  btnCrop.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="6 2 6 8 2 8"/><polyline points="18 22 18 16 22 16"/>
      <path d="M6 8L2 8"/><path d="M18 16l4 0"/>
      <rect x="6" y="8" width="12" height="8" rx="1"/>
    </svg>
    Crop`;

  // Restore toolbar: show export buttons, hide crop confirm/cancel
  actionsEl.style.display          = 'flex';
  cropToolbarActions.style.display = 'none';

  cropOverlay.style.display     = 'none';
  cropSelection.style.display   = 'none';
  cropInstruction.style.display = 'none';
  cropDims.textContent          = '';

  // Remove any lingering listeners
  cropOverlay.removeEventListener('mousedown', onCropMouseDown);
  btnCropConfirm.removeEventListener('click', applyCrop);
  btnCropCancel.removeEventListener('click',  exitCropMode);
  document.removeEventListener('keydown', onCropKey);
}

function onCropMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();

  const overlayRect = cropOverlay.getBoundingClientRect();
  const startX = e.clientX - overlayRect.left;
  const startY = e.clientY - overlayRect.top;
  const overlayW = overlayRect.width;
  const overlayH = overlayRect.height;

  // Hide the "how to use" badge once the user starts dragging
  cropInstruction.style.display = 'none';
  cropSelection.style.display   = 'block';
  cropToolbarHint.textContent   = 'Drag to adjust selection';
  btnCropConfirm.disabled       = true;

  // Physical-pixel scale factors (for the dimension readout)
  const scaleX = canvas.width  / overlayW;
  const scaleY = canvas.height / overlayH;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function updateRect(curX, curY) {
    const x = clamp(Math.min(startX, curX), 0, overlayW);
    const y = clamp(Math.min(startY, curY), 0, overlayH);
    const w = clamp(Math.abs(curX - startX), 0, overlayW - x);
    const h = clamp(Math.abs(curY - startY), 0, overlayH - y);

    cropSelection.style.left   = x + 'px';
    cropSelection.style.top    = y + 'px';
    cropSelection.style.width  = w + 'px';
    cropSelection.style.height = h + 'px';

    // Show live pixel dimensions inside the selection box
    const pw = Math.round(w * scaleX);
    const ph = Math.round(h * scaleY);
    cropDims.textContent = pw > 0 && ph > 0 ? `${pw} × ${ph}` : '';

    cropRect = { x, y, w, h };
  }

  function onMove(e) {
    const cx = e.clientX - overlayRect.left;
    const cy = e.clientY - overlayRect.top;
    updateRect(cx, cy);
  }

  function onUp(e) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);

    const cx = e.clientX - overlayRect.left;
    const cy = e.clientY - overlayRect.top;
    updateRect(cx, cy);

    if (cropRect && cropRect.w > 4 && cropRect.h > 4) {
      cropToolbarHint.textContent = 'Drag again to adjust — or:';
      btnCropConfirm.disabled     = false;
    } else {
      cropRect = null;
      cropDims.textContent          = '';
      cropSelection.style.display   = 'none';
      cropToolbarHint.textContent   = 'Drag to select a region';
      cropInstruction.style.display = 'block';
    }
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
}

function applyCrop() {
  if (!cropRect || cropRect.w <= 0 || cropRect.h <= 0) return;

  // Save the full-page canvas BEFORE the first crop so Undo can restore it.
  savePreCropSnapshot();

  // The overlay has the same CSS dimensions as the canvas.
  // Convert CSS pixel selection to physical canvas pixels.
  const scaleX = canvas.width  / parseFloat(canvas.style.width  || canvas.width);
  const scaleY = canvas.height / parseFloat(canvas.style.height || canvas.height);

  const sx = Math.round(cropRect.x * scaleX);
  const sy = Math.round(cropRect.y * scaleY);
  const sw = Math.round(cropRect.w * scaleX);
  const sh = Math.round(cropRect.h * scaleY);

  // Copy the selected region to a temporary canvas before resizing the main one.
  const tmp = new OffscreenCanvas(sw, sh);
  tmp.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

  // Resize main canvas and paint the cropped region.
  canvas.width  = sw;
  canvas.height = sh;
  canvas.style.width  = cropRect.w + 'px';
  canvas.style.height = cropRect.h + 'px';
  canvas.getContext('2d').drawImage(tmp, 0, 0);

  infoEl.textContent = `${sw} × ${sh} px  •  cropped`;

  // Show Undo Crop button so the user can get back to the full view.
  btnUndoCrop.style.display = 'inline-flex';

  exitCropMode();
  showToast('Crop applied! Click Undo Crop to revert.', 'success');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img    = new Image();
    img.onload   = () => resolve(img);
    img.onerror  = () => reject(new Error('Failed to decode screenshot image'));
    img.src      = src;
  });
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      type
    );
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(msg, pct) {
  statusMsg.textContent   = msg;
  progressBar.style.width = (pct ?? 0) + '%';
}

function showError(msg) {
  statusWrap.style.display = 'none';
  canvasWrap.style.display = 'none';
  errorWrap.style.display  = 'flex';
  errorMsg.textContent     = msg;
}

let toastTimer = null;
function showToast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className   = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 2800);
}

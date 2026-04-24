// popup.js — FullSnap Popup

'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const viewIdle      = document.getElementById('view-idle');
const viewCapturing = document.getElementById('view-capturing');
const viewDone      = document.getElementById('view-done');
const viewError     = document.getElementById('view-error');

const btnCapture     = document.getElementById('btn-capture');
const btnPickElement = document.getElementById('btn-pick-element');
const chkHideAds     = document.getElementById('chk-hide-ads');
const selDelay       = document.getElementById('sel-delay');
const btnStop        = document.getElementById('btn-stop');
const btnRetry       = document.getElementById('btn-retry');
const progressFill   = document.getElementById('progress-fill');
const progressLabel  = document.getElementById('progress-label');
const progressCount  = document.getElementById('progress-count');
const progressEta    = document.getElementById('progress-eta');
const errorMsg       = document.getElementById('error-msg');

// Countdown ring
const countdownRing = document.getElementById('countdown-ring');
const countdownArc  = document.getElementById('countdown-arc');
const countdownNum  = document.getElementById('countdown-num');

const CIRCUMFERENCE = 138.2; // 2π × 22  (matches SVG r="22")

// ── State machine ─────────────────────────────────────────────────────────────
function showView(name) {
  viewIdle.style.display      = name === 'idle'      ? 'block' : 'none';
  viewCapturing.style.display = name === 'capturing' ? 'block' : 'none';
  viewDone.style.display      = name === 'done'      ? 'flex'  : 'none';
  viewError.style.display     = name === 'error'     ? 'flex'  : 'none';
}

// For live time-estimate calculation
let captureStartTime     = null;
let firstCaptureCurrent  = null;

// Track whether we set the ring to its starting position yet (so we can
// animate from full → depleting rather than from empty → full on first update)
let countdownInitialized = false;

function applyProgress(p) {
  if (!p) { showView('idle'); return; }

  switch (p.status) {

    case 'starting':
      showView('capturing');
      countdownRing.style.display = 'none';
      countdownInitialized = false;
      progressLabel.textContent = 'Preparing capture…';
      progressFill.style.width  = '2%';
      progressCount.textContent = '';
      progressEta.textContent   = '';
      captureStartTime    = null;
      firstCaptureCurrent = null;
      break;

    case 'countdown': {
      showView('capturing');
      countdownRing.style.display = 'block';
      progressLabel.textContent   = 'Starting in…';
      progressFill.style.width    = '0%';
      progressCount.textContent   = '';
      progressEta.textContent     = '';

      const { remaining, total } = p;
      countdownNum.textContent = remaining;

      // fraction of time remaining: 1.0 at start, ~0 at launch
      // dashoffset 0 = full circle, CIRCUMFERENCE = empty
      const fraction = remaining / total;
      const offset   = (CIRCUMFERENCE * (1 - fraction)).toFixed(2);

      if (!countdownInitialized) {
        // First update — jump straight to full without the CSS transition
        // so the user sees a filled ring immediately rather than a sweep.
        countdownArc.style.transition = 'none';
        countdownArc.style.strokeDashoffset = '0';
        // Force a reflow so the browser registers the property before we
        // re-enable the transition for subsequent updates.
        void countdownArc.getBoundingClientRect();
        countdownArc.style.transition = '';
        countdownInitialized = true;
        // If there is already some depletion (e.g. popup reopened mid-countdown),
        // apply the correct offset after a tick so the transition fires properly.
        if (remaining < total) {
          requestAnimationFrame(() => {
            countdownArc.style.strokeDashoffset = offset;
          });
        }
      } else {
        countdownArc.style.strokeDashoffset = offset;
      }
      break;
    }

    case 'selecting':
      showView('capturing');
      countdownRing.style.display = 'none';
      countdownInitialized = false;
      progressLabel.textContent   = 'Click an element on the page…';
      progressFill.style.width    = '5%';
      progressCount.textContent   = '';
      progressEta.textContent     = '';
      break;

    case 'loading':
      showView('capturing');
      countdownRing.style.display = 'none';
      progressLabel.textContent   = p.label || 'Loading page content…';
      progressFill.style.width    = '15%';
      progressCount.textContent   = '';
      progressEta.textContent     = '';
      break;

    case 'capturing': {
      showView('capturing');
      countdownRing.style.display = 'none';
      const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
      progressLabel.textContent = 'Capturing sections…';
      progressFill.style.width  = pct + '%';
      progressCount.textContent = `${p.current} / ${p.total}`;

      // ── Time estimate ────────────────────────────────────────────────────
      // Computed from measured pace rather than a fixed per-section guess.
      if (!captureStartTime) {
        captureStartTime    = Date.now();
        firstCaptureCurrent = p.current;
        progressEta.textContent = '';
      } else {
        const elapsedSec = (Date.now() - captureStartTime) / 1000;
        const done       = p.current - firstCaptureCurrent;
        if (done > 0) {
          const secPerSection = elapsedSec / done;
          const remSections   = p.total - p.current;
          const remSec        = Math.ceil(remSections * secPerSection);
          progressEta.textContent = remSec > 0 ? `~${remSec}s remaining` : '';
        }
      }
      break;
    }

    case 'complete':
      showView('done');
      setTimeout(() => window.close(), 1800);
      break;

    case 'error':
      showView('error');
      errorMsg.textContent = p.error || 'An unexpected error occurred.';
      break;
  }
}

// ── Preferences ───────────────────────────────────────────────────────────────
chrome.storage.local.get(['hideAds', 'captureDelay'], (res) => {
  chkHideAds.checked = res.hideAds    ?? false;
  selDelay.value     = String(res.captureDelay ?? 0);
});

chkHideAds.addEventListener('change', () => {
  chrome.storage.local.set({ hideAds: chkHideAds.checked });
});

selDelay.addEventListener('change', () => {
  chrome.storage.local.set({ captureDelay: parseInt(selDelay.value, 10) });
});

// ── Capture full page ─────────────────────────────────────────────────────────
btnCapture.addEventListener('click', () => {
  const delay = parseInt(selDelay.value, 10) || 0;
  if (delay > 0) {
    applyProgress({ status: 'countdown', remaining: delay, total: delay });
  } else {
    applyProgress({ status: 'starting' });
  }
  chrome.runtime.sendMessage({
    action:  'INITIATE_CAPTURE',
    hideAds: chkHideAds.checked,
    delay,
  });
});

// ── Pick scrollable element ───────────────────────────────────────────────────
btnPickElement.addEventListener('click', () => {
  applyProgress({ status: 'selecting' });
  chrome.runtime.sendMessage({
    action:  'PICK_ELEMENT',
    hideAds: chkHideAds.checked,
  });
});

// ── Stop ──────────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' });
  countdownInitialized = false;
  showView('idle');
  btnCapture.focus();
});

// ── Retry ─────────────────────────────────────────────────────────────────────
btnRetry.addEventListener('click', () => {
  chrome.storage.session.remove('fullsnapProgress');
  countdownInitialized = false;
  showView('idle');
  btnCapture.focus();
});

// ── Live progress via storage.onChanged ──────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.fullsnapProgress) return;
  applyProgress(changes.fullsnapProgress.newValue ?? null);
});

// ── On open: resume any in-flight capture ────────────────────────────────────
chrome.storage.session.get('fullsnapProgress', (result) => {
  const p = result.fullsnapProgress;
  if (p && ['starting', 'loading', 'capturing', 'countdown', 'selecting'].includes(p.status)) {
    applyProgress(p);
  } else {
    showView('idle');
    btnCapture.focus();
  }
});

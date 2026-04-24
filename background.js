// background.js — FullSnap Service Worker

'use strict';

// ── In-memory screenshot store ────────────────────────────────────────────────
const captureStore = new Map();   // captureId → { screenshots, pageInfo }

// ── Track which tab is currently being captured (needed for Stop) ─────────────
let currentCaptureTabId = null;

// ── Countdown cancellation flag ───────────────────────────────────────────────
let cancelCountdown = false;

// ── Service-worker keep-alive ─────────────────────────────────────────────────
let keepAliveTimer = null;
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
}
function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ── Progress helpers (popup watches via storage.onChanged) ────────────────────
function setProgress(obj) { chrome.storage.session.set({ fullsnapProgress: obj }); }
function clearProgress()  { chrome.storage.session.remove('fullsnapProgress'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {

  // Popup → start full-page capture (with optional delay)
  if (msg.action === 'INITIATE_CAPTURE') {
    const opts  = { hideAds: msg.hideAds ?? false };
    const delay = Math.max(0, parseInt(msg.delay ?? 0, 10));
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) runWithDelay(tab, opts, delay);
    });
    respond({ ok: true });
    return false;
  }

  // Popup → start element picker (no delay; capture fires after user picks)
  if (msg.action === 'PICK_ELEMENT') {
    const opts = { hideAds: msg.hideAds ?? false };
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) startElementPicker(tab, opts);
    });
    respond({ ok: true });
    return false;
  }

  // Popup → stop capture (also cancels any active countdown)
  if (msg.action === 'STOP_CAPTURE') {
    cancelCountdown = true;
    if (currentCaptureTabId !== null) {
      // Signal the content script loop to exit
      chrome.scripting.executeScript({
        target: { tabId: currentCaptureTabId },
        func: () => { window.__fullSnapCancelled = true; },
      }).catch(() => {});
    }
    currentCaptureTabId = null;
    stopKeepAlive();
    clearProgress();
    respond({ ok: true });
    return false;
  }

  // Content script → take a screenshot of the current viewport
  if (msg.action === 'CAPTURE_SCREENSHOT') {
    if (!sender.tab) { respond({ error: 'No sender tab' }); return false; }
    chrome.tabs.captureVisibleTab(
      sender.tab.windowId,
      { format: 'png' },
      (dataUrl) => {
        if (chrome.runtime.lastError) respond({ error: chrome.runtime.lastError.message });
        else respond({ dataUrl });
      }
    );
    return true;   // keep channel open for async response
  }

  // Content script → phase label (e.g. "Loading page content…")
  if (msg.action === 'CAPTURE_STATUS') {
    setProgress({ status: 'loading', label: msg.label });
    respond({ ok: true });
    return false;
  }

  // Content script → per-section progress
  if (msg.action === 'CAPTURE_PROGRESS') {
    setProgress({ status: 'capturing', current: msg.current, total: msg.total });
    respond({ ok: true });
    return false;
  }

  // Content script → all sections captured
  if (msg.action === 'CAPTURE_COMPLETE') {
    const captureId = Date.now().toString();
    captureStore.set(captureId, { screenshots: msg.screenshots, pageInfo: msg.pageInfo });

    setProgress({ status: 'complete' });
    setTimeout(clearProgress, 4_000);

    chrome.tabs.create({ url: chrome.runtime.getURL(`preview.html?id=${captureId}`) });

    currentCaptureTabId = null;
    stopKeepAlive();
    respond({ ok: true });
    return false;
  }

  // Content script → error
  if (msg.action === 'CAPTURE_ERROR') {
    setProgress({ status: 'error', error: msg.error });
    currentCaptureTabId = null;
    stopKeepAlive();
    respond({ ok: true });
    return false;
  }

  // Preview page → fetch screenshot data
  if (msg.action === 'GET_CAPTURE_DATA') {
    const data = captureStore.get(msg.captureId) ?? null;
    captureStore.delete(msg.captureId);
    respond(data);
    return true;
  }
});

// ── Delay countdown then initiate capture ─────────────────────────────────────
async function runWithDelay(tab, opts, delay) {
  cancelCountdown = false;

  if (delay > 0) {
    // Emit the first countdown tick immediately (remaining = delay)
    setProgress({ status: 'countdown', remaining: delay, total: delay });

    for (let t = delay - 1; t >= 0; t--) {
      await sleep(1000);
      if (cancelCountdown) return;

      if (t > 0) {
        setProgress({ status: 'countdown', remaining: t, total: delay });
      }
      // t === 0 means countdown finished — fall through to capture
    }

    if (cancelCountdown) return;
  }

  await initiateCapture(tab, opts);
}

// ── Element picker orchestration ──────────────────────────────────────────────
async function startElementPicker(tab, opts) {
  if (!tab?.id) return;
  if (
    !tab.url ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('edge://') ||
    tab.url.startsWith('about:')
  ) {
    setProgress({ status: 'error', error: 'Cannot capture browser system pages.' });
    return;
  }

  currentCaptureTabId = tab.id;
  startKeepAlive();
  setProgress({ status: 'selecting' });

  try {
    // Inject content script (idempotent if already injected)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });

    // Launch the picker mode; capture fires once user clicks an element
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (captureOpts) => {
        if (window.__fullSnapPickerRunning || window.__fullSnapRunning) return;
        window.__fullSnapPickerRunning = true;
        window.__fullSnapCancelled    = false;
        startPickerMode(captureOpts)
          .catch((err) =>
            chrome.runtime.sendMessage({ action: 'CAPTURE_ERROR', error: err.message })
          )
          .finally(() => { window.__fullSnapPickerRunning = false; });
      },
      args: [opts],
    });
  } catch (err) {
    setProgress({ status: 'error', error: err.message });
    currentCaptureTabId = null;
    stopKeepAlive();
  }
}

// ── Full-page capture orchestration ──────────────────────────────────────────
async function initiateCapture(tab, opts = {}) {
  if (!tab?.id) return;

  if (
    !tab.url ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('edge://') ||
    tab.url.startsWith('about:')
  ) {
    setProgress({ status: 'error', error: 'Cannot capture browser system pages.' });
    return;
  }

  const existing = await chrome.storage.session.get('fullsnapProgress');
  if (
    existing.fullsnapProgress?.status === 'capturing' ||
    existing.fullsnapProgress?.status === 'loading'
  ) return;

  currentCaptureTabId = tab.id;
  startKeepAlive();
  setProgress({ status: 'starting' });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (captureOpts) => {
        if (window.__fullSnapRunning) return;
        window.__fullSnapCancelled = false;
        window.__fullSnapRunning   = true;
        captureFullPage(captureOpts)
          .catch((err) =>
            chrome.runtime.sendMessage({ action: 'CAPTURE_ERROR', error: err.message })
          )
          .finally(() => { window.__fullSnapRunning = false; });
      },
      args: [opts],
    });
  } catch (err) {
    setProgress({ status: 'error', error: err.message });
    currentCaptureTabId = null;
    stopKeepAlive();
  }
}

/* bridge-app.js
   Runs on YOUR Vocab Register app page (edit "matches" in manifest.json
   to your app's real URL — see the comment there).

   Content scripts and the page's own scripts run in separate JS worlds
   and can't call each other's functions directly, even though they
   share the same DOM. This file is the relay:
     - extension -> page:  chrome.runtime.onMessage  -->  window.postMessage
     - page -> extension:  window.addEventListener("message")  -->  chrome.runtime.sendMessage
   script.js never touches chrome.* directly, so your app keeps working
   with the extension uninstalled — it just won't get Gemini data. */

console.log("[VocabBridge:bridge-app] Content script loaded on:", window.location.href);

// --- extension -> page ---------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GEMINI_ENTRY_SCRAPED") {
    console.log("[VocabBridge:bridge-app] Received GEMINI_ENTRY_SCRAPED from background.js, relaying to page:", message.payload);
    window.postMessage({ type: "GEMINI_ENTRY_SCRAPED", payload: message.payload }, window.location.origin);
    sendResponse({ ok: true });
  }

  if (message?.type === "YOUTUBE_VIDEO_SELECTED") {
    console.log("[VocabBridge:bridge-app] Received YOUTUBE_VIDEO_SELECTED from background.js, relaying to page:", message.payload);
    window.postMessage({ type: "YOUTUBE_VIDEO_SELECTED", payload: message.payload }, window.location.origin);
    sendResponse({ ok: true });
  }
});

// --- page -> extension -----------------------------------------------
// chrome.runtime.sendMessage() throws SYNCHRONOUSLY (not a rejected
// promise) when this content script has been orphaned — e.g. the
// extension was reloaded/updated in chrome://extensions while this tab
// was already open. A plain ".catch()" on the return value never runs
// in that case, since the call never gets far enough to return a
// promise — so this wraps every call in a real try/catch, and tells
// the app page so it can show something better than silent nothing.
function safeSendMessage(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.then === "function") {
      result.catch(() => notifyDisconnected());
    }
  } catch (err) {
    notifyDisconnected();
  }
}

function notifyDisconnected() {
  window.postMessage({ type: "GEMINI_BRIDGE_DISCONNECTED" }, window.location.origin);
}

// Waits to hear script.js's APP_READY handshake before registering this
// tab with background.js — background.js queues any Gemini scrape that
// arrives earlier and flushes it the moment APP_BRIDGE_READY lands.
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) return;

  if (event.data.type === "APP_READY") {
    console.log("[VocabBridge:bridge-app] Saw APP_READY from the page, registering with background.js...");
    safeSendMessage({ type: "APP_BRIDGE_READY" });
    // Acknowledge immediately — this confirms bridge-app.js is actually
    // listening, closing the race where script.js's handshake could
    // otherwise fire before this content script finished initializing.
    window.postMessage({ type: "APP_READY_ACK" }, window.location.origin);
    console.log("[VocabBridge:bridge-app] Sent APP_READY_ACK back to the page.");
  }

  if (event.data.type === "SEARCH_GEMINI" && typeof event.data.word === "string") {
    safeSendMessage({ type: "SEARCH_GEMINI", word: event.data.word, bookTitle: event.data.bookTitle || "" });
  }

  // "Restart Gemini Tab" — close whatever Gemini tab(s) are open and
  // open a fresh one. If script.js had a word (and optional book title)
  // pending, they're passed through so background.js can type the
  // prompt into the new tab once it's ready — same as a normal Search
  // Gemini, just after a clean restart.
  if (event.data.type === "RESTART_GEMINI_TAB") {
    safeSendMessage({
      type: "RESTART_GEMINI_TAB",
      word: event.data.word || "",
      bookTitle: event.data.bookTitle || "",
    });
  }

  // "Search on YouTube.com" (YouTube Window's 🌐 button) — opens/reuses
  // a real youtube.com tab and shows results for this query. Picking a
  // video there comes back as a YOUTUBE_VIDEO_SELECTED message above.
  if (event.data.type === "YOUTUBE_SEARCH_EXTERNAL" && typeof event.data.query === "string") {
    safeSendMessage({ type: "YOUTUBE_SEARCH_EXTERNAL", query: event.data.query });
  }

  // Keyboard-shortcut tab switching (see the "CUSTOMIZABLE KEYBOARD
  // SHORTCUT SYSTEM" block in script.js): "Focus Gemini Tab" just needs
  // background.js to switch to an already-open Gemini tab, and the
  // current key bindings get synced to chrome.storage.local so
  // content-gemini.js can listen for the same "return to app" key while
  // sitting on Gemini's own tab.
  if (event.data.type === "FOCUS_GEMINI_TAB") {
    safeSendMessage({ type: "FOCUS_GEMINI_TAB" });
  }

  if (event.data.type === "FOCUS_YOUTUBE_TAB") {
    safeSendMessage({ type: "FOCUS_YOUTUBE_TAB" });
  }

  if (event.data.type === "SYNC_SHORTCUT_KEYS") {
    safeSendMessage({
      type: "SYNC_SHORTCUT_KEYS",
      focusGeminiKey: event.data.focusGeminiKey,
      focusAppKey: event.data.focusAppKey,
      youtubeSearchKey: event.data.youtubeSearchKey,
      skipAdKey: event.data.skipAdKey,
    });
  }

  // The app's current effective accent color (Custom Accent Color, smart-
  // extracted, or default — see syncAccentColorToExtension() in
  // script.js), relayed so content-youtube.js can highlight its arrow-key
  // focused video/channel card the same color as the rest of the app.
  if (event.data.type === "SYNC_ACCENT_COLOR" && typeof event.data.accentColor === "string") {
    safeSendMessage({ type: "SYNC_ACCENT_COLOR", accentColor: event.data.accentColor });
  }

  // The YouTube Window's "Keep YouTube tab open (copy link only)" toggle
  // (see syncStayOnTabToExtension() in youtube-window.js). Relayed the
  // same way as SYNC_ACCENT_COLOR/SYNC_SHORTCUT_KEYS — background.js
  // stores it in chrome.storage.local so both itself (whether to close
  // the search tab after a pick) and content-youtube.js (whether to let
  // a video click actually navigate at all) can read it independent of
  // this content script or the service worker's lifecycle.
  if (event.data.type === "SYNC_YT_STAY_MODE" && typeof event.data.stayOnTab === "boolean") {
    safeSendMessage({ type: "SYNC_YT_STAY_MODE", stayOnTab: event.data.stayOnTab });
  }
});

/* background.js
   The switchboard between the Gemini tab and your Vocab Register app
   tab. Content scripts on different origins can't talk to each other
   directly, so everything routes through here.

   State (which tab is the app, and whether it has finished its
   APP_READY handshake) is mirrored into chrome.storage.session because
   an MV3 service worker can be killed and restarted at any moment —
   plain module-level variables alone would silently reset mid-session. */

let appTabId = null;
let appReady = false;

const QUEUE_KEY = "vocabBridge_pendingScrapes";

async function restoreState() {
  const stored = await chrome.storage.session.get(["appTabId", "appReady"]);
  appTabId = stored.appTabId ?? null;
  appReady = !!stored.appReady;
}
restoreState();

async function persistState() {
  await chrome.storage.session.set({ appTabId, appReady });
}

async function getQueue() {
  const { [QUEUE_KEY]: queue } = await chrome.storage.session.get(QUEUE_KEY);
  return Array.isArray(queue) ? queue : [];
}

async function setQueue(queue) {
  await chrome.storage.session.set({ [QUEUE_KEY]: queue });
}

// Delivers any Gemini scrapes that arrived before the app's APP_READY
// handshake fired (e.g. you clicked "Save to Register" before the app
// tab had finished loading). Safe to call any time — it's a no-op if
// there's nothing to send or nowhere ready to send it.
async function flushQueue() {
  if (!appReady || !appTabId) {
    console.log(
      `[VocabBridge:bg] flushQueue skipped — appReady=${appReady}, appTabId=${appTabId}. ` +
        `The app tab has never completed its APP_READY handshake (or was closed).`
    );
    return;
  }
  const queue = await getQueue();
  if (!queue.length) return;

  console.log(`[VocabBridge:bg] Attempting to deliver ${queue.length} queued scrape(s) to tab ${appTabId}...`);
  for (const payload of queue) {
    try {
      await chrome.tabs.sendMessage(appTabId, { type: "GEMINI_ENTRY_SCRAPED", payload });
      console.log("[VocabBridge:bg] Delivered a scrape to the app tab successfully.");
    } catch (err) {
      // App tab probably isn't there to receive it right now — stop and
      // leave the rest queued instead of losing them.
      console.warn("[VocabBridge:bg] Could not deliver a queued scrape, will retry later:", err);
      return;
    }
  }
  await setQueue([]);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the channel open for the async sendResponse above
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    // Sent by bridge-app.js the moment it sees script.js's APP_READY
    // postMessage. Marks this tab as the delivery target and flushes
    // anything scraped from Gemini before this point.
    case "APP_BRIDGE_READY": {
      appTabId = sender.tab?.id ?? null;
      appReady = true;
      console.log(`[VocabBridge:bg] APP_BRIDGE_READY received — registered tab ${appTabId} as the app tab.`);
      await persistState();
      await flushQueue();
      return { ok: true };
    }

    // Sent by content-gemini.js when a response finishes generating.
    case "GEMINI_ENTRY_SCRAPED": {
      console.log("[VocabBridge:bg] GEMINI_ENTRY_SCRAPED received from Gemini tab, queueing:", message.payload);
      const queue = await getQueue();
      queue.push(message.payload);
      await setQueue(queue);
      await flushQueue(); // delivers immediately if the app is already ready
      return { ok: true };
    }

    // Sent by bridge-app.js, relaying the app's "Search Gemini" click.
    case "SEARCH_GEMINI": {
      await searchInGemini(message.word, message.bookTitle);
      return { ok: true };
    }

    // Sent by bridge-app.js, relaying the app's "Focus Gemini Tab"
    // keyboard shortcut. Unlike SEARCH_GEMINI this never opens a new tab
    // or injects anything — it's a pure "switch to it if it's already
    // open" action.
    case "FOCUS_GEMINI_TAB": {
      await focusGeminiTabIfOpen();
      return { ok: true };
    }

    // Sent by content-gemini.js (directly, not via bridge-app.js) when
    // the synced "return to app tab" key is pressed while on Gemini's
    // own page — the other half of the two-way tab switch.
    case "RETURN_TO_APP_TAB": {
      await focusAppTabIfKnown();
      return { ok: true };
    }

    // Sent by bridge-app.js whenever the app's Keyboard Shortcuts panel
    // saves a change to either tab-switch binding. Stored in
    // chrome.storage.local (not .session) so content-gemini.js can read
    // it on any fresh page load of gemini.google.com, independent of
    // this service worker's lifecycle.
    case "SYNC_SHORTCUT_KEYS": {
      await chrome.storage.local.set({
        vocabBridge_focusGeminiKey: message.focusGeminiKey || "F7",
        vocabBridge_focusAppKey: message.focusAppKey || "F8",
      });
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown message type: " + message?.type };
  }
}

// Reuses an existing Gemini tab if there is one, otherwise opens one.
// Either way, focuses it and injects the search word once ready.
async function searchInGemini(word, bookTitle) {
  const [existing] = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  let tab = existing;

  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    tab = await chrome.tabs.create({ url: "https://gemini.google.com/app", active: true });
    await waitForTabComplete(tab.id);
  }

  await sendInjectWithRetry(tab.id, word, bookTitle);
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// The tab reporting "complete" doesn't mean Gemini's Angular app (and our
// content script's listeners) have finished mounting yet, so retry with a
// short backoff instead of failing on the first attempt.
async function sendInjectWithRetry(tabId, word, bookTitle, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "INJECT_SEARCH", word, bookTitle });
      return;
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.warn("[VocabBridge] Gemini content script never responded — couldn't inject the search term.");
}

// Focuses an already-open Gemini tab, if there is one — the "Focus
// Gemini Tab" keyboard shortcut. Deliberately doesn't create a new tab
// (that's what "Search Gemini" is for); this is a pure tab switch.
async function focusGeminiTabIfOpen() {
  const [tab] = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (!tab) {
    console.log("[VocabBridge:bg] Focus-Gemini-Tab requested, but no Gemini tab is currently open.");
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// Focuses the VocabBuilderPLUS app tab. Used by content-gemini.js when
// the synced "return to app" key is pressed on Gemini's own page (the
// useful direction); also reachable from the app's own "Return to App
// Tab" shortcut, where it's a harmless no-op since that tab already has
// focus by definition.
async function focusAppTabIfKnown() {
  if (!appTabId) {
    console.log("[VocabBridge:bg] Return-to-App-Tab requested, but no app tab has completed its handshake yet.");
    return;
  }
  try {
    const tab = await chrome.tabs.get(appTabId);
    await chrome.tabs.update(appTabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    console.warn("[VocabBridge:bg] Couldn't focus the app tab (it may have been closed):", err);
  }
}

// Forget the app tab if it closes, so a stale id doesn't silently
// swallow future scrapes into a black hole.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === appTabId) {
    appTabId = null;
    appReady = false;
    persistState();
  }
});

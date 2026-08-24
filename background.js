/* background.js
   The switchboard between the Gemini tab and your Vocab Register app
   tab. Content scripts on different origins can't talk to each other
   directly, so everything routes through here.

   State (which tab is the app, whether it has finished its APP_READY
   handshake, and — for the YouTube bridge — which tab is the current
   YouTube search tab) is mirrored into chrome.storage.session because
   an MV3 service worker can be killed and restarted at any moment —
   plain module-level variables alone would silently reset mid-session. */

let appTabId = null;
let appReady = false;
let youtubeSearchTabId = null;

const QUEUE_KEY = "vocabBridge_pendingScrapes";
const YOUTUBE_QUEUE_KEY = "vocabBridge_pendingYoutubeSelections";
// "Keep YouTube tab open (copy link only)" — synced from the app's
// YouTube Window ⚙ settings panel (see SYNC_YT_STAY_MODE below). Stored
// in chrome.storage.local (not .session) so it survives this service
// worker being killed/restarted and so content-youtube.js can read the
// same value directly on youtube.com, independent of this file's own
// lifecycle — same reasoning as vocabBridge_accentColor/_focusAppKey.
const STAY_ON_TAB_KEY = "vocabBridge_stayOnYoutubeTab";

async function restoreState() {
  const stored = await chrome.storage.session.get(["appTabId", "appReady", "youtubeSearchTabId"]);
  appTabId = stored.appTabId ?? null;
  appReady = !!stored.appReady;
  youtubeSearchTabId = stored.youtubeSearchTabId ?? null;
}
// Awaited at the top of every handleMessage() call below (not just fired
// here and forgotten) — a freshly-woken MV3 service worker can receive a
// message (e.g. AM_I_YOUTUBE_SEARCH_TAB from a content script that just
// loaded) before this chrome.storage.session.get() round-trip finishes,
// which would otherwise read youtubeSearchTabId back as still null and
// wrongly answer "no" for the very tab that should say "yes".
const stateReady = restoreState();

async function persistState() {
  await chrome.storage.session.set({ appTabId, appReady, youtubeSearchTabId });
}

async function getQueue() {
  const { [QUEUE_KEY]: queue } = await chrome.storage.session.get(QUEUE_KEY);
  return Array.isArray(queue) ? queue : [];
}

async function setQueue(queue) {
  await chrome.storage.session.set({ [QUEUE_KEY]: queue });
}

async function getYoutubeQueue() {
  const { [YOUTUBE_QUEUE_KEY]: queue } = await chrome.storage.session.get(YOUTUBE_QUEUE_KEY);
  return Array.isArray(queue) ? queue : [];
}

async function setYoutubeQueue(queue) {
  await chrome.storage.session.set({ [YOUTUBE_QUEUE_KEY]: queue });
}

// Delivers any picked-video URL(s) that arrived before the app's
// APP_READY handshake fired. In practice the app tab is almost always
// already ready by the time this fires (the search itself started
// from inside the app), but the queue keeps this robust the same way
// flushQueue() does for Gemini scrapes — e.g. if the app tab was
// reloaded while the YouTube search tab was still open.
async function flushYoutubeQueue() {
  if (!appReady || !appTabId) {
    console.log(
      `[VocabBridge:bg] flushYoutubeQueue skipped — appReady=${appReady}, appTabId=${appTabId}.`
    );
    return;
  }
  const queue = await getYoutubeQueue();
  if (!queue.length) return;

  console.log(`[VocabBridge:bg] Attempting to deliver ${queue.length} queued YouTube selection(s) to tab ${appTabId}...`);
  for (const payload of queue) {
    try {
      await chrome.tabs.sendMessage(appTabId, { type: "YOUTUBE_VIDEO_SELECTED", payload });
      console.log("[VocabBridge:bg] Delivered a YouTube selection to the app tab successfully.");
    } catch (err) {
      console.warn("[VocabBridge:bg] Could not deliver a queued YouTube selection, will retry later:", err);
      return;
    }
  }
  await setYoutubeQueue([]);
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
  await stateReady;
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

    // Sent by bridge-app.js, relaying the app's "Restart Gemini Tab"
    // click/shortcut. Unlike SEARCH_GEMINI this never reuses an existing
    // tab — it closes whatever Gemini tab(s) are currently open and
    // opens one fresh. If a word was in the word bar when this was
    // triggered, it's typed into the new tab too (same INJECT_SEARCH
    // path as searchInGemini()), so restarting doesn't cost you your
    // lookup. If no word was present, it's just a clean close-then-open,
    // same as before.
    case "RESTART_GEMINI_TAB": {
      await restartGeminiTab(message.word, message.bookTitle);
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

    // Sent by bridge-app.js, relaying the app's "Focus YouTube Tab"
    // keyboard shortcut. Same shape as FOCUS_GEMINI_TAB just above — a
    // pure "switch to it if it's already open" action, targeting
    // specifically the tab this extension opened for a search (tracked
    // in youtubeSearchTabId), not just any youtube.com tab the person
    // might happen to have open elsewhere.
    case "FOCUS_YOUTUBE_TAB": {
      await focusYoutubeTabIfOpen();
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
    // saves a change to any of the tab-switch/focus bindings. Stored in
    // chrome.storage.local (not .session) so content-gemini.js and
    // content-youtube.js can read these on any fresh page load of
    // gemini.google.com / youtube.com, independent of this service
    // worker's lifecycle.
    case "SYNC_SHORTCUT_KEYS": {
      await chrome.storage.local.set({
        vocabBridge_focusGeminiKey: message.focusGeminiKey || "F7",
        vocabBridge_focusAppKey: message.focusAppKey || "F8",
        vocabBridge_focusYoutubeSearchKey: message.youtubeSearchKey || "F10",
        // No fallback default here (unlike the three above) — Skip Ad
        // ships unbound, so a missing/empty value should mean "off",
        // not silently fall back to some F-key of its own.
        vocabBridge_skipAdKey: message.skipAdKey || null,
      });
      return { ok: true };
    }

    // Sent by bridge-app.js whenever the app recomputes its accent color
    // (Custom Accent Color change, smart-extraction re-sample, or just
    // page load). Stored in chrome.storage.local (not .session), same
    // reasoning as SYNC_SHORTCUT_KEYS: content-youtube.js needs to read
    // it on any fresh page load of youtube.com, independent of whether
    // this service worker happens to still be alive.
    case "SYNC_ACCENT_COLOR": {
      if (typeof message.accentColor === "string" && message.accentColor) {
        await chrome.storage.local.set({ vocabBridge_accentColor: message.accentColor });
      }
      return { ok: true };
    }

    // Sent by bridge-app.js, relaying the YouTube Window's "Keep YouTube
    // tab open (copy link only)" toggle. Read by handleYoutubeVideoSelected()
    // below (whether to close the search tab after a pick) and by
    // content-youtube.js (whether to let a video click actually navigate
    // the tab at all).
    case "SYNC_YT_STAY_MODE": {
      await chrome.storage.local.set({ [STAY_ON_TAB_KEY]: !!message.stayOnTab });
      return { ok: true };
    }

    // Sent by content-youtube.js on load to ask "is this tab the one the
    // extension itself opened for a YouTube search?" — the arrow-key
    // video/channel browser (see content-youtube.js) only turns itself on
    // for that tab, never for the person's own ordinary YouTube browsing
    // in some other tab, which content-youtube.js has no way to tell
    // apart from inside the page itself (same reasoning as the
    // YOUTUBE_VIDEO_SELECTED tab-id check below).
    case "AM_I_YOUTUBE_SEARCH_TAB": {
      const tabId = sender.tab?.id ?? null;
      return { ok: true, isSearchTab: tabId != null && tabId === youtubeSearchTabId };
    }

    // Sent by bridge-app.js, relaying the YouTube Window's 🌐 "Search on
    // YouTube.com" button. Opens/reuses a real youtube.com tab showing
    // results for this query — no typing/injection needed, since
    // YouTube's own search-results URL takes the query directly.
    case "YOUTUBE_SEARCH_EXTERNAL": {
      await openYoutubeSearchTab(message.query);
      return { ok: true };
    }

    // Sent directly by content-youtube.js (not via bridge-app.js — it
    // runs on youtube.com, a different origin from the app) whenever
    // ANY youtube.com tab navigates to a video. Only acted on if it's
    // the specific tab this extension opened for the search above —
    // see the tab-id check inside. Any other youtube.com tab the person
    // has open for their own ordinary browsing is left untouched.
    case "YOUTUBE_VIDEO_SELECTED": {
      await handleYoutubeVideoSelected(message, sender);
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown message type: " + message?.type };
  }
}

// Opens a real youtube.com search-results tab for this query — reusing
// the extension's own previously-opened search tab if it's still open,
// same "reuse, don't multiply tabs" courtesy as searchInGemini() below.
async function openYoutubeSearchTab(query) {
  const q = (query || "").trim();
  if (!q) return;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

  if (youtubeSearchTabId) {
    try {
      const tab = await chrome.tabs.get(youtubeSearchTabId);
      await chrome.tabs.update(youtubeSearchTabId, { url, active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      console.log(`[VocabBridge:bg] Reused existing YouTube search tab ${youtubeSearchTabId} for "${q}".`);
      return;
    } catch (err) {
      // Stale id — that tab was closed some other way (e.g. by hand).
      // Fall through and open a fresh one below.
      youtubeSearchTabId = null;
    }
  }

  const tab = await chrome.tabs.create({ url, active: true });
  youtubeSearchTabId = tab.id;
  await persistState();
  console.log(`[VocabBridge:bg] Opened new YouTube search tab ${tab.id} for "${q}".`);
}

// The heart of the YouTube round trip: relay the picked video's URL to
// the app, then hand focus back — but only when the navigation (or, in
// stay-on-tab mode, the intercepted click — see content-youtube.js)
// came from the tab THIS extension opened. Every other open youtube.com
// tab reports its navigations too (content-youtube.js can't tell them
// apart on its own), so this id check is what keeps the person's own
// unrelated YouTube browsing completely untouched.
//
// Whether the search tab actually closes afterward depends on the
// "Keep YouTube tab open (copy link only)" toggle (STAY_ON_TAB_KEY):
// off (default) closes it, same as always; on leaves it open — still
// registered as youtubeSearchTabId — so content-youtube.js's video-click
// interception keeps working on it and the next pick doesn't need a
// fresh tab.
async function handleYoutubeVideoSelected(message, sender) {
  const fromTabId = sender.tab?.id ?? null;
  if (fromTabId == null || fromTabId !== youtubeSearchTabId) return;

  console.log("[VocabBridge:bg] YOUTUBE_VIDEO_SELECTED from the search tab, relaying:", message.url);
  const queue = await getYoutubeQueue();
  queue.push({ url: message.url, videoId: message.videoId });
  await setYoutubeQueue(queue);
  await flushYoutubeQueue(); // delivers immediately if the app is already ready

  const { [STAY_ON_TAB_KEY]: stayOnTab } = await chrome.storage.local.get(STAY_ON_TAB_KEY);

  if (stayOnTab) {
    console.log(`[VocabBridge:bg] Stay-on-tab mode is on — leaving search tab ${fromTabId} open.`);
  } else {
    try {
      await chrome.tabs.remove(fromTabId);
    } catch (err) {
      // Tab may already be gone (person closed it themselves right as
      // they clicked) — not fatal, the URL was already relayed above.
      console.warn("[VocabBridge:bg] Couldn't close the YouTube search tab (it may already be closed):", err);
    }
    youtubeSearchTabId = null;
    await persistState();
  }

  await focusAppTabIfKnown();
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

// Closes every currently-open Gemini tab (if any) and opens a brand new
// one, focusing it. Unlike an earlier version of this, it now mirrors
// searchInGemini()'s tail end: if a word was passed in (i.e. the word
// bar had something in it when Restart was triggered), that word's
// prompt gets typed into the freshly-opened tab once it's ready, via
// the same sendInjectWithRetry() used by "Search Gemini" — so
// restarting a stuck tab doesn't mean losing your in-progress lookup.
// With no word, this stays exactly the old behavior: a clean
// close-then-reopen with nothing typed.
async function restartGeminiTab(word, bookTitle) {
  const existingTabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (existingTabs.length) {
    const ids = existingTabs.map((t) => t.id).filter((id) => id != null);
    console.log(`[VocabBridge:bg] Restart-Gemini-Tab: closing ${ids.length} existing Gemini tab(s).`);
    try {
      await chrome.tabs.remove(ids);
    } catch (err) {
      // A tab may have already closed itself between the query and the
      // remove call — not fatal, just carry on and open the new one.
      console.warn("[VocabBridge:bg] Couldn't close one or more existing Gemini tabs:", err);
    }
  } else {
    console.log("[VocabBridge:bg] Restart-Gemini-Tab: no existing Gemini tab found, just opening a new one.");
  }

  const tab = await chrome.tabs.create({ url: "https://gemini.google.com/app", active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  const trimmedWord = (word || "").trim();
  if (!trimmedWord) return;

  console.log(`[VocabBridge:bg] Restart-Gemini-Tab: word "${trimmedWord}" was pending, injecting into the new tab once ready.`);
  await waitForTabComplete(tab.id);
  await sendInjectWithRetry(tab.id, trimmedWord, bookTitle);
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

// Focuses the youtube.com tab the extension itself opened for a search
// (tracked in youtubeSearchTabId — see AM_I_YOUTUBE_SEARCH_TAB /
// handleYoutubeVideoSelected() for the same id), if it's still open.
// Deliberately doesn't fall back to querying for *any* youtube.com tab
// the way focusGeminiTabIfOpen() queries by URL — the person may well
// have other, unrelated youtube.com tabs open for ordinary browsing,
// and jumping to one of those instead of the actual search tab would be
// worse than doing nothing.
async function focusYoutubeTabIfOpen() {
  if (!youtubeSearchTabId) {
    console.log("[VocabBridge:bg] Focus-YouTube-Tab requested, but no YouTube search tab is currently open.");
    return;
  }
  try {
    const tab = await chrome.tabs.get(youtubeSearchTabId);
    await chrome.tabs.update(youtubeSearchTabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    console.warn("[VocabBridge:bg] Couldn't focus the YouTube search tab (it may have been closed):", err);
    youtubeSearchTabId = null;
    persistState();
  }
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
// swallow future scrapes into a black hole. Also forget the YouTube
// search tab if it's closed by hand (rather than by the extension
// itself after a video is picked) — otherwise the next 🌐 search would
// try to reuse/query a tab id that no longer exists.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === appTabId) {
    appTabId = null;
    appReady = false;
    persistState();
  }
  if (tabId === youtubeSearchTabId) {
    youtubeSearchTabId = null;
    persistState();
  }
});

/* content-youtube.js
   Runs on every youtube.com page — and, as of manifest.json's
   "all_frames": true, inside every youtube.com IFRAME too, including
   the embedded player the app's own floating YouTube Window uses. Its
   main job is noticing when the tab navigates to a video ("you picked
   one") and telling background.js — background.js is what decides
   whether to actually care (see the YOUTUBE_VIDEO_SELECTED handler /
   tab-id check in background.js). This script deliberately does NOT
   try to tell "is this the app's search tab?" apart from any other
   youtube.com tab you might have open for your own ordinary browsing —
   it can't, from inside the page, and guessing wrong would be worse
   than not guessing at all. It just reports every video navigation, on
   every youtube.com tab, always; background.js's tab-id check is what
   keeps your own browsing untouched. It also handles a few synced
   keyboard shortcuts (Return to App, Focus YouTube Search, Skip Ad —
   see each block below) and, for Skip Ad specifically, a postMessage
   trigger so the app's embedded player can ask this same script (now
   running inside that iframe too) to click a Skip Ad button it
   otherwise has no way to reach. */

(function () {
  "use strict";

  // Guards against reporting the same video twice in a row — YouTube's
  // SPA sometimes fires its navigation event more than once for what's
  // effectively the same page (e.g. once on the initial navigation,
  // again after it appends a &t= timestamp param once playback starts).
  let lastReportedUrl = null;

  function extractWatchInfo(href) {
    let url;
    try {
      url = new URL(href);
    } catch (err) {
      return null;
    }
    if (url.hostname.replace(/^www\./, "") !== "youtube.com") return null;
    if (url.pathname !== "/watch") return null;
    const videoId = url.searchParams.get("v");
    if (!videoId) return null;
    return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
  }

  // Sends a picked video's info to background.js. Shared by the normal
  // "it actually navigated here" path (reportIfVideoPage, below) and the
  // stay-on-tab-mode paths (the click interceptor and the arrow-key
  // Enter handler further down) that report a video WITHOUT ever letting
  // this tab navigate to it.
  function reportVideoSelection(info) {
    if (!info) return;
    lastReportedUrl = info.url;

    console.log("[VocabBridge:content-youtube] Reporting video selection:", info.url);
    try {
      const result = chrome.runtime.sendMessage({ type: "YOUTUBE_VIDEO_SELECTED", url: info.url, videoId: info.videoId });
      // Same synchronous-throw hazard as bridge-app.js's safeSendMessage
      // (see its comment) — this content script has nothing useful to
      // show the person on either failure mode (they're on youtube.com,
      // not the app), so both are just logged, not surfaced.
      if (result && typeof result.then === "function") {
        result.catch((err) => console.warn("[VocabBridge:content-youtube] sendMessage failed:", err));
      }
    } catch (err) {
      console.warn("[VocabBridge:content-youtube] sendMessage threw (extension likely reloaded):", err);
    }
  }

  function reportIfVideoPage() {
    const info = extractWatchInfo(location.href);
    if (!info) return;
    if (info.url === lastReportedUrl) return;
    reportVideoSelection(info);
  }

  /* -----------------------------------------------------------------
     STAY-ON-TAB MODE — "Keep YouTube tab open (copy link only)" toggle
     in the app's YouTube Window ⚙ settings panel. Synced into
     chrome.storage.local by background.js's SYNC_YT_STAY_MODE handler
     (see bridge-app.js/background.js), read here the same way
     content-youtube.js already reads vocabBridge_focusAppKey/
     vocabBridge_accentColor — a fresh get() on load plus an onChanged
     listener so a mid-session toggle flip applies immediately without
     needing a page reload.

     This flag only changes behavior on the extension's OWN search tab
     (see the AM_I_YOUTUBE_SEARCH_TAB gate below, same as the arrow-key
     browser) — it's never wired up on the person's own ordinary
     youtube.com browsing.
  ----------------------------------------------------------------- */
  const STAY_ON_TAB_STORAGE = "vocabBridge_stayOnYoutubeTab";
  let stayOnYoutubeTab = false;

  chrome.storage.local.get(STAY_ON_TAB_STORAGE).then((stored) => {
    stayOnYoutubeTab = !!stored[STAY_ON_TAB_STORAGE];
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STAY_ON_TAB_STORAGE]) {
      stayOnYoutubeTab = !!changes[STAY_ON_TAB_STORAGE].newValue;
    }
  });

  // YouTube's own Polymer/SPA shell fires this custom event on
  // `document` at the end of every client-side navigation — search
  // results -> watch, watch -> a different watch via a suggested video,
  // channel page -> watch, all of it — regardless of *how* the
  // navigation happened (thumbnail click, autoplay-next, back/forward).
  // Far more reliable than trying to guess from click events.
  document.addEventListener("yt-navigate-finish", reportIfVideoPage);

  // Defensive fallback in case a future YouTube redesign ever stops
  // firing that event: a lightweight poll that only ever does a string
  // comparison when nothing changed, so leaving it running for a whole
  // tab's lifetime costs essentially nothing.
  setInterval(reportIfVideoPage, 1000);

  // Covers the (rare) case of a tab already sitting on a /watch URL
  // before this content script finishes loading — e.g. a fresh
  // extension install/reload while a video tab was already open.
  reportIfVideoPage();

  /* -----------------------------------------------------------------
     Return-to-App shortcut: same as content-gemini.js — lets you jump
     back to the VocabBuilderPLUS tab from a youtube.com tab without
     touching the mouse, using whichever key the app's own Keyboard
     Shortcuts panel has assigned to "Return to App Tab". That binding
     is synced into chrome.storage.local by background.js (see its
     SYNC_SHORTCUT_KEYS handler) every time it changes in the app, so
     this stays correct without a reload as long as this content script
     is (re)loaded after the sync — and the chrome.storage.onChanged
     listener below keeps it current even without that.

     Deliberately runs on every youtube.com tab, not just the one the
     extension opened for a search — same "can't tell tabs apart from
     inside the page" reasoning as reportIfVideoPage() above. That's
     harmless here: background.js's RETURN_TO_APP_TAB handler just
     focuses the known app tab (a no-op if the app tab isn't open), it
     doesn't touch the YouTube tab you're pressing the key from, so
     using it on an unrelated everyday YouTube tab is perfectly fine
     too — it simply switches you to the app the same way it would from
     Gemini's page.
  ----------------------------------------------------------------- */
  const RETURN_KEY_STORAGE = "vocabBridge_focusAppKey";
  let returnToAppKey = "F8"; // fallback until the real value loads

  chrome.storage.local.get(RETURN_KEY_STORAGE).then((stored) => {
    if (typeof stored[RETURN_KEY_STORAGE] === "string") returnToAppKey = stored[RETURN_KEY_STORAGE];
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[RETURN_KEY_STORAGE]) {
      returnToAppKey = changes[RETURN_KEY_STORAGE].newValue || "F8";
    }
  });

  document.addEventListener("keydown", (e) => {
    // Any modifier held — leave it alone, mirrors the app's own
    // Pass-Through Modifier behavior so the same muscle memory applies.
    if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
    if (e.code !== returnToAppKey) return;
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "RETURN_TO_APP_TAB" }).catch(() => {
      console.warn("[VocabBridge:content-youtube] Couldn't reach the extension to return to the app tab.");
    });
  });

  /* -----------------------------------------------------------------
     SKIP AD — the app's "Skip YouTube Ad" shortcut (skipYoutubeAd in
     script.js's CUSTOMIZABLE KEYBOARD SHORTCUT SYSTEM). Unlike every
     other synced key above, this one has no default binding — it's
     null/unset until the person assigns one in the app's Keyboard
     Shortcuts sidebar — so skipAdKey starts as null here too, and the
     listener below is a silent no-op until then (e.code is always a
     real string, so it can never accidentally match a null key).

     Two ways this fires, covering both places a video can be playing:

     1. A real youtube.com tab (opened via the 🌐 search, or just your
        own ordinary browsing) — this content script runs there and the
        keydown listener below fires directly, same shape as the
        Return-to-App/Focus-Search listeners above.

     2. The app's own floating YouTube Window, which plays video inside
        a youtube.com iframe embed. A key press there happens on the
        APP's page, not inside that iframe, so script.js can't click
        the iframe's Skip Ad button directly (cross-origin) — instead
        youtube-window.js's skipAd() posts a message straight to that
        iframe's contentWindow, and — because manifest.json now injects
        this content script into every youtube.com frame, not just
        top-level tabs ("all_frames": true) — this same script is
        running *inside* that embed too, and the message listener
        further below picks it up and clicks locally, no different
        from case 1.
  ----------------------------------------------------------------- */
  const SKIP_AD_KEY_STORAGE = "vocabBridge_skipAdKey";
  let skipAdKey = null; // no default — stays off until the person binds one

  chrome.storage.local.get(SKIP_AD_KEY_STORAGE).then((stored) => {
    if (typeof stored[SKIP_AD_KEY_STORAGE] === "string") skipAdKey = stored[SKIP_AD_KEY_STORAGE];
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SKIP_AD_KEY_STORAGE]) {
      skipAdKey = changes[SKIP_AD_KEY_STORAGE].newValue || null;
    }
  });

  // YouTube's ad-skip button markup/class names have shifted more than
  // once over the years — same "try each in order, first match wins"
  // defensiveness as YT_SEARCH_BOX_SELECTORS above, so a future rename
  // doesn't silently break this the way one fixed selector would.
  const YT_SKIP_AD_SELECTORS = [
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-container button",
    'button[class*="ytp-ad-skip-button"]',
    'button[id*="skip-button"]',
  ];

  function findSkipAdButton() {
    for (const sel of YT_SKIP_AD_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Returns true if an ad was actually detected and force-skipped —
  // false (a harmless no-op) if no ad happens to be showing right now,
  // e.g. the key was pressed outside the window an ad is on screen.
  //
  // Both a plain btn.click() AND a full synthetic pointerdown/mousedown/
  // pointerup/mouseup/click sequence at the button's real coordinates
  // reliably found and "clicked" the button (confirmed live, see the
  // TEMP DEBUG logs below) but never actually skipped the ad. The
  // remaining explanation is that YouTube's real skip handler checks
  // event.isTrusted — a flag only the browser itself can set on a
  // genuine physical input event, which no script (this one included)
  // can ever fake. So instead of clicking the button at all, this
  // forces the underlying <video> element's own currentTime to its
  // duration once an ad is confirmed showing. That's a native media-
  // element property assignment, not a synthetic input event, so it
  // isn't gated by isTrusted — the browser's media engine treats it
  // exactly like the ad clip actually finishing, which YouTube's ad
  // module advances past the same way it would on its own. Works for
  // non-skippable ad segments too, not just ones with a visible button.
  //
  // isAdShowing() gates all of this — without it, pressing the key
  // outside an ad would force the real video's OWN currentTime to its
  // end, jumping you straight to the end of whatever you're actually
  // watching. Never skip that check.
  function isAdShowing() {
    const playerEl = document.querySelector(".html5-video-player");
    if (playerEl && playerEl.classList.contains("ad-showing")) return true;
    const adModule = document.querySelector(".ytp-ad-module");
    if (adModule && adModule.children.length > 0) return true;
    if (document.querySelector(".ytp-ad-player-overlay")) return true;
    return false;
  }

  function findAdVideoElement() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  // TEMP DEBUG: logs which case it hit, so a person testing this can see
  // in the console whether the key reached this frame at all, whether an
  // ad was actually detected, and whether the video's currentTime could
  // be forced. Safe to remove once Skip Ad is confirmed working — see
  // the console.log calls below.
  function trySkipAd() {
    if (!isAdShowing()) {
      console.log("[VocabBridge:content-youtube] trySkipAd: no ad currently showing in this frame — leaving the real video alone. Frame URL:", location.href);
      return false;
    }

    const btn = findSkipAdButton();
    if (btn) {
      console.log("[VocabBridge:content-youtube] trySkipAd: ad detected, also clicking the skip button as a best-effort (won't reliably work on its own):", btn);
      dispatchRealClick(btn);
    } else {
      console.log("[VocabBridge:content-youtube] trySkipAd: ad detected, no skip button on screen (likely a non-skippable segment) — forcing the ad video to its end instead.");
    }

    const video = findAdVideoElement();
    if (video && isFinite(video.duration) && video.duration > 0) {
      console.log("[VocabBridge:content-youtube] trySkipAd: forcing ad video currentTime to its duration:", video.duration);
      video.currentTime = video.duration;
      return true;
    }

    console.log("[VocabBridge:content-youtube] trySkipAd: couldn't find a seekable video element to force past the ad.");
    return !!btn;
  }


  function dispatchRealClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };
    // PointerEvent first (what modern Chrome/YouTube's own UI actually
    // listens for), MouseEvent pairs right behind each for anything still
    // listening the old-fashioned way, then a final "click" — same order
    // a real physical click produces. Kept as a best-effort alongside the
    // currentTime force above, in case a future YouTube change makes the
    // button responsive to synthetic events again.
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  }

  // Capture phase, not bubble — same reasoning as the arrow-key grid-nav
  // listener further down in this file: once the embedded player itself
  // has keyboard focus (e.g. you clicked into it to play/pause or seek),
  // YouTube's own player-level keyboard handling gets first crack at the
  // event and calls stopPropagation() once it decides to act on a key —
  // which meant a plain bubble-phase listener on `document` here never
  // saw the keypress at all while the player had focus. This is what
  // made Skip Ad specifically fail inside the app's floating YouTube
  // Window (the other synced shortcuts don't depend on a keydown firing
  // *inside* this iframe's own document the way Skip Ad's in-frame
  // fallback does) — capture fires root-to-target, ahead of whatever the
  // player attaches to itself, so this always gets a look at the key
  // first regardless of what currently has focus inside the frame.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat) return;
      if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
      if (!skipAdKey) return;
      if (e.code !== skipAdKey) return;
      console.log("[VocabBridge:content-youtube] Skip Ad key matched (", e.code, ") in frame:", location.href);
      if (trySkipAd()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );

  // TEMP DEBUG: logs the moment skipAdKey is first loaded from storage
  // and every time it changes, so it's obvious from the console whether
  // this frame ever actually received a non-null value at all.
  console.log("[VocabBridge:content-youtube] Skip Ad key listener armed in frame:", location.href, "— current value:", skipAdKey);
  chrome.storage.local.get(SKIP_AD_KEY_STORAGE).then((stored) => {
    console.log("[VocabBridge:content-youtube] Skip Ad key loaded from storage:", stored[SKIP_AD_KEY_STORAGE], "in frame:", location.href);
  });

  // The app's own origin (see manifest.json's bridge-app.js "matches" —
  // keep the two in sync if you ever move the app to a new URL). Only
  // messages posted from here are trusted to trigger a click — cheap
  // insurance against some unrelated page embedding a youtube.com
  // iframe of its own and prodding it. Low-stakes either way (worst
  // case is one extra click attempt on a visible button), but free to
  // check.
  const APP_ORIGIN = "https://alizsultan917-lab.github.io";

  window.addEventListener("message", (event) => {
    if (event.origin !== APP_ORIGIN) return;
    if (event.data?.type !== "VOCAB_SKIP_YOUTUBE_AD") return;
    trySkipAd();
  });

  /* -----------------------------------------------------------------
     FOCUS YOUTUBE SEARCH BAR — the other half of the app's "Focus
     YouTube Window Search Bar" shortcut (see focusYoutubeSearch in
     script.js's CUSTOMIZABLE KEYBOARD SHORTCUT SYSTEM). In the app
     itself that key opens/focuses the in-app YouTube Window's own
     search input; here — on a real youtube.com tab — the same physical
     key jumps the text cursor straight to YouTube's own top search box,
     so the habit of "press this key to get to search" carries over
     whether you're in the app or already sitting on a youtube.com tab.

     Runs on every youtube.com tab, same reasoning as the Return-to-App
     key just above: this content script can't tell "the tab the
     extension opened for a search" apart from any other youtube.com tab
     you have open, and jumping to YouTube's own search box is harmless
     (and arguably useful) on ordinary browsing too — it only fires on
     an explicit keypress, same as the Return-to-App key.
  ----------------------------------------------------------------- */
  const YT_SEARCH_KEY_STORAGE = "vocabBridge_focusYoutubeSearchKey";
  let focusYoutubeSearchKey = "F10"; // fallback until the real value loads

  chrome.storage.local.get(YT_SEARCH_KEY_STORAGE).then((stored) => {
    if (typeof stored[YT_SEARCH_KEY_STORAGE] === "string") focusYoutubeSearchKey = stored[YT_SEARCH_KEY_STORAGE];
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[YT_SEARCH_KEY_STORAGE]) {
      focusYoutubeSearchKey = changes[YT_SEARCH_KEY_STORAGE].newValue || "F10";
    }
  });

  // YouTube has redesigned its masthead search box's markup more than
  // once — this list is tried in order, first match wins, so a future
  // rename doesn't silently break the shortcut the way a single fixed
  // selector would.
  const YT_SEARCH_BOX_SELECTORS = [
    "input#search",
    "input.ytSearchboxComponentInput",
    "#search-input input",
    'input[name="search_query"]',
    'ytd-searchbox input',
  ];

  function findYoutubeSearchBox() {
    for (const sel of YT_SEARCH_BOX_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  document.addEventListener("keydown", (e) => {
    // Same shape as the Return-to-App key listener just above (no
    // isTypingTarget gate either) — the default binding is a bare F-key,
    // which never types a character anywhere, so jumping to the search
    // box works the instant it's pressed regardless of what currently
    // has focus. Rebinding this to a printable key is on the person —
    // same trade-off every other rebindable shortcut in this app makes.
    if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
    if (e.code !== focusYoutubeSearchKey) return;
    const box = findYoutubeSearchBox();
    if (!box) return;
    e.preventDefault();
    box.focus();
    if (typeof box.select === "function") box.select();
  });

  /* -----------------------------------------------------------------
     ARROW-KEY VIDEO/CHANNEL BROWSER — lets you browse the results of a
     🌐 "Search on YouTube.com" the same way you browse the app itself:
     no mouse. Up/Down/Left/Right moves a highlight (in your app's
     Custom Accent Color — see SYNC_ACCENT_COLOR below) between video and
     channel cards, Enter opens whichever one is highlighted.

     ONLY ACTIVE ON THE EXTENSION'S OWN SEARCH TAB. content-youtube.js
     runs on every youtube.com page (see the file's top comment), and
     this feature — unlike reportIfVideoPage() above — is NOT safe to run
     everywhere: it repurposes the arrow keys, which already do something
     on an ordinary YouTube tab (scroll, and on a /watch page, seek/
     volume). So this asks background.js, once, "is this tab the one the
     extension opened?" (it keeps track via youtubeSearchTabId — see
     handleYoutubeVideoSelected()'s tab-id check for the same pattern)
     and only wires up if the answer is yes. That ask-on-load happens
     once per real page load; it stays correct across YouTube's own SPA
     navigations (search -> watch -> a related video, etc.) without
     re-asking, because those don't reload this content script.
  ----------------------------------------------------------------- */
  chrome.runtime
    .sendMessage({ type: "AM_I_YOUTUBE_SEARCH_TAB" })
    .then((res) => {
      if (res && res.isSearchTab) {
        initGridNav();
        initStayOnTabClickInterception();
      } else {
        console.log(
          "[VocabBridge:content-youtube] Not the extension's search tab — arrow-key browsing stays off here " +
            "(this is expected on any youtube.com tab you opened yourself, not through the app's 🌐 button)."
        );
      }
    })
    .catch((err) => {
      console.warn("[VocabBridge:content-youtube] Couldn't ask background.js whether this is the search tab:", err);
    });

  // Stay-on-tab mode's other half (see the STAY_ON_TAB_STORAGE block
  // above): a capture-phase click listener that, ONLY while the toggle
  // is on, stops a click on a video thumbnail/title from ever navigating
  // this tab — it grabs the /watch URL straight off the link, reports it
  // exactly like a normal pick, and leaves the results page exactly as
  // it was. When the toggle is off this listener still runs but does
  // nothing (see the early return), so clicking behaves exactly like
  // ordinary YouTube browsing — the tab navigates, and reportIfVideoPage()
  // above reports it via the yt-navigate-finish event as always.
  //
  // A plain "a[href]" search (rather than CARD_SELECTOR's long list of
  // renderer tags) is enough here: every clickable video thumbnail/title
  // YouTube renders is itself an <a href="/watch?..."> — there's no
  // renderer-tag guessing needed the way there is for the arrow-key
  // browser's spatial navigation.
  function initStayOnTabClickInterception() {
    console.log("[VocabBridge:content-youtube] This is the extension's search tab — stay-on-tab click interception armed.");

    document.addEventListener(
      "click",
      (e) => {
        if (!stayOnYoutubeTab) return;
        // Leave modified clicks (ctrl/cmd/shift-click, or anything but a
        // plain left click) alone — those are the person deliberately
        // asking for normal browser behavior (open in new tab, etc.),
        // not "pick this video for the app".
        if (e.button !== 0 || e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;

        const link = e.target.closest("a[href]");
        if (!link) return;
        const info = extractWatchInfo(link.href);
        if (!info) return; // not a video link (a channel/playlist card, a nav link, etc.) — let it behave normally

        e.preventDefault();
        e.stopPropagation();
        reportVideoSelection(info);
      },
      { capture: true }
    );
  }

  function initGridNav() {
    console.log("[VocabBridge:content-youtube] This is the extension's search tab — arrow-key browsing enabled.");

    // Every renderer tag YouTube uses for a clickable video/channel/
    // playlist card, across the page types a search/browse session
    // actually passes through: search results, home feed, a channel's
    // Videos tab, and the up-next/related sidebar on a watch page.
    const CARD_SELECTOR = [
      "ytd-video-renderer",
      "ytd-rich-item-renderer",
      "ytd-compact-video-renderer",
      "ytd-channel-renderer",
      "ytd-grid-video-renderer",
      "ytd-playlist-renderer",
      "ytd-radio-renderer",
      "ytd-compact-radio-renderer",
      "ytd-movie-renderer",
      "ytd-reel-item-renderer",
    ].join(",");

    // A second category, separate from CARD_SELECTOR (different
    // highlight color, see FOCUS_CLASS_BUTTON below): a channel page's
    // top tab strip (Home/Videos/Shorts/Live/Podcasts/Playlists/Posts)
    // and its sort/filter chips (Latest/Popular/Oldest, and the search
    // filter chips). These aren't video/channel *results*, they're
    // controls, so they get their own selector and their own color
    // rather than being folded into CARD_SELECTOR.
    // NOTE: YouTube's exact tag names for these have changed before and
    // will again (yt-tab-shape / tp-yt-paper-tab is the current/legacy
    // pair for tabs; yt-chip-cloud-chip-renderer for chips) — the
    // role="tab" / role="button"[aria-selected] fallbacks are there so
    // this keeps working through a future rename without needing an
    // extension update, at the cost of occasionally catching an
    // unrelated aria-tab/button that happens to sit in a strip like this.
    const BUTTON_SELECTOR = [
      "yt-tab-shape",
      "tp-yt-paper-tab",
      "yt-chip-cloud-chip-renderer",
      '[role="tab"]',
      "ytd-feed-filter-chip-bar-renderer button",
    ].join(",");

    const ACCENT_STORAGE = "vocabBridge_accentColor";
    const ACCENT_VAR = "--vocabbridge-accent";
    const FOCUS_CLASS_CARD = "vocabbridge-yt-focus-card";
    const FOCUS_CLASS_BUTTON = "vocabbridge-yt-focus-button";
    const BUTTON_COLOR = "#ff9500"; // same orange as the search bar's key-triggered flash

    // A CSS custom property (rather than recomputing an inline color on
    // every move) so a later accent-color sync just updates one variable
    // and the current highlight — if any — repaints itself for free.
    // The button highlight is a fixed orange, not accent-colored, so it
    // reads as "a control" at a glance vs. accent-colored "a result".
    function ensureFocusStyle() {
      if (document.getElementById("vocabbridge-yt-focus-style")) return;
      const style = document.createElement("style");
      style.id = "vocabbridge-yt-focus-style";
      style.textContent = `
        .${FOCUS_CLASS_CARD} {
          outline: 3px solid var(${ACCENT_VAR}, #1a73e8) !important;
          outline-offset: 3px;
          border-radius: 12px;
          box-shadow: 0 0 0 6px color-mix(in srgb, var(${ACCENT_VAR}, #1a73e8) 30%, transparent) !important;
        }
        .${FOCUS_CLASS_BUTTON} {
          outline: 3px solid ${BUTTON_COLOR} !important;
          outline-offset: 2px;
          border-radius: 8px;
          box-shadow: 0 0 0 5px rgba(255, 149, 0, 0.3) !important;
        }
      `;
      document.documentElement.appendChild(style);
    }
    ensureFocusStyle();

    function applyAccentColor(css) {
      if (typeof css === "string" && css) {
        document.documentElement.style.setProperty(ACCENT_VAR, css);
      }
    }
    chrome.storage.local.get(ACCENT_STORAGE).then((stored) => applyAccentColor(stored[ACCENT_STORAGE]));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[ACCENT_STORAGE]) applyAccentColor(changes[ACCENT_STORAGE].newValue);
    });

    let focusedEl = null;
    let focusedIsButton = false;

    function isCardUsable(el) {
      if (!el || !el.isConnected) return false;
      const rect = el.getBoundingClientRect();
      // Filters out cards YouTube has left in the DOM but collapsed/hidden
      // (lazy-loaded placeholders, filtered-out chips, etc.) — a real
      // rendered card always has both dimensions.
      return rect.width > 0 && rect.height > 0;
    }

    // One combined pool for arrow-key traversal — cards and buttons are
    // reachable from each other with the same four keys, per the spec:
    // "move through every option or function", not two separate modes.
    function getNavTargets() {
      const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
      const buttons = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      const seen = new Set();
      const out = [];
      for (const el of cards) {
        if (isCardUsable(el) && !seen.has(el)) {
          seen.add(el);
          out.push({ el, isButton: false });
        }
      }
      for (const el of buttons) {
        if (isCardUsable(el) && !seen.has(el)) {
          seen.add(el);
          out.push({ el, isButton: true });
        }
      }
      return out;
    }

    function setFocus(entry) {
      if (focusedEl) focusedEl.classList.remove(focusedIsButton ? FOCUS_CLASS_BUTTON : FOCUS_CLASS_CARD);
      if (!entry) {
        focusedEl = null;
        return;
      }
      focusedEl = entry.el;
      focusedIsButton = entry.isButton;
      focusedEl.classList.add(focusedIsButton ? FOCUS_CLASS_BUTTON : FOCUS_CLASS_CARD);
      focusedEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }

    function center(el) {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    // Simple spatial-navigation heuristic: among targets actually in the
    // pressed direction from the current one, pick whichever is closest
    // along that direction, breaking ties toward whichever stays best
    // aligned on the cross-axis — same shape of trade-off a person
    // scanning a page by eye makes, which is what keeps this feeling
    // "smart" across a tab strip (single row), a chip row (single row),
    // and a real multi-column grid (video/channel cards) without needing
    // separate code paths for each.
    function findNext(direction, candidates) {
      if (!focusedEl) return candidates[0]?.el || null;
      const cur = center(focusedEl);
      let best = null;
      let bestScore = Infinity;
      for (const { el } of candidates) {
        if (el === focusedEl) continue;
        const c = center(el);
        const dx = c.x - cur.x;
        const dy = c.y - cur.y;
        let primary;
        let cross;
        if (direction === "right") {
          if (dx <= 4) continue;
          primary = dx;
          cross = Math.abs(dy);
        } else if (direction === "left") {
          if (dx >= -4) continue;
          primary = -dx;
          cross = Math.abs(dy);
        } else if (direction === "down") {
          if (dy <= 4) continue;
          primary = dy;
          cross = Math.abs(dx);
        } else {
          if (dy >= -4) continue;
          primary = -dy;
          cross = Math.abs(dx);
        }
        // Cross-axis distance weighted higher than primary — keeps
        // Up/Down snapping to the same column, Left/Right to the same
        // row, instead of jumping to the nearest target in raw distance.
        const score = primary + cross * 2.5;
        if (score < bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best;
    }

    // YouTube's infinite-scroll continuation only fires (an
    // IntersectionObserver watching a sentinel well below the fold) once
    // the page is actually scrolled there — scrollIntoView({block:
    // "nearest"}) in setFocus() only scrolls just far enough to reveal
    // the last loaded card, which sits well short of that sentinel, so
    // arrow-Down at the bottom of what's loaded used to just... stop,
    // and going further needed the mouse/trackpad. This kicks the page
    // the rest of the way down and keeps nudging (with a short pause
    // between each try, so the observer/network round-trip has time to
    // land) until either new cards show up — at which point focus moves
    // onto the first new one, same as any other Down press — or a few
    // tries come up empty (end of results, or a slow connection that
    // needs another manual press).
    function loadMoreThenFocus(direction, retriesLeft) {
      if (typeof retriesLeft !== "number") retriesLeft = 6;
      const before = getNavTargets();
      const beforeCount = before.length;
      window.scrollBy({ top: Math.round(window.innerHeight * 1.4), left: 0, behavior: "auto" });
      if (retriesLeft <= 0) return;
      setTimeout(() => {
        const after = getNavTargets();
        if (after.length > beforeCount) {
          const next = findNext(direction, after) || after[after.length - 1]?.el || null;
          if (next) {
            const entry = after.find((c) => c.el === next);
            setFocus(entry || { el: next, isButton: false });
          }
        } else {
          loadMoreThenFocus(direction, retriesLeft - 1);
        }
      }, 350);
    }

    function openFocused() {
      if (!focusedEl) return;
      const link =
        focusedEl.matches("a[href]") ? focusedEl : focusedEl.querySelector(
          "a#video-title-link, a#thumbnail, a#main-link, a#avatar-link, a.yt-simple-endpoint[href], a[href]"
        );
      const target = link || focusedEl;
      // target.click() dispatches a real click event that runs through
      // document's capture phase same as an actual mouse click would —
      // which means initStayOnTabClickInterception()'s listener (also on
      // document, also capture-phase) sees this synthetic click too and,
      // while the "Keep YouTube tab open" toggle is on, cancels the
      // navigation and reports the video's URL itself, exactly like a
      // real click on a video link would. Nothing extra needed here for
      // stay-on-tab mode to work with Enter as well as the mouse.
      target.click();
      // Clicking hands real DOM focus to the link/button/tab that was
      // just activated — and several of YouTube's own controls (the tab
      // strip and chip row especially) implement their own roving-
      // tabindex arrow-key handling the moment they have focus, which
      // would otherwise compete with (and can outright swallow, via
      // stopPropagation before this ever reaches our capture-phase
      // listener's own handling further down the chain) the next
      // arrow-key press. Handing focus back to the page itself is what
      // was actually causing arrow keys to "stop working" after opening
      // a channel — this closes that off, so the keyboard browser stays
      // the only thing arrow keys talk to on this tab, page after page.
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur();
        }
      });
    }

    function isTypingTarget(el) {
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    }

    const ARROW_TO_DIRECTION = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };

    // Capture phase, not bubble: several of YouTube's own components
    // (the tab strip, chip row) attach their own arrow-key handling
    // directly on themselves and call stopPropagation() once they have
    // focus — a bubble-phase listener on `document` never sees the key
    // at all once that happens, which is the other half of the "stopped
    // working after opening a channel" bug. Capture fires root-to-target,
    // so this always sees the key first regardless of what has DOM focus.
    // stopPropagation() below (once WE handle a key) is the return half
    // of that same fix — it stops the key from *also* reaching whatever
    // YouTube control has focus, so a card's arrow-key press can't
    // simultaneously trigger a native scroll or a YouTube tab-switch.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return;
        if (isTypingTarget(e.target)) return;
        // A /watch page's own player already owns arrow keys (seek/
        // volume) and Enter (play/pause on some layouts) — this feature
        // stays out of its way there entirely, rather than trying to
        // guess when the player "really" has focus vs. the up-next
        // sidebar next to it.
        if (location.pathname === "/watch") return;

        const direction = ARROW_TO_DIRECTION[e.code] || ARROW_TO_DIRECTION[e.key];
        if (direction) {
          const candidates = getNavTargets();
          if (!candidates.length) return;
          e.preventDefault();
          e.stopPropagation();
          if (!focusedEl || !isCardUsable(focusedEl)) {
            setFocus(candidates[0]);
            return;
          }
          const next = findNext(direction, candidates);
          if (next) {
            const entry = candidates.find((c) => c.el === next);
            setFocus(entry || { el: next, isButton: false });
          } else if (direction === "down") {
            // Nothing further down among what's currently loaded — try
            // to load more instead of just doing nothing (see
            // loadMoreThenFocus() above).
            loadMoreThenFocus(direction);
          }
          return;
        }

        if (e.key === "Enter" && focusedEl) {
          e.preventDefault();
          e.stopPropagation();
          openFocused();
        }
      },
      { capture: true }
    );
  }
})();

/* content-gemini.js
   Runs on gemini.google.com. Two jobs:
     1. Watch the chat for new model-response bubbles and, once a
        response has finished streaming, AUTOMATICALLY scrape it and
        relay it to background.js — no button, no click required.
     2. Handle INJECT_SEARCH messages from background.js: focus the
        chat box and type in the strict literary lookup prompt.

   IMPORTANT — Google's class/tag names here are obfuscated and change
   without notice. If auto-scrape stops firing, or search injection
   stops working, open DevTools on a live Gemini response, find the
   real selector, and update SELECTORS below. Everything else in this
   file is written to keep working as long as SELECTORS stays roughly
   accurate — in particular, "has this response finished generating?"
   is detected by DOM quiescence (no mutations for a short while), not
   by a specific class name, so it survives most DOM churn on its own. */

const SELECTORS = {
  // Candidate containers for a single model-response bubble. Tried in
  // order; the first selector that matches anything on the page wins.
  RESPONSE: [
    "model-response",
    "[data-response-index]",
    ".response-container-content",
    ".conversation-container .model-response-text",
  ],
  // Candidate chat input boxes (a contenteditable rich-text box).
  CHAT_INPUT: [
    "rich-textarea .ql-editor",
    "div.ql-editor[contenteditable='true']",
    "[contenteditable='true'][role='textbox']",
  ],
  // Optional — clicked after injecting text to submit immediately.
  SEND_BUTTON: ["button[aria-label*='Send' i]", "button.send-button"],
  // If a "stop generating" control is visible, the response is still
  // streaming even if the DOM has briefly gone quiet (e.g. a pause
  // mid-thought) — used as a guard before treating a bubble as done.
  STOP_BUTTON: [
    "button[aria-label*='Stop' i]",
    "button[data-test-id*='stop' i]",
    "button.stop-icon",
  ],
};

// The prompt is user-editable via the extension's popup (popup.html /
// popup.js). As of the multi-prompt popup, up to SLOT_COUNT variants can
// be saved at once under vocabBridge_promptSlots, with
// vocabBridge_activePromptIndex marking which one is actually sent to
// Gemini — both read fresh on every search, so switching the active
// slot in the popup applies immediately, no rebuild/reload needed.
// DEFAULT_PROMPT_TEMPLATE is the fallback when nothing has been saved
// yet — keep it in sync with DEFAULT_PROMPT in popup.js. (A single
// prompt used to live under the older vocabBridge_customPrompt key;
// popup.js migrates that into slot 1 the first time it's opened, but
// resolveActiveTemplate() below also honors it directly in case a
// search happens before the popup has ever been opened post-upgrade.)
//
// Supports two placeholders: {word} (the looked-up word) and {book}
// (the book title, passed through from the app via background.js —
// see bookTitle in injectSearchTerm below). If no book title reaches
// this content script, {book} falls back to "this book" so the prompt
// still reads naturally.
//
// Deliberately does NOT ask Gemini to type out an image URL as text: a
// typed-out URL comes from the model's memory and is frequently
// hallucinated/dead (e.g. a fictional character has no real Wikimedia
// photo); an image Gemini actually attaches/renders in its own UI is
// guaranteed to be real, since Gemini itself just displayed it
// successfully. If you edit the prompt in the popup, keep the
// "attach one representative image" instruction to preserve that
// guarantee.
//
// Also asks for a US and a UK phonetic respelling, on the SAME single
// line as the definition, separated by "|". This is what lets the
// app's Pronunciation panel populate for proper nouns, character names,
// and rare/archaic words that the Free Dictionary API (script.js's
// normal source for phonetics) simply has no entry for.
//
// script.js's playAudioChain() only SPEAKS this respelling text as a
// last resort — when the device has no genuine en-US/en-GB system voice
// installed and playback falls all the way through to Google Translate's
// accent-less voice (or the browser's bare default voice). Whenever a
// real accent-matched voice IS available, script.js speaks the actual
// looked-up word with that voice instead (far more accurate — a TTS
// engine reading "lai-luhk" literally mangles it, since it isn't a real
// word). So the respelling is mainly for the on-screen Pronunciation
// panel; it only doubles as spoken text on devices without proper
// en-US/en-GB voices. The prompt still asks for real
// accent-distinguishing pronunciation (rhotic vs. dropped "r", vowel
// shifts, etc.), not just a different-looking spelling, and asks for
// plain syllables a TTS voice can read naturally rather than IPA symbols
// or punctuation a speech engine would stumble over — that still matters
// for the fallback case and keeps the panel itself accurate to read.
//
// An earlier version of this prompt asked for three separate labeled
// lines (DEF: / US: / UK:) instead. That turned out to be unreliable —
// Gemini's markdown renderer very often puts each label on its own
// line/paragraph with the actual content on the *next* line, which a
// same-line "label: content" parser can't see. A single pipe-delimited
// line has no such ambiguity: parseGeminiReply() just flattens all
// whitespace and splits on "|", so it doesn't matter how the reply gets
// wrapped or paragraphed. If you edit the prompt in the popup, keep the
// "one line ... separated by |" instruction — dropping the pipes makes
// parsing fall back to treating the whole reply as just the definition,
// with no pronunciation.
const SLOTS_KEY = "vocabBridge_promptSlots";
const ACTIVE_KEY = "vocabBridge_activePromptIndex";
const LEGACY_PROMPT_KEY = "vocabBridge_customPrompt";
const DEFAULT_PROMPT_TEMPLATE = (
  `Context: the book "{book}". Reply with ONE plain-text line, no markdown, no labels: ` +
  `a 2-line definition of "{word}" in this context, then "|", then {word}'s US pronunciation ` +
  `as a natural-sounding phonetic respelling (real American accent — e.g. pronounced "r", ` +
  `stressed syllable in CAPS, no IPA symbols), then "|", then {word}'s UK pronunciation the ` +
  `same way (real British accent — e.g. dropped final "r"). Then attach one representative image.`
);

// Resolves whichever prompt variant is currently marked "active" in the
// popup's multi-slot storage. Falls back to the pre-multi-prompt single
// value (if that's all that's there — e.g. right after upgrading, before
// the popup has run its migration), then to the built-in default.
async function resolveActiveTemplate() {
  const stored = await chrome.storage.local.get([SLOTS_KEY, ACTIVE_KEY, LEGACY_PROMPT_KEY]);
  const slots = Array.isArray(stored[SLOTS_KEY]) ? stored[SLOTS_KEY] : null;

  if (slots && slots.length) {
    const idx =
      Number.isInteger(stored[ACTIVE_KEY]) && stored[ACTIVE_KEY] >= 0 && stored[ACTIVE_KEY] < slots.length
        ? stored[ACTIVE_KEY]
        : 0;
    const active = slots[idx];
    if (active && typeof active.text === "string" && active.text.trim()) return active.text;
  }

  if (typeof stored[LEGACY_PROMPT_KEY] === "string" && stored[LEGACY_PROMPT_KEY].trim()) {
    return stored[LEGACY_PROMPT_KEY];
  }

  return DEFAULT_PROMPT_TEMPLATE;
}

async function buildLiteraryPrompt(word, bookTitle) {
  const template = await resolveActiveTemplate();
  const book = (bookTitle && bookTitle.trim()) || "this book";

  let prompt = template.includes("{book}") ? template.replace(/{book}/g, book) : template;
  // If the saved template forgot the {word} placeholder, tack the word
  // on the end instead of silently sending a wordless prompt to Gemini.
  prompt = prompt.includes("{word}") ? prompt.replace(/{word}/g, word) : `${prompt}\n\nWord: "${word}"`;
  return prompt;
}

const PROCESSED_ATTR = "data-vocab-bridge-processed"; // already scraped, ignore forever
const WATCHING_ATTR = "data-vocab-bridge-watching";   // already has a settle-timer running
const SETTLE_DELAY_MS = 1500; // no DOM changes inside the bubble for this long => "done generating"
const SETTLE_RECHECK_MS = 700; // extra wait if a Stop button is still visibly present

function firstMatch(selectorList, root = document) {
  for (const sel of selectorList) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function allMatches(selectorList, root = document) {
  for (const sel of selectorList) {
    const list = root.querySelectorAll(sel);
    if (list.length) return Array.from(list);
  }
  return [];
}

function isVisible(el) {
  return !!(el && el.offsetParent !== null);
}

/* -------------------------------------------------------------------
   1. Auto-scrape: detect "response finished generating" and act
      with zero user interaction.
------------------------------------------------------------------- */

// Per-bubble debounce timers, keyed by element so they don't leak.
const settleTimers = new WeakMap();

function watchResponseBubble(bubble) {
  if (bubble.hasAttribute(PROCESSED_ATTR) || bubble.hasAttribute(WATCHING_ATTR)) return;
  bubble.setAttribute(WATCHING_ATTR, "1");
  console.log(
    `[VocabBridge] New response bubble detected: <${bubble.tagName.toLowerCase()} class="${bubble.className}">`
  );

  const scheduleSettleCheck = (delay) => {
    clearTimeout(settleTimers.get(bubble));
    settleTimers.set(
      bubble,
      setTimeout(() => onBubbleSettled(bubble, bubbleObserver), delay)
    );
  };

  const bubbleObserver = new MutationObserver(() => scheduleSettleCheck(SETTLE_DELAY_MS));
  bubbleObserver.observe(bubble, { childList: true, subtree: true, characterData: true });
  scheduleSettleCheck(SETTLE_DELAY_MS); // start the clock immediately, in case it's already done
}

function onBubbleSettled(bubble, bubbleObserver) {
  if (bubble.hasAttribute(PROCESSED_ATTR)) return; // dedupe races

  // Still streaming (e.g. a mid-response pause) — give it more time
  // instead of scraping a half-finished answer.
  const stopBtn = firstMatch(SELECTORS.STOP_BUTTON);
  if (isVisible(stopBtn)) {
    clearTimeout(settleTimers.get(bubble));
    settleTimers.set(bubble, setTimeout(() => onBubbleSettled(bubble, bubbleObserver), SETTLE_RECHECK_MS));
    return;
  }

  bubble.setAttribute(PROCESSED_ATTR, "1");
  bubbleObserver.disconnect();
  scrapeAndSend(bubble);
}

async function scrapeAndSend(bubble) {
  const { definition, imageUrl, usPronunciation, ukPronunciation } = scrapeContent(bubble);
  console.log(
    `[VocabBridge] Bubble settled → definition: "${definition}" | imageUrl: "${imageUrl}" | ` +
      `US: "${usPronunciation}" | UK: "${ukPronunciation}"`
  );

  if (!definition && !imageUrl && !usPronunciation && !ukPronunciation) {
    console.warn("[VocabBridge] Nothing usable scraped from this response.");
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      type: "GEMINI_ENTRY_SCRAPED",
      payload: { definition, imageUrl, usPronunciation, ukPronunciation, raw: definition },
    });
    console.log("[VocabBridge] Sent to background.js successfully.");
  } catch (err) {
    console.error("[VocabBridge] Failed to relay scraped entry:", err);
  }
}

// Prefers the real <img> Gemini rendered in its own response (its src
// is guaranteed to actually load, since Gemini just displayed it). Only
// falls back to pulling a URL out of the text if no image was attached
// — and if it does, strips that URL back out of the definition text so
// it doesn't leak into the saved definition. The remaining text is then
// handed to parseGeminiReply() to split into the definition and the two
// pronunciation lines.
function scrapeContent(bubble) {
  let text = extractText(bubble);
  let imageUrl = "";

  const imgEl = bubble.querySelector("img");
  if (imgEl) {
    // currentSrc reflects the actually-loaded resource (handles
    // srcset/lazy-loading); falls back to src if not populated yet.
    imageUrl = imgEl.currentSrc || imgEl.src || "";
  } else {
    const match = text.match(/https?:\/\/\S+/);
    if (match) {
      imageUrl = match[0].replace(/[)\].,]+$/, ""); // trim trailing punctuation
      text = text.replace(match[0], "").trim();
    }
  }

  const { definition, usPronunciation, ukPronunciation } = parseGeminiReply(text);
  return { definition, imageUrl, usPronunciation, ukPronunciation };
}

// Splits Gemini's reply on "|" into definition / US pronunciation / UK
// pronunciation. Whitespace (including any line breaks Gemini's own
// markdown rendering introduced) is flattened to single spaces FIRST,
// before splitting — so it doesn't matter whether the reply came back
// as one paragraph or got wrapped across several; the pipes are the
// only thing that matters. Degrades gracefully if Gemini didn't follow
// the format at all (no "|" found): the whole reply becomes the
// definition and both pronunciations are left empty, rather than
// silently swallowing content.
function parseGeminiReply(rawText) {
  const flattened = rawText.replace(/\s+/g, " ").trim();
  if (!flattened) return { definition: "", usPronunciation: "", ukPronunciation: "" };

  const parts = flattened.split("|").map((part) => part.trim());

  if (parts.length >= 3) {
    return { definition: parts[0], usPronunciation: parts[1], ukPronunciation: parts[2] };
  }
  if (parts.length === 2) {
    // Only one pronunciation came back — assume it's US and leave UK
    // empty rather than guessing wrong.
    return { definition: parts[0], usPronunciation: parts[1], ukPronunciation: "" };
  }
  return { definition: flattened, usPronunciation: "", ukPronunciation: "" };
}

function extractText(bubble) {
  const clone = bubble.cloneNode(true);
  // Strip visually-hidden accessibility labels (e.g. a screen-reader-only
  // "Gemini said" span) — they're in the DOM for a11y but aren't part of
  // the actual response, and innerText still picks them up since they're
  // clipped off-screen rather than display:none.
  clone
    .querySelectorAll(".cdk-visually-hidden, .visually-hidden, .sr-only, .a11y-hidden, [aria-hidden='true']")
    .forEach((el) => el.remove());

  let text = (clone.innerText || clone.textContent || "").trim();
  // Fallback in case that label uses a class we didn't anticipate —
  // strip a leading "Gemini said" regardless of markup.
  text = text.replace(/^gemini said[:\s]*/i, "").trim();
  return text;
}


/* -------------------------------------------------------------------
   MutationObserver — watches for newly-added response bubbles and
   hands each one to watchResponseBubble() exactly once. Wired up on
   every content-script load, which Chrome triggers automatically on
   every navigation, so it needs zero further user action.
------------------------------------------------------------------- */

const topLevelObserver = new MutationObserver(() => {
  // Chat streaming fires many mutations per second — batch with rAF
  // instead of re-scanning the DOM on every single one.
  window.requestAnimationFrame(() => {
    const bubbles = allMatches(SELECTORS.RESPONSE);
    bubbles.forEach(watchResponseBubble);
  });
});

function start() {
  // Diagnostic: reports whether ANY of the RESPONSE selectors currently
  // match anything on the page at all. If this logs 0, the selectors
  // are stale and nothing downstream can work — open DevTools, inspect
  // a real response bubble, and update SELECTORS.RESPONSE.
  const initialMatches = allMatches(SELECTORS.RESPONSE);
  console.log(
    `[VocabBridge] Startup check: found ${initialMatches.length} element(s) matching SELECTORS.RESPONSE.` +
      (initialMatches.length === 0
        ? " None matched — auto-scrape cannot work until SELECTORS.RESPONSE is updated to match Gemini's real DOM."
        : "")
  );

  // Mark any bubbles already on the page (old conversation history,
  // or a refresh) as processed so they're never re-scraped — only
  // responses that arrive AFTER this point (i.e. from a fresh
  // "Search Gemini" lookup) get auto-scraped.
  initialMatches.forEach((b) => b.setAttribute(PROCESSED_ATTR, "1"));
  topLevelObserver.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

/* -------------------------------------------------------------------
   2. Search-Bridge: receive a word from background.js, type in the
      strict literary lookup prompt.
------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "INJECT_SEARCH") {
    injectSearchTerm(message.word, message.bookTitle).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});

async function injectSearchTerm(word, bookTitle) {
  const input = await waitForElement(SELECTORS.CHAT_INPUT, 8000);
  if (!input) {
    console.warn("[VocabBridge] Couldn't find the Gemini chat input box — selectors may be stale.");
    return;
  }

  const prompt = await buildLiteraryPrompt(word, bookTitle);

  input.focus();
  // execCommand (still supported for contenteditable, deprecated
  // elsewhere) fires real InputEvents that Angular's own listeners pick
  // up — just setting .textContent does not reliably update its model.
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  document.execCommand("insertText", false, prompt);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: prompt, inputType: "insertText" }));

  const sendBtn = firstMatch(SELECTORS.SEND_BUTTON);
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  }
}

/* -------------------------------------------------------------------
   3. Return-to-App shortcut: lets you jump back to the VocabBuilderPLUS
      tab from here without touching the mouse, using whichever key the
      app's own Keyboard Shortcuts panel has assigned to "Return to App
      Tab". That binding is synced into chrome.storage.local by
      background.js (see its SYNC_SHORTCUT_KEYS handler) every time it
      changes in the app, so this stays correct without a reload as
      long as this content script is (re)loaded after the sync — and
      the chrome.storage.onChanged listener below keeps it current even
      without that.
------------------------------------------------------------------- */
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
    console.warn("[VocabBridge] Couldn't reach the extension to return to the app tab.");
  });
});

function waitForElement(selectorList, timeoutMs) {
  return new Promise((resolve) => {
    const existing = firstMatch(selectorList);
    if (existing) {
      resolve(existing);
      return;
    }

    const obs = new MutationObserver(() => {
      const found = firstMatch(selectorList);
      if (found) {
        obs.disconnect();
        resolve(found);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(firstMatch(selectorList));
    }, timeoutMs);
  });
}

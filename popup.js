/* popup.js
   Lets you keep up to SLOT_COUNT prompt variants saved at once, pick
   any one to view/edit, and mark one of them "active" — the active
   slot's text is what content-gemini.js actually sends to Gemini on
   the next "Search Gemini". The other slots stay saved untouched so
   you can switch between them without retyping.

   Storage (chrome.storage.local):
     vocabBridge_promptSlots        -> [{ name, text }, ...] length SLOT_COUNT
     vocabBridge_activePromptIndex  -> index into the array above

   content-gemini.js reads these same two keys fresh on every search,
   so switching the active slot here applies immediately — no
   rebuild/reload of the extension needed.

   A single prompt used to be stored under vocabBridge_customPrompt
   (pre-multi-prompt). If that's the only thing found in storage, it's
   migrated into slot 1 the first time this popup opens, and removed
   afterward. */

const SLOTS_KEY = "vocabBridge_promptSlots";
const ACTIVE_KEY = "vocabBridge_activePromptIndex";
const LEGACY_PROMPT_KEY = "vocabBridge_customPrompt";
const SLOT_COUNT = 4;

// Kept in sync with DEFAULT_PROMPT_TEMPLATE in content-gemini.js.
// If you change one, change the other. Keep the reply as ONE line with
// two "|" separators (definition | US pronunciation | UK pronunciation)
// — content-gemini.js's parser flattens whitespace and splits on "|",
// so it doesn't care about line breaks, but it does need those two
// pipes to find the pronunciations at all.
//
// script.js only falls back to SPEAKING the US/UK respellings (rather
// than a real accent-matched voice reading the actual word) on devices
// with no proper en-US/en-GB system voice installed — see
// playAudioChain()/cleanRespellingForSpeech() in script.js. That fallback
// still matters (not every device has those voices), and the respelling
// is always shown in the Pronunciation panel regardless, so it's worth
// asking for real accent differences (pronounced vs. dropped "r", vowel
// shifts) and plain, TTS-readable syllables rather than IPA symbols if
// you customize this further.
const DEFAULT_PROMPT = (
  `Context: the book "{book}". Reply with ONE plain-text line, no markdown, no labels: ` +
  `a 2-line definition of "{word}" in this context, then "|", then {word}'s US pronunciation ` +
  `as a natural-sounding phonetic respelling (real American accent — e.g. pronounced "r", ` +
  `stressed syllable in CAPS, no IPA symbols), then "|", then {word}'s UK pronunciation the ` +
  `same way (real British accent — e.g. dropped final "r"). Then attach one representative image.`
);

function defaultSlots() {
  return Array.from({ length: SLOT_COUNT }, (_, i) => ({
    name: `Prompt ${i + 1}`,
    text: DEFAULT_PROMPT,
  }));
}

let slots = defaultSlots();
let activeIndex = 0;
let currentTab = 0;

const tabsEl = document.getElementById("tabs");
const nameInput = document.getElementById("slot-name");
const textarea = document.getElementById("prompt");
const useBtn = document.getElementById("use");
const activeBadge = document.getElementById("active-badge");
const statusEl = document.getElementById("status");

function showStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => {
    if (statusEl.textContent === msg) statusEl.textContent = "";
  }, 1500);
}

function renderTabs() {
  tabsEl.innerHTML = "";
  slots.forEach((slot, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "tab" + (i === currentTab ? " tab-selected" : "") + (i === activeIndex ? " tab-active" : "");
    btn.textContent = slot.name || `Prompt ${i + 1}`;
    btn.title =
      i === activeIndex
        ? "Currently used for searches — click to view/edit"
        : "Click to view/edit this saved prompt";
    btn.addEventListener("click", () => selectTab(i));
    tabsEl.appendChild(btn);
  });
}

function updateActiveBadge() {
  activeBadge.textContent = currentTab === activeIndex ? "● Active — used for every search" : "";
  useBtn.disabled = currentTab === activeIndex;
  useBtn.textContent = currentTab === activeIndex ? "This is the active prompt" : "Use this prompt";
}

function selectTab(i) {
  currentTab = i;
  nameInput.value = slots[i].name;
  textarea.value = slots[i].text;
  renderTabs();
  updateActiveBadge();
}

async function persist() {
  await chrome.storage.local.set({ [SLOTS_KEY]: slots, [ACTIVE_KEY]: activeIndex });
}

async function load() {
  const stored = await chrome.storage.local.get([SLOTS_KEY, ACTIVE_KEY, LEGACY_PROMPT_KEY]);

  if (Array.isArray(stored[SLOTS_KEY]) && stored[SLOTS_KEY].length) {
    // Normalize to exactly SLOT_COUNT entries — fills in defaults for
    // any slot that's missing or malformed, so a corrupted/partial
    // save never breaks the popup.
    const base = defaultSlots();
    slots = base.map((fallback, i) => {
      const saved = stored[SLOTS_KEY][i];
      return saved && typeof saved.text === "string" && saved.text.trim()
        ? { name: (saved.name && saved.name.trim()) || fallback.name, text: saved.text }
        : fallback;
    });
  } else if (typeof stored[LEGACY_PROMPT_KEY] === "string" && stored[LEGACY_PROMPT_KEY].trim()) {
    // One-time migration from the old single-prompt storage.
    slots = defaultSlots();
    slots[0] = { name: "My Prompt", text: stored[LEGACY_PROMPT_KEY] };
    await chrome.storage.local.remove(LEGACY_PROMPT_KEY);
  } else {
    slots = defaultSlots();
  }

  activeIndex =
    Number.isInteger(stored[ACTIVE_KEY]) && stored[ACTIVE_KEY] >= 0 && stored[ACTIVE_KEY] < SLOT_COUNT
      ? stored[ACTIVE_KEY]
      : 0;

  await persist(); // write back the normalized/migrated state
  selectTab(activeIndex);
}

document.getElementById("save").addEventListener("click", async () => {
  const text = textarea.value.trim();
  if (!text) return;
  slots[currentTab] = { name: nameInput.value.trim() || `Prompt ${currentTab + 1}`, text };
  await persist();
  renderTabs();
  showStatus("Saved ✓");
});

useBtn.addEventListener("click", async () => {
  activeIndex = currentTab;
  await persist();
  renderTabs();
  updateActiveBadge();
  showStatus("Now active for searches ✓");
});

document.getElementById("reset").addEventListener("click", async () => {
  const name = nameInput.value.trim() || `Prompt ${currentTab + 1}`;
  slots[currentTab] = { name, text: DEFAULT_PROMPT };
  textarea.value = DEFAULT_PROMPT;
  nameInput.value = name;
  await persist();
  renderTabs();
  showStatus("Reset to default ✓");
});

nameInput.addEventListener("change", async () => {
  slots[currentTab].name = nameInput.value.trim() || `Prompt ${currentTab + 1}`;
  await persist();
  renderTabs();
});

load();

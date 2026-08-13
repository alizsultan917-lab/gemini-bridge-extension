# Vocab Register — Gemini Bridge (Chrome Extension)

## What each file does
- `manifest.json` — MV3 config. Declares two content scripts (Gemini side,
  app side) and the background service worker.
- `background.js` — relays messages between the two content scripts;
  also owns tab-finding/creating logic for "Search Gemini".
- `content-gemini.js` — runs on gemini.google.com. Types the strict
  literary lookup prompt into the chat box on request, then watches
  each response with a `MutationObserver` and — as soon as it detects
  the reply has finished streaming — automatically parses and scrapes
  it: a definition, an attached image, and a US + UK phonetic
  respelling. **Fully automated: no "Save to Register" button, no
  click.**
- `bridge-app.js` — runs on your app's page. Pure relay: turns
  `chrome.runtime` messages into `window.postMessage` and back, so your
  app's own `script.js` never has to touch the `chrome.*` API.

## The automated flow
1. You click **"Search Gemini"** in your app (or it opens a new tab).
2. `content-gemini.js` types this prompt into Gemini's chat box and
   submits it:
   > Context: the book "[book title]". Reply with ONE plain-text line,
   > no markdown, no labels: a 2-line definition of "[word]" in this
   > context, then "|", then [word]'s US pronunciation as a
   > natural-sounding phonetic respelling (real American accent — e.g.
   > pronounced "r", stressed syllable in CAPS, no IPA symbols), then
   > "|", then [word]'s UK pronunciation the same way (real British
   > accent — e.g. dropped final "r"). Then attach one representative
   > image.
3. A `MutationObserver` watches the new response bubble. Once the DOM
   inside it stops changing for ~1.5s (and no "Stop generating" control
   is still visible), the reply is treated as finished.
4. The bubble is scraped: the real `<img>` Gemini attached (never a
   typed-out URL — see "Known fragility" below for why), plus the text,
   which `parseGeminiReply()` flattens and splits on `|` into
   definition / US pronunciation / UK pronunciation. All four pieces
   are sent instantly to `background.js`, which relays them to your app
   tab — no click, no popup, no manual copy/paste.
5. Your app's existing bridge listener (in `script.js`) auto-populates
   the pending definition, image, and Pronunciation panel fields, ready
   for you to review and hit **Add Entry**.

### Pronunciation, specifically
The Free Dictionary API that `script.js` normally uses for phonetics has
no entries at all for most proper nouns — character names, place names,
invented words — which is why the Pronunciation panel used to just show
"—" for those. Gemini fills that gap: it can't produce real recorded
audio, only text, so the US/UK respellings it returns are stored as
text-only phonetics (no audio clip).

Pressing the 🔊 buttons plays, in order: (1) real recorded dictionary
audio, if there is any; (2) a genuinely accent-matched system voice, if
this device has one installed (e.g. Chrome's built-in "Google UK English
Female" / "Google US English", preferred over lower-quality OS voices
when both are present) — this speaks the **actual word**, letting the
voice's own native pronunciation rules produce the accent, the same way
Google's own pronunciation widget does it; (3) Google Translate's voice
as a fallback for devices with no accent-specific system voice, which
sounds natural but has no accent parameter at all, so it reads US and UK
identically; (4) the browser's default-voice speech synthesis as a last
resort. Only steps (3) and (4) fall back to speaking Gemini's respelling
text instead of the plain word (via `cleanRespellingForSpeech()` in
`script.js`, which strips syllable hyphens and any trailing punctuation)
— since neither carries real accent information otherwise, reading
different-looking text is the only way left to make "US" and "UK" sound
different from each other. Feeding a respelling like "lai-luhk" into a
real accent voice instead would make things *worse*, not better — a TTS
engine reads it literally and mangles it, since it isn't an actual word
— which is why step (2) always uses the real word. That's also why the
prompt still asks for real accent-distinguishing pronunciation (a
pronounced vs. dropped "r", vowel shifts) instead of just any
different-looking spelling: it keeps the on-screen Pronunciation panel
accurate and gives steps (3)/(4) their best shot when no proper voice is
installed. If a word *does* have real dictionary audio, that's left
alone — Gemini's text only fills in the accents that were otherwise
empty.

An earlier version of this asked Gemini for three separate labeled lines
(`DEF:` / `US:` / `UK:`) instead of one pipe-delimited line. That turned
out to be unreliable: Gemini's markdown renderer frequently puts each
label on its own line/paragraph with the content on the *next* line,
which breaks a same-line "label: content" parser. The single-line `|`
format sidesteps that entirely — whitespace gets flattened before
splitting, so it doesn't matter how the reply gets wrapped or
paragraphed.

## Multiple saved prompts (extension popup)
Click the extension's toolbar icon to open the popup. It holds **4 prompt
slots** at once — each with its own editable name and text — so you can
keep, say, a strict "definition only" variant, a more casual/kid-friendly
one, and a couple of experiments, without losing any of them:
- Click a **tab** to view/edit that slot (renaming it via the field above
  the textarea, editing the prompt text, then **Save**).
- Click **Use this prompt** to make the slot you're viewing the one
  actually sent to Gemini on your next search — the green dot on its tab
  marks it as active. The other three slots stay saved untouched; switch
  back to any of them the same way, any time.
- **Reset to default** restores just the slot you're currently viewing
  to the built-in prompt — it doesn't touch the other three.
- Changes apply on your very next search; no rebuild/reload of the
  extension needed.

All 4 slots are stored in `chrome.storage.local` under
`vocabBridge_promptSlots` (array of `{ name, text }`), with
`vocabBridge_activePromptIndex` marking which one `content-gemini.js`
reads. If you were using an earlier single-prompt version of this
extension, that old prompt is migrated automatically into slot 1 the
first time you open the popup after updating.

## Setup
1. **Edit `manifest.json`.** The second `content_scripts` entry (`bridge-app.js`)
   must match your app's real deployed URL (already set to
   `https://alizsultan917-lab.github.io/VocabBuilderPLUS/*` — update this
   if you redeploy elsewhere, or add `file:///*` / `http://localhost/*`
   back in for local testing).
   - If you're testing over `file://`, you must also turn on **"Allow
     access to file URLs"** for this extension in `chrome://extensions`
     after loading it (see step 3) — Chrome disables file:// access for
     extensions by default.
2. Make sure your app's `index.html`/`script.js` already have the
   "Search Gemini" button and the bridge listener block (already added
   to your project).
3. Go to `chrome://extensions`, turn on **Developer mode** (top right),
   click **Load unpacked**, and select this folder.
4. Open your app, then open gemini.google.com in another tab (or just
   click "Search Gemini" — it'll open one for you). Definitions/images
   should now auto-populate with zero further clicks.

## Known fragility
Google's Gemini DOM uses obfuscated, frequently-changing class names.
Two things can break as a result, and both are controlled by the same
`SELECTORS` object at the top of `content-gemini.js`:
- **Responses aren't detected at all** — `SELECTORS.RESPONSE` no
  longer matches Gemini's response container. Open DevTools on a live
  Gemini page, inspect an actual response bubble, and add/update a
  selector.
- **"Search Gemini" stops typing into the box** — `SELECTORS.CHAT_INPUT`
  (or `SEND_BUTTON`) is stale; same fix.

The "has this response finished generating?" check itself is
selector-independent (it just waits for the DOM to go quiet), so it's
the most resilient part of the pipeline and shouldn't need updating
even when Google reshuffles class names.

If Gemini's reply doesn't contain any `|` at all (e.g. it ignored the
format, or you edited the prompt in the popup and removed the pipes),
the parser degrades gracefully — it treats the whole reply as the
definition and simply leaves the Pronunciation panel empty, rather than
sending garbage into your form. Check the Gemini tab's console for the
logged `definition` / `US` / `UK` values if pronunciations stop arriving
even though definitions still work.

## ⌨️ Customizable Keyboard Shortcuts (app-side)

The app now has a Gemini-style sliding sidebar — click the new **⌨️** icon
in the header (or press **F1**) — for fully remapping every shortcut:
header buttons, Search Gemini / Fetch with AI / Add Entry / manual-add
buttons, US/UK pronunciation, Definitions/Images list navigation +
selection, and the two tab-switch keys below. Bindings save to
`localStorage` instantly and survive reloads. Click any key field, then
press the new key; hold the configurable **Pass-Through Modifier**
(default `Alt`) while pressing a mapped key to type it as a literal
character instead of triggering the shortcut.

Two of those bindings — **Focus Gemini Tab** (`F7`) and **Return to App
Tab** (`F8`) — are synced to this extension automatically (see
`SYNC_SHORTCUT_KEYS` in `background.js` / `bridge-app.js`), so:
- Pressing `F7` in the app switches you to an already-open Gemini tab
  (it does not open a new one — that's what "Search Gemini" is for).
- Pressing your "Return to App Tab" key **while sitting on the Gemini
  tab itself** switches you straight back to the app (`content-gemini.js`
  listens for it and relays `RETURN_TO_APP_TAB` to `background.js`).

## Data flow
```
Gemini page                          Your app's page
┌─────────────────────┐              ┌─────────────────────┐
│ content-gemini.js    │              │ script.js            │
│  - MutationObserver   │              │  - "Search Gemini" btn│
│    (settle-detect)    │              │  - window.postMessage │
│  - auto-scrape+parse  │              │    listener + handshake│
└──────────┬────────────┘              └──────────┬────────────┘
           │ chrome.runtime                        │ window.postMessage
           ▼                                        ▼
       background.js  ◄────────────────────►  bridge-app.js
        (service worker, relays + tab control)  (content script)
```

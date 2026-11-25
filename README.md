# Card Assistant (stage phone reader)

An iPhone hidden in a box looks at a paper Q&A card, reads it with Google Gemini, and
speaks a short answer into your earbud. It is a plain web page (no App Store, no Mac),
served free by GitHub Pages and opened in Safari.

## How the pieces fit

```
iPhone Safari (docs/app.html)  ──photo──▶  Cloudflare Worker (worker/proxy.js)  ──▶  Gemini
        ▲                                     holds your secret key                       │
        └──────────────── text answer ◀───────────────────────────────────────────────────┘
```

- **`docs/`** holds the web pages. GitHub Pages publishes this folder as a website.
- **`worker/proxy.js`** is a small program that runs on Cloudflare (free). It keeps
  your Gemini key, so the key is never in this repo or on the web page.

| File | What it is |
|---|---|
| `docs/app.html` + `docs/app.js` | **The show app** |
| `docs/log.html` | Capture log: what the camera saw, and the replies |
| `docs/test.html` | Phase 0 camera/reading test page |
| `docs/rehearsal-checklist.html` (and `.md`) | Step-by-step pre-show checklist, phone-friendly |
| `docs/sw.js`, `docs/manifest.webmanifest`, `docs/icons/` | Home-screen app support |
| `worker/proxy.js` | Cloudflare Worker that holds the Gemini key |

---

## One-time setup (all from your iPhone)

Use Safari for everything. Some dashboards work better if you tap **aA** in the address
bar and choose **Request Desktop Website**.

### Step 1: Get a Gemini API key

1. Go to **aistudio.google.com** and sign in with a Google account.
2. Tap **Get API key** → **Create API key**, then copy it.
3. Paste it into Notes for now. **Never paste it into GitHub.** You'll delete the note
   after Step 3.

### Step 2: Make up an app password

Make up a long random password, e.g. `blue-tiger-4417-lamp-orbit`. This is your
**APP_TOKEN**. The app sends it to the Worker so strangers can't use your Gemini credit.

### Step 3: Create (or update) the Cloudflare Worker

1. Go to **dash.cloudflare.com** and sign in. Tap **Workers & Pages** (it may be under
   **Compute**).
2. **New Worker:** tap **Create** → **Create Worker**, name it `card-proxy`, tap **Deploy**.
   **Existing Worker:** tap `card-proxy`.
3. Tap **Edit code**.
4. In another Safari tab, open this repo on GitHub → **worker** → **proxy.js**, and tap the
   **copy** icon (two overlapping squares) above the code.
5. Back in the Cloudflare editor, tap inside the code, long-press → **Select All**, then
   **Paste**. Tap **Deploy**.
6. First time only: open **Settings** → **Variables and Secrets** → **Add**:
   - Type **Secret**, name `GEMINI_API_KEY`, value = your Gemini key
   - Type **Secret**, name `APP_TOKEN`, value = your app password
   - Type **Text**, name `ALLOWED_ORIGIN`, value = `https://jtacoolbeans-hub.github.io`
     (no slash at the end)
7. Copy the Worker's address (`https://card-proxy.<something>.workers.dev`). Delete the
   Gemini key from Notes.

> **Already set up for Phase 0?** You still need to do steps 3–5 once more. The new Worker
> tries backup models when Gemini is busy and fixes the "invalid argument" error. Your
> secrets stay as they are. The app shows ❌ *Worker is OUT OF DATE* until you do this.

### Step 4: Turn on GitHub Pages

1. On github.com, open this repo → **Settings** → **Pages**.
2. **Source:** **Deploy from a branch**. **Branch:** the branch with this code, folder
   **/docs**. Tap **Save**.
3. After 1–2 minutes, the page shows **"Your site is live at …"**.

### Step 5: Open the show app and add it to your Home Screen

1. Open `https://jtacoolbeans-hub.github.io/Photo-ai/app.html` (or tap **Open the show app**
   on the site's front page).
2. Open **Connection**, paste the Worker URL and app password, then tap **Test connection**.
   You want four ✅ lines.
3. Optional: tap the **Share** button (square with an up-arrow) → **Add to Home Screen** →
   **Add**. You'll get a full-screen "Cards" icon. If the screen lock or earbud buttons
   misbehave from the icon, use the Safari tab instead. See the rehearsal checklist.

---

## Using the show app

1. Tap **START**. This unlocks sound, the camera, the screen lock and the earbud buttons.
   On iPhone, all of these need one real tap.
2. Tap **Draw crop box** and drag a box around where the card sits. Only that area is
   checked and sent, which means sharper text and faster uploads.
3. **Arm** with a single earbud press (or the ARM button). The app then:
   - watches for the picture to go **still**,
   - compares a few frames and keeps the **sharpest**,
   - sends it to Gemini and **speaks the answer**,
   - waits for the card to **change** before reading again.
4. Tap **SHOW MODE** for a black screen (double-tap the screen to exit).
5. After the show, open **CAPTURE LOG** to see every capture.

### Earbud buttons

| Press | Default |
|---|---|
| Single (play/pause) | Arm / disarm |
| Double (next track) | Capture now |
| Triple (previous track) | Repeat last answer |

These only work while the app is open and nothing else is playing audio.

### Keyboard or Bluetooth clicker

Works too (a page-turner just sends ordinary keys). **Space / Enter** = single earbud press,
**→ / Page Down** = double, **← / Page Up** = triple. **A** arm/disarm, **C** capture,
**R** repeat, **S** show mode, **K** restart camera, **Esc** leave show mode.

### What it does with the card

**Gemini → What should it do with the card?** The default, **Anything**, responds to whatever
is on the card: a question gets answered, a word, name or topic gets a short interesting or funny
line, an instruction gets carried out. **Questions only** is the stricter answer-the-printed-question
mode. Use **Style** to steer the tone, e.g. *be witty*, *keep it under 15 words*, *sound confident*.
You can still edit the full prompt yourself.

### Reading speed

**Detection → Capture speed**: *Fastest* sends the first sharp frame as soon as the picture is
still. *Fast* (default) checks twice and sends the sharpest of 2. *Careful* waits longer for
the sharpest of 4. Gemini's own thinking time is also kept to a minimum.

### Cues, and vibration

**Speech & sounds → Cues** lets you set each cue (started, armed, disarmed, captured, waiting
tick, answer, failed) to **Sound** or **Off**. iPhone Safari does not allow web pages to
vibrate the phone, so there is no vibration option on iPhone; on phones whose browser supports
it (e.g. Android) **Vibrate** and **Sound + vibrate** appear automatically.

### 8BitDo (or any Bluetooth controller / clicker)

1. Put the controller in a Bluetooth mode your iPhone understands. Many 8BitDo pads have a **keyboard**
   mode and a **Switch / iOS-style gamepad** mode; how you switch differs by model, so check its manual.
   Then iPhone **Settings → Bluetooth** and tap the controller's name to pair.
2. Open the show app and tap **START**. (A controller in keyboard mode can press START itself; a
   gamepad-mode controller can't, because iOS needs a real tap or key press to start the camera and sound.)
3. Open **Keyboard & clicker → Your own buttons**. Next to **Arm / disarm**, tap **Learn**, then press the
   button you want. It says "Saved: …". Do the same for **Capture now** and **Repeat last answer**.
   This works for both keyboard-style and gamepad-style buttons, so you don't need to know which keys it sends.
4. In gamepad mode Safari only "sees" the pad after you press a button on it. If it says *No controller
   seen yet*, press any button with the app open in front.
5. Without learning anything, gamepad button **A/0** arms, **B/1** captures and **Y/3** repeats.
   Turn controller buttons off with **Controller (gamepad) buttons on**.

### If the camera disconnects

After you leave the app (a call, another app, locking the phone), iOS can refuse to give the camera back
until you touch the page again. The app then shows an orange **Camera disconnected** panel: tap it, or
press any key, and it reconnects. It also keeps retrying quietly. If it keeps happening, use a **Safari tab**
instead of the Home Screen icon (Home Screen apps re-ask for camera permission), and in Safari tap **aA →
Website Settings → Camera → Allow**.

### Free voice: Cloudflare Workers AI (version 1.9, recommended)

Gemini's voice has a tiny free limit (3 lines a minute, about 10 a day). The app's default voice is now
**Cloudflare's own AI voice**, which runs inside your Worker on Cloudflare's free daily allowance — no Google
quota, no extra key. Gemini's voice is kept as the backup. One-time setup on your phone:

1. **dash.cloudflare.com** → **Workers & Pages** → **card-proxy** → **Settings** → **Bindings** → **Add**
   → **Workers AI**. Any variable name works (e.g. `AI` or `Voice`). Save / Deploy.
2. **Edit code** → paste the new `worker/proxy.js` → **Deploy**.
3. In the app: **Connection → Test connection** should show **✅ Worker is up to date** and
   **✅ Cloudflare voice connected**. Then run **Speech & sounds → Audio check** and tick what you heard.

If a voice runs out of its free allowance, the app stops asking it for the rest of the session and uses the
other one; the status line shows a short message such as "Gemini free daily limit reached — resets in 11 h 47 m".

### The voice (version 1.14): iPhone voice first

The iPhone's own voice is now the default: it is unlimited and free, starts instantly, and spends nothing. (It was silent
for a long time only because iOS ignores speech until the page has spoken once during a tap — fixed in 1.13.1, confirmed
working on a real iPhone.) At START it says **"Ready"** out loud so you know it works. If the iPhone voice ever fails to
start, the online voices (Deepgram, then Cloudflare, then Gemini) take over for the next minute, so a hiccup never leaves you
silent. Choose another first voice any time under **Speech & sounds → Voice engine**. The sections below are about the online voices.

### Voice limits, and how to get plenty of free voice (version 1.12+)

**The free allowances are small.** Cloudflare's is 10,000 "units" a day, which on its cheaper voice (aura-1) is only
about **7,000 characters** (roughly 15 answers) and on its better voice (aura-2) about **3,700**. Gemini's voice is about
**10 lines a day**. Testing uses it up fast: the app now keeps its fixed short lines (stall line, "Number 1", "Ready")
on the phone so they are only ever made once, speaks at most **500 characters** per read (**Speech & sounds → Longest
spoken reply**), tries the cheaper Cloudflare voice first, and shows **"Voice used today"** under the camera view.

**Best fix: a Deepgram key (free credit, no card needed as far as I know).** Deepgram's voices are the same family Cloudflare
uses, but through Deepgram's own account, so the allowance is separate and much larger (new accounts get free credit worth
tens of thousands of answers — check the amount on their sign-up page). It is also very fast: sound starts in a fraction of a second.

1. Go to **deepgram.com** and sign up (the Console). Note the free credit it shows.
2. In the Console open **API Keys → Create a New API Key**, give it any name, and copy the key.
3. In Cloudflare open **stage-proxy → Settings → Variables and Secrets → Add**: type **Secret**, name
   `DEEPGRAM_API_KEY`, value = the key. Deploy.
4. Paste the newest `worker/proxy.js` into **Edit code** and Deploy (this adds the Deepgram voice; version 8).
5. In the app: **Connection → Test connection** should show **✅ Deepgram voice set up**. **Voice engine → Automatic**
   (the default) then uses Deepgram first, then Cloudflare, Gemini, and the iPhone voice as the last resort.

**Gemini voice** now accepts several models (comma-separated under **Gemini voice model**): each model has its own free
quota, and when one is used up the next is tried.

### If reading stops part-way

The progress shows in the status line ("speaking 2 of 4"), and the sound log says how many pieces and characters each answer has.
Things that used to cut it off, all fixed: the 500-character cap (it now only applies to the small free Cloudflare and Gemini
voices, never to Deepgram or the iPhone voice), a whole-download time limit on long pieces (now "no data for 12 seconds"),
and iOS pausing the audio mid-sentence (it is now woken again straight away). Replies that start with an introduction
("Here are the solutions…") no longer have the introduction read as answer 1, and "---" lines, "m^2", "×", "≈" and "°" are read naturally.

### The iPhone voice (unlimited and free): the lab

The iPhone's own voice has no limits, but on your phone it spoke without any sound. iOS decides whether speech is audible
(for example with the silent switch on) from what else the page is doing with sound, and the earlier set-up paused
everything during speech. **Speech & sounds → 🔬 iPhone voice lab** plays "Voice one … six" in six different audio
set-ups. Run it once with the **silent switch** (left side of the phone) *not* showing orange, tick what you heard, and tap
**Use it**: that set-up is saved and the iPhone voice is selected. (iOS only lets speech start after the page has spoken once during a tap; versions before 1.13.1 skipped that unless the iPhone voice was selected, which made every lab voice say "did NOT start". Update first.) If you heard nothing, flip the switch and run it again, then
**Copy report** and paste it to Claude. If it works you no longer need any online voice.

### Page detection (saves your Gemini calls)

Nothing is sent to Gemini unless a page or card is actually in view. The check runs **on the phone** (it
takes under a millisecond and costs nothing): it looks for a bright, plain, boxy region that stands out from the
background and has a clear edge. It does not look at text, so **blurry pages, nearly blank pages and small
index cards all count**. A dim room, a plain wall, a glow, a colourful TV, or a patterned blanket or clothing do not
(paper is *one plain colour*; the status line shows the "colour spread" it measured, near 0 for a card and 30+ for a blanket).
A page needs 2 sightings in a row to count and 3 misses in a row to stop, so one odd frame doesn't flip it.

- The **page** meter under the camera view shows ✓ and the page's share of the picture (✕ if none), and a **dashed
  green outline** shows what it thinks the page is. The status line says why when it sees none, and
  "Cards sent to Gemini this session" counts what you have spent.
- **Detection → Page detection**: *Broad* (default), *Strict* (only large, clear pages) or *Off*.
  **Smallest card to accept** is a percentage of the checked picture (default 2%).
- **Learn empty view** (most reliable for a fixed box): with the box empty, tap it once. From then on anything that
  differs from the empty box counts as a page, whatever its colour, size or sharpness. Learn it again if you
  move the crop box or change the camera resolution.
- A page that is in view but soft is **not** rejected: it waits up to **2 seconds** for focus (**Focus target / Wait
  for focus**), then is sent anyway. (Before, a card with just one word on it could be skipped for having too few
  sharp edges.)
- A capture you ask for yourself (double press, the button, **C**) is always sent.

### Cloudflare retires voice models (Worker version 7)

Cloudflare switches old Workers AI models off from time to time (MeloTTS stopped working on 2026-11-20). The
newest `worker/proxy.js` therefore tries several voices in turn (**aura-2-en**, then **aura-1**, then
MeloTTS), skips any that are retired, remembers which work, and as a last resort asks Cloudflare which
text-to-speech models exist today. The audio check shows which one played, e.g. `Cloudflare voice (@cf/deepgram/aura-1)`.
You can put your own choice first under **Cloudflare voice model(s)** (comma-separated; see the *Workers AI
Catalog* linked in the Worker's Bindings page). If a voice keeps failing the app pauses it for 45 seconds
instead of retrying every line, and uses the other voice meanwhile. A per-minute Gemini limit is simply waited out.
**To get this, paste the newest `worker/proxy.js` into Cloudflare again** (the app already moved you off the retired model).

### Card reading limits (Gemini)

Reading cards also uses Gemini, and its free tier is small too (your error showed 20 a day for
`gemini-3.6-flash`). Two ways round it:

- **Add more models** under **Gemini → Models to try**, separated by commas. Each Gemini model has its own
  free allowance, and when one is used up the Worker moves on to the next. Check the current models and
  limits at **aistudio.google.com → Rate limits**.
- **Turn on billing** for your Gemini API key in AI Studio. Each card then costs a tiny fraction of a cent
  and the limits are far higher. For real shows this is the safe option: a free limit can run out mid-show.

### How the voice works (version 1.8)

The iPhone's built-in web voice turned out to be silent while this page has the camera on (it reports
"speaking" but nothing comes out), and it interrupted the beeps. So the app now speaks with the **Gemini
voice**, played through the same route as the beeps, which you can hear:

- The Worker **streams** the voice: the phone starts playing the first fraction of a second while Gemini is
  still making the rest. If streaming isn't available for the voice model, it falls back to a whole file.
- The stall line and "Number 1 … Number 6" are made when you press START, so they play instantly.
- All answers on a page are voiced at the same time; repeats reuse the audio already made.
- **Requires Worker version 4**: paste the new `worker/proxy.js` into Cloudflare (Step 3, steps 3–5).
  Connection → Test connection tells you if it's out of date.

The iPhone voice is still available under **Speech & sounds → Voice engine** for phones where it works.

### No voice? Run the audio check

**Speech & sounds → 🔊 Run audio check.** It plays a beep and four numbered voices made in different ways:
(2) the iPhone voice, (3) the iPhone voice with the app's background sound paused, (4) the iPhone voice in the
normal audio mode, (5) the Gemini voice. Tick the numbers you heard and tap **Use what I heard**; the app
switches to the method that works. **Copy report** copies the technical details so you can paste them to Claude.

The **Gemini voice** is made by your Worker and played through the same route as the beeps, so it works when
the iPhone voice is silent. It is about 1–2 s slower to start, so it is a fallback: the app starts making it the
moment the answer arrives, makes several answers at once, and prepares the stall line in advance.
**It needs the updated Worker**: paste the new `worker/proxy.js` into Cloudflare once more (Step 3, steps 3–5).

### Voice fading out?

The app now pauses its inaudible background sound (used for the earbud buttons) while anything is being
said, never restarts it mid-sentence, skips beeps that would land on top of the voice, and never cancels
speech that is actually playing. If the voice still drops out, go to **Speech & sounds → Copy sound log**
right after it happens and paste it to Claude: it lists every start, pause and stop with timestamps.

### Freeze after capture

**Detection → After a capture, freeze the picture.** After a photo is taken, the screen shows that photo with a
❄ label and checking stops, so nothing in front of the camera can trigger another read. By default it stays
frozen until the answer has been spoken (or choose "until the answer arrives", or off). When it unfreezes, the
same card is not read again; a new card is.

### Pages with several questions

The app answers **every** question or item on the card, in order: "Number 1 … Number 2 …". The last-answer
box and **⤢ Expand** show them all. To go back to only the first item, untick **Gemini → Answer every
question / item on the page**. Long pages take longer to answer, so raise **Timeout & stall line** if the
stall line plays too often.

### Speech

At START it says "Ready" so you know speech works. If iOS swallows speech, the app resets it and tries
again, and shows a warning if it still won't start. Check the **ringer/silent switch** and the volume, then tap
**Speech & sounds → Test voice**. Long answers can be read in full: tap **⤢ Expand** under *Last answer*
(it also scrolls, and has A− / A+ for text size).

### Camera freezes

The app watches the camera. If the picture freezes, goes black, or iOS stops the camera, it
restarts it by itself within about 5 seconds (a second quick failure drops to plain 720p).
Each restart is written to the capture log. You can also tap **Camera ↻**, or press **K**.
The default resolution is now 1920×1440, which runs much cooler than the full 12 MP camera.
Pick a higher one under **Camera & crop → Resolution** if the text is too small to read.

### Settings worth tuning (all saved on the phone)

- **Gemini → Models to try:** `gemini-3.5-flash, gemini-flash-latest`. If the first is busy,
  the next is tried automatically. Fix the names if you see "model not found".
- **Timeout & stall line:** after how many seconds the stall line plays, and what it says.
- **Detection:** the motion threshold, how many still checks to wait for, the minimum
  sharpness, and so on. Watch the live meters under the camera view while you tune these.
- **Heat & battery:** how often it checks when disarmed, armed, and while a card is settling.

### Updates

When the code changes on GitHub, just **close and reopen the app**. It always loads the
newest version when online. The only exception is a change to `worker/proxy.js`; then
redo Step 3 (steps 3–5). The app will tell you if that's needed.

---

## Phase 0 test page

`docs/test.html` is still there for camera experiments: try resolutions, cameras, zoom,
crop and prompts, and see exactly what Gemini reads. It's useful when changing the box or
lighting.

## If something goes wrong

| What you see | Fix |
|---|---|
| ❌ Gemini key / App token | Re-add the secret in Cloudflare, spelled exactly. |
| ❌ This page is allowed | `ALLOWED_ORIGIN` must be exactly `https://jtacoolbeans-hub.github.io` |
| ❌ Worker is OUT OF DATE | Paste the new `worker/proxy.js` into Cloudflare (Step 3). |
| "model not found" | Fix the names under **Gemini → Models to try**. |
| "high demand" | Add a second model to the list; the Worker falls back automatically. |
| Camera error / black video | Tap the orange **Camera disconnected** panel, or press any key. Then iPhone Settings → Apps → Safari → Camera → **Allow**, reload. |
| No speech | Check the ringer switch and volume, tap **Test voice**, and look for a ⚠ line under the status. |
| Earbud buttons do nothing | Tap START again; close music/podcast apps; check the earbuds are connected. |
| "Screen lock: NOT held" | Set iPhone Auto-Lock to **Never** (Settings → Display & Brightness). |
| Reads the empty box / never captures | Adjust **Minimum sharpness** using the live meter. A card that is too dim or blurry shows "Not sent: sharpness…" under the status. |
| Lots of NONE in the log | Open the thumbnail: is it frozen, cut off, or too small? Try Camera ↻, a larger crop box, or a higher resolution. |
| Picture frozen / black | It should restart itself. Otherwise tap **Camera ↻** or press **K**. |

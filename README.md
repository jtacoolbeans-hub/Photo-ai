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

### Reading speed

**Detection → Capture speed**: *Fastest* sends the first sharp frame as soon as the picture is
still. *Fast* (default) checks twice and sends the sharpest of 2. *Careful* waits longer for
the sharpest of 4. Gemini's own thinking time is also kept to a minimum.

### Cues, and vibration

**Speech & sounds → Cues** lets you set each cue (started, armed, disarmed, captured, waiting
tick, answer, failed) to **Sound** or **Off**. iPhone Safari does not allow web pages to
vibrate the phone, so there is no vibration option on iPhone; on phones whose browser supports
it (e.g. Android) **Vibrate** and **Sound + vibrate** appear automatically.

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
| Camera error / black video | iPhone Settings → Apps → Safari → Camera → **Allow**, reload. |
| Earbud buttons do nothing | Tap START again; close music/podcast apps; check the earbuds are connected. |
| "Screen lock: NOT held" | Set iPhone Auto-Lock to **Never** (Settings → Display & Brightness). |
| Reads the empty box / never captures | Adjust **Minimum sharpness** using the live meter. A card that is too dim or blurry shows "Not sent: sharpness…" under the status. |
| Lots of NONE in the log | Open the thumbnail: is it frozen, cut off, or too small? Try Camera ↻, a larger crop box, or a higher resolution. |
| Picture frozen / black | It should restart itself. Otherwise tap **Camera ↻** or press **K**. |

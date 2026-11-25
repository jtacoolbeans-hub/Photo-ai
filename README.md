# Card Assistant (stage phone reader)

An iPhone hidden in a box looks at a paper Q&A card, reads it with Google Gemini, and
speaks a short answer into your earbud. It is a plain web page (no App Store, no Mac),
served free by GitHub Pages and opened in Safari.

**Current stage: Phase 0.** This is only a camera test page. It shows how sharp the
iPhone camera can get through a web page and how well Gemini reads 12pt text. The show
app gets built after you've tested this.

## How the pieces fit

```
iPhone Safari (docs/test.html)  ──photo──▶  Cloudflare Worker (worker/proxy.js)  ──▶  Gemini
        ▲                                     holds your secret key                       │
        └──────────────── text answer ◀───────────────────────────────────────────────────┘
```

- **`docs/`** holds the web pages. GitHub Pages publishes this folder as a website.
- **`worker/proxy.js`** is a small program that runs on Cloudflare (free). It keeps
  your Gemini key, so the key is never in this repo or on the web page.

---

## One-time setup (about 20 minutes, all from your iPhone)

Use Safari for everything. Some dashboards work better if you tap **aA** in the address
bar and choose **Request Desktop Website**.

### Step 1: Get a Gemini API key

1. Go to **aistudio.google.com** and sign in with a Google account.
2. Tap **Get API key** (in the menu, or at the bottom left on desktop view).
3. Tap **Create API key**, then copy it.
4. Paste it into Notes for now. **Never paste it into GitHub.** You'll delete the note
   after Step 3.

### Step 2: Make up an app password

Make up a long random password, e.g. `blue-tiger-4417-lamp-orbit`. This is your
**APP_TOKEN**. The web page sends it to the Worker so strangers can't use your Gemini
credit. Save it in Notes too.

### Step 3: Create the Cloudflare Worker

1. Go to **dash.cloudflare.com** and sign up (free plan is fine).
2. In the menu, tap **Workers & Pages** (it may be under **Compute**).
3. Tap **Create** → **Create Worker** (or **Start with Hello World!**).
4. Name it `card-proxy`, then tap **Deploy**.
5. Tap **Edit code**.
6. In another Safari tab, open this repo on GitHub, go to **worker → proxy.js**, and tap
   the **copy** icon (two overlapping squares) above the code.
7. Back in the Cloudflare editor, tap inside the code, select all (long-press →
   **Select All**), and **Paste** over it.
8. Tap **Deploy** (top right), then go back to the Worker's page.
9. Open **Settings** → **Variables and Secrets** → **Add**:
   - Type **Secret**, name `GEMINI_API_KEY`, value = your Gemini key → **Save/Deploy**
   - Type **Secret**, name `APP_TOKEN`, value = your app password → **Save/Deploy**
   - Type **Text**, name `ALLOWED_ORIGIN`, value = `https://jtacoolbeans-hub.github.io`
     (no slash at the end) → **Save/Deploy**
10. Copy the Worker's address from its overview page. It looks like
    `https://card-proxy.<something>.workers.dev`.
11. Delete the Gemini key from Notes.

### Step 4: Turn on GitHub Pages

1. Open this repo on github.com → **Settings** (you may need desktop view) → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Under **Branch**, pick `claude/stage-performer-phone-assistant-5bgbk0` (or `main` once
   the work is merged there) and set the folder to **/docs**. Tap **Save**.
4. Wait 1–2 minutes, then refresh. The page shows **"Your site is live at …"**. Tap
   that link.

> If the repo is **private**, Pages needs a paid GitHub plan. The free fix is to make the
> repo public (Settings → General → Danger Zone → Change visibility). That is safe,
> because no secret is stored in the repo.

### Step 5: Open the test page

1. On the site, tap **Phase 0: camera & reading test** (or add `/test.html` to the
   address).
2. In **1. Connection**, paste the Worker URL and your app password, then tap
   **Save & test connection**. You want four green ✅ lines.

---

## Phase 0 test: what to try

1. Tap **Start camera** and allow camera access. The big line shows the resolution you
   actually **got** (for example `3840 × 2160`). Tell me that number.
2. Try each choice under **Camera** (Back Camera, Back Ultra Wide, Back Dual Wide…)
   and note which looks sharpest up close.
3. Put a real 12pt Times New Roman card at the distance it will sit in the box. Keep
   the prompt on **Transcribe exactly**, set a 5-second delay, tap
   **Capture + send to Gemini**, and place the phone.
4. Look at the reply. Is every word right? Tap the still and pinch to zoom in on what the
   camera saw.
5. Move the **crop sliders** so the yellow box hugs the card, then send again. Cropping
   sends only the card area, which usually reads better and uploads faster.
6. If **Zoom** or **Torch** controls show up, try them. A little zoom puts more pixels
   on the text, and the torch can light a dark box.
7. Switch the prompt to **Show prompt (Q: / A: / NONE)** and tap **Speak reply** with
   your earbuds in.
8. Try **Fast mode** on and off, and compare the times shown.

**Send me back:** the resolution you got, the best camera choice, the card distance,
whether the reading was accurate, and typical reply times. I'll tune the main app to
match.

### If something goes wrong

| What you see | Fix |
|---|---|
| ❌ Gemini key / APP_TOKEN | Re-add the secret in Cloudflare (Step 3.9), spelled exactly. |
| ❌ Token you typed matches | Retype the app password on the test page. |
| ❌ This page is allowed | `ALLOWED_ORIGIN` must be exactly `https://jtacoolbeans-hub.github.io` with no slash. |
| "model not found" | Change the **Gemini model** box, e.g. `gemini-2.5-flash`. |
| Error with Fast mode on | Untick Fast mode. Some models don't accept that setting. |
| Camera error / black video | Safari → Settings → Apps → Safari → Camera → **Allow**, then reload. |

---

## Files

| File | What it is |
|---|---|
| `docs/index.html` | Landing page |
| `docs/test.html` | Phase 0 camera/reading test |
| `worker/proxy.js` | Cloudflare Worker that holds the Gemini key |

Coming in Phase 1: the show app (`docs/app.html`), offline/home-screen support, and
`docs/rehearsal-checklist.md`.

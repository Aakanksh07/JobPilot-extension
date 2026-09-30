# JobPilot Browser Extension

Fill out any job application using your [JobPilot](https://huntai-frontend.onrender.com) profile — not just the ones JobPilot's own search surfaces. Sign in on the JobPilot website once; the extension picks up that session automatically, no separate login.

This repo is open source on purpose: an extension that reads form fields on every page you visit is exactly the kind of thing you shouldn't have to take on faith. Read the code, verify what it does and doesn't do, and see [Privacy & data](#privacy--data) below for the short version.

## What it does

- Injects a small floating widget on job application pages
- **Fill this page** — extracts the visible form fields, sends them to your JobPilot account's backend for AI-assisted mapping against your resume, and fills them in
- Uploads your resume (and generates a tailored cover letter, if the page asks for one) under your actual name, not a random filename
- **Mark Applied** / **Not applying** — records the outcome in your JobPilot Job Tracker, so applications you fill here show up next to ones found through JobPilot's own search
- Draggable, and can be hidden/shown per-page from the popup

## What it does NOT do

- No auto-submit. You always click the site's own Submit button yourself — the extension fills, you review, you decide.
- No background scraping of pages you're not actively using it on.
- No third-party analytics or tracking.

## Install

**From source (this repo):**
1. Clone or download this repo
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder

**From the Chrome Web Store:** _(link once published)_

## Privacy & data

- The extension only activates on a page when you click the 🎯 icon — it doesn't read or transmit anything from pages you haven't interacted with it on.
- Your JobPilot login token is stored in `chrome.storage.local` as `JobPilot_token` — a legacy internal key name from before the JobPilot rebrand, kept as-is so existing installs don't need to re-sync (standard extension storage, not accessible to the websites you visit).
- Form field data extracted from a job page is sent to **your own JobPilot account's backend** (see `API_BASE` in `background.js`) for AI field-mapping — it is not sent anywhere else, and no third party operating this extension has access to it beyond what your JobPilot account already does.
- See [background.js](./background.js) for every network call this extension makes — there are no others.

## Configuration

If you're running your own JobPilot backend/frontend (e.g. self-hosting, or contributing), set these before loading the extension:

| File | Value | What it is |
|---|---|---|
| `manifest.json` | `host_permissions` | Your backend's domain |
| `manifest.json` | `externally_connectable.matches` | Your frontend's domain (lets the website hand off your login session to the extension) |
| `background.js` | `API_BASE` | Your backend's API base URL |
| `popup.js` | `JobPilot_SITE` | Your frontend's URL |

## License

MIT — see [LICENSE](./LICENSE).

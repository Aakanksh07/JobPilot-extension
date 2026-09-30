// JobPilot extension — background service worker.
//
// All backend calls go through here, not the content script. A content
// script's fetch() runs in the context of whatever page it's injected
// into (an arbitrary job site), so it's subject to THAT page's CORS
// policy — not yours. The background service worker is a proper
// extension context with host_permissions for your API domain, so it can
// call your backend cleanly regardless of what site the user is on.
//
// The extension never shows its own login form. The JobPilot website itself
// hands off the logged-in session via chrome.runtime.sendMessage() (see
// onMessageExternal below + the small snippet added to login.html/
// index.html/tracker.html) — same pattern LastPass/Grammarly use for their
// companion extensions. If the user is signed into JobPilot.com, the
// extension is signed in too, automatically.

const API_BASE = "https://huntai-backend.onrender.com/api/v1"; // set this to your deployed backend

async function getToken() {
  const { JobPilot_token } = await chrome.storage.local.get("JobPilot_token");
  return JobPilot_token || null;
}

async function apiFetch(path, options = {}) {
  const token = await getToken();
  const headers = { ...(options.headers || {}), "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data;
}

// ── Session handoff from the JobPilot website ─────────────────────────────
// Only pages matching "externally_connectable" in manifest.json (your
// JobPilot.com domain) can send these — no other website can call this.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "PING": {
          // Lets the website detect "is the extension installed at all"
          // (distinct from "is it synced") — used to show/hide the
          // install banner and nav badge.
          sendResponse({ ok: true, installed: true });
          break;
        }
        case "JobPilot_SYNC": {
          // Sent after login, on page load if already logged in, and
          // whenever the user switches their active resume.
          await chrome.storage.local.set({
            JobPilot_token:     msg.token || null,
            JobPilot_email:     msg.email || null,
            JobPilot_resume_id: msg.resumeId || null,
          });
          sendResponse({ ok: true });
          break;
        }
        case "JobPilot_LOGOUT": {
          await chrome.storage.local.clear();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_AUTH_STATE": {
          const token = await getToken();
          const { JobPilot_resume_id, JobPilot_email } = await chrome.storage.local.get(["JobPilot_resume_id", "JobPilot_email"]);
          sendResponse({ ok: true, loggedIn: !!token, resumeId: JobPilot_resume_id || null, email: JobPilot_email || null });
          break;
        }

        case "MAP_FIELDS": {
          // Wraps POST /apply/map-fields — the new backend endpoint that
          // exposes _gemini_map_fields as a plain JSON API (see below).
          const data = await apiFetch("/apply/map-fields", {
            method: "POST",
            body: JSON.stringify({
              resume_id: msg.resumeId,
              job: msg.job,
              fields: msg.fields,
            }),
          });
          sendResponse({ ok: true, mapping: data.mapping || {} });
          break;
        }

        case "GET_RESUME_FILE": {
          const data = await apiFetch(`/resume/${msg.resumeId}`);
          sendResponse({
            ok: true,
            pdfUrl: data.resume_pdf_url,
            fullName: data.profile?.full_name || "",
          });
          break;
        }

        case "GENERATE_COVER_LETTER": {
          const data = await apiFetch("/apply/cover-letter", {
            method: "POST",
            body: JSON.stringify({ resume_id: msg.resumeId, job: msg.job }),
          });
          sendResponse({ ok: true, pdfBase64: data.pdf_base64, filename: data.filename, text: data.text });
          break;
        }

        case "TRACK_JOB": {
          // Creates (or finds) the jobs/applications rows for a job the
          // extension is filling — so it shows up in the website's own
          // Job Tracker, same as anything found through the scraper.
          const data = await apiFetch("/apply/track", {
            method: "POST",
            body: JSON.stringify({ resume_id: msg.resumeId, title: msg.title, company: msg.company, url: msg.url }),
          });
          sendResponse({ ok: true, applicationId: data.application_id, status: data.status });
          break;
        }

        case "MARK_APPLIED": {
          const data = await apiFetch(`/apply/${msg.applicationId}/mark-submitted`, { method: "POST" });
          sendResponse({ ok: true, status: data.status });
          break;
        }

        case "MARK_SKIPPED": {
          const data = await apiFetch(`/apply/${msg.applicationId}/mark-skipped`, { method: "POST" });
          sendResponse({ ok: true, status: data.status });
          break;
        }

        case "SAVE_COVER_LETTER": {
          const data = await apiFetch(`/apply/${msg.applicationId}/save-cover-letter`, {
            method: "POST",
            body: JSON.stringify({ pdf_base64: msg.pdfBase64, filename: msg.filename }),
          });
          sendResponse({ ok: true, status: data.status });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // keep the message channel open for the async response
});

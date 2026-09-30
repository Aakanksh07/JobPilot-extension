// JobPilot extension — content script.
// Injected into every page. Extraction/fill logic here mirrors what
// _extract_page_fields_json / _apply_field_mapping did in Python+Playwright
// — it's the same idea, just running natively in the browser instead of
// through a driven page. Gemini mapping still happens server-side (via the
// background worker calling /apply/map-fields), so your API key never
// ships to the client.

(async () => {
  if (window.__JobPilotInstalled) return;
  window.__JobPilotInstalled = true;

  const auth = await send({ type: "GET_AUTH_STATE" });
  if (!auth.ok || !auth.loggedIn || !auth.resumeId) return; // not logged in / no resume selected — stay dormant

  const state = { resumeUploaded: false, coverLetterUploaded: false, coverLetterText: null, applicationId: null, ended: false, coverLetterSaved: false };

  // ── messaging helper ──────────────────────────────────────────────────
  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  // ── field extraction (same shape as the Python version) ────────────────
  function getLabel(el) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.innerText.trim();
    }
    const parentLabel = el.closest("label");
    if (parentLabel) return parentLabel.innerText.trim();
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    if (el.placeholder) return el.placeholder;
    const prev = el.previousElementSibling;
    if (prev && prev.innerText) return prev.innerText.trim().slice(0, 80);
    return "";
  }

  function cssSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    let path = [], node = el;
    while (node && node.nodeType === 1 && path.length < 5) {
      let sel = node.tagName.toLowerCase();
      if (node.parentElement) {
        const sibs = Array.from(node.parentElement.children).filter((s) => s.tagName === node.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      path.unshift(sel);
      node = node.parentElement;
    }
    return path.join(" > ");
  }

  function extractFields() {
    const els = [...document.querySelectorAll(
      "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]), textarea, select"
    )];
    return els.filter((el) => el.offsetParent !== null).map((el) => {
      const out = {
        label: getLabel(el),
        type: el.tagName.toLowerCase() === "select" ? "select" : (el.type || "text"),
        selector: cssSelector(el),
        current_value: el.value || "",
        required: !!el.required,
      };
      if (el.tagName.toLowerCase() === "select") out.options = [...el.options].map((o) => o.textContent.trim());
      return out;
    });
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function jitter(minMs, maxMs) { return minMs + Math.random() * (maxMs - minMs); }

  async function applyMapping(fields, mapping) {
    const filled = {};
    let first = true;
    for (const [idxStr, value] of Object.entries(mapping)) {
      const idx = parseInt(idxStr, 10);
      const field = fields[idx];
      if (!field || !value) continue;
      const el = document.querySelector(field.selector);
      if (!el) continue;

      // Small randomized pause between fields instead of filling every
      // field in the same instant — cheap, honest improvement with no
      // functional downside, even though it's not a guarantee against
      // anything that specifically fingerprints trusted vs. scripted events.
      if (!first) await sleep(jitter(150, 450));
      first = false;

      try {
        if (field.type === "select") {
          const opt = [...el.options].find((o) => o.textContent.trim() === value);
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
        } else if (field.type === "checkbox" || field.type === "radio") {
          // Only check it if the value actually signals "yes" -- a truthy
          // STRING like "false" or "no" would otherwise check the box
          // anyway (this was the actual bug behind "every skill checkbox
          // got checked" — Gemini answering "false" for irrelevant ones
          // still passed the `!value` truthy check above).
          const negative = /^(false|no|0|none|n\/a)?$/i.test(String(value).trim());
          if (!negative) {
            el.checked = true;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            continue;
          }
        } else {
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        filled[field.label || field.selector] = value;
      } catch (e) { /* skip unfillable field */ }
    }
    return filled;
  }

  function pageContextForJob() {
    // Best-effort — the user could be on ANY job posting, not just ones
    // JobPilot's own scraper surfaced, so there's no stored job record to
    // pull from. Grab whatever signal the page itself offers.
    const title = document.title || "";
    const ogSite = document.querySelector('meta[property="og:site_name"]')?.content || "";
    const bodyText = document.body?.innerText?.slice(0, 2000) || "";
    return { title, company: ogSite, description: bodyText };
  }

  // ── file attach helper (DataTransfer is the browser-native equivalent
  // of Playwright's set_input_files) ──────────────────────────────────────
  async function attachFile(inputEl, blob, filename) {
    const file = new File([blob], filename, { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);
    inputEl.files = dt.files;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function stripDiacritics(s) {
    return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function findFileInput(keywords) {
    const inputs = [...document.querySelectorAll("input[type=file]")];
    for (const el of inputs) {
      // NOTE: deliberately NOT filtering on el.offsetParent here. Custom
      // drop-zone widgets (react-dropzone and similar — exactly what
      // "Drop or select (.doc / .docx / .pdf)" is) almost always hide the
      // real <input type=file> completely (display:none / opacity:0 /
      // zero-size) and show a styled div on top that just clicks it.
      // Hidden is the NORMAL case for file inputs, unlike text fields.
      if (el.disabled) continue;
      const label = el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText || "") : "";
      // Dropzone widgets also rarely use a proper <label for=id> at all —
      // the field name ("Résumé") is usually just a nearby heading. Walk
      // a few ancestors up and check their text too, kept shallow so it
      // doesn't pick up an unrelated field's label from further up the page.
      let nearby = "";
      let node = el.parentElement;
      for (let i = 0; i < 3 && node; i++) {
        nearby += " " + (node.innerText || "").slice(0, 150);
        node = node.parentElement;
      }
      // "Résumé" doesn't contain the plain substring "resume" -- strip
      // accents before matching or labels like this silently miss.
      const combined = stripDiacritics(`${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""} ${label} ${nearby}`).toLowerCase();
      if (keywords.some((k) => combined.includes(k))) return el;
    }
    if (keywords.includes("resume") && inputs.length === 1) return inputs[0];
    return null;
  }

  async function uploadResumeIfNeeded() {
    if (state.resumeUploaded) return;
    const resumeInput = findFileInput(["resume", "cv", "curriculum", "upload", "attach", "document"]);
    if (!resumeInput) return;
    const resumeData = await send({ type: "GET_RESUME_FILE", resumeId: auth.resumeId });
    if (!resumeData.ok || !resumeData.pdfUrl) return;
    try {
      const blob = await (await fetch(resumeData.pdfUrl)).blob();
      const filename = resumeData.fullName
        ? `${resumeData.fullName.replace(/[^A-Za-z0-9\s-]/g, "").trim().replace(/\s+/g, "_")}_Resume.pdf`
        : "Resume.pdf";
      await attachFile(resumeInput, blob, filename);
      state.resumeUploaded = true;
    } catch (e) { console.warn("[JobPilot] resume attach failed", e); }
  }

  async function uploadCoverLetterIfNeeded() {
    if (state.coverLetterUploaded) return;
    const clInput = findFileInput(["cover letter", "cover_letter", "motivation letter", "letter of interest", "covering letter"]);
    if (!clInput) return;
    const res = await send({ type: "GENERATE_COVER_LETTER", resumeId: auth.resumeId, job: pageContextForJob() });
    if (!res.ok || !res.pdfBase64) return;
    try {
      const byteChars = atob(res.pdfBase64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/pdf" });
      await attachFile(clInput, blob, res.filename || "Cover_Letter.pdf");
      state.coverLetterUploaded = true;
      state.coverLetterText = res.text || null;
      state.coverLetterPdfBase64 = res.pdfBase64;
      state.coverLetterFilename = res.filename || "Cover_Letter.pdf";
    } catch (e) { console.warn("[JobPilot] cover letter attach failed", e); }
  }

  // ── overlay UI (matches the JobPilot website's light/cream theme) ──────
  const COLORS = { bg: "#FFFFFF", bg3: "#F6F2E9", border: "#D8D2C2", accent: "#B17457", text: "#4A4947", text2: "#736E66", red: "#B34C43" };
  const FONT_BODY = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
  const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace";
  if (!document.getElementById("__jobpilot_ext_fonts")) {
    const link = document.createElement("link");
    link.id = "__jobpilot_ext_fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
  }
  function el(tag, style, html) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  const root = el("div", { position: "fixed", bottom: "20px", right: "20px", zIndex: 2147483647, width: "52px", height: "52px" });
  const panel = el("div", { position: "absolute", bottom: "62px", right: "0", display: "none", width: "300px", fontFamily: FONT_BODY, fontSize: "14px", background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: "14px", padding: "16px", boxShadow: "0 12px 40px rgba(74,73,71,0.18)", color: COLORS.text });
  const header = el("div", { display: "flex", alignItems: "center", gap: "6px", fontFamily: "'Playfair Display', serif", fontWeight: "700", fontSize: "16px", marginBottom: "12px", color: COLORS.text, cursor: "move", userSelect: "none" }, `Job<span style="color:${COLORS.text2}">Pilot</span><span style="width:5px;height:5px;border-radius:50%;background:${COLORS.accent};display:inline-block;margin-left:2px;"></span><span style="opacity:0.55;font-family:${FONT_MONO};font-weight:400;font-size:10px;margin-left:4px;">(drag to move)</span>`);
  const fillBtn = el("button", { width: "100%", background: COLORS.accent, color: "#FFFFFF", border: "none", borderRadius: "999px", padding: "10px", fontFamily: FONT_BODY, fontWeight: "600", fontSize: "13px", cursor: "pointer" }, "✨ Fill this page");
  const resultBox = el("div", { fontFamily: FONT_MONO, fontSize: "11.5px", color: COLORS.text2, marginTop: "8px", marginBottom: "8px", lineHeight: "1.55" });
  const divider = el("div", { borderTop: `1px solid ${COLORS.border}`, margin: "10px 0" });
  const doneLabel = el("div", { fontSize: "11px", color: COLORS.text2, marginBottom: "8px" }, "When you're done with this application:");
  const row = el("div", { display: "flex", gap: "8px" });
  const appliedBtn = el("button", { flex: "1", background: "transparent", color: COLORS.accent, border: `1px solid ${COLORS.accent}`, borderRadius: "999px", padding: "8px", fontFamily: FONT_BODY, fontWeight: "600", fontSize: "12px", cursor: "pointer" }, "✅ Mark Applied");
  const skipBtn = el("button", { flex: "1", background: "transparent", color: COLORS.red, border: `1px solid rgba(179,76,67,0.4)`, borderRadius: "999px", padding: "8px", fontFamily: FONT_BODY, fontWeight: "600", fontSize: "12px", cursor: "pointer" }, "⏭ Not applying");
  row.append(appliedBtn, skipBtn);
  panel.append(header, fillBtn, resultBox, divider, doneLabel, row);

  const fab = el("button", { width: "52px", height: "52px", borderRadius: "50%", border: `1px solid ${COLORS.border}`, background: COLORS.bg, color: COLORS.accent, fontSize: "20px", cursor: "grab", boxShadow: "0 6px 20px rgba(74,73,71,0.16)" }, "🎯");

  // ── Dragging ────────────────────────────────────────────────────────────
  // Position is saved per-origin in localStorage, same as the Playwright
  // overlay, so it survives navigating between steps of a multi-page form
  // on the same site. Works from the fab (click still opens/closes the
  // panel — click vs. drag disambiguated by movement distance) or the
  // panel header.
  const POS_KEY = "__JobPilot_ext_overlay_pos";
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
      root.style.left = saved.left + "px";
      root.style.top = saved.top + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
    }
  } catch {}

  let open = false;
  let dragging = false, moved = false, startX, startY, startLeft, startTop, dragViaFab = false;

  function dragStart(viaFab) {
    return (e) => {
      dragging = true; moved = false; dragViaFab = viaFab;
      const rect = root.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      root.style.left = startLeft + "px";
      root.style.top = startTop + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
      e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
  }
  function dragMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    const newLeft = Math.min(Math.max(0, startLeft + dx), window.innerWidth - 56);
    const newTop  = Math.min(Math.max(0, startTop + dy), window.innerHeight - 56);
    root.style.left = newLeft + "px";
    root.style.top = newTop + "px";
  }
  function dragEnd() {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left: parseFloat(root.style.left), top: parseFloat(root.style.top) })); } catch {}
    } else if (dragViaFab) {
      open = !open; panel.style.display = open ? "block" : "none";
    }
  }
  fab.addEventListener("pointerdown", dragStart(true));
  header.addEventListener("pointerdown", dragStart(false));
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", dragEnd);

  fillBtn.onclick = async () => {
    fillBtn.disabled = true; fillBtn.textContent = "Filling…"; resultBox.textContent = "";
    try {
      await uploadResumeIfNeeded();
      await uploadCoverLetterIfNeeded();
      const fields = extractFields();
      const res = await send({ type: "MAP_FIELDS", resumeId: auth.resumeId, job: pageContextForJob(), fields });
      if (!res.ok) throw new Error(res.error);
      const filled = await applyMapping(fields, res.mapping);
      const n = Object.keys(filled).length;
      let html = `<span style="color:${COLORS.accent}">✓ Filled ${n} field(s)</span>`;
      if (state.coverLetterText) {
        const safe = state.coverLetterText.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br/>");
        html += `<details style="margin-top:8px;">
          <summary style="cursor:pointer;color:${COLORS.accent};">📄 View cover letter</summary>
          <div style="margin-top:6px;max-height:200px;overflow-y:auto;font-size:11px;line-height:1.5;color:${COLORS.text2};background:${COLORS.bg3};border-radius:8px;padding:10px;">${safe}</div>
        </details>`;
      }
      resultBox.innerHTML = html;

      // Lazily create the jobs/applications rows the FIRST time a fill
      // actually does something — not on page load, so pages someone
      // just glances at (or the 🎯 they click by accident) don't clutter
      // the tracker with empty rows.
      if (!state.applicationId) {
        const job = pageContextForJob();
        const track = await send({ type: "TRACK_JOB", resumeId: auth.resumeId, title: job.title, company: job.company, url: window.location.href });
        if (track.ok) state.applicationId = track.applicationId;
      }

      // Cover letter is generated before an application record necessarily
      // exists (first fill click creates both in the same pass), so saving
      // it happens here, once — after tracking, whenever we actually have
      // both a letter and an applicationId to attach it to. Saves the PDF
      // itself (uploaded to storage server-side), not the raw text.
      if (state.applicationId && state.coverLetterPdfBase64 && !state.coverLetterSaved) {
        const saved = await send({
          type: "SAVE_COVER_LETTER", applicationId: state.applicationId,
          pdfBase64: state.coverLetterPdfBase64, filename: state.coverLetterFilename,
        });
        if (saved.ok) state.coverLetterSaved = true;
      }
    } catch (e) {
      resultBox.innerHTML = `<span style="color:${COLORS.red}">⚠ ${e.message || e}</span>`;
    } finally {
      fillBtn.disabled = false; fillBtn.textContent = "✨ Fill this page";
    }
  };

  appliedBtn.onclick = async () => {
    if (!state.applicationId) {
      resultBox.innerHTML = `<span style="color:${COLORS.red}">⚠ Fill this page at least once first, so there's something to mark applied.</span>`;
      return;
    }
    appliedBtn.disabled = true; appliedBtn.textContent = "Marking…";
    try {
      const res = await send({ type: "MARK_APPLIED", applicationId: state.applicationId });
      if (!res.ok) throw new Error(res.error);
      state.ended = true;
      resultBox.innerHTML = `<span style="color:${COLORS.accent}">✓ Saved to your Job Tracker as submitted</span>`;
    } catch (e) {
      resultBox.innerHTML = `<span style="color:${COLORS.red}">⚠ ${e.message || e}</span>`;
    } finally {
      appliedBtn.disabled = false; appliedBtn.textContent = "✅ Mark Applied";
    }
  };

  skipBtn.onclick = async () => {
    if (!state.applicationId) { resultBox.innerHTML = `<span style="color:${COLORS.text2}">Nothing tracked yet for this page.</span>`; return; }
    skipBtn.disabled = true; skipBtn.textContent = "Marking…";
    try {
      const res = await send({ type: "MARK_SKIPPED", applicationId: state.applicationId });
      if (!res.ok) throw new Error(res.error);
      state.ended = true;
      resultBox.innerHTML = `<span style="color:${COLORS.text2}">Marked as not applying.</span>`;
    } catch (e) {
      resultBox.innerHTML = `<span style="color:${COLORS.red}">⚠ ${e.message || e}</span>`;
    } finally {
      skipBtn.disabled = false; skipBtn.textContent = "⏭ Not applying";
    }
  };

  root.append(panel, fab);
  document.body.appendChild(root);

  // ── Show/hide toggle, driven from the popup ────────────────────────────
  // Respects whatever the user last set (defaults to visible), and applies
  // live if the popup's toggle is used while this page is already open —
  // no refresh needed.
  chrome.storage.local.get("JobPilot_overlay_visible", ({ JobPilot_overlay_visible }) => {
    if (JobPilot_overlay_visible === false) root.style.display = "none";
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "JobPilot_TOGGLE_VISIBILITY") {
      root.style.display = msg.visible ? "flex" : "none";
    }
  });
})();

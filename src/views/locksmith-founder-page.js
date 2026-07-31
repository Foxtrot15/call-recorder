// AIDA Locksmith Receptionist — founder/operator console (M2).
//
// Behind the existing operator login (requireLogin), same as /calls and
// /settings. It exists so the founder can see why an onboarding is stuck
// without opening a database client.
//
// What it deliberately CANNOT do: approve a profile on the client's behalf. The
// client approval is the entire safety mechanism — a founder override that
// quietly bypassed it would make the audit trail a lie. The console shows the
// approval state and the blockers; approving stays with the client. If an
// override is ever genuinely needed, it must be built as its own audited,
// reason-carrying action (see docs/LOCKSMITH_ONBOARDING_SPEC.md §10) rather
// than a second, quieter approve button.
//
// Transcripts are rendered ESCAPED, line by line. This is the one page in the
// system that displays raw customer speech, so it is the one that would suffer
// if escaping were missed.

const { escapeHtml, escapeAttr } = require("./escape");

function statusChip(status) {
  const tone = {
    created: "neutral",
    interview_ready: "neutral",
    interview_in_progress: "active",
    transcript_received: "active",
    extraction_pending: "active",
    needs_review: "attention",
    approved: "good",
    cancelled: "neutral",
    failed: "bad",
  }[status] || "neutral";
  const marker = { good: "✓", bad: "✕", attention: "!", active: "▶", neutral: "·" }[tone];
  return `<span class="chip chip--${escapeAttr(tone)}"><span aria-hidden="true">${marker}</span> ${escapeHtml(status)}</span>`;
}

function renderSessionList(sessions) {
  if (!sessions.length) {
    return '<p class="empty">No onboarding sessions yet.</p>';
  }
  const rows = sessions
    .map(
      (s) => `<tr>
        <td data-label="Session"><a href="/locksmith-founder/sessions/${escapeAttr(s.sessionId)}">${escapeHtml(s.sessionId.slice(0, 8))}…</a></td>
        <td data-label="Client">${escapeHtml(s.clientId)}</td>
        <td data-label="Status">${statusChip(s.status)}</td>
        <td data-label="Transcript">${s.hasTranscript ? "Received" : "—"}</td>
        <td data-label="Extraction">${escapeHtml(s.extractionVersion || "—")}</td>
        <td data-label="Warnings">${escapeHtml(String((s.reviewWarnings || []).length))}</td>
        <td data-label="Profile version">${escapeHtml(s.profileVersion == null ? "—" : String(s.profileVersion))}</td>
        <td data-label="Created">${escapeHtml(s.createdAt || "")}</td>
      </tr>`
    )
    .join("");

  return `<div class="table-scroll">
    <table class="sessions">
      <caption class="visually-hidden">Onboarding sessions, newest first</caption>
      <thead><tr>
        <th scope="col">Session</th><th scope="col">Client</th><th scope="col">Status</th>
        <th scope="col">Transcript</th><th scope="col">Extraction</th><th scope="col">Warnings</th>
        <th scope="col">Profile version</th><th scope="col">Created</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderTranscript(transcriptText) {
  if (!transcriptText) return '<p class="empty">No transcript received for this session.</p>';
  // Split into speaker turns for readability. Every fragment is escaped; this
  // page never inserts transcript content as markup.
  const lines = String(transcriptText).split("\n").filter((l) => l.trim());
  return `<div class="transcript-body">${lines
    .map((line) => {
      const match = line.match(/^([A-Za-z][A-Za-z ]{0,20}):\s*(.*)$/);
      if (!match) return `<p class="t-line">${escapeHtml(line)}</p>`;
      const speaker = match[1];
      const said = match[2];
      const who = /aida/i.test(speaker) ? "aida" : "owner";
      return `<p class="t-line t-line--${escapeAttr(who)}"><span class="t-speaker">${escapeHtml(speaker)}</span> <span class="t-said">${escapeHtml(said)}</span></p>`;
    })
    .join("")}</div>`;
}

function renderWarnings(title, items, kind) {
  if (!items || !items.length) return "";
  return `<div class="issues issues--${escapeAttr(kind)}">
    <h3>${escapeHtml(title)}</h3>
    <ul>${items.map((w) => `<li>${escapeHtml(w.message || w.label || String(w))}</li>`).join("")}</ul>
  </div>`;
}

function renderAuditTrail(events) {
  if (!events || !events.length) return '<p class="empty">No audit events recorded.</p>';
  return `<ol class="audit">${events
    .map(
      (e) => `<li>
        <span class="audit-when">${escapeHtml(e.created_at || "")}</span>
        <span class="audit-type">${escapeHtml(e.event_type)}</span>
        <span class="audit-actor">${escapeHtml(e.actor_type)}${e.actor_id ? ` · ${escapeHtml(e.actor_id)}` : ""}</span>
        ${e.reason ? `<span class="audit-reason">${escapeHtml(e.reason)}</span>` : ""}
      </li>`
    )
    .join("")}</ol>`;
}

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/locksmith/onboarding.css">
</head>
<body class="locksmith locksmith-founder">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">AIDA Locksmith</span>
    <span class="site-header__provider">Founder console</span>
  </p>
  <nav class="site-nav" aria-label="Console">
    <ul><li><a href="/locksmith-founder/sessions">All sessions</a></li></ul>
  </nav>
</header>
<main id="main">${body}</main>
<footer class="footer">
  <p>Operator view. Client approval cannot be performed from this console.</p>
</footer>
<script src="/locksmith/onboarding.js" defer></script>
</body>
</html>
`;
}

function renderFounderList({ sessions, tablesMissing = false }) {
  return pageShell(
    "Onboarding sessions — AIDA Locksmith founder console",
    `<h1>Onboarding sessions</h1>
     ${
       tablesMissing
         ? '<p class="notice notice--blocking">The onboarding tables are not provisioned in this environment. Apply <code>supabase/sql/lpm2_create_locksmith_onboarding.sql</code> first.</p>'
         : ""
     }
     ${renderSessionList(sessions || [])}`
  );
}

function renderFounderSession({ session, transcriptText, profileVersion, assessment, events, rerunAllowed, isDemo = false }) {
  const blockers = (assessment && assessment.blockers) || [];
  return pageShell(
    `Session ${session.sessionId.slice(0, 8)} — AIDA Locksmith founder console`,
    `<h1>Onboarding session</h1>
     ${isDemo ? '<p class="demo-banner"><span aria-hidden="true">●</span> Demonstration data — example session.</p>' : ""}

     <section aria-labelledby="overview-heading">
       <h2 id="overview-heading">Overview</h2>
       <dl class="facts">
         <div class="fact"><dt>Session</dt><dd><span class="value">${escapeHtml(session.sessionId)}</span></dd></div>
         <div class="fact"><dt>Client</dt><dd><span class="value">${escapeHtml(session.clientId)}</span></dd></div>
         <div class="fact"><dt>Status</dt><dd>${statusChip(session.status)}</dd></div>
         <div class="fact"><dt>Provider</dt><dd><span class="value">${escapeHtml(session.provider || "—")}</span></dd></div>
         <div class="fact"><dt>Provider call id</dt><dd><span class="value">${escapeHtml(session.providerCallId || "—")}</span></dd></div>
         <div class="fact"><dt>Transcript digest</dt><dd><span class="value">${escapeHtml(session.transcriptSha256 ? session.transcriptSha256.slice(0, 16) + "…" : "—")}</span></dd></div>
         <div class="fact"><dt>Extraction</dt><dd><span class="value">${escapeHtml(session.extractionVersion || "—")}</span></dd></div>
         <div class="fact"><dt>Profile version</dt><dd><span class="value">${escapeHtml(session.profileVersion == null ? "—" : String(session.profileVersion))}</span></dd></div>
         <div class="fact"><dt>Approval</dt><dd><span class="value">${escapeHtml(profileVersion ? profileVersion.status : "no draft")}</span></dd></div>
         ${session.failureCode ? `<div class="fact"><dt>Failure</dt><dd><span class="value">${escapeHtml(session.failureCode)}${session.failureDetail ? ` — ${escapeHtml(session.failureDetail)}` : ""}</span></dd></div>` : ""}
       </dl>
     </section>

     <section aria-labelledby="blocked-heading">
       <h2 id="blocked-heading">Why provisioning is blocked</h2>
       ${
         !profileVersion
           ? '<p class="empty">No draft profile yet.</p>'
           : blockers.length
             ? `<ul class="blocker-list">${blockers.map((b) => `<li><code>${escapeHtml(b.code)}</code> ${escapeHtml(b.message)}</li>`).join("")}</ul>`
             : profileVersion.status === "approved"
               ? '<p class="ok-line"><span aria-hidden="true">✓</span> Nothing blocking. Approved and eligible for provisioning.</p>'
               : '<p class="ok-line"><span aria-hidden="true">✓</span> Nothing technically blocking — awaiting the client\'s approval.</p>'
       }
     </section>

     ${
       // Corrections the client saved. The founder needs to see these — they
       // are the actual list of things to fix before the next draft.
       profileVersion && profileVersion.reviewNotes && Object.keys(profileVersion.reviewNotes).length
         ? `<section aria-labelledby="notes-heading">
              <h2 id="notes-heading">Client corrections</h2>
              <ul class="service-list">${Object.entries(profileVersion.reviewNotes)
                .map(
                  ([section, entry]) => `<li>
                    <span class="service-name">${escapeHtml(section)}${entry.forDiscussion ? " (marked for discussion)" : ""}</span>
                    <span class="service-note">${escapeHtml(entry.note || "")}</span>
                  </li>`
                )
                .join("")}</ul>
            </section>`
         : ""
     }

     ${renderWarnings("Extraction warnings", session.reviewWarnings, "warning")}
     ${renderWarnings("Contradictions", session.contradictions, "blocking")}
     ${renderWarnings("Missing fields", (session.missingFields || []).map((m) => ({ message: m.label || m.path })), "blocking")}

     <section aria-labelledby="transcript-heading">
       <h2 id="transcript-heading">Transcript</h2>
       <details class="transcript">
         <summary>Show the transcript</summary>
         ${renderTranscript(transcriptText)}
       </details>
     </section>

     <section aria-labelledby="actions-heading">
       <h2 id="actions-heading">Operator actions</h2>
       <div class="decision-actions" data-session-id="${escapeAttr(session.sessionId)}" data-client-id="${escapeAttr(session.clientId)}">
         ${
           rerunAllowed
             ? '<button type="button" class="btn btn--ghost" id="rerun-extraction">Re-run deterministic extraction</button>'
             : '<p class="note-inline">Re-running extraction is available in development and test environments only.</p>'
         }
         <button type="button" class="btn btn--danger-ghost" id="fail-session">Mark this session failed</button>
       </div>
       <div class="reject-panel" id="fail-panel" hidden>
         <label for="fail-reason">Why did it fail?</label>
         <textarea id="fail-reason" rows="2" maxlength="500" required></textarea>
         <button type="button" class="btn btn--danger" id="fail-confirm">Mark failed</button>
       </div>
       <div class="form-status" id="form-status" role="status" aria-live="polite" data-state="idle"></div>
       <p class="note-inline note-inline--critical">
         The client approves their own profile. This console cannot approve on their behalf.
       </p>
     </section>

     <section aria-labelledby="audit-heading">
       <h2 id="audit-heading">Audit history</h2>
       ${renderAuditTrail(events)}
     </section>`
  );
}

module.exports = { renderFounderList, renderFounderSession, renderTranscript, statusChip };

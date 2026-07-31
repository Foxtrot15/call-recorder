// AIDA — founder client-operations view (M5).
//
//   /locksmith-founder/clients
//   /locksmith-founder/clients/:clientId
//
// Behind requireLogin (operator). Reads ACROSS tenants by design: this is the
// view that answers "which of my pilot clients is stuck, and on what?".
//
// ─── WHAT THIS VIEW DELIBERATELY CANNOT DO ──────────────────────────
// It cannot approve a change on a client's behalf. Approval is the client's
// act — it is the whole basis of the promise that nothing goes live without
// them saying yes, and an operator-side approve button would quietly make that
// false. The founder can see, diagnose, and raise a change request with
// sourceChannel "founder_operator", which still lands in the client's queue
// awaiting THEIR approval.
//
// It also shows no customer phone numbers and no transcript text. An operator
// debugging a stuck onboarding does not need the locksmith's customers'
// personal numbers, and the least-surprising default for a cross-tenant screen
// is that it carries no personal data at all.

const { escapeHtml, escapeAttr } = require("./escape");

function chip(tone, label) {
  const markers = { good: "✓", attention: "!", bad: "✕", neutral: "•", muted: "–" };
  return `<span class="chip chip--${escapeAttr(tone)}"><span class="chip__marker" aria-hidden="true">${
    markers[tone] || "•"
  }</span>${escapeHtml(label)}</span>`;
}

function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — AIDA operator</title>
<link rel="stylesheet" href="/locksmith/onboarding.css">
<link rel="stylesheet" href="/locksmith/portal.css">
</head>
<body class="locksmith locksmith-portal locksmith-ops">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">AIDA</span>
    <span class="site-header__provider">Client operations</span>
  </p>
</header>
<main id="main">
${body}
</main>
</body>
</html>`;
}

/**
 * The list. Sorted so the clients who need something appear first — an
 * operations screen ordered alphabetically makes you read all of it every time.
 */
function renderClientOpsList({ clients, basePath }) {
  const ranked = (clients || []).slice().sort((a, b) => rank(a) - rank(b));

  const body = `
  <h1>Client operations</h1>
  <p class="lead">Every pilot client and what is holding them up. Blocked and waiting-on-us first.</p>

  ${
    ranked.length
      ? `<ul class="request-list">${ranked
          .map(
            (c) => `<li class="request">
      <p class="request__head">
        ${chip(toneFor(c), labelFor(c))}
        <span class="request__when">${escapeHtml(String(c.readinessPercent || 0))}% set up</span>
        ${c.openChangeRequests ? chip("neutral", `${c.openChangeRequests} open change${c.openChangeRequests === 1 ? "" : "s"}`) : ""}
      </p>
      <p class="request__what"><a href="${escapeAttr(basePath)}/${escapeAttr(c.clientId)}">${escapeHtml(c.businessName || c.clientId)}</a></p>
      <p class="enquiry__summary">
        ${escapeHtml(c.nextStepLabel || "Live")}${c.waitingOn ? ` — waiting on ${escapeHtml(c.waitingOn === "client" ? "the client" : "us")}` : ""}
      </p>
      <p class="enquiry__summary">${escapeHtml(String(c.callsThisMonth || 0))} calls this month${
        c.lastCallAt ? `, last on ${escapeHtml(c.lastCallAt)}` : ", none yet"
      }</p>
    </li>`
          )
          .join("")}</ul>`
      : `<div class="empty"><p class="empty__message">No locksmith clients yet.</p></div>`
  }`;

  return shell("Client operations", body);
}

// Waiting on us, then blocked clients, then live. Within a bucket, least
// complete first — the ones furthest from live need the most help.
function rank(c) {
  if (c.live) return 300 - (c.readinessPercent || 0);
  if (c.waitingOn === "aida") return 0 - (c.readinessPercent || 0);
  return 100 - (c.readinessPercent || 0);
}

function toneFor(c) {
  if (c.live) return "good";
  if (c.waitingOn === "aida") return "bad";
  return "attention";
}

function labelFor(c) {
  if (c.live) return "Live";
  if (c.waitingOn === "aida") return "Waiting on us";
  return "Waiting on client";
}

/** One client's detail. Diagnosis, not control. */
function renderClientOpsDetail({ client, model, basePath }) {
  const r = model.launchReadiness || { steps: [] };
  const p = model.profileSummary || { present: false, sections: [] };
  const t = model.testStatus || {};
  const c = model.changeRequests || { requests: [] };
  const u = model.usage || {};

  const body = `
  <p><a href="${escapeAttr(basePath)}">← All clients</a></p>
  <h1>${escapeHtml(client.businessName || client.clientId)}</h1>
  <p class="lead">Client id <code>${escapeHtml(client.clientId)}</code></p>

  <div class="callout">
    <p><strong>This view is read-only for anything that affects the client's receptionist.</strong>
    You can raise a change request on their behalf; only they can approve it.</p>
  </div>

  <section aria-labelledby="ops-readiness">
    <h2 id="ops-readiness">Setup</h2>
    <ol class="timeline">${(r.steps || [])
      .map(
        (s) => `<li class="timeline__step timeline__step--${s.done ? "done" : "todo"}">
      <span class="timeline__marker" aria-hidden="true">${s.done ? "✓" : "○"}</span>
      <span class="timeline__label">${escapeHtml(s.label)}</span>
      <span class="timeline__owner">${escapeHtml(s.done ? "Done" : s.owner === "client" ? "Client" : "Us")}</span>
      ${s.detail ? `<span class="timeline__detail">${escapeHtml(s.detail)}</span>` : ""}
    </li>`
      )
      .join("")}</ol>
  </section>

  <section aria-labelledby="ops-usage">
    <h2 id="ops-usage">Usage this month</h2>
    <dl class="stat-grid">
      <div class="stat"><dt>Calls</dt><dd>${escapeHtml(String(u.calls || 0))}</dd></div>
      <div class="stat"><dt>Minutes</dt><dd>${escapeHtml(String(u.totalMinutes || 0))}</dd></div>
      <div class="stat"><dt>Transferred</dt><dd>${escapeHtml(String(u.transferred || 0))}</dd></div>
      <div class="stat"><dt>Urgent</dt><dd>${escapeHtml(String(u.urgent || 0))}</dd></div>
      <div class="stat"><dt>After hours</dt><dd>${escapeHtml(String(u.afterHours || 0))}</dd></div>
    </dl>
    ${
      u.excludedShortCalls
        ? `<p class="stat-note">${escapeHtml(String(u.excludedShortCalls))} call${
            u.excludedShortCalls === 1 ? "" : "s"
          } under ${escapeHtml(String(u.billableMinimumSeconds || 6))}s excluded from counts and minutes.</p>`
        : ""
    }
  </section>

  <section aria-labelledby="ops-profile">
    <h2 id="ops-profile">Configuration</h2>
    ${
      p.present
        ? `<p>${chip(p.status === "approved" ? "good" : "attention", `Profile ${p.status}`)}${chip(
            p.completeness >= 100 ? "good" : "neutral",
            `${p.completeness}% complete`
          )}</p>
      ${(p.blockingOutstanding || []).length ? `<p class="callout callout--attention">Blocking gaps: ${escapeHtml(p.blockingOutstanding.join(", "))}</p>` : ""}`
        : `<div class="empty"><p class="empty__message">No profile captured yet.</p></div>`
    }
  </section>

  <section aria-labelledby="ops-tests">
    <h2 id="ops-tests">Tests</h2>
    <p>${
      t.total
        ? `${chip(t.failed ? "bad" : t.ready ? "good" : "neutral", `${t.passed}/${t.total} passing`)}${
            t.stale ? chip("attention", "Stale") : ""
          }`
        : "Not run yet."
    }</p>
  </section>

  <section aria-labelledby="ops-changes">
    <h2 id="ops-changes">Change requests</h2>
    ${
      (c.requests || []).length
        ? `<ul class="request-list">${c.requests
            .map(
              (req) => `<li class="request">
      <p class="request__head">
        ${chip(req.status === "approved" ? "good" : "neutral", String(req.status || "").replace(/_/g, " "))}
        <span class="request__source">${escapeHtml(String(req.sourceChannel || ""))}</span>
      </p>
      <p class="request__what">${escapeHtml(req.summary || req.requestId || "Change request")}</p>
    </li>`
            )
            .join("")}</ul>`
        : `<div class="empty"><p class="empty__message">No change requests.</p></div>`
    }
  </section>

  ${
    (model.problems || []).length
      ? `<section aria-labelledby="ops-problems">
    <h2 id="ops-problems">Data sources unavailable</h2>
    <ul>${model.problems
      .map((p2) => `<li>${escapeHtml(p2.area)}${p2.expected ? " — not provisioned yet (expected)" : " — unexpected failure, check the logs"}</li>`)
      .join("")}</ul>
  </section>`
      : ""
  }`;

  return shell(client.businessName || client.clientId, body);
}

module.exports = { renderClientOpsList, renderClientOpsDetail, rank, toneFor, labelFor };

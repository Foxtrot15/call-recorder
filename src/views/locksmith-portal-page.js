// AIDA — client portal (M5).
//
//   /client/locksmith?tab=…
//
// Behind requireClientAuth AND the portal flag. This is what a paying locksmith
// sees: what AIDA did on their phone today, what it is configured to do, and
// what they can change.
//
// RENDERING RULES
//   * Tabs are server-rendered links, not JavaScript. A locksmith reading this
//     on a phone in a van with one bar must get the whole page in one response.
//   * Every value that reaches markup goes through escapeHtml/escapeAttr.
//   * Nothing is communicated by colour alone — every state carries a text
//     label and a non-colour marker, matching the M2 review page.
//   * Customer phone numbers render masked in lists. Revealing one is a
//     deliberate act on the call's own page.
//   * The page never claims AIDA is live when it is not. Launch readiness is
//     computed, and the headline follows it.
//
// Presentation only: every number, label and state comes from the read models
// in services/locksmith-portal-readmodel.js. This file decides nothing.

const { escapeHtml, escapeAttr } = require("./escape");

const TABS = Object.freeze([
  { key: "overview", label: "Overview", heading: "Your AIDA receptionist" },
  { key: "timeline", label: "Setup", heading: "Getting you live" },
  { key: "calls", label: "Calls", heading: "Calls AIDA answered" },
  { key: "enquiries", label: "Enquiries", heading: "Work that came in" },
  { key: "configuration", label: "Settings", heading: "How AIDA answers" },
  { key: "tests", label: "Test centre", heading: "Testing your receptionist" },
  { key: "support", label: "Support", heading: "Changes and help" },
]);

const TAB_KEYS = Object.freeze(TABS.map((t) => t.key));

function resolveTab(requested) {
  return TAB_KEYS.includes(requested) ? requested : "overview";
}

// ── Shared fragments ────────────────────────────────────────────────

function renderNav(activeTab, basePath, counts = {}) {
  return `<nav class="portal-nav" aria-label="Portal sections">
  <ul>${TABS.map((tab) => {
    const active = tab.key === activeTab;
    const badge = counts[tab.key];
    return `<li><a class="portal-nav__link${active ? " portal-nav__link--active" : ""}" href="${escapeAttr(basePath)}?tab=${escapeAttr(tab.key)}"${active ? ' aria-current="page"' : ""}>${escapeHtml(tab.label)}${
      badge ? ` <span class="portal-nav__badge">${escapeHtml(String(badge))}</span>` : ""
    }</a></li>`;
  }).join("")}</ul>
</nav>`;
}

/** A status chip. `tone` drives colour; the label and marker carry the meaning. */
function chip(tone, label) {
  const markers = { good: "✓", attention: "!", bad: "✕", neutral: "•", muted: "–" };
  const marker = markers[tone] || "•";
  return `<span class="chip chip--${escapeAttr(tone)}"><span class="chip__marker" aria-hidden="true">${marker}</span>${escapeHtml(label)}</span>`;
}

function renderEmpty(message, detail) {
  return `<div class="empty"><p class="empty__message">${escapeHtml(message)}</p>${
    detail ? `<p class="empty__detail">${escapeHtml(detail)}</p>` : ""
  }</div>`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}, ${hh}:${mm}`;
}

// ── Overview ────────────────────────────────────────────────────────

function renderOverview(model, basePath) {
  const o = model.overview || {};
  const m = o.thisMonth || {};

  return `
  <div class="status-banner status-banner--${o.live ? "live" : "setup"}">
    <p class="status-banner__headline">
      <span aria-hidden="true">${o.live ? "✓" : "▶"}</span>
      ${escapeHtml(o.headline || "Getting set up.")}
    </p>
    ${
      !o.live && o.nextStep
        ? `<p class="status-banner__next">Next: ${escapeHtml(o.nextStep.label)}${
            o.nextStep.owner === "client" ? " — this one needs you." : " — we're on it."
          }</p>
        <p class="status-banner__progress">${escapeHtml(String(o.readinessPercent))}% of setup done. <a href="${escapeAttr(basePath)}?tab=timeline">See the steps</a></p>`
        : ""
    }
  </div>

  ${
    o.awaitingYourApproval
      ? `<div class="callout callout--attention">
      <p><strong>${escapeHtml(String(o.awaitingYourApproval))} change${o.awaitingYourApproval === 1 ? "" : "s"} waiting for your approval.</strong>
      Nothing changes on your phone until you say yes.</p>
      <p><a class="btn btn--ghost" href="${escapeAttr(basePath)}?tab=support">Review ${o.awaitingYourApproval === 1 ? "it" : "them"}</a></p>
    </div>`
      : ""
  }

  <section aria-labelledby="month-heading">
    <h2 id="month-heading">This month</h2>
    <dl class="stat-grid">
      <div class="stat"><dt>Calls answered</dt><dd>${escapeHtml(String(m.calls || 0))}</dd></div>
      <div class="stat"><dt>Enquiries</dt><dd>${escapeHtml(String(m.enquiries || 0))}</dd></div>
      <div class="stat"><dt>Urgent</dt><dd>${escapeHtml(String(m.urgent || 0))}</dd></div>
      <div class="stat"><dt>After hours</dt><dd>${escapeHtml(String(m.afterHours || 0))}</dd></div>
      <div class="stat"><dt>Minutes</dt><dd>${escapeHtml(String(m.minutes || 0))}</dd></div>
    </dl>
    ${
      m.afterHours
        ? `<p class="stat-note">${escapeHtml(String(m.afterHours))} of those came in outside your hours — calls you would have missed.</p>`
        : ""
    }
  </section>

  ${
    o.needingAttention
      ? `<div class="callout callout--attention"><p><strong>${escapeHtml(String(o.needingAttention))} urgent enquir${
          o.needingAttention === 1 ? "y" : "ies"
        } not followed up yet.</strong> <a href="${escapeAttr(basePath)}?tab=enquiries">Open them</a></p></div>`
      : ""
  }

  <section aria-labelledby="recent-heading">
    <h2 id="recent-heading">Recent calls</h2>
    ${
      (o.recentCalls || []).length
        ? renderCallTable(o.recentCalls, basePath)
        : renderEmpty("No calls yet.", o.live ? "Calls will appear here as AIDA answers them." : "Once your forwarding is on, calls appear here.")
    }
    <p><a href="${escapeAttr(basePath)}?tab=calls">See all calls</a></p>
  </section>`;
}

// ── Calls ───────────────────────────────────────────────────────────

function renderCallTable(calls, basePath) {
  return `<table class="calls-table">
  <caption class="visually-hidden">Calls AIDA answered, newest first</caption>
  <thead><tr>
    <th scope="col">When</th><th scope="col">Caller</th><th scope="col">What happened</th><th scope="col">Length</th>
  </tr></thead>
  <tbody>${calls
    .map(
      (c) => `<tr${c.isUrgent ? ' class="row--urgent"' : ""}>
    <td data-label="When">${escapeHtml(formatDate(c.at))}</td>
    <td data-label="Caller">
      ${c.callerName ? `<span class="caller-name">${escapeHtml(c.callerName)}</span>` : '<span class="caller-name caller-name--unknown">Not given</span>'}
      ${c.callerNumber ? `<span class="caller-number">${escapeHtml(c.callerNumber.masked)}</span>` : ""}
      ${c.suburb ? `<span class="caller-suburb">${escapeHtml(c.suburb)}</span>` : ""}
    </td>
    <td data-label="What happened">
      ${chip(c.outcomeTone, c.outcomeLabel)}
      ${c.isUrgent ? chip("attention", "Urgent") : ""}
      ${c.summary ? `<p class="call-summary">${escapeHtml(c.summary)}</p>` : ""}
    </td>
    <td data-label="Length">${escapeHtml(c.durationLabel)}</td>
  </tr>`
    )
    .join("")}</tbody>
</table>`;
}

function renderCalls(model, basePath) {
  const list = model.callList || { calls: [], total: 0 };
  return `
  <p class="lead">Every call AIDA answered for you, newest first. Customer numbers are hidden in this list — open a call to see the full number.</p>
  ${
    list.calls.length
      ? renderCallTable(list.calls, basePath)
      : renderEmpty("No calls yet.", "This fills up once your forwarding is switched on and a customer rings.")
  }
  ${list.truncated ? `<p class="table-note">Showing the most recent ${escapeHtml(String(list.calls.length))} of ${escapeHtml(String(list.total))}.</p>` : ""}`;
}

// ── Enquiries ───────────────────────────────────────────────────────

function renderEnquiries(model, basePath) {
  const list = model.enquiryList || { enquiries: [], total: 0, byState: {} };
  return `
  <p class="lead">Calls that look like work. Mark each one as you deal with it, so you can see what is still open.</p>
  ${
    list.needingAttention
      ? `<div class="callout callout--attention"><p><strong>${escapeHtml(String(list.needingAttention))} urgent, not yet actioned.</strong></p></div>`
      : ""
  }
  ${
    list.enquiries.length
      ? `<ul class="enquiry-list">${list.enquiries
          .map(
            (e) => `<li class="enquiry${e.needsAttention ? " enquiry--attention" : ""}">
      <p class="enquiry__head">
        <span class="enquiry__when">${escapeHtml(formatDate(e.at))}</span>
        ${e.isUrgent ? chip("attention", "Urgent") : ""}
        ${chip("neutral", e.enquiryState.replace(/_/g, " "))}
      </p>
      <p class="enquiry__who">
        ${escapeHtml(e.callerName || "Name not given")}${e.suburb ? ` — ${escapeHtml(e.suburb)}` : ""}
      </p>
      ${e.summary ? `<p class="enquiry__summary">${escapeHtml(e.summary)}</p>` : ""}
      ${
        e.callbackNumber
          ? `<p class="enquiry__callback">Callback number recorded — <a href="${escapeAttr(basePath)}?tab=calls&amp;call=${escapeAttr(String(e.id))}">open to view</a></p>`
          : ""
      }
    </li>`
          )
          .join("")}</ul>`
      : renderEmpty("No enquiries yet.", "When AIDA takes a job enquiry it shows up here.")
  }`;
}

// ── Setup timeline ──────────────────────────────────────────────────

function renderTimeline(model, basePath) {
  const r = model.launchReadiness || { steps: [], completed: 0, total: 0, percent: 0 };
  return `
  <p class="lead">Six steps to having AIDA answer your phone. We do the ones marked as ours; you do the rest.</p>
  <p class="progress-line"><strong>${escapeHtml(String(r.completed))} of ${escapeHtml(String(r.total))} done</strong> (${escapeHtml(String(r.percent))}%)</p>
  <ol class="timeline">${(r.steps || [])
    .map((step) => {
      const status = step.done ? "done" : "todo";
      return `<li class="timeline__step timeline__step--${escapeAttr(status)}">
      <span class="timeline__marker" aria-hidden="true">${step.done ? "✓" : "○"}</span>
      <span class="timeline__label">${escapeHtml(step.label)}</span>
      <span class="timeline__owner">${escapeHtml(step.done ? "Done" : step.owner === "client" ? "Needs you" : "We're on it")}</span>
      ${step.detail ? `<span class="timeline__detail">${escapeHtml(step.detail)}</span>` : ""}
    </li>`;
    })
    .join("")}</ol>
  ${renderForwardingPanel(model.forwarding, basePath)}`;
}

function renderForwardingPanel(forwarding, basePath) {
  if (!forwarding) return "";
  return `<section class="card" aria-labelledby="fwd-heading">
    <h2 id="fwd-heading">Forwarding your phone to AIDA</h2>
    <p class="card__status">${chip(forwarding.working ? "good" : forwarding.owner === "client" ? "attention" : "neutral", forwarding.label)}</p>
    <p>${escapeHtml(forwarding.detail)}</p>
    ${
      forwarding.aidaNumber
        ? `<p class="fwd-number">Your AIDA number: <strong>${escapeHtml(forwarding.aidaNumber)}</strong></p>`
        : `<p class="fwd-number fwd-number--pending">Your AIDA number is not allocated yet. We will not give you any codes until it is — a placeholder number would send your calls nowhere.</p>`
    }
    ${
      forwarding.canGenerate
        ? `<p><a class="btn btn--primary" href="${escapeAttr(basePath)}?tab=timeline&amp;setup=forwarding">Get my forwarding codes</a></p>`
        : ""
    }
    <p class="fine-print">${escapeHtml(forwarding.disclaimer || "")}</p>
  </section>`;
}

// ── Configuration ───────────────────────────────────────────────────

function renderConfiguration(model, basePath) {
  const p = model.profileSummary || { present: false, sections: [] };
  const n = model.notifications || null;

  if (!p.present) {
    return renderEmpty("Your business details haven't been captured yet.", "Once you've talked with AIDA, everything it understood shows up here for you to check.");
  }

  return `
  <p class="lead">This is what AIDA knows about your business, and what it is allowed to say. Change anything here and we will check it, test it, and ask you to approve it before it goes live.</p>

  <section class="card" aria-labelledby="profile-heading">
    <h2 id="profile-heading">Your details</h2>
    <p class="card__status">
      ${chip(p.status === "approved" ? "good" : "attention", p.status === "approved" ? `Approved${p.versionNumber ? ` (version ${p.versionNumber})` : ""}` : `Status: ${p.status}`)}
      ${chip(p.completeness >= 100 ? "good" : "neutral", `${p.completeness}% complete`)}
    </p>
    <ul class="section-list">${(p.sections || [])
      .map(
        (s) => `<li class="section-list__item">
      <span class="section-list__marker" aria-hidden="true">${s.filled ? "✓" : "○"}</span>
      <span class="section-list__label">${escapeHtml(s.label)}</span>
      ${s.blocking && !s.filled ? '<span class="section-list__flag">Needed before you can go live</span>' : ""}
    </li>`
      )
      .join("")}</ul>
    ${
      (p.blockingOutstanding || []).length
        ? `<p class="callout callout--attention">Still needed: ${escapeHtml(p.blockingOutstanding.join(", "))}</p>`
        : ""
    }
  </section>

  ${renderNotificationPanel(n, basePath)}

  <section class="card" aria-labelledby="change-heading">
    <h2 id="change-heading">Want something changed?</h2>
    <p>Ask us for a change and we will show you exactly what it would alter before anything happens.</p>
    <p><a class="btn btn--primary" href="${escapeAttr(basePath)}?tab=support">Request a change</a></p>
    <p class="fine-print">Soon you will also be able to ring AIDA and just say what you want changed. It will go through the same checks and still come back here for your approval.</p>
  </section>`;
}

function renderNotificationPanel(n, basePath) {
  if (!n) return "";
  return `<section class="card" aria-labelledby="notif-heading">
    <h2 id="notif-heading">How we tell you about calls</h2>
    <p>${escapeHtml(n.summary ? n.summary.spoken : "")}</p>
    ${
      n.cost && n.cost.estimatedMonthlyCostAud > 0
        ? `<p class="cost-note">Text messages: about <strong>${escapeHtml(String(n.cost.smsMessagesPerMonth))}</strong> a month, roughly <strong>A$${escapeHtml(
            n.cost.estimatedMonthlyCostAud.toFixed(2)
          )}</strong>, based on ${escapeHtml(n.cost.basis)}. Email and portal notifications are included.</p>`
        : `<p class="cost-note">No text messages are switched on, so notifications cost you nothing.</p>`
    }
    <p><a class="btn btn--ghost" href="${escapeAttr(basePath)}?tab=support&amp;change=notifications">Change how you're told</a></p>
  </section>`;
}

// ── Test centre ─────────────────────────────────────────────────────

function renderTests(model, basePath) {
  const t = model.testStatus || { total: 0, passed: 0, failed: 0, pending: 0 };
  return `
  <p class="lead">Before AIDA answers a real customer, we run it through a set of pretend calls — a lockout at 2am, a job outside your areas, someone asking a price you don't quote. You can see exactly how it handled each one.</p>

  <section class="card" aria-labelledby="test-summary-heading">
    <h2 id="test-summary-heading">Where the tests stand</h2>
    ${
      t.total === 0
        ? renderEmpty("Tests haven't run yet.", "They run once your details are approved.")
        : `<p class="card__status">
        ${chip(t.failed ? "bad" : t.ready ? "good" : "neutral", `${t.passed} of ${t.total} passing`)}
        ${t.failed ? chip("bad", `${t.failed} failing`) : ""}
        ${t.stale ? chip("attention", "Out of date — settings changed since these ran") : ""}
      </p>
      ${
        t.stale
          ? `<p class="callout callout--attention">Your settings changed after these tests ran, so they no longer prove anything. We will re-run them before the change goes live.</p>`
          : ""
      }
      ${
        (t.failures || []).length
          ? `<h3>What's failing</h3><ul class="failure-list">${t.failures
              .map((f) => `<li><strong>${escapeHtml(f.label || f.id)}</strong>${f.detail ? `<br>${escapeHtml(f.detail)}` : ""}</li>`)
              .join("")}</ul>`
          : ""
      }`
    }
  </section>

  <section class="card" aria-labelledby="own-test-heading">
    <h2 id="own-test-heading">Try it yourself</h2>
    <p>The best test is your own. Ring your AIDA number and pretend to be a customer — ask for something you would normally get asked for.</p>
    ${
      model.forwarding && model.forwarding.aidaNumber
        ? `<p class="fwd-number">Ring <strong>${escapeHtml(model.forwarding.aidaNumber)}</strong></p>`
        : `<p class="fwd-number fwd-number--pending">Your AIDA number isn't allocated yet.</p>`
    }
    <p class="fine-print">Your own test calls appear in your call list like any other call.</p>
  </section>`;
}

// ── Support and change requests ─────────────────────────────────────

function renderSupport(model, basePath) {
  const c = model.changeRequests || { requests: [], open: 0 };
  return `
  <p class="lead">Ask for a change, or tell us something is wrong. Nothing that affects how AIDA answers your phone happens without you approving it first.</p>

  ${
    c.awaitingClient
      ? `<div class="callout callout--attention"><p><strong>${escapeHtml(String(c.awaitingClient))} change${
          c.awaitingClient === 1 ? "" : "s"
        } waiting for you.</strong> Read what would change, then approve or reject.</p></div>`
      : ""
  }

  <section aria-labelledby="requests-heading">
    <h2 id="requests-heading">Your change requests</h2>
    ${
      (c.requests || []).length
        ? `<ul class="request-list">${c.requests
            .map(
              (r) => `<li class="request">
      <p class="request__head">
        ${chip(requestTone(r.status), formatStatus(r.status))}
        <span class="request__when">${escapeHtml(formatDate(r.createdAt))}</span>
        <span class="request__source">${escapeHtml(formatChannel(r.sourceChannel))}</span>
      </p>
      <p class="request__what">${escapeHtml(r.summary || "Change request")}</p>
      ${
        r.status === "awaiting_client_approval"
          ? `<p><a class="btn btn--ghost" href="${escapeAttr(basePath)}?tab=support&amp;request=${escapeAttr(String(r.requestId))}">Review this change</a></p>`
          : ""
      }
    </li>`
            )
            .join("")}</ul>`
        : renderEmpty("No change requests yet.", "When you ask for something to change, it shows up here with its status.")
    }
  </section>

  <section class="card" aria-labelledby="new-request-heading">
    <h2 id="new-request-heading">Ask for a change</h2>
    <p>Tell us what you want AIDA to do differently. We will turn it into a specific change, show you exactly what it alters, test it, and ask you to approve it.</p>
    <p><a class="btn btn--primary" href="${escapeAttr(basePath)}?tab=support&amp;change=new">Start a change request</a></p>
    <p class="fine-print">Safety-critical changes — transfer numbers, prices, what AIDA must never promise — always get read back to you before they go live.</p>
  </section>`;
}

function requestTone(status) {
  if (["approved"].includes(status)) return "good";
  if (["rejected", "cancelled", "superseded"].includes(status)) return "muted";
  if (["needs_clarification", "awaiting_client_approval"].includes(status)) return "attention";
  return "neutral";
}

function formatStatus(status) {
  return String(status || "").replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
}

function formatChannel(channel) {
  const labels = {
    client_ui: "Asked here",
    voice_configuration_agent: "Asked by phone",
    initial_voice_onboarding: "From your setup call",
    founder_operator: "Raised by us",
    api: "Automated",
    system_generated: "Automatic",
  };
  return labels[channel] || "Change request";
}

// ── Page ────────────────────────────────────────────────────────────

function renderPortalPage({ tab, model, basePath, businessName, isDemo = false }) {
  const active = resolveTab(tab);
  const meta = TABS.find((t) => t.key === active);

  const counts = {
    support: model.changeRequests ? model.changeRequests.awaitingClient : 0,
    enquiries: model.enquiryList ? model.enquiryList.needingAttention : 0,
  };

  const body = {
    overview: renderOverview,
    timeline: renderTimeline,
    calls: renderCalls,
    enquiries: renderEnquiries,
    configuration: renderConfiguration,
    tests: renderTests,
    support: renderSupport,
  }[active](model, basePath);

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(meta.heading)} — AIDA</title>
<link rel="stylesheet" href="/locksmith/onboarding.css">
<link rel="stylesheet" href="/locksmith/portal.css">
</head>
<body class="locksmith locksmith-portal">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">AIDA</span>
    <span class="site-header__provider">${escapeHtml(businessName || "Your receptionist")}</span>
  </p>
</header>

${renderNav(active, basePath, counts)}

<main id="main">
  <h1>${escapeHtml(meta.heading)}</h1>
  ${isDemo ? '<p class="demo-banner"><span aria-hidden="true">●</span> Demonstration data — this is an example business, not a real one.</p>' : ""}
  ${body}
</main>

<footer class="site-footer">
  <p>AIDA is an AI phone receptionist, not a human operator. It follows the rules you set here.</p>
</footer>
</body>
</html>`;
}

module.exports = {
  renderPortalPage,
  TABS,
  TAB_KEYS,
  resolveTab,
  renderNav,
  renderOverview,
  renderCalls,
  renderEnquiries,
  renderTimeline,
  renderConfiguration,
  renderTests,
  renderSupport,
  renderCallTable,
  chip,
  formatDate,
  formatChannel,
  formatStatus,
};

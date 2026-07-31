// AIDA Locksmith Receptionist — the review page (M2).
//
//   "Here is what AIDA understood about your business"
//
// A pure function: (session, profile version, assessment) → HTML string. Same
// house style as views/locksmith-page.js — no template engine, no framework,
// everything escaped at output.
//
// The page's job is to make it easy to spot what is WRONG, not to look
// impressive. So every section shows the same five things in the same place:
// what AIDA extracted, where it came from, what is missing, what to watch, and
// whether it blocks launch. A locksmith should be able to scan the left edge
// and see exactly which sections still need them.
//
// Nothing on this page is a form-post-and-pray: the reviewer confirms sections
// individually, corrections invalidate the confirmation for that section, and
// the Approve button is refused server-side regardless of what the browser
// allows (routes/locksmith-onboarding-handlers.js).

const { escapeHtml, escapeAttr } = require("./escape");
const S = require("../services/locksmith-profile-schema");

// ── Value rendering ─────────────────────────────────────────────────

const NOT_ESTABLISHED = '<span class="value value--missing">Not established during the call</span>';

function renderValue(value) {
  if (value === null || value === undefined || value === "") return NOT_ESTABLISHED;
  if (value === true) return '<span class="value value--yes">Yes</span>';
  if (value === false) return '<span class="value value--no">No</span>';
  if (Array.isArray(value)) {
    if (value.length === 0) return NOT_ESTABLISHED;
    return `<ul class="value-list">${value.map((v) => `<li>${escapeHtml(String(v))}</li>`).join("")}</ul>`;
  }
  return `<span class="value">${escapeHtml(String(value))}</span>`;
}

function fact(label, value) {
  return `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${renderValue(value)}</dd></div>`;
}

function timeRange(entry) {
  if (!entry) return null;
  if (entry.closed === true) return "Closed";
  if (entry.byArrangement === true) return "By arrangement";
  if (entry.open && entry.close) return `${entry.open} – ${entry.close}`;
  return null;
}

// ── Per-section bodies ──────────────────────────────────────────────

function renderIdentity(p) {
  const i = p.identity || {};
  const toneLabels = {
    straightforward_efficient: "Straightforward and efficient",
    warm_reassuring: "Warm and reassuring",
    professional: "Professional",
    friendly_australian_trade: "Friendly Australian trade-business tone",
    custom_reviewed: "Custom reviewed wording",
  };
  return `<dl class="facts">
    ${fact("Business name callers hear", i.spokenName)}
    ${fact("Legal or trading name", i.legalName)}
    ${fact("Receptionist name", i.receptionistName)}
    ${fact("Greeting", i.greeting)}
    ${fact("Timezone", i.timezone)}
    ${fact("Website", i.website)}
    ${fact("Main business number", i.businessPhone)}
    ${fact("Description", i.description)}
    ${fact("Tone", i.tone ? toneLabels[i.tone] || i.tone : null)}
  </dl>`;
}

function renderServicesAccepted(p) {
  const list = Array.isArray(p.servicesAccepted) ? p.servicesAccepted.filter((s) => s && s.enabled) : [];
  if (!list.length) return `<p class="empty">${NOT_ESTABLISHED} — AIDA would have no work to take.</p>`;
  return `<ul class="service-list">${list
    .map(
      (s) => `<li>
        <span class="service-name">${escapeHtml(s.publicName || S.SERVICE_LABELS[s.serviceId] || s.serviceId)}</span>
        ${s.mayBeUrgent ? '<span class="chip chip--urgent"><span aria-hidden="true">!!</span> Can be urgent</span>' : '<span class="chip">Routine</span>'}
        ${s.notes ? `<span class="service-note">${escapeHtml(s.notes)}</span>` : ""}
        ${
          Array.isArray(s.mustCollect) && s.mustCollect.length
            ? `<span class="service-collect">AIDA collects: ${s.mustCollect.map((f) => escapeHtml(S.CALLER_INFO_LABELS[f] || f)).join(", ")}</span>`
            : ""
        }
      </li>`
    )
    .join("")}</ul>`;
}

function renderServicesDeclined(p) {
  const list = Array.isArray(p.servicesDeclined) ? p.servicesDeclined : [];
  const note = `<p class="note-inline">AIDA never assumes an unlisted service is accepted. Anything not in the accepted list above is declined by default.</p>`;
  if (!list.length) return `<p class="empty">No services were explicitly ruled out.</p>${note}`;
  return `<ul class="service-list">${list
    .map(
      (s) => `<li>
        <span class="service-name">${escapeHtml(S.SERVICE_LABELS[s.serviceId] || s.serviceId)}</span>
        ${s.reason ? `<span class="service-note">${escapeHtml(s.reason)}</span>` : ""}
      </li>`
    )
    .join("")}</ul>${note}`;
}

function renderServiceAreas(p) {
  const a = p.serviceAreas || {};
  const actionLabels = {
    collect_details_for_confirmation: "Take their details for you to confirm",
    politely_decline: "Politely tell them it's outside your area",
    transfer_for_manual_assessment: "Put them through for you to decide",
    other_reviewed_action: "Custom reviewed action",
  };
  return `<dl class="facts">
    ${fact("Core suburbs and regions", a.primary)}
    ${fact("Will stretch to", a.extended)}
    ${fact("Will not travel to", a.declined)}
    ${fact("Radius", a.radiusKm ? `${a.radiusKm} km` : null)}
    ${fact("After-hours coverage", a.afterHoursAreas === null || a.afterHoursAreas === undefined ? "Same as the core area" : a.afterHoursAreas)}
    ${fact("If someone calls from outside the area", a.outsideAreaAction ? actionLabels[a.outsideAreaAction] || a.outsideAreaAction : null)}
  </dl>`;
}

function renderHours(p) {
  const h = p.hours || {};
  const ordinary = h.ordinary || {};
  const rows = S.DAYS.map((day) => {
    const label = day.charAt(0).toUpperCase() + day.slice(1);
    const value = timeRange(ordinary[day]);
    return `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${value ? `<span class="value">${escapeHtml(value)}</span>` : NOT_ESTABLISHED}</dd></div>`;
  }).join("");
  return `<dl class="facts">
    ${rows}
    ${fact("Public holidays", timeRange(h.publicHolidays))}
    ${fact("Takes after-hours call-outs", h.afterHoursAvailable)}
    ${fact("After-hours note", h.afterHoursNote)}
    ${fact("Timezone", h.timezone)}
  </dl>`;
}

function renderUrgency(p) {
  const list = Array.isArray(p.urgencyRules) ? p.urgencyRules : [];
  if (!list.length) return `<p class="empty">${NOT_ESTABLISHED} — every call would be treated the same way.</p>`;
  const actionLabels = {
    transfer_immediately: "Put through straight away",
    notify_urgently_and_collect: "Take details and alert you urgently",
    collect_and_notify: "Take details and notify you",
    collect_for_business_hours: "Take details for business hours",
    decline_politely: "Politely decline",
  };
  return `<ul class="rule-list">${list
    .map(
      (r) => `<li>
        <p class="rule-condition">${escapeHtml(r.condition || r.ruleId)}</p>
        <p class="rule-meta">
          <span class="chip chip--${escapeAttr(r.classification)}"><span aria-hidden="true">${r.classification === "urgent" ? "!!" : r.classification === "priority" ? "!" : "–"}</span> ${escapeHtml(r.classification || "")}</span>
          <span class="rule-action">${escapeHtml(actionLabels[r.action] || r.action || "")}</span>
        </p>
        ${r.approvedWording ? `<p class="rule-wording">AIDA says: &ldquo;${escapeHtml(r.approvedWording)}&rdquo;</p>` : ""}
      </li>`
    )
    .join("")}</ul>`;
}

function renderTransfer(p) {
  const t = p.transfer || {};
  const permitted = t.permittedHours;
  const permittedLabel = !permitted
    ? null
    : permitted.always === true
      ? "Any time"
      : permitted.businessHoursOnly === true
        ? "Business hours only"
        : permitted.from && permitted.to
          ? `${permitted.from} – ${permitted.to}`
          : null;
  const unansweredLabels = {
    try_backup_number: "Try the backup number",
    take_message_and_notify: "Take a message and notify you",
    take_message_only: "Take a message",
  };
  return `<dl class="facts">
    ${fact("Primary transfer number", t.primaryNumber)}
    ${fact("Backup number", t.backupNumber)}
    ${fact("Transfers permitted", permittedLabel)}
    ${fact("Urgency required to transfer", t.requiredUrgency)}
    ${fact("Ring time before giving up", t.timeoutSeconds ? `${t.timeoutSeconds} seconds` : null)}
    ${fact("Attempts", t.maxAttempts)}
    ${fact("If nobody answers", t.unansweredAction ? unansweredLabels[t.unansweredAction] || t.unansweredAction : null)}
    ${fact("Takes details before transferring", t.collectDetailsFirst)}
    ${fact("What AIDA says before transferring", t.preTransferWording)}
  </dl>
  <p class="note-inline note-inline--critical">
    Check every digit of these numbers. They came from a spoken call, and an urgent
    job goes here.
  </p>`;
}

function renderNotifications(p) {
  const n = p.notifications || {};
  return `<dl class="facts">
    ${fact("Text message to", n.sms)}
    ${fact("Email to", n.email)}
    ${fact("Urgent calls only", n.urgentOnly)}
    ${fact("Standard summaries", n.standardSummary)}
    ${fact("Backup recipients", n.backup)}
    ${fact("Timing", n.timing)}
    ${fact("Content preferences", n.contentPreferences)}
  </dl>
  <p class="note-inline">AIDA does not send notifications yet. This records who will receive them once the receptionist is live.</p>`;
}

function renderPricing(p) {
  const pr = p.pricing || {};
  return `<dl class="facts">
    ${fact("AIDA may mention pricing", pr.mayMentionPricing)}
    ${fact("You confirm every price", pr.humanConfirmsEveryPrice)}
    ${fact("Approved call-out wording", pr.calloutWording)}
    ${fact("After-hours surcharge wording", pr.afterHoursSurchargeWording)}
    ${fact("Disclaimer", pr.disclaimer)}
    ${fact("Never state", pr.neverState)}
  </dl>
  ${
    Array.isArray(pr.indicativePrices) && pr.indicativePrices.length
      ? `<ul class="service-list">${pr.indicativePrices
          .map((x) => `<li><span class="service-name">${escapeHtml(S.SERVICE_LABELS[x.serviceId] || x.serviceId)}</span><span class="service-note">${escapeHtml(x.wording || "")}</span></li>`)
          .join("")}</ul>`
      : ""
  }`;
}

function renderCallerInfo(p) {
  const c = p.callerInfo || {};
  const always = Array.isArray(c.always) ? c.always.map((f) => S.CALLER_INFO_LABELS[f] || f) : [];
  const byService = c.byService || {};
  const extra = Object.keys(byService)
    .map((id) => `<div class="fact"><dt>${escapeHtml(S.SERVICE_LABELS[id] || id)}</dt><dd>${renderValue((byService[id] || []).map((f) => S.CALLER_INFO_LABELS[f] || f))}</dd></div>`)
    .join("");
  return `<dl class="facts">
    ${fact("Collected on every call", always)}
    ${extra}
    ${fact("Other questions", c.otherQuestions)}
  </dl>`;
}

function renderForbidden(p) {
  const list = Array.isArray(p.forbiddenPromises) ? p.forbiddenPromises.filter((x) => x && x.enabled) : [];
  if (!list.length) return `<p class="empty">${NOT_ESTABLISHED} — these safety limits must be in place before launch.</p>`;
  return `<ul class="forbidden-list">${list
    .map(
      (x) => `<li>
        <span aria-hidden="true" class="forbidden-mark">✕</span>
        <span>${escapeHtml(S.FORBIDDEN_PROMISE_LABELS[x.promiseId] || x.promiseId)}</span>
        ${x.note ? `<span class="service-note">${escapeHtml(x.note)}</span>` : ""}
      </li>`
    )
    .join("")}</ul>
  <p class="note-inline">These are fixed safety limits. AIDA will never say any of them, on any plan.</p>`;
}

function renderPrivacy(p) {
  const pv = p.privacy || {};
  const retentionLabels = {
    keep_indefinitely_until_changed: "Keep until you change this",
    keep_12_months: "Keep for 12 months",
    keep_6_months: "Keep for 6 months",
    keep_3_months: "Keep for 3 months",
    delete_after_summary: "Delete once the summary is sent",
  };
  return `<dl class="facts">
    ${fact("Calls may be recorded", pv.callsMayBeRecorded)}
    ${fact("Recording disclosure", pv.recordingDisclosure)}
    ${fact("Transcript retention", pv.transcriptRetention ? retentionLabels[pv.transcriptRetention] || pv.transcriptRetention : null)}
    ${fact("Recording retention", pv.recordingRetention ? retentionLabels[pv.recordingRetention] || pv.recordingRetention : null)}
    ${fact("Redact sensitive details", pv.redactSensitiveData)}
    ${fact("Contact consent wording", pv.customerContactConsentWording)}
  </dl>
  <p class="note-inline">Recording rules differ between states. We record your preference here; the wording is reviewed before recording is switched on.</p>`;
}

const SECTION_RENDERERS = {
  identity: renderIdentity,
  servicesAccepted: renderServicesAccepted,
  servicesDeclined: renderServicesDeclined,
  serviceAreas: renderServiceAreas,
  hours: renderHours,
  urgencyRules: renderUrgency,
  transfer: renderTransfer,
  notifications: renderNotifications,
  pricing: renderPricing,
  callerInfo: renderCallerInfo,
  forbiddenPromises: renderForbidden,
  privacy: renderPrivacy,
};

// ── Section shell ───────────────────────────────────────────────────

function renderSection(section, { profile, confirmations, reviewNotes = {}, warningsBySection, blockersBySection, sourceStatus, readOnly }) {
  const confirmation = confirmations[section.key];
  const savedNote = reviewNotes[section.key];
  const confirmed = Boolean(confirmation && confirmation.confirmedAt);
  const warnings = warningsBySection[section.key] || [];
  const blockers = blockersBySection[section.key] || [];
  const blocksLaunch = blockers.length > 0;
  const body = (SECTION_RENDERERS[section.key] || (() => ""))(profile);
  const headingId = `section-${section.key}-heading`;

  return `
    <section class="review-section${blocksLaunch ? " review-section--blocking" : ""}${confirmed ? " review-section--confirmed" : ""}" aria-labelledby="${escapeAttr(headingId)}" data-section="${escapeAttr(section.key)}">
      <div class="review-section__head">
        <h3 id="${escapeAttr(headingId)}">${escapeHtml(section.title)}</h3>
        <p class="status-row">
          <span class="status status--${confirmed ? "confirmed" : "unconfirmed"}">
            <span aria-hidden="true">${confirmed ? "✓" : "○"}</span> ${confirmed ? "Confirmed by you" : "Not yet confirmed"}
          </span>
          <span class="status status--source">
            <span aria-hidden="true">◆</span> Source: ${escapeHtml(sourceStatus)}
          </span>
          ${
            blocksLaunch
              ? '<span class="status status--blocking"><span aria-hidden="true">■</span> Blocks launch</span>'
              : '<span class="status status--ok"><span aria-hidden="true">□</span> Does not block launch</span>'
          }
        </p>
      </div>

      ${body}

      ${
        // A saved correction is shown back, escaped. Without this the reviewer
        // types a note, it disappears, and they have no way to tell whether it
        // was recorded — and the correction is invisible to whoever fixes it.
        savedNote && savedNote.note
          ? `<div class="issues issues--note">
               <h4>${savedNote.forDiscussion ? "You marked this for discussion" : "Your correction"}</h4>
               <p class="saved-note">${escapeHtml(savedNote.note)}</p>
             </div>`
          : ""
      }
      ${
        blockers.length
          ? `<div class="issues issues--blocking"><h4>Needs your input before launch</h4><ul>${blockers.map((b) => `<li>${escapeHtml(b.message)}</li>`).join("")}</ul></div>`
          : ""
      }
      ${
        warnings.length
          ? `<div class="issues issues--warning"><h4>Worth checking</h4><ul>${warnings.map((w) => `<li>${escapeHtml(w.message)}</li>`).join("")}</ul></div>`
          : ""
      }

      ${
        readOnly
          ? ""
          : `<div class="section-actions">
              <button type="button" class="btn btn--confirm" data-action="confirm" data-section="${escapeAttr(section.key)}" ${confirmed ? "disabled" : ""}>
                ${confirmed ? "Confirmed" : "This section is correct"}
              </button>
              <button type="button" class="btn btn--ghost" data-action="correct" data-section="${escapeAttr(section.key)}" aria-expanded="false" aria-controls="${escapeAttr(`correct-${section.key}`)}">
                Something's wrong here
              </button>
              <button type="button" class="btn btn--ghost" data-action="discuss" data-section="${escapeAttr(section.key)}">
                Mark for discussion
              </button>
            </div>
            <div class="correction" id="${escapeAttr(`correct-${section.key}`)}" hidden>
              <label for="${escapeAttr(`note-${section.key}`)}">What should it say instead?</label>
              <textarea id="${escapeAttr(`note-${section.key}`)}" name="note" rows="3" maxlength="1000" data-note-for="${escapeAttr(section.key)}"></textarea>
              <button type="button" class="btn btn--small" data-action="save-note" data-section="${escapeAttr(section.key)}">Save this note</button>
              <p class="correction-hint">Saving a note removes your confirmation for this section so it gets looked at again.</p>
            </div>`
      }
    </section>`;
}

// ── Page ────────────────────────────────────────────────────────────

/**
 * @param {object} args
 *   session         public session shape
 *   profileVersion  public profile-version shape (includes .profile and .confirmations)
 *   assessment      { ready, blockers[], warnings[] } from assessProvisioning
 *   warnings        review warnings from the extraction
 *   readOnly        true when the viewer may look but not act (e.g. already approved)
 *   isDemo          true when this session is demonstration data
 */
function renderReviewPage({ session, profileVersion, assessment, warnings = [], readOnly = false, isDemo = false, csrfSafeMethodNote = true }) {
  const profile = (profileVersion && profileVersion.profile) || {};
  const confirmations = (profileVersion && profileVersion.confirmations) || {};
  const reviewNotes = (profileVersion && profileVersion.reviewNotes) || {};

  // Group issues by section so each one appears where the reviewer is looking.
  const blockersBySection = {};
  const warningsBySection = {};
  for (const blocker of assessment.blockers || []) {
    const key = blocker.code.startsWith("invalid_") ? blocker.code.slice("invalid_".length) : sectionForBlocker(blocker.code);
    (blockersBySection[key] = blockersBySection[key] || []).push(blocker);
  }
  for (const warning of [...(assessment.warnings || []), ...warnings]) {
    const key = sectionForBlocker(warning.code);
    (warningsBySection[key] = warningsBySection[key] || []).push(warning);
  }

  const outstanding = S.CONFIRMATION_KEYS.filter((k) => !confirmations[k] || !confirmations[k].confirmedAt);
  const canApprove = assessment.ready && outstanding.length === 0 && !readOnly;

  const sections = S.SECTIONS.map((section) =>
    renderSection(section, {
      profile,
      confirmations,
      reviewNotes,
      warningsBySection,
      blockersBySection,
      sourceStatus: session.extractionVersion ? `onboarding call, read by ${session.extractionVersion}` : "not yet extracted",
      readOnly,
    })
  ).join("");

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Review your AIDA receptionist settings</title>
<link rel="stylesheet" href="/locksmith/onboarding.css">
</head>
<body class="locksmith locksmith-review">
<a class="skip-link" href="#main">Skip to main content</a>

<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">AIDA Locksmith Receptionist</span>
    <span class="site-header__provider">Setup review</span>
  </p>
</header>

<main id="main"
      data-session-id="${escapeAttr(session.sessionId)}"
      data-version="${escapeAttr(String(profileVersion ? profileVersion.version : ""))}"
      data-updated-at="${escapeAttr(profileVersion ? profileVersion.updatedAt : "")}">
  <h1>Here is what AIDA understood about your business</h1>
  <p class="lead">
    Read each section and tell us if it's right. Nothing answers your phone until
    you approve it, and you can change any of it afterwards.
  </p>

  ${isDemo ? '<p class="demo-banner"><span aria-hidden="true">●</span> Demonstration data — this is an example onboarding session, not a real business.</p>' : ""}

  ${
    readOnly
      ? `<p class="notice notice--readonly">This version is ${escapeHtml(profileVersion ? profileVersion.status : "closed")} and can no longer be edited. Any change starts a new version.</p>`
      : ""
  }

  <div class="progress-summary" role="status" aria-live="polite" id="progress-summary">
    <p class="progress-line">
      <strong>${escapeHtml(String(S.CONFIRMATION_KEYS.length - outstanding.length))}</strong> of
      <strong>${escapeHtml(String(S.CONFIRMATION_KEYS.length))}</strong> sections confirmed.
      ${
        assessment.ready
          ? '<span class="ready-flag ready-flag--yes"><span aria-hidden="true">✓</span> Nothing is blocking launch.</span>'
          : `<span class="ready-flag ready-flag--no"><span aria-hidden="true">■</span> ${escapeHtml(String((assessment.blockers || []).length))} thing(s) still block launch.</span>`
      }
    </p>
  </div>

  <div class="form-status" id="form-status" role="status" aria-live="polite" data-state="idle"></div>

  ${sections}

  <section class="review-section review-decision" aria-labelledby="decision-heading">
    <h2 id="decision-heading">Ready to go?</h2>
    ${
      canApprove
        ? '<p>Everything is confirmed and nothing is blocking launch.</p>'
        : `<p>You can approve once every section is confirmed and nothing is blocking launch.
             ${outstanding.length ? `Outstanding: ${escapeHtml(outstanding.map((k) => sectionTitle(k)).join(", "))}.` : ""}</p>`
    }
    ${
      readOnly
        ? ""
        : `<div class="decision-actions">
            <button type="button" class="btn btn--primary" id="approve-button" ${canApprove ? "" : "disabled"}>
              Approve these settings
            </button>
            <button type="button" class="btn btn--danger-ghost" id="reject-button">Reject this draft</button>
          </div>
          <div class="reject-panel" id="reject-panel" hidden>
            <label for="reject-reason">Why are you rejecting it?</label>
            <textarea id="reject-reason" rows="3" maxlength="1000" required></textarea>
            <button type="button" class="btn btn--danger" id="reject-confirm">Reject the draft</button>
          </div>`
    }
    <p class="approval-note">
      Approving records your name and the time against this version. Approval does not
      switch anything on by itself — it makes these settings eligible to be built.
    </p>
  </section>
</main>

<footer class="footer">
  <p>Your answers and this transcript are treated as confidential business information.</p>
  <p>AIDA is an AI-powered receptionist. Transfers and responses follow the rules you set here.</p>
</footer>
<script src="/locksmith/onboarding.js" defer></script>
</body>
</html>
`;
}

// Map a blocker/warning code back to the section it belongs to, so it renders
// next to the values it is about rather than in a pile at the top.
function sectionForBlocker(code) {
  const map = {
    no_services_accepted: "servicesAccepted",
    transfer_number_invalid: "transfer",
    transfer_backup_missing: "transfer",
    verify_transfer_number: "transfer",
    no_backup_number: "transfer",
    transfer_hours_conflict: "transfer",
    transfer_service_not_accepted: "transfer",
    no_service_area: "serviceAreas",
    no_outside_area_action: "serviceAreas",
    area_both_ways: "serviceAreas",
    no_timezone: "hours",
    no_open_hours: "hours",
    after_hours_conflict: "hours",
    no_urgency_rules: "urgencyRules",
    pricing_authority_ambiguous: "pricing",
    pricing_unbounded: "pricing",
    forbidden_promises_missing: "forbiddenPromises",
    no_callback_number: "callerInfo",
    no_caller_name: "callerInfo",
    no_description: "identity",
    no_notification_recipients: "notifications",
    recording_preference_unset: "privacy",
    no_declined_services: "servicesDeclined",
    service_both_ways: "servicesDeclined",
  };
  if (map[code]) return map[code];
  if (code.startsWith("missing_identity.")) return "identity";
  if (code.startsWith("missing_transfer.")) return "transfer";
  if (code.startsWith("missing_serviceAreas.")) return "serviceAreas";
  if (code.startsWith("missing_hours.")) return "hours";
  if (code.startsWith("missing_pricing.")) return "pricing";
  if (code.startsWith("missing_servicesAccepted")) return "servicesAccepted";
  if (code.startsWith("missing_urgencyRules")) return "urgencyRules";
  if (code.startsWith("missing_callerInfo")) return "callerInfo";
  return "identity";
}

function sectionTitle(key) {
  const section = S.SECTIONS.find((s) => s.key === key);
  return section ? section.title : key;
}

module.exports = { renderReviewPage, renderSection, sectionForBlocker, renderValue };

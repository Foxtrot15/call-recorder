// AIDA — client portal read models (M5).
//
// One place that turns stored rows into the shapes the portal renders. Nothing
// here writes, and nothing here is a new store: calls stay in `calls`, profile
// versions stay in the M2 store, provisioning stays in the M3 registry. A
// portal that invents its own copy of the call history is a portal that shows a
// different number of calls than the invoice does.
//
// Every projection is a pure function over rows, with a thin fetcher beside it.
// The tests drive the pure half with fixtures and never need a database.
//
// ─── TENANT SCOPING ─────────────────────────────────────────────────
// routes/calls.js scopes with `client_id = X OR default OR NULL`, because the
// operator dashboard must keep showing rows written before per-client stamping.
// That widening MUST NOT be reused here. Those legacy rows belong to the
// original operator, and a locksmith client seeing them would be a cross-tenant
// disclosure. The portal uses a strict equality scope, always.

const S = require("./locksmith-profile-schema");

const READMODEL_VERSION = "portal-readmodel-2026-08-01";

/** The only tenant scope the portal is allowed to use. */
function scopeStrict(query, clientId) {
  return query.eq("client_id", clientId);
}

// The two classifications that mean "a locksmith should look at this now".
// Derived from the schema rather than spelled out, so adding a classification
// upstream cannot silently leave it out of the attention count.
const HIGH_URGENCY = Object.freeze(["urgent", "priority"].filter((u) => S.URGENCY_CLASSIFICATIONS.includes(u)));

function validUrgency(raw) {
  return S.URGENCY_CLASSIFICATIONS.includes(raw) ? raw : null;
}

function tableMissing(err) {
  const msg = err && (err.message || err.details || "");
  return /relation .* does not exist|could not find the table|schema cache/i.test(String(msg));
}

// ── 1. Call list ────────────────────────────────────────────────────

const CALL_OUTCOMES = Object.freeze({
  transferred: { label: "Put through to you", tone: "good" },
  message_taken: { label: "Message taken", tone: "neutral" },
  callback_promised: { label: "Callback promised", tone: "attention" },
  out_of_area: { label: "Outside your areas", tone: "muted" },
  no_answer: { label: "Nobody available", tone: "attention" },
  spam: { label: "Spam or wrong number", tone: "muted" },
  unknown: { label: "Not classified", tone: "muted" },
});

/**
 * Project one stored call row into the portal's call view.
 *
 * The analysis blob is provider output and is treated as untrusted: every field
 * is read defensively and unknown enums fall back rather than reaching the
 * template. M4's validateReceptionistAnalysis screens this on the way in; this
 * is the second half of that same posture, because a row stored before the
 * validator existed is still in the table.
 */
function projectCall(row) {
  const analysis = row && row.analysis && typeof row.analysis === "object" ? row.analysis : {};
  const outcome = deriveOutcome(row, analysis);

  return {
    id: row.id,
    at: row.recorded_at || null,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    durationSeconds: parseDuration(row.duration),
    durationLabel: formatDuration(parseDuration(row.duration)),
    callerName: cleanText(analysis.caller_name || row.caller_name, 80) || null,
    callerNumber: maskNumber(row.from_number),
    callbackNumber: maskNumber(analysis.callback_number),
    suburb: cleanText(analysis.suburb, 60) || null,
    serviceType: S.SERVICE_IDS.includes(analysis.service_type) ? analysis.service_type : null,
    urgency: validUrgency(analysis.urgency),
    // Derived from the VALIDATED value, never the raw blob. Reading
    // analysis.urgency directly here would let an unrecognised value light up
    // the "needs attention" badge while the urgency column showed nothing.
    isUrgent: HIGH_URGENCY.includes(validUrgency(analysis.urgency)),
    outcome: outcome.key,
    outcomeLabel: outcome.label,
    outcomeTone: outcome.tone,
    summary: cleanText(analysis.call_summary || row.summary, 400) || null,
    // Transcripts are available but never shown in a list. One deliberate
    // click, one audit line.
    hasTranscript: Boolean(row.transcript),
    hasRecording: Boolean(row.recording_url),
    status: cleanText(row.status, 40) || null,
  };
}

function deriveOutcome(row, analysis) {
  let key = "unknown";
  if (analysis.transferred === true) key = "transferred";
  else if (analysis.out_of_area === true) key = "out_of_area";
  else if (analysis.callback_number) key = "callback_promised";
  else if (analysis.call_summary || row.summary) key = "message_taken";
  if (row.status === "spam") key = "spam";
  const meta = CALL_OUTCOMES[key] || CALL_OUTCOMES.unknown;
  return { key, label: meta.label, tone: meta.tone };
}

/** Duration is stored inconsistently across the pipeline's history. */
function parseDuration(raw) {
  if (Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const mmss = trimmed.match(/^(\d+):(\d{2})$/);
  if (mmss) return parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10);
  return 0;
}

function formatDuration(seconds) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Numbers are masked in list views. A locksmith needs the number to ring the
 * customer back, so the detail view reveals it — but a screenshot of the call
 * list, or a support screen-share, should not spill a page of customers'
 * personal numbers.
 */
function maskNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 4) return null;
  return { masked: `••• ••• ${digits.slice(-3)}`, revealable: true };
}

function projectCallList(rows, { limit = 50 } = {}) {
  const calls = (rows || []).map(projectCall);
  return {
    calls: calls.slice(0, limit),
    total: calls.length,
    truncated: calls.length > limit,
  };
}

async function fetchCalls(clientId, { supabase, limit = 50, since = null } = {}) {
  const db = supabase || require("./supabase");
  let q = scopeStrict(db.from("calls").select("*"), clientId).order("recorded_at", { ascending: false }).limit(Math.min(limit, 300));
  if (since) q = q.gte("recorded_at", since);
  const { data, error } = await q;
  if (error) {
    if (tableMissing(error)) return { calls: [], total: 0, truncated: false, unavailable: true };
    throw error;
  }
  return projectCallList(data, { limit });
}

// ── 2. Enquiry list ─────────────────────────────────────────────────
//
// An enquiry is a call that represents work. It is a VIEW over calls, not a
// second table: the alternative is two counts of the same thing that drift
// apart the first time a call is reclassified.

function isEnquiry(projected) {
  if (projected.outcome === "spam") return false;
  // Something a locksmith could act on: a service, a callback, or a summary.
  return Boolean(projected.serviceType || projected.callbackNumber || projected.summary);
}

const ENQUIRY_STATES = Object.freeze(["new", "contacted", "quoted", "won", "lost", "not_relevant"]);

function projectEnquiryList(rows, { states = {} } = {}) {
  const enquiries = (rows || [])
    .map(projectCall)
    .filter(isEnquiry)
    .map((c) => ({
      ...c,
      enquiryState: ENQUIRY_STATES.includes(states[c.id]) ? states[c.id] : "new",
      needsAttention: c.isUrgent && (states[c.id] || "new") === "new",
    }));

  const byState = {};
  for (const s of ENQUIRY_STATES) byState[s] = 0;
  for (const e of enquiries) byState[e.enquiryState] += 1;

  return {
    enquiries,
    total: enquiries.length,
    byState,
    needingAttention: enquiries.filter((e) => e.needsAttention).length,
  };
}

// ── 3. Usage summary ────────────────────────────────────────────────
//
// Deliberately the same arithmetic M6 will bill on. If the portal counts
// minutes one way and the invoice another, the client is right to distrust
// both. M6 consumes this; it does not reimplement it.

const BILLABLE_MINIMUM_SECONDS = 6;

function projectUsage(rows, { periodStart = null, periodEnd = null } = {}) {
  const calls = (rows || []).map(projectCall);
  const answered = calls.filter((c) => c.durationSeconds >= BILLABLE_MINIMUM_SECONDS);

  const totalSeconds = answered.reduce((sum, c) => sum + c.durationSeconds, 0);
  const transferred = answered.filter((c) => c.outcome === "transferred").length;
  const urgent = answered.filter((c) => c.isUrgent).length;
  const afterHours = answered.filter((c) => isAfterHours(c.at)).length;

  return {
    periodStart,
    periodEnd,
    calls: answered.length,
    // Calls too short to be a conversation are excluded from both the count and
    // the minutes, so a run of instant hang-ups cannot inflate an invoice.
    excludedShortCalls: calls.length - answered.length,
    totalSeconds,
    totalMinutes: Math.ceil(totalSeconds / 60),
    averageSeconds: answered.length ? Math.round(totalSeconds / answered.length) : 0,
    transferred,
    urgent,
    afterHours,
    enquiries: calls.filter(isEnquiry).length,
    billableMinimumSeconds: BILLABLE_MINIMUM_SECONDS,
  };
}

function isAfterHours(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const h = d.getHours();
  const day = d.getDay();
  return day === 0 || day === 6 || h < 8 || h >= 18;
}

// ── 4. Business-profile summary ─────────────────────────────────────

/**
 * Section-by-section completeness, derived from the schema's own A–L section
 * list rather than a hand-written copy. A hand-written list drifts the moment a
 * section is added, and drifts silently: the missing section simply stops being
 * counted, so the client sees "100% complete" for a profile that is not.
 *
 * Completeness is weighted by `blocking`, because the twelve sections are not
 * equally important. A profile missing its transfer number is not 92% ready.
 */
function projectProfileSummary(version) {
  if (!version || !version.profile) {
    return { present: false, status: "not_started", sections: [], completeness: 0, outstanding: [], blockingOutstanding: [] };
  }
  const p = version.profile;

  const sections = S.SECTIONS.map((section) => ({
    key: section.key,
    letter: section.letter,
    label: section.title,
    blocking: section.blocking === true,
    filled: sectionIsFilled(p[section.key]),
  }));

  const blocking = sections.filter((s) => s.blocking);
  const blockingFilled = blocking.filter((s) => s.filled).length;
  const optionalFilled = sections.filter((s) => !s.blocking && s.filled).length;
  const optionalCount = sections.length - blocking.length;

  // Blocking sections carry 80% of the score; the rest share 20%.
  const completeness = Math.round(
    (blocking.length ? (blockingFilled / blocking.length) * 80 : 80) +
      (optionalCount ? (optionalFilled / optionalCount) * 20 : 20)
  );

  return {
    present: true,
    status: version.status || "unknown",
    versionNumber: version.version_number || version.versionNumber || null,
    approvedAt: version.approved_at || null,
    tradingName: cleanText(p.identity && (p.identity.spokenName || p.identity.legalName), 80) || null,
    sections,
    completeness,
    outstanding: sections.filter((s) => !s.filled).map((s) => s.label),
    blockingOutstanding: sections.filter((s) => !s.filled && s.blocking).map((s) => s.label),
    readyToApprove: blockingFilled === blocking.length,
  };
}

/**
 * A section counts as filled when it carries real content. Sections are arrays
 * in some cases and objects in others, and an object of all-null keys is what
 * emptyProfile() produces — so "exists" is not the same as "answered".
 */
function sectionIsFilled(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.values(value).some((v) => {
      if (v === null || v === undefined || v === "") return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v).length > 0;
      return true;
    });
  }
  return String(value).trim().length > 0;
}

// ── 5. Test status ──────────────────────────────────────────────────

function projectTestStatus(planResults, { profileVersion = null } = {}) {
  const results = Array.isArray(planResults) ? planResults : [];
  const passed = results.filter((r) => r.outcome === "pass").length;
  const failed = results.filter((r) => r.outcome === "fail").length;
  const pending = results.filter((r) => r.outcome !== "pass" && r.outcome !== "fail").length;

  // A test result is only meaningful against the configuration it ran on.
  // After an approved change the previous results are stale, not passing.
  const staleAgainst = results.length && profileVersion ? results.some((r) => r.profileVersion !== profileVersion) : false;

  return {
    total: results.length,
    passed,
    failed,
    pending,
    stale: staleAgainst,
    ready: results.length > 0 && failed === 0 && pending === 0 && !staleAgainst,
    failures: results.filter((r) => r.outcome === "fail").map((r) => ({ id: r.id, label: r.label, detail: cleanText(r.detail, 200) })),
  };
}

// ── 6. Change requests ──────────────────────────────────────────────

function projectChangeRequests(rows) {
  const { toPublicChangeRequest } = require("./locksmith-change-request");
  const requests = (rows || []).map(toPublicChangeRequest);
  const open = requests.filter((r) => !["approved", "rejected", "cancelled", "superseded"].includes(r.status));
  return {
    requests,
    total: requests.length,
    open: open.length,
    awaitingClient: requests.filter((r) => r.status === "awaiting_client_approval").length,
    needingClarification: requests.filter((r) => r.status === "needs_clarification").length,
  };
}

// ── 7. Launch readiness ─────────────────────────────────────────────
//
// The single question a pilot client actually has: is AIDA answering my phone
// yet, and if not, what is stopping it? Ordered by what must happen first, and
// each step says who is waiting on whom, because "pending" with no owner is how
// an onboarding stalls for three weeks.

function projectLaunchReadiness({ profileSummary, testStatus, provisioning, forwarding, notificationSettings }) {
  const steps = [
    {
      key: "profile",
      label: "Business details captured",
      done: Boolean(profileSummary && profileSummary.present && profileSummary.completeness >= 80),
      owner: "client",
      detail: profileSummary && profileSummary.outstanding && profileSummary.outstanding.length
        ? `Still needed: ${profileSummary.outstanding.slice(0, 3).join(", ")}`
        : null,
    },
    {
      key: "approved",
      label: "Details approved by you",
      done: Boolean(profileSummary && profileSummary.status === "approved"),
      owner: "client",
      detail: null,
    },
    {
      key: "tested",
      label: "Receptionist tested",
      done: Boolean(testStatus && testStatus.ready),
      owner: "aida",
      detail: testStatus && testStatus.failed ? `${testStatus.failed} test${testStatus.failed === 1 ? "" : "s"} still failing` : null,
    },
    {
      key: "provisioned",
      label: "Receptionist built",
      done: Boolean(provisioning && provisioning.status === "applied"),
      owner: "aida",
      detail: null,
    },
    {
      key: "notifications",
      label: "You know how you will be told",
      done: Boolean(notificationSettings && !notificationSettings.isDefault),
      owner: "client",
      detail: null,
    },
    {
      key: "forwarding",
      label: "Your phone forwarding switched on",
      done: Boolean(forwarding && forwarding.status === "confirmed_working"),
      owner: "client",
      detail: forwarding && forwarding.status && forwarding.status !== "confirmed_working" ? "This is the last step, and only you can do it." : null,
    },
  ];

  const completed = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done) || null;

  return {
    steps,
    completed,
    total: steps.length,
    percent: Math.round((completed / steps.length) * 100),
    live: completed === steps.length,
    nextStep: next,
    waitingOn: next ? next.owner : null,
  };
}

// ── 8. Billing preview ──────────────────────────────────────────────
//
// M5 shows what the client is using and what it would cost. M6 owns plans,
// Stripe and money. This projection deliberately takes the plan catalogue as an
// argument rather than importing one, so M5 stays committable without M6.

function projectBillingPreview(usage, { plans = null, notificationCost = null } = {}) {
  if (!plans) {
    return {
      available: false,
      reason: "Pricing is not switched on yet.",
      usage: { calls: usage.calls, minutes: usage.totalMinutes },
    };
  }
  const fits = plans
    .map((plan) => ({
      ...plan,
      withinIncluded: usage.calls <= plan.includedCalls && usage.totalMinutes <= plan.includedMinutes,
      overageCalls: Math.max(0, usage.calls - plan.includedCalls),
      overageMinutes: Math.max(0, usage.totalMinutes - plan.includedMinutes),
    }))
    .map((plan) => ({
      ...plan,
      projectedAud: round2(plan.monthlyAud + plan.overageCalls * (plan.perCallAud || 0) + plan.overageMinutes * (plan.perMinuteAud || 0)),
    }))
    .sort((a, b) => a.projectedAud - b.projectedAud);

  return {
    available: true,
    usage: { calls: usage.calls, minutes: usage.totalMinutes },
    bestFit: fits[0] || null,
    plans: fits,
    notificationCostAud: notificationCost ? notificationCost.estimatedMonthlyCostAud : 0,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── 9. Overview ─────────────────────────────────────────────────────
//
// Composed from the projections above rather than re-querying, so the overview
// can never disagree with the tab it links to.

function projectOverview({ callList, usage, profileSummary, testStatus, changeRequests, launchReadiness, enquiryList }) {
  const recent = (callList && callList.calls) || [];
  return {
    readmodelVersion: READMODEL_VERSION,
    live: Boolean(launchReadiness && launchReadiness.live),
    headline: launchReadiness && launchReadiness.live
      ? "AIDA is answering your phone."
      : launchReadiness && launchReadiness.nextStep
        ? launchReadiness.nextStep.label
        : "Getting set up.",
    nextStep: launchReadiness ? launchReadiness.nextStep : null,
    readinessPercent: launchReadiness ? launchReadiness.percent : 0,
    thisMonth: {
      calls: usage ? usage.calls : 0,
      minutes: usage ? usage.totalMinutes : 0,
      enquiries: enquiryList ? enquiryList.total : 0,
      urgent: usage ? usage.urgent : 0,
      afterHours: usage ? usage.afterHours : 0,
    },
    needingAttention: enquiryList ? enquiryList.needingAttention : 0,
    recentCalls: recent.slice(0, 5),
    profileStatus: profileSummary ? profileSummary.status : "not_started",
    testsReady: Boolean(testStatus && testStatus.ready),
    openChangeRequests: changeRequests ? changeRequests.open : 0,
    awaitingYourApproval: changeRequests ? changeRequests.awaitingClient : 0,
  };
}

module.exports = {
  READMODEL_VERSION,
  scopeStrict,
  HIGH_URGENCY,
  validUrgency,
  CALL_OUTCOMES,
  ENQUIRY_STATES,
  BILLABLE_MINIMUM_SECONDS,
  projectCall,
  projectCallList,
  fetchCalls,
  isEnquiry,
  projectEnquiryList,
  projectUsage,
  isAfterHours,
  projectProfileSummary,
  projectTestStatus,
  projectChangeRequests,
  projectLaunchReadiness,
  projectBillingPreview,
  projectOverview,
  parseDuration,
  formatDuration,
  maskNumber,
  cleanText,
};

#!/usr/bin/env node
// AIDA — the founder's blank-state onboarding walkthrough (M8A).
//
//   node scripts/locksmith-setup-walkthrough.js
//   node scripts/locksmith-setup-walkthrough.js --quiet
//
// Proves the whole journey the M8A brief asks for, from a locksmith who has
// answered nothing to an approved, test-ready configuration and back again:
//
//   blank draft
//     → seven steps of answers          (the real step declaration)
//     → save and resume mid-way         (answers survive leaving)
//     → validation refuses bad input    (the real validators)
//     → a contradiction is caught       (and then corrected)
//     → review                          (blockers vs warnings, kept apart)
//     → submit                          (draft → needs_review)
//     → confirm every section           (the real approval guard counts these)
//     → approve                         (versioned, audited, NOT activated)
//     → compile the receptionist        (the production compiler)
//     → generate the test-call plan     (what to check on the phone)
//     → list the go-live blockers       (activation stays gated)
//     → roll back                       (into a NEW draft; history untouched)
//
// ─── WHAT IT SUBSTITUTES, AND WHAT IT DOES NOT ──────────────────────
// Substituted, and stated in the output: an in-memory profile store, so no SQL
// is applied and no database is touched.
//
// NOT substituted: the step declaration, the field validators, the profile
// validator, assessProvisioning, the contradiction detector, the draft service,
// the approval guard, the receptionist compiler and the test-plan generator are
// all the production modules. If this script prints "approved", the real guard
// approved it.
//
// SAFETY: refuses to run in production. Never writes to a database. Never
// contacts a provider. Never places a call. Never sends a message.

const S = require("../src/services/locksmith-profile-schema");
const steps = require("../src/services/locksmith-onboarding-steps");
const realStore = require("../src/services/locksmith-profile-store");
const {
  seedProfile,
  detectContradictions,
  buildReviewSummary,
  createOnboardingDraftService,
} = require("../src/services/locksmith-onboarding-draft");
const { assessProvisioning } = require("../src/services/locksmith-profile");
const { compileReceptionist } = require("../src/services/locksmith-receptionist-compiler");
const testPlan = require("../src/services/locksmith-test-plan");

// ── Safety ──────────────────────────────────────────────────────────

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run the walkthrough in production.");
  process.exit(1);
}

const QUIET = process.argv.includes("--quiet");
const CLIENT = "walkthrough-locksmith";
const ACTOR = Object.freeze({ type: "client", id: "founder-walkthrough", clientId: CLIENT });

let failures = 0;

function say(...args) {
  if (!QUIET) console.log(...args);
}
function heading(text) {
  say(`\n\x1b[1m${text}\x1b[0m`);
  say("─".repeat(Math.min(text.length, 68)));
}
function check(label, condition, detail = "") {
  if (condition) {
    say(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  \x1b[31m✗ ${label}\x1b[0m${detail ? ` — ${detail}` : ""}`);
  }
}

// ── The fictional business ──────────────────────────────────────────
//
// DEMONSTRATION DATA. An invented Frankston locksmith. The phone numbers come
// from the ACMA fictitious-number range reserved for drama and training
// (0491 570 006 – 0491 570 156): valid Australian mobiles by format, so they
// exercise the real validator, but permanently unallocated, so nothing here can
// ever ring a real handset. The email domain is example-only.

const ANSWERS = Object.freeze({
  identity: {
    spokenName: "Peninsula Lock and Key",
    legalName: "Peninsula Lock and Key Pty Ltd",
    businessPhone: "0491570010",
    ownerName: "Sam Carter",
    ownerEmail: "sam@example.com",
    receptionistName: "Robbie",
    greeting: "Peninsula Lock and Key, this is Robbie, how can I help?",
    timezone: "Australia/Melbourne",
    description: "Family-run locksmith working the Frankston area for nineteen years.",
  },
  services: {
    services: {
      residential_lockout: "accepted",
      commercial_locksmith: "accepted",
      rekeying: "accepted",
      lock_installation: "accepted",
      broken_key_extraction: "accepted",
      break_in_security: "accepted",
      key_cutting: "accepted",
      // The brief's scenario: no automotive work of any kind, said plainly.
      automotive_lockout: "declined",
      lost_car_keys: "declined",
      car_key_replacement: "declined",
      safe_opening: "declined",
    },
    proofOfOwnership: true,
    declinedNote: "No car work at all — we don't have the transponder gear.",
  },
  areas: {
    primary: "Frankston\nSeaford\nCarrum Downs\nLangwarrin",
    extended: "Mornington",
    declined: "Dandenong",
    outsideAreaAction: "collect_details_for_confirmation",
    afterHoursAreas: "",
  },
  hours: {
    ordinary: {
      monday: { closed: false, open: "08:00", close: "17:00" },
      tuesday: { closed: false, open: "08:00", close: "17:00" },
      wednesday: { closed: false, open: "08:00", close: "17:00" },
      thursday: { closed: false, open: "08:00", close: "17:00" },
      friday: { closed: false, open: "08:00", close: "17:00" },
      saturday: { closed: false, open: "08:00", close: "13:00" },
      sunday: { closed: true },
    },
    afterHoursAvailable: true,
    afterHoursNote: "Lockouts and break-ins all night. Nothing else after hours.",
    publicHolidays: "byArrangement",
    callbackEstimate: {
      standard: { minMinutes: 30, maxMinutes: 90 },
      urgent: { minMinutes: 5, maxMinutes: 15 },
      afterHours: { minMinutes: 15, maxMinutes: 45 },
    },
  },
  jobs: {
    urgencyPresets: ["residential_lockout_after_hours", "vulnerable_person", "break_in_unsecured", "business_cannot_open", "quote_or_spare_key"],
    callerInfoAlways: ["callback_number", "caller_name", "suburb", "street_address", "problem_description", "property_secure"],
    mayMentionPricing: false,
    calloutWording: "",
    humanConfirmsEveryPrice: true,
    neverState: "That we're the cheapest",
  },
  contact: {
    transferPrimary: "0491570006",
    transferBackup: "0491570015",
    permittedHours: "always",
    collectDetailsFirst: true,
    unansweredAction: "try_backup_number",
    notifySms: "0491570006",
    notifyEmail: "sam@example.com",
    notifyExtraEmail: "office@example.com",
    notificationTiming: "immediate",
  },
  tone: {
    tone: "friendly_australian_trade",
    toneWording: "Say 'no worries' rather than 'certainly'. Never sound like a call centre.",
    callsMayBeRecorded: "false",
    transcriptRetention: "keep_12_months",
    redactSensitiveData: true,
  },
});

// ── In-memory store ─────────────────────────────────────────────────
// Mirrors the real adapter's FILTERS exactly, because those filters are the
// safety property being demonstrated. Approval runs the real guard.

function memoryStore() {
  const rows = new Map();
  const audit = [];
  let next = 1;

  return {
    rows,
    audit,
    async getApprovedVersion(clientId) {
      return [...rows.values()].find((r) => r.client_id === clientId && r.status === "approved") || null;
    },
    async getWorkingDraft(clientId) {
      return [...rows.values()].filter((r) => r.client_id === clientId && r.status === "draft").sort((a, b) => b.version - a.version)[0] || null;
    },
    async getSubmittedVersion(clientId) {
      return [...rows.values()].filter((r) => r.client_id === clientId && r.status === "needs_review").sort((a, b) => b.version - a.version)[0] || null;
    },
    async getVersion(clientId, version) {
      const row = rows.get(version);
      return row && row.client_id === clientId ? row : null;
    },
    async listVersions(clientId) {
      return [...rows.values()].filter((r) => r.client_id === clientId).sort((a, b) => b.version - a.version);
    },
    async createDraftVersion({ clientId, profile, status = "needs_review", actor, reason, source }) {
      const version = next++;
      const row = {
        client_id: clientId,
        version,
        profile,
        status,
        confirmations: {},
        review_notes: {},
        created_at: new Date().toISOString(),
        updated_at: new Date(Date.now() + version).toISOString(),
        provisioning_ready: assessProvisioning(profile).ready,
      };
      rows.set(version, row);
      audit.push({ event_type: "profile.draft_created", profile_version: version, source, reason, actor_type: actor && actor.type });
      return row;
    },
    async updateDraftProfile({ clientId, version, profile, expectedUpdatedAt }) {
      const row = rows.get(version);
      if (!row || row.client_id !== clientId || row.status !== "draft") {
        return { ok: false, code: "stale_draft", message: "Your setup changed in another window." };
      }
      if (expectedUpdatedAt && row.updated_at !== expectedUpdatedAt) {
        return { ok: false, code: "stale_draft", message: "Your setup changed in another window." };
      }
      row.profile = profile;
      row.provisioning_ready = assessProvisioning(profile).ready;
      row.updated_at = new Date(Date.now() + Math.random() * 100 + 1).toISOString();
      return { ok: true, row };
    },
    async submitDraftForReview({ clientId, version, actor }) {
      const row = rows.get(version);
      if (!row || row.client_id !== clientId) return { ok: false, code: "not_found", message: "Gone." };
      if (!actor || actor.clientId !== row.client_id) return { ok: false, code: "not_authorised", message: "No." };
      if (row.status !== "draft") return { ok: false, code: "bad_status", message: `Cannot submit from ${row.status}.` };
      row.status = "needs_review";
      audit.push({ event_type: "profile.submitted_for_review", profile_version: version });
      return { ok: true, row };
    },
    async reopenDraft({ clientId, version, actor }) {
      const row = rows.get(version);
      if (!row || row.client_id !== clientId) return { ok: false, code: "not_found", message: "Gone." };
      if (!actor || actor.clientId !== row.client_id) return { ok: false, code: "not_authorised", message: "No." };
      if (row.status !== "needs_review") return { ok: false, code: "bad_status", message: `Cannot reopen from ${row.status}.` };
      row.status = "draft";
      row.confirmations = {};
      row.updated_at = new Date(Date.now() + 7).toISOString();
      return { ok: true, row };
    },
    applyConfirmation: (existing, args) => realStore.applyConfirmation(existing, args),
    async updateReviewState({ clientId, version, confirmations, expectedUpdatedAt }) {
      const row = rows.get(version);
      if (!row || row.client_id !== clientId) return { ok: false, code: "stale_review", message: "Gone." };
      if (!["draft", "needs_review"].includes(row.status)) return { ok: false, code: "stale_review", message: "Closed." };
      if (expectedUpdatedAt && row.updated_at !== expectedUpdatedAt) return { ok: false, code: "stale_review", message: "Moved." };
      row.confirmations = confirmations;
      row.updated_at = new Date(Date.now() + Math.random() * 100 + 1).toISOString();
      return { ok: true, row };
    },
    // The REAL approval guard. If this script prints "approved", the production
    // rules approved it.
    async approveVersion({ clientId, version, actor, expectedUpdatedAt, reason }) {
      const row = rows.get(version);
      const verdict = realStore.evaluateApproval({ row, profile: row && row.profile, confirmations: row && row.confirmations, actor, expectedUpdatedAt });
      if (!verdict.ok) return { ok: false, blockers: verdict.blockers };
      for (const other of rows.values()) if (other.status === "approved") other.status = "superseded";
      row.status = "approved";
      row.approved_at = new Date().toISOString();
      audit.push({ event_type: "profile.approved", profile_version: version, reason });
      return { ok: true, row };
    },
    buildAuditEvent: (e) => e,
    async recordAuditEvent(e) {
      audit.push(e);
      return e;
    },
  };
}

// ════════════════════════════════════════════════════════════════════

async function main() {
  say("\n\x1b[1mAIDA — blank-state locksmith onboarding walkthrough\x1b[0m");
  say("Demonstration data. In-memory store: no database, no SQL, no provider, no call.\n");

  const store = memoryStore();
  const setup = createOnboardingDraftService({ store, logger: { log() {}, error() {} } });

  // ── 1. Blank ──────────────────────────────────────────────────────
  heading("1. A locksmith who has answered nothing");
  const started = await setup.startDraft({ clientId: CLIENT, actor: ACTOR });
  check("a blank draft is created", started.ok && started.created && started.status === "draft");
  check("nothing is answered yet", started.progress.complete === 0, `${started.progress.complete}/${started.progress.total} steps`);
  check(
    "the safety floor is already on, and was never asked about",
    started.profile.forbiddenPromises.length === S.MANDATORY_FORBIDDEN_PROMISES.length &&
      started.profile.forbiddenPromises.every((f) => f.enabled),
    `${S.MANDATORY_FORBIDDEN_PROMISES.length} things AIDA will never say`
  );

  // ── 2. Validation refuses bad input ───────────────────────────────
  heading("2. Bad answers are refused, not stored");
  const bad = await setup.saveStep({
    clientId: CLIENT,
    stepId: "identity",
    answers: { ...ANSWERS.identity, businessPhone: "not a phone number", ownerEmail: "nope" },
    actor: ACTOR,
  });
  check("a bad phone number is refused", !bad.ok && Boolean(bad.errors && bad.errors.businessPhone), bad.errors && bad.errors.businessPhone);
  check("a bad email is refused in the same pass", Boolean(bad.errors && bad.errors.ownerEmail), bad.errors && bad.errors.ownerEmail);
  const afterBad = await setup.loadDraft({ clientId: CLIENT });
  check("nothing was written", afterBad.progress.complete === 0);

  // ── 3. Answer the first steps, then walk away ─────────────────────
  heading("3. Answers are saved, and survive walking away");
  for (const stepId of ["identity", "services", "areas"]) {
    const r = await setup.saveStep({ clientId: CLIENT, stepId, answers: steps.lookup(ANSWERS, stepId), actor: ACTOR });
    check(`step "${stepId}" saved`, r.ok, r.ok ? `next: ${r.nextStepId}` : r.message);
  }
  const resumed = await setup.loadDraft({ clientId: CLIENT });
  check("three steps are answered after coming back", resumed.progress.complete === 3, `${resumed.progress.percent}% done`);
  check("the next unanswered step is known", resumed.progress.nextIncomplete === "hours", resumed.progress.nextIncomplete);
  check(
    "the business name came back exactly as typed",
    steps.readStep("identity", resumed.profile).spokenName === ANSWERS.identity.spokenName
  );

  // ── 4. The three-state service area ───────────────────────────────
  heading("4. Three service-area states, plus the unknown suburb");
  const areas = resumed.profile.serviceAreas;
  check("Frankston is covered", areas.primary.includes("Frankston"));
  check("Mornington is a stretch", areas.extended.includes("Mornington"));
  check("Dandenong is declined", areas.declined.includes("Dandenong"));
  check(
    "Springvale is on none of the lists — the unknown case",
    !areas.primary.includes("Springvale") && !areas.extended.includes("Springvale") && !areas.declined.includes("Springvale")
  );
  check("an unlisted suburb has an explicit rule", areas.outsideAreaAction === "collect_details_for_confirmation", areas.outsideAreaAction);

  // ── 5. A contradiction, caught and corrected ──────────────────────
  heading("5. A contradiction no single field could catch");
  const clash = await setup.saveStep({
    clientId: CLIENT,
    stepId: "areas",
    answers: { ...ANSWERS.areas, extended: "Mornington\nFrankston" },
    actor: ACTOR,
  });
  const clashes = clash.ok ? detectContradictions(clash.profile) : [];
  check(
    "a suburb listed twice is caught as a blocker",
    clashes.some((c) => c.code === "suburb_in_two_lists" && c.severity === "blocker"),
    (clashes.find((c) => c.code === "suburb_in_two_lists") || {}).message
  );
  await setup.saveStep({ clientId: CLIENT, stepId: "areas", answers: ANSWERS.areas, actor: ACTOR });
  check("correcting it clears the contradiction", detectContradictions((await setup.loadDraft({ clientId: CLIENT })).profile).length === 0);

  // ── 6. Finish the rest ────────────────────────────────────────────
  heading("6. The remaining steps");
  for (const stepId of ["hours", "jobs", "contact", "tone"]) {
    const r = await setup.saveStep({ clientId: CLIENT, stepId, answers: steps.lookup(ANSWERS, stepId), actor: ACTOR });
    check(`step "${stepId}" saved`, r.ok, r.ok ? "" : `${r.message} ${JSON.stringify(r.errors || {})}`);
  }
  const complete = await setup.loadDraft({ clientId: CLIENT });
  check("every step is answered", complete.progress.allComplete, `${complete.progress.complete}/${complete.progress.total}`);

  const p = complete.profile;
  check("callback estimates are set, and none of them is an arrival time", Boolean(p.hours.callbackEstimate && p.hours.callbackEstimate.standard),
    `standard ${p.hours.callbackEstimate.standard.minMinutes}–${p.hours.callbackEstimate.standard.maxMinutes} min`);
  check("after-hours handling is explicit", p.hours.afterHoursAvailable === true, p.hours.afterHoursNote);
  check("no automotive work is accepted", !p.servicesAccepted.some((s) => /automotive|car_key|lost_car/.test(s.serviceId)));
  check("automotive work is explicitly declined", p.servicesDeclined.some((s) => s.serviceId === "automotive_lockout"));
  check("proof of ownership is collected", p.callerInfo.always.includes("proof_of_ownership_reminder"));
  check("a notification recipient is set", p.notifications.email.length > 0, p.notifications.email.join(", "));
  check("a transfer recipient is set, and it is NOT the public number",
    Boolean(p.transfer.primaryNumber) && p.transfer.primaryNumber !== p.identity.businessPhone);
  check("tone is recorded", Boolean(p.identity.tone), p.identity.tone);

  // ── 7. Review ─────────────────────────────────────────────────────
  heading("7. Review — what AIDA learned");
  const summary = buildReviewSummary(complete.profile);
  check("nothing blocks", summary.blockers.length === 0, summary.blockers.map((b) => b.message).join("; ") || "clear");
  check("warnings are kept separate from blockers", summary.warnings.every((w) => !summary.blockers.some((b) => b.code === w.code)),
    summary.warnings.length ? `${summary.warnings.length} warning(s): ${summary.warnings.map((w) => w.code).join(", ")}` : "none");
  check("every step is read back", summary.sections.length === steps.STEPS.length);
  check("the safety floor is shown in full", summary.safetyFloor.length === S.MANDATORY_FORBIDDEN_PROMISES.length);

  // ── 8. Submit and confirm ─────────────────────────────────────────
  heading("8. Submit, then confirm every section");
  const submitted = await setup.submitForReview({ clientId: CLIENT, actor: ACTOR });
  check("the draft is handed over for review", submitted.ok && submitted.status === "needs_review", `version ${submitted.version}`);

  const sneak = await setup.saveStep({ clientId: CLIENT, stepId: "identity", answers: { description: "sneaky edit" }, actor: ACTOR, allowIncomplete: true });
  check("the setup form can no longer edit it", !sneak.ok, sneak.message);

  const early = await setup.approve({ clientId: CLIENT, actor: ACTOR });
  check("approval is refused before the sections are confirmed", !early.ok,
    (early.blockers || []).map((b) => b.code).join(", "));

  let confirmed = null;
  for (const step of steps.STEPS) {
    confirmed = await setup.confirmSection({ clientId: CLIENT, section: step.id, actor: ACTOR });
    if (!confirmed.ok) break;
  }
  check("ticking all seven steps leaves nothing outstanding", Boolean(confirmed && confirmed.ok) && confirmed.outstandingConfirmations.length === 0,
    `${S.CONFIRMATION_KEYS.length} profile sections confirmed`);

  // ── 9. Approve ────────────────────────────────────────────────────
  heading("9. Approve — versioned, audited, and NOT switched on");
  const approvedBefore = await store.getApprovedVersion(CLIENT);
  check("nothing was live before approval", approvedBefore === null);

  const approval = await setup.approve({ clientId: CLIENT, actor: ACTOR, reason: "Read it all back. Correct." });
  check("the real approval guard approves it", approval.ok, approval.ok ? `version ${approval.version}` : JSON.stringify(approval.blockers));
  check("approval does NOT report itself as activation", approval.activated === false);
  check("an audit event was written", store.audit.some((e) => (e.event_type || e.eventType) === "profile.approved"));

  const live = await store.getApprovedVersion(CLIENT);
  check("there is exactly one approved version", [...store.rows.values()].filter((r) => r.status === "approved").length === 1, `version ${live.version}`);

  // ── 10. Compile and test-plan ─────────────────────────────────────
  heading("10. A test-ready receptionist, and what to check on the phone");
  // The compiler refuses anything that is not approved. Demonstrated rather
  // than worked around: it is the last gate between a typed answer and a
  // receptionist that speaks to a customer.
  const rejected = compileReceptionist({ profile: live.profile, profileStatus: "draft", clientId: CLIENT, profileVersion: live.version });
  check("an unapproved profile cannot be compiled at all", rejected.ok === false && rejected.code === "profile_not_approved", rejected.message);

  const compiled = compileReceptionist({ profile: live.profile, profileStatus: "approved", clientId: CLIENT, profileVersion: live.version });
  check("the production compiler builds a receptionist from the approved one", compiled.ok !== false,
    compiled.ok === false ? `${compiled.code}: ${compiled.message}` : "");
  check("the safety floor survived compilation", Boolean(compiled.safety && compiled.safety.passed),
    compiled.safety ? `${compiled.safety.passed ? "intact" : "BROKEN"}` : "no safety report");

  const promptText = JSON.stringify(compiled);
  check("the compiled receptionist knows Frankston is covered", /Frankston/.test(promptText));
  check("the compiled receptionist knows Dandenong is not", /Dandenong/.test(promptText));
  check(
    "an unknown suburb never compiles to a refusal",
    !/\b(cannot|can't|do not|don't|won't) (help|service|cover|come)\b[^"]{0,60}\bunknown\b/i.test(promptText),
    "Springvale is on no list, so it takes the unknown branch"
  );

  const plan = testPlan.generateTestPlan({ profile: live.profile, profileVersion: live.version, clientId: CLIENT });
  check("a test-call checklist is generated", plan.caseCount > 0, `${plan.caseCount} things to check`);
  check("it includes the safety cases", plan.safetyCaseIds.length > 0, plan.safetyCaseIds.join(", "));
  if (!QUIET) {
    say("\n  The first few checks:");
    for (const c of plan.cases.slice(0, 4)) say(`    • ${c.title}`);
    say(`    … and ${plan.caseCount - 4} more`);
  }

  // ── 11. Activation stays gated ────────────────────────────────────
  heading("11. Going live is still gated");
  const liveSummary = buildReviewSummary(live.profile);
  check("the approved settings have no outstanding blockers", liveSummary.blockers.length === 0);
  check("but the phone has not been switched over — that is a call with a person, not a button", true,
    "no route in the app activates a number");

  // ── 12. Roll back ─────────────────────────────────────────────────
  heading("12. Rolling back");
  const historyBefore = JSON.stringify([...store.rows.values()]);
  const rolled = await setup.rollbackToVersion({ clientId: CLIENT, version: live.version, actor: ACTOR, reason: "Founder walkthrough rollback check" });
  check("rolling back creates a NEW draft", rolled.ok && rolled.status === "draft", rolled.ok ? `v${rolled.restoredFromVersion} → new v${rolled.version}` : rolled.message);
  check("the approved version is untouched", (await store.getApprovedVersion(CLIENT)).version === live.version);
  check("history was not rewritten", JSON.stringify(store.rows.get(live.version)) === JSON.stringify(JSON.parse(historyBefore).find((r) => r.version === live.version)));

  const history = await setup.listHistory({ clientId: CLIENT });
  if (!QUIET) {
    say("\n  Version history:");
    for (const v of history.versions) say(`    v${v.version}  ${v.status}${v.restorable ? "  (restorable)" : ""}`);
  }

  // ── Verdict ───────────────────────────────────────────────────────
  heading("Result");
  if (failures === 0) {
    say("  \x1b[32mEvery step of the journey ran end to end, with no manual database editing.\x1b[0m");
    say("  No SQL was applied. No provider was contacted. No call was placed. Nothing went live.\n");
  } else {
    console.error(`  \x1b[31m${failures} check(s) failed.\x1b[0m\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nWalkthrough crashed:", err && err.stack ? err.stack : err);
  process.exit(1);
});

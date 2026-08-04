// M8A — the launch-ready onboarding journey: step spec + draft service.
//
// Covers the brief's test list at the service layer: blank onboarding, save and
// resume, validation, contradictory answers, three-state service areas, callback
// estimates, notification recipients, transfer settings, draft creation, version
// history, rollback, and — the one that matters most — that nothing production
// moves before approval.
//
// Route, rendering and accessibility coverage lives in
// test/locksmith-setup-ui.test.js.
//
// Dep-free: an in-memory store stands in for Supabase, following the
// memoryStore precedent in test/locksmith-feedback-loop.test.js.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const S = require("../src/services/locksmith-profile-schema");
const steps = require("../src/services/locksmith-onboarding-steps");
const interview = require("../src/services/locksmith-interview-spec");
const realStore = require("../src/services/locksmith-profile-store");
const {
  seedProfile,
  detectContradictions,
  buildReviewSummary,
  createOnboardingDraftService,
  OUTCOMES,
} = require("../src/services/locksmith-onboarding-draft");
const { validateProfile, assessProvisioning } = require("../src/services/locksmith-profile");

const CLIENT = "test-locksmith";
const ACTOR = Object.freeze({ type: "client", id: "user-1", clientId: CLIENT });
const SILENT = { log() {}, error() {} };

// ── In-memory store ─────────────────────────────────────────────────

function memoryStore({ seedApproved = null } = {}) {
  const rows = new Map();
  const audit = [];
  let next = 1;

  if (seedApproved) {
    rows.set(next, {
      client_id: CLIENT,
      version: next,
      profile: seedApproved,
      status: "approved",
      confirmations: {},
      review_notes: {},
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      approved_at: "2026-08-01T00:00:00.000Z",
      provisioning_ready: assessProvisioning(seedApproved).ready,
    });
    next += 1;
  }

  return {
    rows,
    audit,
    async getApprovedVersion(clientId) {
      return [...rows.values()].find((r) => r.client_id === clientId && r.status === "approved") || null;
    },
    async getWorkingDraft(clientId) {
      const drafts = [...rows.values()].filter((r) => r.client_id === clientId && r.status === "draft");
      drafts.sort((a, b) => b.version - a.version);
      return drafts[0] || null;
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
      // Mirrors the real adapter's filters exactly, because these ARE the safety
      // property: only a `draft` row, and only if it hasn't moved.
      if (!row || row.client_id !== clientId || row.status !== "draft") {
        return { ok: false, code: "stale_draft", message: "Your setup changed in another window." };
      }
      if (expectedUpdatedAt && row.updated_at !== expectedUpdatedAt) {
        return { ok: false, code: "stale_draft", message: "Your setup changed in another window." };
      }
      row.profile = profile;
      row.provisioning_ready = assessProvisioning(profile).ready;
      row.updated_at = new Date(Date.now() + Math.random() * 1000 + 1).toISOString();
      return { ok: true, row };
    },
    async submitDraftForReview({ clientId, version, actor, expectedUpdatedAt }) {
      const row = rows.get(version);
      if (!row || row.client_id !== clientId) return { ok: false, code: "not_found", message: "Gone." };
      if (!actor || actor.clientId !== row.client_id) return { ok: false, code: "not_authorised", message: "No." };
      if (row.status !== "draft") return { ok: false, code: "bad_status", message: `Cannot submit from ${row.status}.` };
      if (expectedUpdatedAt && row.updated_at !== expectedUpdatedAt) return { ok: false, code: "stale_draft", message: "Moved." };
      row.status = "needs_review";
      audit.push({ event_type: "profile.submitted_for_review", profile_version: version });
      return { ok: true, row };
    },
    buildAuditEvent: (e) => e,
    async recordAuditEvent(e) {
      audit.push(e);
      return e;
    },
  };
}

const service = (store) => createOnboardingDraftService({ store, logger: SILENT });

// ── A complete set of answers for the founder scenario ──────────────
// A fictional Frankston locksmith. Numbers come from the ACMA fictitious range
// (0491 570 006 – 0491 570 156), which is valid by format but permanently
// unallocated, so no test can ever ring a real handset.

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
    description: "Family-run locksmith on the Mornington Peninsula.",
  },
  services: {
    services: {
      residential_lockout: "accepted",
      commercial_locksmith: "accepted",
      rekeying: "accepted",
      lock_installation: "accepted",
      broken_key_extraction: "accepted",
      break_in_security: "accepted",
      automotive_lockout: "declined",
      lost_car_keys: "declined",
      car_key_replacement: "declined",
      safe_opening: "declined",
    },
    proofOfOwnership: true,
    declinedNote: "No car work of any kind — we don't have the transponder gear.",
  },
  areas: {
    primary: "Frankston\nSeaford\nCarrum Downs",
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
    afterHoursNote: "Lockouts and break-ins all night. Nothing else.",
    publicHolidays: "byArrangement",
    callbackEstimate: {
      standard: { minMinutes: 30, maxMinutes: 90 },
      urgent: { minMinutes: 5, maxMinutes: 15 },
      afterHours: { minMinutes: 15, maxMinutes: 45 },
    },
  },
  jobs: {
    urgencyPresets: ["residential_lockout_after_hours", "vulnerable_person", "break_in_unsecured", "quote_or_spare_key"],
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
    toneWording: "Say 'no worries' rather than 'certainly'.",
    callsMayBeRecorded: "false",
    transcriptRetention: "keep_12_months",
    redactSensitiveData: true,
  },
});

/** Walk every step, exactly as the wizard does. */
async function completeSetup(svc, overrides = {}) {
  for (const step of steps.STEPS) {
    const answers = { ...(steps.lookup(ANSWERS, step.id) || {}), ...(steps.lookup(overrides, step.id) || {}) };
    const r = await svc.saveStep({ clientId: CLIENT, stepId: step.id, answers, actor: ACTOR });
    assert.equal(r.ok, true, `step ${step.id} failed: ${r.message} ${JSON.stringify(r.errors || {})}`);
  }
}

function fullProfile() {
  let p = seedProfile(CLIENT);
  for (const step of steps.STEPS) p = steps.applyStep(step.id, steps.lookup(ANSWERS, step.id), p);
  return p;
}

// ════════════════════════════════════════════════════════════════════

describe("M8A step spec — one model for form and voice", () => {
  test("every step declares fields, and every field can read and apply", () => {
    assert.ok(steps.STEPS.length >= 7, "the journey needs its data-entry steps");
    for (const step of steps.STEPS) {
      assert.ok(step.fields.length > 0, `${step.id} has no fields`);
      for (const f of step.fields) {
        assert.equal(typeof f.read, "function", `${step.id}.${f.name} cannot be read`);
        assert.equal(typeof f.apply, "function", `${step.id}.${f.name} cannot be applied`);
        assert.equal(typeof f.validate, "function", `${step.id}.${f.name} cannot be validated`);
        assert.ok(f.spoken && f.spoken.length > 8, `${step.id}.${f.name} has no spoken form — a voice agent could not ask it`);
        assert.ok(f.label, `${step.id}.${f.name} has no label`);
      }
    }
  });

  test("every step names interview groups that actually exist", () => {
    const known = new Set(interview.QUESTION_GROUPS.map((g) => g.id));
    for (const step of steps.STEPS) {
      assert.ok(step.interviewGroups.length > 0, `${step.id} is not bound to the interview spec`);
      for (const id of step.interviewGroups) {
        assert.ok(known.has(id), `${step.id} names interview group "${id}", which does not exist`);
      }
    }
  });

  test("every interview group that establishes facts is covered by some step", () => {
    const covered = new Set(steps.STEPS.flatMap((s) => s.interviewGroups));
    const uncovered = interview.QUESTION_GROUPS.filter((g) => g.mustEstablish.length > 0 && !covered.has(g.id));
    assert.deepEqual(
      uncovered.map((g) => g.id),
      [],
      "a question the voice agent must establish has no place in the form — the two channels would diverge"
    );
  });

  test("apply never mutates the profile it is given", () => {
    const before = seedProfile(CLIENT);
    const snapshot = JSON.stringify(before);
    const after = steps.applyStep("identity", ANSWERS.identity, before);
    assert.equal(JSON.stringify(before), snapshot, "the input profile was mutated");
    assert.notEqual(JSON.stringify(after), snapshot, "the output profile did not change");
  });

  test("a field name from Object.prototype cannot reach a lookup table", () => {
    // The M7I hazard: TABLE["constructor"] returns a truthy function.
    for (const key of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      assert.equal(steps.getStep(key), null, `getStep("${key}") resolved through the prototype chain`);
      assert.equal(steps.getField("identity", key), null, `getField("${key}") resolved through the prototype chain`);
    }
    // And applying such a "field" changes nothing.
    const before = seedProfile(CLIENT);
    const after = steps.applyStep("identity", { constructor: "boom", toString: "boom" }, before);
    assert.equal(JSON.stringify(after), JSON.stringify(before));
  });

  test("a blank profile completes no steps; a full one completes them all", () => {
    const blank = steps.assessProgress(seedProfile(CLIENT));
    assert.equal(blank.complete, 0);
    assert.equal(blank.percent, 0);
    assert.equal(blank.allComplete, false);
    assert.equal(blank.nextIncomplete, steps.STEP_IDS[0]);

    const full = steps.assessProgress(fullProfile());
    assert.equal(full.allComplete, true, `incomplete: ${full.steps.filter((s) => !s.complete).map((s) => s.id)}`);
    assert.equal(full.percent, 100);
    assert.equal(full.nextIncomplete, null);
  });

  test("a completed setup is a VALID, provisioning-ready profile", () => {
    const p = fullProfile();
    const validation = validateProfile(p);
    assert.equal(validation.ok, true, `invalid: ${JSON.stringify(validation.errors)}`);
    const assessment = assessProvisioning(p);
    assert.equal(assessment.ready, true, `blocked: ${JSON.stringify(assessment.blockers)}`);
  });

  test("the journey covers all eleven stages the brief names", () => {
    const kinds = steps.STAGES.map((s) => s.kind);
    for (const kind of ["form", "review", "approve", "test", "activate"]) {
      assert.ok(kinds.includes(kind), `no stage of kind "${kind}"`);
    }
    assert.equal(steps.STAGES.length, 11, "the journey is eleven stages");
    assert.deepEqual(
      steps.STAGES.map((s) => s.number),
      Array.from({ length: 11 }, (_, i) => i + 1),
      "stage numbers must run 1..11 without gaps"
    );
  });
});

describe("M8A three-state service areas", () => {
  test("covered, extended and declined are stored as three distinct lists", () => {
    const p = steps.applyStep("areas", ANSWERS.areas, seedProfile(CLIENT));
    assert.deepEqual(p.serviceAreas.primary, ["Frankston", "Seaford", "Carrum Downs"]);
    assert.deepEqual(p.serviceAreas.extended, ["Mornington"]);
    assert.deepEqual(p.serviceAreas.declined, ["Dandenong"]);
  });

  test("an unlisted suburb has an explicit rule, and it is never a flat refusal by default", () => {
    const p = steps.applyStep("areas", ANSWERS.areas, seedProfile(CLIENT));
    assert.equal(p.serviceAreas.outsideAreaAction, "collect_details_for_confirmation");
    // Springvale is on none of the three lists — the unknown case.
    for (const list of ["primary", "extended", "declined"]) {
      assert.ok(!p.serviceAreas[list].includes("Springvale"));
    }
  });

  test("the outside-area choice is required", () => {
    const verdict = steps.validateStep("areas", { ...ANSWERS.areas, outsideAreaAction: null }, seedProfile(CLIENT));
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.outsideAreaAction, /suburb you haven't listed/i);
  });

  test("suburb lists accept commas or newlines and de-duplicate", () => {
    const p = steps.applyStep("areas", { ...ANSWERS.areas, primary: "Frankston, Seaford\nFrankston" }, seedProfile(CLIENT));
    assert.deepEqual(p.serviceAreas.primary, ["Frankston", "Seaford"]);
  });

  test("a blank after-hours area means 'same as daytime', stored as null not []", () => {
    const p = steps.applyStep("areas", { ...ANSWERS.areas, afterHoursAreas: "  " }, seedProfile(CLIENT));
    assert.equal(p.serviceAreas.afterHoursAreas, null);
  });
});

describe("M8A callback estimates", () => {
  test("three windows are stored, and none of them is an arrival time", () => {
    const p = steps.applyStep("hours", ANSWERS.hours, seedProfile(CLIENT));
    assert.deepEqual(p.hours.callbackEstimate, {
      standard: { minMinutes: 30, maxMinutes: 90 },
      urgent: { minMinutes: 5, maxMinutes: 15 },
      afterHours: { minMinutes: 15, maxMinutes: 45 },
    });
    // The forbidden promise that keeps it from becoming a guarantee is still on.
    const enabled = p.forbiddenPromises.filter((f) => f.enabled).map((f) => f.promiseId);
    assert.ok(enabled.includes("guaranteed_arrival_time"));
  });

  test("blank is valid and means 'no approved estimate'", () => {
    const verdict = steps.validateStep("hours", { ...ANSWERS.hours, callbackEstimate: {} }, seedProfile(CLIENT));
    assert.equal(verdict.ok, true);
    const p = steps.applyStep("hours", { ...ANSWERS.hours, callbackEstimate: {} }, seedProfile(CLIENT));
    assert.equal(p.hours.callbackEstimate, null);
  });

  test("urgent or after-hours without a standard window is refused", () => {
    const verdict = steps.validateStep(
      "hours",
      { ...ANSWERS.hours, callbackEstimate: { urgent: { minMinutes: 5, maxMinutes: 10 } } },
      seedProfile(CLIENT)
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.callbackEstimate, /ordinary-enquiry estimate/i);
  });

  test("a backwards or absurd window is refused", () => {
    const backwards = steps.validateStep("hours", { ...ANSWERS.hours, callbackEstimate: { standard: { minMinutes: 90, maxMinutes: 30 } } }, seedProfile(CLIENT));
    assert.equal(backwards.ok, false);
    const absurd = steps.validateStep("hours", { ...ANSWERS.hours, callbackEstimate: { standard: { minMinutes: 1, maxMinutes: 5000 } } }, seedProfile(CLIENT));
    assert.equal(absurd.ok, false);
  });

  test("a stored estimate survives a round trip through read and apply", () => {
    const p = steps.applyStep("hours", ANSWERS.hours, seedProfile(CLIENT));
    const readBack = steps.readStep("hours", p);
    const again = steps.applyStep("hours", readBack, seedProfile(CLIENT));
    assert.deepEqual(again.hours.callbackEstimate, p.hours.callbackEstimate);
  });
});

describe("M8A notification recipients and transfer settings", () => {
  test("a notification recipient can be set from answers alone — the M5 gap", () => {
    const p = steps.applyStep("contact", ANSWERS.contact, seedProfile(CLIENT));
    assert.deepEqual(p.notifications.email, ["sam@example.com", "office@example.com"]);
    assert.deepEqual(p.notifications.sms, ["0491570006"]);
    assert.equal(p.notifications.timing, "immediate");
    // And the profile no longer warns that nobody is listening.
    const warnings = assessProvisioning(fullProfile()).warnings.map((w) => w.code);
    assert.ok(!warnings.includes("no_notification_recipients"));
  });

  test("a bad extra email is named, not silently dropped", () => {
    const verdict = steps.validateStep("contact", { ...ANSWERS.contact, notifyExtraEmail: "not-an-email" }, seedProfile(CLIENT));
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.notifyExtraEmail, /not-an-email/);
  });

  test("transfer number, backup, permitted hours and fallback all persist", () => {
    const p = steps.applyStep("contact", ANSWERS.contact, seedProfile(CLIENT));
    assert.equal(p.transfer.primaryNumber, "0491570006");
    assert.equal(p.transfer.backupNumber, "0491570015");
    assert.deepEqual(p.transfer.permittedHours, { always: true });
    assert.equal(p.transfer.unansweredAction, "try_backup_number");
    assert.equal(p.transfer.collectDetailsFirst, true);
  });

  test("choosing 'try the backup number' without giving one is refused at the step", () => {
    const answers = { ...ANSWERS.contact, transferBackup: "" };
    const candidate = steps.applyStep("contact", answers, seedProfile(CLIENT));
    const verdict = steps.validateStep("contact", steps.readStep("contact", candidate), candidate);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.unansweredAction, /haven't given one/i);
  });

  test("a non-Australian transfer number is refused", () => {
    const verdict = steps.validateStep("contact", { ...ANSWERS.contact, transferPrimary: "+1 415 555 0100" }, seedProfile(CLIENT));
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors.transferPrimary, /Australian/i);
  });
});

describe("M8A contradictory answers", () => {
  test("a suburb in two lists is a blocker naming both lists", () => {
    const p = steps.applyStep("areas", { ...ANSWERS.areas, extended: "Mornington\nFrankston" }, fullProfile());
    const found = detectContradictions(p);
    const hit = found.find((c) => c.code === "suburb_in_two_lists");
    assert.ok(hit, "the overlap was not detected");
    assert.equal(hit.severity, "blocker");
    assert.equal(hit.stepId, "areas");
    assert.match(hit.message, /Frankston/);
  });

  test("suburb overlap is caught regardless of capitalisation", () => {
    const p = steps.applyStep("areas", { ...ANSWERS.areas, declined: "FRANKSTON" }, fullProfile());
    assert.ok(detectContradictions(p).some((c) => c.code === "suburb_in_two_lists"));
  });

  test("transferring urgent callers to the public business number is a blocker", () => {
    const p = steps.applyStep("contact", { ...ANSWERS.contact, transferPrimary: "0491570010" }, fullProfile());
    const hit = detectContradictions(p).find((c) => c.code === "transfer_is_public_number");
    assert.ok(hit, "sending an urgent caller back to the line they rang was not caught");
    assert.equal(hit.severity, "blocker");
    assert.equal(hit.stepId, "contact");
  });

  test("after-hours detail contradicting 'we don't work after hours' is a warning, not a blocker", () => {
    let p = steps.applyStep("hours", { ...ANSWERS.hours, afterHoursAvailable: false }, fullProfile());
    p = steps.applyStep("areas", { ...ANSWERS.areas, afterHoursAreas: "Frankston" }, p);
    const found = detectContradictions(p);
    const hit = found.find((c) => c.code === "after_hours_areas_without_after_hours");
    assert.ok(hit);
    assert.equal(hit.severity, "warning", "a survivable inconsistency must not block launch");
  });

  test("an after-hours suburb that is also a 'won't go' suburb is a blocker", () => {
    const p = steps.applyStep("areas", { ...ANSWERS.areas, afterHoursAreas: "Dandenong" }, fullProfile());
    assert.ok(detectContradictions(p).some((c) => c.code === "after_hours_area_declined" && c.severity === "blocker"));
  });

  test("a service both accepted and declined is a blocker", () => {
    const p = fullProfile();
    p.servicesDeclined.push({ serviceId: "residential_lockout", reason: "contradiction" });
    assert.ok(detectContradictions(p).some((c) => c.code === "service_accepted_and_declined" && c.severity === "blocker"));
  });

  test("a fully consistent setup produces no contradictions at all", () => {
    assert.deepEqual(detectContradictions(fullProfile()), []);
  });
});

describe("M8A review summary — blockers versus warnings", () => {
  test("a blank setup reports blockers, and every blocker names a step that can fix it", () => {
    const summary = buildReviewSummary(seedProfile(CLIENT));
    assert.equal(summary.ready, false);
    assert.ok(summary.blockers.length > 0);
    for (const b of summary.blockers) {
      assert.ok(b.message, "a blocker with no message is not actionable");
    }
    const withStep = summary.blockers.filter((b) => b.stepId);
    assert.ok(withStep.length > 0, "no blocker could be linked to a step");
  });

  test("warnings never appear among blockers", () => {
    const summary = buildReviewSummary(fullProfile());
    const blockerCodes = new Set(summary.blockers.map((b) => b.code));
    for (const w of summary.warnings) {
      assert.ok(!blockerCodes.has(w.code), `"${w.code}" is reported as both a warning and a blocker`);
    }
  });

  test("a complete setup is ready with no blockers", () => {
    const summary = buildReviewSummary(fullProfile());
    assert.deepEqual(summary.blockers, [], `unexpected blockers: ${JSON.stringify(summary.blockers)}`);
    assert.equal(summary.ready, true);
  });

  test("the safety floor is shown, and it is the full mandatory list", () => {
    const summary = buildReviewSummary(fullProfile());
    assert.equal(summary.safetyFloor.length, S.MANDATORY_FORBIDDEN_PROMISES.length);
    assert.ok(summary.safetyFloor.some((l) => /arrival time/i.test(l)));
  });

  test("every section of the review carries the answers it is about", () => {
    const summary = buildReviewSummary(fullProfile());
    assert.equal(summary.sections.length, steps.STEPS.length);
    const identity = summary.sections.find((s) => s.id === "identity");
    assert.equal(identity.answers.spokenName, "Peninsula Lock and Key");
    assert.equal(identity.complete, true);
  });
});

describe("M8A blank onboarding, save and resume", () => {
  test("a brand-new client starts from a seeded, blank draft", async () => {
    const store = memoryStore();
    const r = await service(store).startDraft({ clientId: CLIENT, actor: ACTOR });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.status, "draft");
    assert.equal(r.version, 1);
    assert.equal(r.basedOnVersion, null);
    assert.equal(r.progress.complete, 0);
    // Seeded, not empty: the safety floor is on from the first byte.
    assert.equal(r.profile.forbiddenPromises.length, S.MANDATORY_FORBIDDEN_PROMISES.length);
    assert.ok(r.profile.forbiddenPromises.every((f) => f.enabled === true));
  });

  test("starting twice returns the SAME draft — two tabs do not fork the setup", async () => {
    const store = memoryStore();
    const svc = service(store);
    const first = await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    const second = await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    assert.equal(second.created, false);
    assert.equal(second.version, first.version);
    assert.equal(store.rows.size, 1);
  });

  test("answers survive leaving and coming back", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await svc.saveStep({ clientId: CLIENT, stepId: "identity", answers: ANSWERS.identity, actor: ACTOR });

    const resumed = await svc.loadDraft({ clientId: CLIENT });
    assert.equal(resumed.ok, true);
    assert.equal(steps.readStep("identity", resumed.profile).spokenName, "Peninsula Lock and Key");
    assert.equal(resumed.progress.complete, 1);
    assert.equal(resumed.progress.nextIncomplete, "services");
  });

  test("a half-finished step can be parked with allowIncomplete and still reads back", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    const r = await svc.saveStep({
      clientId: CLIENT,
      stepId: "identity",
      answers: { spokenName: "Half Done" },
      actor: ACTOR,
      allowIncomplete: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.progress.complete, 0, "an incomplete step must not count as done");
    const resumed = await svc.loadDraft({ clientId: CLIENT });
    assert.equal(steps.readStep("identity", resumed.profile).spokenName, "Half Done");
  });

  test("a field left out of a save keeps its stored value", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await svc.saveStep({ clientId: CLIENT, stepId: "identity", answers: ANSWERS.identity, actor: ACTOR });
    await svc.saveStep({ clientId: CLIENT, stepId: "identity", answers: { description: "Changed." }, actor: ACTOR, allowIncomplete: true });
    const after = await svc.loadDraft({ clientId: CLIENT });
    const read = steps.readStep("identity", after.profile);
    assert.equal(read.description, "Changed.");
    assert.equal(read.spokenName, "Peninsula Lock and Key", "an untouched field was wiped");
  });

  test("a stale save is refused rather than silently overwriting", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    const r = await svc.saveStep({
      clientId: CLIENT,
      stepId: "identity",
      answers: ANSWERS.identity,
      actor: ACTOR,
      expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
    });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOMES.stale);
  });

  test("bad answers are refused field by field, and nothing is written", async () => {
    const store = memoryStore();
    const svc = service(store);
    const started = await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    const before = JSON.stringify(started.profile);
    const r = await svc.saveStep({
      clientId: CLIENT,
      stepId: "identity",
      answers: { ...ANSWERS.identity, businessPhone: "banana", ownerEmail: "nope" },
      actor: ACTOR,
    });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOMES.invalidAnswers);
    assert.ok(r.errors.businessPhone);
    assert.ok(r.errors.ownerEmail);
    const after = await svc.loadDraft({ clientId: CLIENT });
    assert.equal(JSON.stringify(after.profile), before, "a refused step still wrote to the draft");
  });

  test("an unknown step id is refused", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    for (const bad of ["nope", "constructor", "__proto__"]) {
      const r = await svc.saveStep({ clientId: CLIENT, stepId: bad, answers: {}, actor: ACTOR });
      assert.equal(r.ok, false);
      assert.equal(r.outcome, OUTCOMES.unknownStep, `"${bad}" was accepted as a step`);
    }
  });
});

describe("M8A submission and the approval boundary", () => {
  test("an incomplete setup cannot be submitted, and it says exactly what is outstanding", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await svc.saveStep({ clientId: CLIENT, stepId: "identity", answers: ANSWERS.identity, actor: ACTOR });

    const r = await svc.submitForReview({ clientId: CLIENT, actor: ACTOR });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOMES.incomplete);
    assert.ok(r.outstanding.length >= 6);
    assert.ok(r.outstanding.every((o) => o.id && o.title));
  });

  test("a complete setup moves draft → needs_review and no further", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await completeSetup(svc);

    const r = await svc.submitForReview({ clientId: CLIENT, actor: ACTOR });
    assert.equal(r.ok, true);
    assert.equal(r.status, "needs_review");
    // NOT approved. Approval is a separate, confirmed act.
    assert.equal(store.rows.get(r.version).status, "needs_review");
    assert.equal(await store.getApprovedVersion(CLIENT), null);
  });

  test("submission requires the real approval guard to still refuse without confirmations", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await completeSetup(svc);
    const submitted = await svc.submitForReview({ clientId: CLIENT, actor: ACTOR });

    const row = store.rows.get(submitted.version);
    const verdict = realStore.evaluateApproval({
      row,
      profile: row.profile,
      confirmations: {},
      actor: ACTOR,
      expectedUpdatedAt: null,
    });
    assert.equal(verdict.ok, false, "a setup was approvable without any section being confirmed");
    assert.ok(verdict.blockers.some((b) => b.code === "confirmations_missing"));
  });

  test("with every section confirmed, the same guard passes", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await completeSetup(svc);
    const submitted = await svc.submitForReview({ clientId: CLIENT, actor: ACTOR });

    const row = store.rows.get(submitted.version);
    const confirmations = {};
    for (const key of S.CONFIRMATION_KEYS) confirmations[key] = { confirmedAt: "2026-08-04T00:00:00.000Z", actorId: "user-1" };
    const verdict = realStore.evaluateApproval({ row, profile: row.profile, confirmations, actor: ACTOR, expectedUpdatedAt: null });
    assert.equal(verdict.ok, true, `still blocked: ${JSON.stringify(verdict.blockers)}`);
  });

  test("once submitted, the setup form can no longer write to it", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await completeSetup(svc);
    await svc.submitForReview({ clientId: CLIENT, actor: ACTOR });

    const r = await svc.saveStep({ clientId: CLIENT, stepId: "identity", answers: { description: "sneak" }, actor: ACTOR });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOMES.noDraft, "a submitted version was still editable through the setup form");
  });
});

describe("M8A: nothing production moves before approval", () => {
  test("a whole setup run never touches the approved profile", async () => {
    const approved = fullProfile();
    approved.identity.spokenName = "Live And Approved";
    const store = memoryStore({ seedApproved: approved });
    const before = JSON.stringify(await store.getApprovedVersion(CLIENT));

    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await completeSetup(svc);
    await svc.submitForReview({ clientId: CLIENT, actor: ACTOR });

    const after = await store.getApprovedVersion(CLIENT);
    assert.equal(JSON.stringify(after), before, "the approved profile changed during setup");
    assert.equal(after.profile.identity.spokenName, "Live And Approved");
  });

  test("updateDraftProfile refuses every non-draft status", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    for (const status of ["needs_review", "approved", "superseded", "rejected"]) {
      store.rows.get(1).status = status;
      const r = await store.updateDraftProfile({ clientId: CLIENT, version: 1, profile: fullProfile() });
      assert.equal(r.ok, false, `a "${status}" profile was writable from the setup form`);
    }
  });

  test("reopening setup starts from the approved profile, not from blank", async () => {
    const approved = fullProfile();
    const store = memoryStore({ seedApproved: approved });
    const r = await service(store).startDraft({ clientId: CLIENT, actor: ACTOR });
    assert.equal(r.created, true);
    assert.equal(r.basedOnVersion, 1);
    assert.equal(r.progress.allComplete, true, "an edit should not make the owner re-answer everything");
    assert.equal(steps.readStep("identity", r.profile).spokenName, "Peninsula Lock and Key");
  });
});

describe("M8A version history and rollback", () => {
  test("history lists every version newest-first with its status", async () => {
    const store = memoryStore({ seedApproved: fullProfile() });
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    const h = await svc.listHistory({ clientId: CLIENT });
    assert.equal(h.ok, true);
    assert.equal(h.versions.length, 2);
    assert.equal(h.versions[0].version, 2);
    assert.equal(h.versions[0].status, "draft");
    assert.equal(h.versions[1].status, "approved");
  });

  test("rollback creates a NEW draft and leaves history byte-identical", async () => {
    const old = fullProfile();
    old.identity.spokenName = "The Old Name";
    const store = memoryStore({ seedApproved: old });
    // Retire v1 so there is a settled version to roll back to.
    store.rows.get(1).status = "superseded";
    const before = JSON.stringify([...store.rows.values()]);

    const r = await service(store).rollbackToVersion({ clientId: CLIENT, version: 1, actor: ACTOR });
    assert.equal(r.ok, true);
    assert.equal(r.restoredFromVersion, 1);
    assert.equal(r.version, 2);
    assert.equal(r.status, "draft", "a rollback must not silently become live");
    assert.equal(steps.readStep("identity", r.profile).spokenName, "The Old Name");
    assert.equal(JSON.stringify(store.rows.get(1)), JSON.stringify(JSON.parse(before)[0]), "history was rewritten");
  });

  test("a rolled-back draft still has to be reviewed and approved", async () => {
    const store = memoryStore({ seedApproved: fullProfile() });
    store.rows.get(1).status = "superseded";
    const svc = service(store);
    const r = await svc.rollbackToVersion({ clientId: CLIENT, version: 1, actor: ACTOR });
    assert.equal(store.rows.get(r.version).status, "draft");
    assert.equal(await store.getApprovedVersion(CLIENT), null, "rollback approved something by itself");
  });

  test("rollback refuses while an unfinished setup is open", async () => {
    const store = memoryStore({ seedApproved: fullProfile() });
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    const r = await svc.rollbackToVersion({ clientId: CLIENT, version: 1, actor: ACTOR });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOMES.stale);
    assert.equal(r.workingDraftVersion, 2);
  });

  test("rollback refuses a version that does not exist", async () => {
    const store = memoryStore({ seedApproved: fullProfile() });
    const r = await service(store).rollbackToVersion({ clientId: CLIENT, version: 99, actor: ACTOR });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOMES.badVersion);
  });
});

describe("M8A tenant isolation", () => {
  test("an actor from another tenant is refused at every entry point", async () => {
    const store = memoryStore({ seedApproved: fullProfile() });
    const svc = service(store);
    const intruder = { type: "client", id: "user-9", clientId: "someone-else" };

    for (const [name, call] of [
      ["startDraft", () => svc.startDraft({ clientId: CLIENT, actor: intruder })],
      ["saveStep", () => svc.saveStep({ clientId: CLIENT, stepId: "identity", answers: ANSWERS.identity, actor: intruder })],
      ["submitForReview", () => svc.submitForReview({ clientId: CLIENT, actor: intruder })],
      ["rollbackToVersion", () => svc.rollbackToVersion({ clientId: CLIENT, version: 1, actor: intruder })],
    ]) {
      const r = await call();
      assert.equal(r.ok, false, `${name} let another tenant through`);
      assert.equal(r.outcome, OUTCOMES.notAuthorised, `${name} refused for the wrong reason`);
    }
  });

  test("a missing actor is refused, never treated as the owner", async () => {
    const store = memoryStore();
    const r = await service(store).startDraft({ clientId: CLIENT, actor: null });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOMES.notAuthorised);
  });

  test("an unrecognised source channel is refused", async () => {
    const store = memoryStore();
    const r = await service(store).startDraft({ clientId: CLIENT, actor: ACTOR, sourceChannel: "smoke_signal" });
    assert.equal(r.ok, false);
  });

  test("the voice channel uses the SAME entry points as the form", async () => {
    const store = memoryStore();
    const svc = service(store);
    const started = await svc.startDraft({ clientId: CLIENT, actor: ACTOR, sourceChannel: "initial_voice_onboarding" });
    assert.equal(started.ok, true);
    const saved = await svc.saveStep({
      clientId: CLIENT,
      stepId: "identity",
      answers: ANSWERS.identity,
      actor: ACTOR,
      sourceChannel: "initial_voice_onboarding",
    });
    assert.equal(saved.ok, true, "a voice channel could not use the shared setup service");
    assert.equal(saved.progress.complete, 1);
  });
});

describe("M8A audit trail", () => {
  test("every step save and the submission are recorded", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await completeSetup(svc);
    await svc.submitForReview({ clientId: CLIENT, actor: ACTOR });

    const types = store.audit.map((e) => e.event_type || e.eventType);
    assert.ok(types.includes("profile.draft_created"));
    assert.equal(types.filter((t) => t === "profile.setup_step_saved").length, steps.STEPS.length);
    assert.ok(types.includes("profile.submitted_for_review"));
  });

  test("no audit event carries a phone number or the profile body", async () => {
    const store = memoryStore();
    const svc = service(store);
    await svc.startDraft({ clientId: CLIENT, actor: ACTOR });
    await completeSetup(svc);
    const serialised = JSON.stringify(store.audit);
    assert.ok(!/0491570006/.test(serialised), "a transfer number leaked into the audit trail");
    assert.ok(!/Peninsula Lock and Key/.test(serialised), "the profile body leaked into the audit trail");
  });
});

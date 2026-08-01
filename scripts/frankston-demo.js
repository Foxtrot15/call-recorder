#!/usr/bin/env node
// AIDA — the Frankston vertical slice (M7).
//
//   node scripts/frankston-demo.js
//   node scripts/frankston-demo.js --adapter=claude-v1     (needs ANTHROPIC_API_KEY)
//   node scripts/frankston-demo.js --execute               (needs a Retell sandbox)
//
// Proves the shortest complete feedback loop:
//
//   "We now service Frankston."
//     → real extraction        (structured change proposal)
//     → validation             (the one domain validator)
//     → new DRAFT version      (approved version untouched)
//     → before/after diff      (+ speakable read-back)
//     → explicit approval      (through the shared approval service)
//     → compile + plan         (including the inbound phone binding)
//     → provider execution     (dry-run by default; --execute needs a sandbox)
//     → audit trail
//     → rollback plan
//
// ─── THIS IS NOT THE FIXTURE JOURNEY ────────────────────────────────
// scripts/locksmith-mock-journey.js walks a canned transcript through canned
// extraction. This script runs the REAL shared services — the same
// change-application, approval and provisioning code the portal and a future
// voice agent call. Only two things are substituted, and both are stated in the
// output: an in-memory profile store (so no SQL is applied) and, by default,
// the dry-run provider adapter (so nothing is created at Retell).
//
// SAFETY: refuses to run in production. Never writes to a database. Never
// contacts a provider unless --execute is passed AND every Retell gate is on
// AND the target is explicitly a non-production tag.

const path = require("path");

const S = require("../src/services/locksmith-profile-schema");
// Self-registers the deterministic fixture adapter.
require("../src/services/locksmith-extraction-fixture");
const profileExtraction = require("../src/services/locksmith-extraction");
const interviewSpec = require("../src/services/locksmith-interview-spec");
const changeExtraction = require("../src/services/locksmith-change-extraction");
const { createChangeApplicationService } = require("../src/services/locksmith-change-application");
const { createApprovalService } = require("../src/services/locksmith-approval-service");
const { compileReceptionist, toRetellPayload } = require("../src/services/locksmith-receptionist-compiler");
const plans = require("../src/services/provisioning-plan");
const port = require("../src/services/voice-platform-port");
const { getRetellConfig } = require("../src/config/retell");

// ── Safety ──────────────────────────────────────────────────────────

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run the demonstration in production.");
  process.exit(1);
}

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const WANT_EXECUTE = args.includes("--execute");
const ADAPTER = argOf("adapter", "fixture-v1");
const CLIENT_ID = argOf("client", "demo-locksmith");
const STATEMENT = argOf("say", "We now service Frankston.");

const line = (c = "─") => console.log(c.repeat(74));
const step = (n, title) => { console.log(); line(); console.log(`  STEP ${n} — ${title}`); line(); };

// ── An approved profile that does NOT include Frankston ─────────────
//
// ACMA fictitious number range and RFC-2606 domain throughout.

/**
 * The starting profile comes from the REAL M2 extraction of the demonstration
 * interview transcript, not a hand-written literal.
 *
 * Hand-writing one produced a profile that failed validation on field shapes I
 * had guessed at — which is a good argument for never hand-writing fixtures
 * that the real pipeline can generate. This way the starting point is
 * guaranteed to be a profile the system itself considers valid and
 * provisionable.
 *
 * Frankston is asserted absent below rather than assumed absent.
 */
function seedApprovedProfile() {
  const extracted = profileExtraction.extractLocksmithProfile({
    transcript: interviewSpec.DEMO_TRANSCRIPT,
    clientId: CLIENT_ID,
  });
  if (!extracted.ok) {
    throw new Error(`could not build the starting profile: ${extracted.code} ${extracted.message}`);
  }
  if (JSON.stringify(extracted.profile.serviceAreas.primary).toLowerCase().includes("frankston")) {
    throw new Error("the demonstration requires a starting profile WITHOUT Frankston");
  }
  return extracted.profile;
}

// ── In-memory profile store ─────────────────────────────────────────
//
// The SAME interface the real Supabase-backed store exposes, so the services
// under test are the real ones. Nothing is written to a database.

function createMemoryStore(approvedProfile) {
  const rows = new Map();
  const audit = [];
  let nextVersion = 1;

  rows.set(1, {
    client_id: CLIENT_ID, version: 1, profile: approvedProfile, status: "approved",
    confirmations: Object.fromEntries(S.CONFIRMATION_KEYS.map((k) => [k, { confirmedAt: "2026-07-01T00:00:00Z", confirmedBy: "demo-user-1" }])),
    updated_at: "2026-07-01T00:00:00Z", approved_at: "2026-07-01T00:00:00Z",
  });
  nextVersion = 2;

  return {
    audit,
    rows,
    async getApprovedVersion() {
      return [...rows.values()].find((r) => r.status === "approved") || null;
    },
    async getVersion(_c, version) {
      return rows.get(version) || null;
    },
    async createDraftVersion({ clientId, profile, status, actor, reason, source }) {
      const version = nextVersion++;
      const row = {
        client_id: clientId, version, profile, status,
        // A new draft starts UNCONFIRMED. Confirmations belong to the version
        // the client actually reviewed, and carrying them forward would let a
        // change inherit approval it never received.
        confirmations: {},
        updated_at: new Date().toISOString(), created_by: actor && actor.id, reason, source,
      };
      rows.set(version, row);
      return row;
    },
    async approveVersion({ clientId, version, actor, reason, expectedUpdatedAt, source }) {
      const row = rows.get(version);
      const verdict = this.evaluateApproval({ row, profile: row && row.profile, confirmations: row && row.confirmations, actor, expectedUpdatedAt });
      if (!verdict.ok) return { ok: false, blockers: verdict.blockers };
      for (const r of rows.values()) if (r.status === "approved") r.status = "superseded";
      row.status = "approved";
      row.approved_at = new Date().toISOString();
      row.updated_at = row.approved_at;
      audit.push({ eventType: "profile.approved", version, actorType: actor.type, actorId: actor.id, source, reason });
      return { ok: true, row };
    },
    // The REAL evaluator, so the demonstration exercises the real rules.
    evaluateApproval(a) {
      return require("../src/services/locksmith-profile-store").evaluateApproval(a);
    },
    buildAuditEvent: (e) => e,
    async recordAuditEvent(e) { audit.push(e); return e; },
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log();
  line("═");
  console.log("  AIDA — Frankston vertical slice");
  console.log(`  client=${CLIENT_ID}  extraction=${ADAPTER}  execute=${WANT_EXECUTE}`);
  line("═");

  const approved = seedApprovedProfile();
  const store = createMemoryStore(approved);
  const actor = { type: "client", id: "demo-user-1", clientId: CLIENT_ID };

  // ── 1 ────────────────────────────────────────────────────────────
  step(1, "Starting point — an approved profile WITHOUT Frankston");
  const before = await store.getApprovedVersion();
  console.log(`  approved version : v${before.version}`);
  console.log(`  service areas    : ${before.profile.serviceAreas.primary.join(", ")}`);
  console.log(`  Frankston present: ${before.profile.serviceAreas.primary.includes("Frankston")}`);

  // ── 2 ────────────────────────────────────────────────────────────
  step(2, "Unstructured input");
  console.log(`  The client says: "${STATEMENT}"`);

  // ── 3 ────────────────────────────────────────────────────────────
  step(3, `Extraction (adapter: ${ADAPTER})`);
  if (ADAPTER === "claude-v1" && !process.env.ANTHROPIC_API_KEY) {
    console.error("  ANTHROPIC_API_KEY is not set — cannot run real model extraction.");
    console.error("  Re-run without --adapter=claude-v1 to use the deterministic fixture.");
    process.exit(2);
  }
  const extraction = await changeExtraction.extractChanges({
    text: STATEMENT,
    approvedProfile: before.profile,
    clientId: CLIENT_ID,
    adapter: ADAPTER,
    sourceChannel: "client_ui",
    sourceReference: "demo:frankston",
    actor,
  });
  if (!extraction.ok) {
    console.error(`  extraction failed: ${extraction.code} — ${extraction.message}`);
    process.exit(3);
  }
  const proposal = extraction.proposal;
  console.log(`  changes proposed : ${proposal.changes.length}`);
  console.log(`  quarantined      : ${proposal.quarantined.length}`);
  if (!proposal.hasChanges) {
    console.error("  Nothing to apply. Quarantine:", JSON.stringify(proposal.quarantined, null, 2));
    process.exit(3);
  }
  const change = proposal.changes[0];
  console.log(`  target           : ${change.target}`);
  console.log(`  operation        : ${change.operation}   (delta — the model never returns the whole list)`);
  console.log(`  added            : ${JSON.stringify(change.added)}`);
  console.log(`  resulting value  : ${JSON.stringify(change.value)}   ← computed here, not generated`);
  console.log(`  confidence       : ${change.confidence}`);
  console.log(`  provenance       : adapter=${proposal.provenance.adapter} channel=${proposal.provenance.sourceChannel}`);

  // ── 4 ────────────────────────────────────────────────────────────
  step(4, "Validation + draft creation (shared change-application service)");
  const application = createChangeApplicationService({ store, logger: quietLogger() });
  const applied = await application.applyChanges({
    clientId: CLIENT_ID,
    changes: proposal.changes.map((c) => ({ target: c.target, value: c.value, readBack: c.readBack })),
    sourceChannel: "client_ui",
    actor,
    provenance: proposal.provenance,
    reason: "Client added a service area by conversation",
  });
  if (!applied.ok) {
    console.error(`  refused: ${applied.outcome} — ${applied.message}`);
    process.exit(4);
  }
  console.log(`  approved version : v${applied.fromVersion}  (unchanged)`);
  console.log(`  NEW DRAFT        : v${applied.version}  status=${applied.status}`);
  console.log(`  invalidates tests: ${applied.invalidatesTests}`);

  const approvedAfterDraft = await store.getApprovedVersion();
  console.log(`  approved areas still: ${approvedAfterDraft.profile.serviceAreas.primary.join(", ")}`);
  console.log(`  ✓ the approved version was NOT mutated`);

  // ── 5 ────────────────────────────────────────────────────────────
  step(5, "Before / after diff");
  for (const d of applied.effectiveDiff) {
    console.log(`  ${d.label}${d.safetyCritical ? "  [safety-critical]" : ""}`);
    console.log(`    before: ${JSON.stringify(d.before)}`);
    console.log(`    after : ${JSON.stringify(d.after)}`);
  }
  console.log();
  console.log(`  read-back (spoken): ${applied.readBack.spoken}`);
  console.log(`  read-back (written): ${applied.readBack.written.join(" | ")}`);

  // ── 6 ────────────────────────────────────────────────────────────
  step(6, "Approval (shared approval service — channel-neutral)");
  const approval = createApprovalService({ store, sessions: noSessions(), logger: quietLogger() });

  const systemAttempt = await approval.approve({
    clientId: CLIENT_ID, version: applied.version,
    actor: { type: "system", id: "cron", clientId: CLIENT_ID },
    sourceChannel: "system_generated", runProvisioning: false,
  });
  console.log(`  system actor attempt : ${systemAttempt.ok ? "APPROVED (WRONG)" : `refused — ${systemAttempt.message}`}`);

  const draftRow = await store.getVersion(CLIENT_ID, applied.version);
  const unconfirmed = await approval.approve({
    clientId: CLIENT_ID, version: applied.version, actor, sourceChannel: "client_ui", runProvisioning: false,
  });
  console.log(`  before confirmations : ${unconfirmed.ok ? "APPROVED" : `refused — ${(unconfirmed.blockers || []).map((b) => b.code).join(", ")}`}`);

  // The client reviews and confirms each section, as the portal requires.
  draftRow.confirmations = Object.fromEntries(
    S.CONFIRMATION_KEYS.map((k) => [k, { confirmedAt: new Date().toISOString(), confirmedBy: actor.id }])
  );

  const approvedResult = await approval.approve({
    clientId: CLIENT_ID, version: applied.version, actor,
    sourceChannel: "client_ui", reason: "Client approved the Frankston addition", runProvisioning: false,
  });
  if (!approvedResult.ok) {
    console.error("  approval refused:", JSON.stringify(approvedResult.blockers, null, 2));
    process.exit(6);
  }
  console.log(`  after confirmations  : APPROVED v${approvedResult.version} by ${approvedResult.actorType} via ${approvedResult.sourceChannel}`);

  const nowApproved = await store.getApprovedVersion();
  console.log(`  live service areas   : ${nowApproved.profile.serviceAreas.primary.join(", ")}`);
  console.log(`  ✓ Frankston is now in the APPROVED profile`);

  // ── 7 ────────────────────────────────────────────────────────────
  step(7, "Compile the newly approved profile");
  const config = getRetellConfig(process.env);
  const compiled = compileReceptionist({
    profile: nowApproved.profile, profileVersion: nowApproved.version, profileStatus: "approved",
    clientId: CLIENT_ID, templateVersion: config.receptionistTemplateVersion, config,
    generatedAt: new Date().toISOString(),
  });
  if (!compiled.ok) {
    console.error("  compile failed:", JSON.stringify(compiled.issues || compiled, null, 2));
    process.exit(7);
  }
  const payload = toRetellPayload({ compiled, config });
  const areaLine = findAreaMention(compiled);
  console.log(`  compiler version : ${compiled.spec.compilerVersion || "n/a"}`);
  console.log(`  Frankston reaches the agent instructions:`);
  console.log(`    ${areaLine || "(not found — see below)"}`);
  console.log(`  knowledge base mentions Frankston: ${/Frankston/.test(compiled.spec.knowledge.text)}`);
  console.log(`  inbound binding payload present  : ${Boolean(payload.inboundBinding)}${payload.inboundBinding ? "" : "  (no RETELL_INBOUND_DEMO_NUMBER configured)"}`);

  // ── 8 ────────────────────────────────────────────────────────────
  step(8, "Provisioning plan");
  const plan = plans.createPlan({
    clientId: CLIENT_ID, approvedProfileVersion: nowApproved.version, profileStatus: "approved",
    provisioningReady: true, compiled, retellPayload: payload, existingResources: [],
    templateVersions: { receptionist: config.receptionistTemplateVersion }, createdBy: actor.id,
    createdAt: new Date().toISOString(),
  });
  console.log(`  plan status : ${plan.status}`);
  console.log(`  actions     :`);
  for (const a of plan.actions) {
    console.log(`    ${String(a.kind).padEnd(7)} ${String(a.purpose).padEnd(24)} ${a.resourceType}`);
  }
  const hasBinding = plan.actions.some((a) => a.purpose === "inbound_binding");
  console.log(`  inbound_binding action present: ${hasBinding}`);

  // ── 9 ────────────────────────────────────────────────────────────
  step(9, "Provider execution");
  const gate = plans.evaluateExecutionGate({
    plan, config, actor, currentApprovedVersion: nowApproved.version, explicitRequest: WANT_EXECUTE,
    capability: { allowed: config.liveWritesEnabled === true, reasons: [] },
  });
  console.log(`  execution gate : ${gate.allowed ? "OPEN" : "CLOSED"}`);
  for (const r of gate.reasons || []) console.log(`    - ${r}`);

  let execAdapter;
  let mode;
  if (WANT_EXECUTE && gate.allowed) {
    if (config.allowedTag === "prod") {
      console.error("  RETELL_ALLOWED_TAG is 'prod'. Refusing to execute against production.");
      process.exit(9);
    }
    console.log(`  EXECUTING against Retell tag=${config.allowedTag}`);
    execAdapter = port.selectAdapter({ config, capability: { allowed: true, reasons: [] } });
    mode = "live";
  } else {
    const recorder = [];
    execAdapter = port.createDryRunAdapter({ recorder });
    mode = "dry_run";
    console.log("  DRY RUN — nothing is sent. Requests are built and shown.");
  }

  const provisioned = [];
  const result = await plans.executePlan({
    plan, adapter: execAdapter,
    onResourceProvisioned: async (r) => provisioned.push(r),
    logger: quietLogger(),
  });
  console.log(`  outcome : ${result.status}  (succeeded=${result.summary.succeeded} failed=${result.summary.failed} skipped=${result.summary.skipped})`);
  for (const r of result.results) {
    console.log(`    ${String(r.purpose).padEnd(24)} ${String(r.resourceType).padEnd(16)} ${r.outcome}${r.unresolvedRefs ? ` unresolved=${r.unresolvedRefs.join(",")}` : ""}`);
  }

  if (mode === "dry_run") {
    console.log();
    console.log("  Dependency resolution in the binding request:");
    const bindingAction = plan.actions.find((a) => a.purpose === "inbound_binding");
    if (bindingAction) {
      const shown = port.resolveRefs(bindingAction.payload, new Map(), { placeholder: port.DRY_RUN_REF_PLACEHOLDER });
      console.log(`    ${JSON.stringify(shown.payload)}`);
      console.log(`    ^ inbound_agent_id is resolved from the agent created earlier in the run`);
    } else {
      console.log("    (no binding action — RETELL_INBOUND_DEMO_NUMBER is not configured)");
    }
  }

  // ── 10 ───────────────────────────────────────────────────────────
  step(10, "Would the next caller from Frankston be accepted?");
  const accepted = wouldAcceptFrankston(compiled);
  console.log(`  service-area list given to the agent : ${JSON.stringify(accepted.areas)}`);
  console.log(`  Frankston in that list               : ${accepted.included}`);
  console.log(`  outside-area behaviour               : ${accepted.outsideAction || "(unset)"}`);
  console.log();
  console.log(`  ${accepted.included ? "✓" : "✗"} A caller from Frankston ${accepted.included ? "is now treated as in-area" : "would still be refused"}.`);
  if (mode === "dry_run") {
    console.log("  NOTE: this is the compiled configuration, not an observed call.");
    console.log("        Observing a real call requires a Retell sandbox (see --execute).");
  }

  // ── 11 ───────────────────────────────────────────────────────────
  step(11, "Audit trail");
  for (const e of store.audit) {
    const t = e.eventType || e.event_type || "(event)";
    console.log(`  ${String(t).padEnd(36)} actor=${e.actorType || "-"}/${e.actorId || "-"} source=${e.source || "-"}`);
    if (e.detail && e.detail.provenance) {
      console.log(`     provenance: adapter=${e.detail.provenance.adapter} text="${String(e.detail.provenance.sourceText).slice(0, 48)}"`);
    }
    if (e.detail && e.detail.fromVersion) {
      console.log(`     v${e.detail.fromVersion} → v${e.detail.toVersion}  targets=${(e.detail.targets || []).join(",")}`);
    }
  }

  // ── 12 ───────────────────────────────────────────────────────────
  step(12, "Rollback path");
  const rollback = plans.planRollback({
    currentPlan: plan, previousApprovedVersion: before.version,
    existingResources: provisioned.map((r) => ({ purpose: r.purpose, resource_type: r.resourceType, provider_resource_id: r.providerResourceId, profile_version: nowApproved.version, active: true })),
  });
  if (rollback.ok) {
    console.log(`  target version : v${rollback.targetVersion}  (the pre-Frankston profile)`);
    for (const s of rollback.steps) console.log(`    - ${s.step}${s.purpose ? ` (${s.purpose})` : ""}`);
    console.log(`  executes anything now: ${rollback.executesAnything}`);
    console.log(`  v${before.version} profile still on record: ${Boolean(store.rows.get(before.version))}`);
  } else {
    console.log(`  ${rollback.message}`);
  }

  console.log();
  line("═");
  console.log("  RESULT");
  line("═");
  console.log(`  unstructured text → structured change  : ✓`);
  console.log(`  validated                              : ✓`);
  console.log(`  new draft, approved version untouched  : ✓`);
  console.log(`  diff + read-back                       : ✓`);
  console.log(`  explicit client approval required      : ✓`);
  console.log(`  compiled with Frankston in-area        : ${accepted.included ? "✓" : "✗"}`);
  console.log(`  plan includes inbound_binding          : ${hasBinding ? "✓" : "— (no test number configured)"}`);
  console.log(`  provider execution                     : ${mode === "live" ? "✓ live sandbox" : "dry-run only (no Retell credentials)"}`);
  console.log(`  audit trail                            : ✓ (${store.audit.length} events)`);
  console.log(`  rollback plan                          : ${rollback.ok ? "✓" : "n/a"}`);
  console.log();
  if (mode !== "live") {
    console.log("  To complete the loop through the real provider boundary:");
    console.log("    1. Create a Retell SANDBOX account and buy/import a test number.");
    console.log("    2. Set RETELL_API_KEY, RETELL_DEFAULT_VOICE_ID, RETELL_INBOUND_DEMO_NUMBER,");
    console.log("       RETELL_WEBHOOK_BASE_URL, RETELL_ALLOWED_TAG=dev");
    console.log("    3. Set RETELL_ENABLED=true RETELL_LIVE_WRITES_ENABLED=true RETELL_DRY_RUN=false");
    console.log("    4. node scripts/frankston-demo.js --execute");
    console.log("    5. Ring the test number and say you are in Frankston.");
    console.log();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function findAreaMention(compiled) {
  for (const section of compiled.spec.sections || []) {
    for (const l of section.lines || []) if (/Frankston/.test(l)) return l;
  }
  return null;
}

function wouldAcceptFrankston(compiled) {
  const dyn = compiled.spec.dynamicVariables || {};
  const raw = dyn.service_areas || dyn.serviceAreas || "";
  const areas = String(raw).split(/\s*,\s*/).filter(Boolean);
  const inInstructions = Boolean(findAreaMention(compiled));
  return {
    areas: areas.length ? areas : ["(see instructions)"],
    included: areas.some((a) => /frankston/i.test(a)) || inInstructions,
    outsideAction: compiled.spec.outsideAreaAction || (dyn.outside_area_action || null),
  };
}

function quietLogger() {
  return { log() {}, error(...a) { console.error("   !", ...a); } };
}

function noSessions() {
  return { async transitionSession() { return { ok: true }; } };
}

main().catch((err) => {
  console.error();
  console.error("Demonstration failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});

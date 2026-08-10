// ============================================================================
// M8J / E-2 LIFECYCLE PROOF — the round trip.
//
// RUN ONCE, against dev, on 2026-08-09, under explicit founder approval. The
// approved residue is spent: `pr_3740207ebbc0a379910f` went 0 -> 2 history
// entries and its `updated_at` moved to 2026-08-09T00:36:42.287+00:00, with the
// lifecycle back at `review_approved` where it started.
//
// DO NOT RE-RUN IT CASUALLY. A second run is not idempotent in its residue: it
// would append two MORE journal entries to that row, which is beyond what was
// approved. Post-run state is checked by verify.js, which is read-only.
//
//   NODE_PATH=../call-recorder/node_modules \
//   M8J_LIFECYCLE_PROOF_WRITE=yes \
//   node scripts/dev/acquisition-lifecycle-proof/run.js
//
// Proves against REAL Postgres the one thing the offline tests cannot: that
// `transitionProspectLifecycle` is a genuine compare-and-set on a real row, and
// that the projection survives a restart.
//
// The offline tests exercise the in-memory reference. That is exactly the
// component nobody doubts. What is new in M8J is an UPDATE with two predicates
// against a table that has never been updated by this system at all, and the
// failure modes that matters — a blind overwrite, a CAS that silently matches
// zero rows and reports success — are invisible until it runs.
//
// See common.js for the residue statement. In one line: two journal entries on
// one existing fictional row, and the lifecycle back where it started.
// ============================================================================

const C = require("./common");
const { LIFECYCLE_TRANSITION_CODES } = require("../../../src/services/acquisition-store");

const now = () => new Date();

async function main() {
  console.log("=".repeat(74));
  console.log("M8J / E-2 LIFECYCLE PROOF — compare-and-set against real Postgres");
  console.log("=".repeat(74));

  C.requireWriteConsent();

  const store = C.makeStore(C.makeClient());
  const before = await store.loadProspect(C.SUBJECT);
  if (!before) throw new Error(`${C.SUBJECT} is not on dev. Nothing to prove against.`);

  const startedAt = before.lifecycle;
  const journalBefore = (before.history || []).length;
  console.log(`\nsubject   ${C.SUBJECT}  "${before.businessName}"`);
  console.log(`lifecycle ${startedAt}   journal entries ${journalBefore}\n`);

  C.check("L0", `the subject starts at ${C.EXPECTED_START}, so the round trip can end where it began`, startedAt === C.EXPECTED_START, `found "${startedAt}"`);
  if (startedAt !== C.EXPECTED_START) {
    console.error("\nREFUSING TO CONTINUE: the round trip would not be reversible from here.");
    process.exit(1);
  }

  // ── 1. The import still cannot move it ────────────────────────────
  const upserted = await store.upsertProspect({ ...before, lifecycle: "discovered", businessName: before.businessName, updatedAt: now().toISOString() });
  C.check("L1", "upsertProspect could NOT drag the lifecycle back to discovered", upserted.prospect.lifecycle === C.EXPECTED_START, `still "${upserted.prospect.lifecycle}"`);

  // ── 2. An illegal transition is refused by real Postgres' guard ────
  const illegal = await store.transitionProspectLifecycle({ prospectId: C.SUBJECT, expectedFrom: C.EXPECTED_START, to: "discovered", actor: "m8j-proof", reason: "Attempting a transition the state machine forbids." });
  C.check("L2", "an illegal transition is refused", illegal.ok === false && illegal.code === LIFECYCLE_TRANSITION_CODES.TRANSITION_ILLEGAL, `${illegal.code}: ${illegal.message}`);

  // ── 3. A stale expectedFrom is refused — the CAS actually compares ─
  //
  // THE TARGET MUST DIFFER FROM THE CURRENT STATE, and the first version of
  // this probe got that wrong. It asked for `expectedFrom: review_pending,
  // to: review_approved` while the row was already `review_approved`, and got
  // `already_at_target` — which is CORRECT and deliberate: the caller's desired
  // end state already holds, and reporting a conflict would break the
  // reconciler, whose whole job is to re-run a repair whose first attempt may
  // have landed. Already-at-target is checked before staleness on purpose.
  //
  // A genuine stale case needs a target the row is NOT already at.
  const stale = await store.transitionProspectLifecycle({ prospectId: C.SUBJECT, expectedFrom: "review_pending", to: "review_rejected", actor: "m8j-proof", reason: "Working from a read that is ten minutes old." });
  C.check("L3", "a STALE expectedFrom is refused rather than overwriting", stale.ok === false && stale.code === LIFECYCLE_TRANSITION_CODES.STALE_LIFECYCLE, `${stale.code}: reported current "${stale.from}"`);

  const idempotent = await store.transitionProspectLifecycle({ prospectId: C.SUBJECT, expectedFrom: "review_pending", to: startedAt, actor: "m8j-proof", reason: "A repair whose first attempt may already have landed." });
  C.check("L3b", "but a stale expectedFrom whose TARGET already holds is idempotent, not a conflict", idempotent.ok === true && idempotent.code === LIFECYCLE_TRANSITION_CODES.ALREADY_AT_TARGET, `${idempotent.code}`);

  const untouched = await store.loadProspect(C.SUBJECT);
  C.check("L4", "nothing moved during the three refusals", untouched.lifecycle === startedAt && (untouched.history || []).length === journalBefore, `lifecycle ${untouched.lifecycle}, journal ${(untouched.history || []).length}`);

  // ── 4. The forward hop — a real UPDATE, guarded ───────────────────
  const out = await store.transitionProspectLifecycle({
    prospectId: C.SUBJECT,
    expectedFrom: startedAt,
    to: C.VIA,
    actor: "m8j-proof",
    reason: "M8J E-2 proof: reopening the review so the return hop can prove the compare-and-set both ways.",
    at: now().toISOString(),
  });
  C.check("L5", `the guarded UPDATE applied ${startedAt} -> ${C.VIA}`, out.ok === true && out.code === LIFECYCLE_TRANSITION_CODES.TRANSITIONED, out.message || `${out.from} -> ${out.to}`);

  // ── 5. A FRESH PROCESS-EQUIVALENT READ. The restart. ──────────────
  //
  // Every service is discarded and rebuilt around a NEW client, which is what a
  // process restart does to a database that does not restart with it.
  const freshStore = C.makeStore(C.makeClient());
  const reloaded = await freshStore.loadProspect(C.SUBJECT);
  C.check("L6", "a fresh client sees the transition — it is durable, not in memory", reloaded.lifecycle === C.VIA, `reloaded as "${reloaded.lifecycle}"`);
  C.check("L7", "the journal entry was written with who and why", (reloaded.history || []).length === journalBefore + 1 && reloaded.history[reloaded.history.length - 1].actor === "m8j-proof", JSON.stringify(reloaded.history[reloaded.history.length - 1] || null));

  // ── 6. Idempotency: repeating a landed transition is a no-op ──────
  const repeat = await freshStore.transitionProspectLifecycle({ prospectId: C.SUBJECT, expectedFrom: startedAt, to: C.VIA, actor: "m8j-proof", reason: "Repairing a projection that may not have landed." });
  C.check("L8", "repeating it reports already_at_target and writes nothing", repeat.ok === true && repeat.code === LIFECYCLE_TRANSITION_CODES.ALREADY_AT_TARGET, `${repeat.code}`);
  const afterRepeat = await freshStore.loadProspect(C.SUBJECT);
  C.check("L9", "the journal did not grow on the no-op", (afterRepeat.history || []).length === journalBefore + 1, `${(afterRepeat.history || []).length} entries`);

  // ── 7. The return hop — put it back exactly where it was ──────────
  const back = await freshStore.transitionProspectLifecycle({
    prospectId: C.SUBJECT,
    expectedFrom: C.VIA,
    to: startedAt,
    actor: "m8j-proof",
    reason: "M8J E-2 proof: restoring the lifecycle to exactly the state this proof found it in.",
    at: now().toISOString(),
  });
  C.check("L10", `the return hop applied ${C.VIA} -> ${startedAt}`, back.ok === true && back.code === LIFECYCLE_TRANSITION_CODES.TRANSITIONED, back.message || `${back.from} -> ${back.to}`);

  // ── 8. What dev holds afterwards ──────────────────────────────────
  const finalStore = C.makeStore(C.makeClient());
  const after = await finalStore.loadProspect(C.SUBJECT);
  C.check("L11", "the lifecycle is EXACTLY where the proof found it", after.lifecycle === startedAt, `${startedAt} -> ... -> ${after.lifecycle}`);
  C.check("L12", "the only residue is 2 journal entries", (after.history || []).length === journalBefore + 2, `${journalBefore} -> ${(after.history || []).length} entries`);

  console.log("");
  console.log("-".repeat(74));
  console.log("PERMANENT DEV RESIDUE FROM THIS RUN");
  console.log(`  ${C.SUBJECT}.lifecycle   ${startedAt} (unchanged)`);
  console.log(`  ${C.SUBJECT}.history     ${journalBefore} -> ${(after.history || []).length} entries`);
  console.log(`  ${C.SUBJECT}.updated_at  bumped`);
  console.log("  no row created in any table; no append-only table written to.");

  process.exit(C.summary("M8J / E-2 LIFECYCLE PROOF") ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

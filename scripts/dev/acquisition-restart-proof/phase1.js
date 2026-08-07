// ============================================================================
// M8D REAL-DATABASE RESTART PROOF - PHASE 1 (process A).
//
// Writes durable state to dev Postgres, then EXITS. The heap dies with it.
// Phase 2 runs in a brand-new process and must rebuild everything from the
// database alone. Nothing is handed between them - no state file, no export.
// Phase 2 re-derives the prospect ids from the same fixtures, which is itself
// part of the proof: the identity is deterministic, the state is durable.
//
// WHAT THIS LEAVES BEHIND, DELIBERATELY AND PERMANENTLY (3 rows):
//   1. acquisition_suppressions  - the opt-out. Append-only.
//   2. acquisition_contact_outcomes - the DO_NOT_CALL record. Append-only.
//   3. acquisition_prospects     - the business row those two point at,
//                                  pinned by ON DELETE RESTRICT.
// Everything else it writes (leases, the second prospect) is cleaned up by
// m8d_restart_cleanup.js. The append-only triggers are never disabled.
//
// NOTHING IS DIALLED. There is no dialler in this build. The terminal artifact
// is rows describing an intention.
//
// RUN:
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-restart-proof/phase1.js
// ============================================================================

const C = require("./common");

const now = () => new Date();

async function main() {
  console.log("=".repeat(74));
  console.log("M8D RESTART PROOF - PHASE 1 (process A): establish durable state");
  console.log("=".repeat(74));

  const client = C.makeClient(); // throws unless the URL is the dev ref
  const store = C.makeStore(client);
  const svc = await C.freshServices(store, now);

  const main = C.mainProspect();
  const live = C.liveLeaseProspect();

  console.log(`\nProject guard   : dev ref ${C.DEV_REF} confirmed`);
  console.log(`Store kind      : ${store.kind}`);
  console.log(`MAIN prospectId : ${main.prospectId}`);
  console.log(`MAIN fingerprint: ${C.identityFingerprint(main)}`);
  console.log(`LIVE prospectId : ${live.prospectId}`);

  // -- 1. INGEST -------------------------------------------------------------
  await C.upsertProspectRow(client, main);
  await C.upsertProspectRow(client, live);
  console.log("\n1. INGEST        two invented locksmiths written to acquisition_prospects");

  // -- 2. QUALIFY ------------------------------------------------------------
  const q = C.qualificationFor(main, now());
  console.log(`2. QUALIFY       ${main.businessName}: verdict=${q.verdict} tier=${q.tier} score=${q.score}`);

  // -- 3. MARK ELIGIBLE ------------------------------------------------------
  const elig = svc.evaluate(main);
  C.check("3.", "MAIN is eligible BEFORE the opt-out", elig.eligible === true, `code=${elig.code}`);

  // -- 4. LEASE --------------------------------------------------------------
  // A real selection through the durable queue: eligibility is re-run at the
  // selection instant and the lease is acquired atomically against the partial
  // unique index.
  const sel = await svc.queue.selectNext({
    prospects: [main],
    limit: 1,
    workerId: "m8d-restart-worker-a",
    evidenceFor: C.evidenceFor,
    qualificationFor: (p) => C.qualificationFor(p, now()),
  });
  C.check("4.", "MAIN received a durable lease", sel.ok === true && sel.selected.length === 1,
    sel.selected.length ? `token=${sel.selected[0].lease.leaseToken}` : `selected=0`);

  // A LONG lease for the live-lease business, acquired directly so its expiry
  // is far enough out that phase 2's sweep cannot touch it. This is what makes
  // "the reaper releases ONLY the expired lease" a real distinction rather
  // than a sweep that happens to catch everything.
  const longExpiry = new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString();
  const liveLease = await store.acquireLease({
    prospectId: live.prospectId,
    e164: C.LIVE_E164,
    workerId: "m8d-restart-worker-b",
    leaseToken: "m8d-restart-live-token",
    grantedAt: now().toISOString(),
    expiresAt: longExpiry,
    requestId: null,
    qualificationScore: 50,
    eligibilitySnapshot: { code: "eligible", evaluatedAt: now().toISOString(), canonicalNumber: C.LIVE_E164 },
  });
  C.check("4b", "LIVE holds a 24h lease that must survive the restart",
    liveLease !== null, liveLease ? `token=${liveLease.leaseToken} expires=${liveLease.expiresAt}` : "acquire returned null");

  // -- 5. RECORD DO_NOT_CALL -------------------------------------------------
  // The outcome recorder applies the suppression as a side effect, durably,
  // BEFORE the lifecycle transition. This is the row that becomes permanent.
  const { transitionProspect } = require("../../../src/services/acquisition-prospect");
  const queued = transitionProspect(main, "queued", {
    actor: "m8d-restart-probe",
    reason: "Selected into the restart proof batch.",
    now,
  }).prospect;

  const optOut = await svc.outcomes.record({
    prospect: queued,
    outcome: "opt_out",
    actor: "m8d-restart-probe",
    actorKind: "human",
    note: "M8D restart proof: the business asked never to be contacted again. Invented business.",
    e164: C.MAIN_E164,
  });
  C.check("5.", "DO_NOT_CALL recorded and durable", optOut.ok === true && optOut.durable === true,
    optOut.ok ? `lifecycle ${optOut.from} -> ${optOut.to}, suppressionApplied=${optOut.suppression.applied}` : optOut.message);

  // -- 6. SUPPRESSION PERSISTS ----------------------------------------------
  C.check("6.", "suppression applied as a side effect of the outcome",
    optOut.ok === true && optOut.suppression.applied === true);

  const rows = await store.listSuppressions();
  const mine = rows.filter((r) => r.actor === "m8d-restart-probe");
  C.check("6b", "the opt-out is readable straight back out of Postgres",
    mine.length >= 1, `${mine.length} suppression row(s) with actor m8d-restart-probe`);

  const liveNow = await store.listLiveLeases();
  console.log(`\nLive leases now : ${liveNow.length} (${liveNow.map((l) => l.leaseToken).join(", ")})`);

  const ok = C.summary("PHASE 1");
  console.log("\nNow EXIT this process and run phase 2. Do not reuse this shell state.");
  console.log("  NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-restart-proof/phase2.js");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPHASE 1 FAILED:", err.message);
  process.exit(1);
});

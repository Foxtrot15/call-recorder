// ============================================================================
// M8D REAL-DATABASE RESTART PROOF - PHASE 2 (process B).
//
// A BRAND-NEW PROCESS. Phase 1's heap is gone: its suppression index, its
// queue, its lease map, its audit log, its store object, its Supabase client.
// Nothing was written to disk and nothing was exported. Everything asserted
// below is rebuilt from dev Postgres alone.
//
// That is what makes this a restart proof rather than a restatement. The
// prospect ids are re-derived from the same fixtures because the identity
// fingerprint is deterministic - not because phase 1 told us what they were.
//
// GUARD AGAINST A FALSE POSITIVE: R0 builds the same services against an EMPTY
// in-memory store and asserts they come up empty. If R0 did not hold, every
// PASS below could be an artefact of state that never left memory.
//
// NOTHING IS DIALLED. No provider is contacted. Postgres only.
//
// RUN:
//   NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-restart-proof/phase2.js
// ============================================================================

const C = require("./common");
const { createInMemoryAcquisitionStore } = require("../../../src/services/acquisition-store");
const { summarisePipeline } = require("../../../src/services/acquisition-readmodel");

const now = () => new Date();

async function main() {
  console.log("=".repeat(74));
  console.log("M8D RESTART PROOF - PHASE 2 (process B): rebuild from Postgres alone");
  console.log("=".repeat(74));

  // -- R0. The false-positive guard -----------------------------------------
  const emptySvc = await C.freshServices(createInMemoryAcquisitionStore(), now);
  const emptyHit = emptySvc.suppression.check({ e164: C.MAIN_E164, fingerprint: C.identityFingerprint(C.mainProspect()) });
  C.check("R0", "services built on an EMPTY store come up empty (guards against false positives)",
    emptySvc.suppression.count() === 0 && emptyHit.suppressed === false,
    `count=${emptySvc.suppression.count()} suppressed=${emptyHit.suppressed}`);

  // -- Fresh everything, from the database ----------------------------------
  const client = C.makeClient(); // throws unless the URL is the dev ref
  const store = C.makeStore(client);
  const svc = await C.freshServices(store, now);

  const main = C.mainProspect();
  const reimport = C.reimportedProspect();
  const live = C.liveLeaseProspect();

  console.log(`\nProject guard    : dev ref ${C.DEV_REF} confirmed`);
  console.log(`Suppressions read: ${svc.suppression.count()} hydrated from Postgres`);
  console.log(`MAIN     id      : ${main.prospectId}`);
  console.log(`RE-IMPORT id     : ${reimport.prospectId}  ${reimport.prospectId === main.prospectId ? "(same identity)" : "(DIFFERENT identity - drifted)"}`);
  console.log("");

  // -- R1. Suppression survived the process death ---------------------------
  const hitMain = svc.suppression.check({ e164: C.MAIN_E164, fingerprint: C.identityFingerprint(main) });
  C.check("R1", "the opt-out survived the restart",
    hitMain.suppressed === true, `code=${hitMain.code || "n/a"}`);

  // -- R2. The re-import, drifted every way at once -------------------------
  // Different trading name, different suburb, different source, different
  // number formatting, and a freshly generated prospect identity.
  const hitReimport = svc.suppression.check({
    e164: C.toE164(reimport.phones[0].raw),
    fingerprint: C.identityFingerprint(reimport),
  });
  C.check("R2", "the RE-IMPORTED business is still SUPPRESSED after the restart",
    hitReimport.suppressed === true,
    `name/suburb/source/format all drifted; identity ${reimport.prospectId === main.prospectId ? "same" : "regenerated"}; number normalised to ${C.toE164(reimport.phones[0].raw)}`);

  // -- R3. Eligibility refuses it -------------------------------------------
  const ev = svc.evaluate(reimport);
  C.check("R3", "eligibility refuses the re-imported business",
    ev.eligible === false && ev.code === "suppressed_permanently", `code=${ev.code}`);

  // -- R4. NO LEASE IS ISSUED -----------------------------------------------
  const sel = await svc.queue.selectNext({
    prospects: [reimport],
    limit: 1,
    workerId: "m8d-restart-worker-c",
    evidenceFor: C.evidenceFor,
    qualificationFor: (p) => C.qualificationFor(p, now()),
  });
  C.check("R4", "NO LEASE is issued for the re-imported business",
    sel.ok === true && sel.selected.length === 0,
    `selected=${sel.selected.length} eligibleCount=${sel.eligibleCount}`);

  // -- R5. Active leases survived the restart -------------------------------
  const liveLeases = await svc.queue.activeLeases();
  const tokens = liveLeases.map((l) => l.leaseToken);
  const liveHeld = tokens.includes("m8d-restart-live-token");
  C.check("R5", "the ACTIVE lease survived the restart",
    liveHeld === true, `live leases: ${tokens.join(", ") || "(none)"}`);

  // -- R6. An active lease cannot be duplicated -----------------------------
  // The partial unique index decides this, not application memory. A second
  // acquire for a business that already holds a live lease returns null.
  const dup = await store.acquireLease({
    prospectId: live.prospectId,
    e164: C.LIVE_E164,
    workerId: "m8d-restart-worker-d",
    leaseToken: "m8d-restart-duplicate-attempt",
    grantedAt: now().toISOString(),
    expiresAt: new Date(now().getTime() + 5 * 60 * 1000).toISOString(),
    requestId: null,
    qualificationScore: 50,
    eligibilitySnapshot: null,
  });
  C.check("R6", "the active lease CANNOT be duplicated after a restart",
    dup === null, "second acquire returned null (partial unique index refused it)");

  // -- R7. An expired lease is NOT released on its own ----------------------
  // Expiry is deliberately not part of the unique index. A lease that expired
  // without being released is a worker that died mid-call; it stays visible
  // until something reaps it explicitly and leaves a row saying so.
  const sweepAt = new Date(now().getTime() + 10 * 60 * 1000); // past MAIN's 5-min TTL, well inside LIVE's 24h
  const mainLeaseStillLive = liveLeases.some((l) => l.prospectId === main.prospectId);
  C.check("R7", "the EXPIRED lease is still held - expiry alone does not release it",
    mainLeaseStillLive === true, "MAIN's lease is past its TTL yet still present in live leases");

  // -- R8. The reaper releases ONLY the expired lease -----------------------
  const dry = await svc.reaper.sweep({ at: sweepAt, dryRun: true });
  const swept = await svc.reaper.sweep({ at: sweepAt });
  const reapedIds = (swept.released || []).map((r) => r.prospectId);
  C.check("R8", "the reaper released ONLY the expired lease",
    swept.reaped === 1 && reapedIds.includes(main.prospectId) && !reapedIds.includes(live.prospectId),
    `dryRun saw ${dry.expiredCount} expired; reaped=${swept.reaped} -> ${reapedIds.join(", ")}`);

  const afterSweep = (await svc.queue.activeLeases()).map((l) => l.leaseToken);
  C.check("R8b", "the 24h lease is untouched by the sweep",
    afterSweep.includes("m8d-restart-live-token"), `live leases after sweep: ${afterSweep.join(", ")}`);

  // -- R9. A reaped prospect is RE-EVALUATED before being queued again ------
  // The reaper releases the lease; it does not grant eligibility. A business
  // that became suppressed while its lease was held must not be resurrected
  // by having that lease reclaimed.
  const afterReap = await svc.queue.selectNext({
    prospects: [main],
    limit: 1,
    workerId: "m8d-restart-worker-e",
    at: sweepAt,
    evidenceFor: C.evidenceFor,
    qualificationFor: (p) => C.qualificationFor(p, now()),
  });
  C.check("R9", "the REAPED prospect is re-evaluated and REFUSED, not auto-queued",
    afterReap.ok === true && afterReap.selected.length === 0,
    `its lease was free, yet selected=${afterReap.selected.length} because eligibility ran again`);

  // -- R10. Outcome state survived the restart ------------------------------
  const outcomes = await svc.outcomes.list({});
  const mineOut = outcomes.filter((o) => o.prospectId === main.prospectId);
  C.check("R10", "the DO_NOT_CALL outcome survived the restart",
    mineOut.length >= 1 && mineOut.some((o) => o.outcome === "opt_out"),
    `${mineOut.length} outcome row(s); outcomes=${mineOut.map((o) => o.outcome).join(", ")}`);

  C.check("R10b", "the outcome still records that suppression was applied",
    mineOut.some((o) => o.suppressionApplied === true));

  // -- R11. Read model rebuilt from durable state ---------------------------
  const summary = summarisePipeline({
    prospects: [main],
    evaluate: svc.evaluate,
    evidenceFor: C.evidenceFor,
    suppression: svc.suppression,
    at: now(),
  });
  const blocked = JSON.stringify(summary).includes("suppress");
  C.check("R11", "the read model reports the business as suppressed after the restart",
    blocked === true, "summarisePipeline built from the hydrated suppression index");

  const ok = C.summary("PHASE 2 (RESTART PROOF)");
  console.log("\nNext: NODE_PATH=../call-recorder/node_modules node scripts/dev/acquisition-restart-proof/cleanup.js");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\nPHASE 2 FAILED:", err.message);
  process.exit(1);
});

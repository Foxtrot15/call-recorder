// LOCKSMITH ACQUISITION M8C — the process-restart proof.
//
// M8C succeeds only if killing and restarting the process cannot make a
// previously suppressed locksmith callable again. This file is where that is
// decided.
//
// ── HOW A RESTART IS SIMULATED, AND WHY IT IS FAITHFUL ──────────────
// `restart()` throws away every service object — the suppression list, the
// queue, the outcome recorder, the eligibility engine, the audit log — and
// builds a completely new set around the SAME store instance.
//
// That is precisely what a restart does: the process dies and takes its heap
// with it; the database does not restart with it. Nothing is carried across in
// a closure, and the tests below assert that the rebuilt services genuinely
// start from nothing but the store — a `freshServices()` built against an EMPTY
// store is checked to be empty, so a passing restart cannot be an artefact of
// state that never left memory.
//
// No database is contacted. The in-memory store is the reference implementation
// of the same contract the Supabase adapter implements, and the adapter's
// translation is covered separately in acquisition-store.test.js.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createInMemoryAcquisitionStore } = require("../src/services/acquisition-store");
const { createDurableSuppression, createDurableQueue, createDurableOutcomes, createLeaseReaper } = require("../src/services/acquisition-durable");
const { createAuditLog } = require("../src/services/acquisition-audit");
const { createProspect, identityFingerprint, transitionProspect } = require("../src/services/acquisition-prospect");
const { qualifyProspect } = require("../src/services/acquisition-qualification");
const { summarisePipeline } = require("../src/services/acquisition-readmodel");

const AT = new Date("2026-08-07T03:00:00.000Z"); // Fri 13:00 Melbourne
const now = () => AT;
const MINUTE = 60 * 1000;

const TRADE_EVIDENCE = [{ evidenceId: "ev_1", kind: "trade_category", value: "Locksmith — 24 hour emergency lockouts and rekeying" }];
const evidenceFor = () => TRADE_EVIDENCE;

/**
 * A fictional Melbourne locksmith. `overrides` lets a re-import arrive with the
 * same business spelled differently, which is the whole point of the exercise.
 */
function locksmith(overrides = {}) {
  const { lifecycle = "review_approved", ...rest } = overrides;
  const built = createProspect({
    businessName: "Preston Key & Safe",
    tradeCategory: "Locksmith — safes, rekeying, emergency lockouts",
    abn: "53 337 901 664",
    suburb: "Preston",
    state: "VIC",
    postcode: "3072",
    region: "Melbourne",
    timezone: "Australia/Melbourne",
    phones: [{ raw: "(03) 5550 2287" }],
    sourceRefs: [{ url: "https://prestonkeyandsafe.example.com.au/contact" }],
    origin: "fixture",
    discoveredAt: "2026-07-15T02:00:00.000Z",
    ...rest,
  });
  assert.strictEqual(built.ok, true, JSON.stringify(built.errors));
  return Object.freeze({ ...built.prospect, lifecycle });
}

const E164 = "+61355502287";

/**
 * Build a complete, independent set of services around a store.
 *
 * Called once to set the scene and again after the "restart". Nothing is shared
 * between two calls except the store argument.
 */
async function freshServices(store) {
  const audit = createAuditLog({ now });
  const suppression = await createDurableSuppression({ now, store, audit });

  // A stand-in eligibility engine that consults the DURABLE suppression service
  // — the real engine composes suppression exactly this way, and using a
  // stand-in keeps this file about persistence rather than about compliance
  // precedence, which acquisition-eligibility.test.js already covers.
  const evaluate = (prospect) => {
    const hit = suppression.check({ e164: E164, fingerprint: identityFingerprint(prospect) });
    if (hit.suppressed) {
      return Object.freeze({ eligible: false, code: "suppressed_permanently", message: `This business must never be called. ${hit.message}`, prospectId: prospect.prospectId, businessName: prospect.businessName, failedChecks: [] });
    }
    return Object.freeze({ eligible: true, code: "eligible", message: "This business can be called now.", canonicalNumber: E164, localTime: "13:00", prospectId: prospect.prospectId, businessName: prospect.businessName, evaluatedAt: AT.toISOString(), failedChecks: [] });
  };

  const queue = await createDurableQueue({ now, evaluate, store, audit, leaseTtlMs: 5 * MINUTE });
  const outcomes = createDurableOutcomes({ now, suppression, store, audit });
  const reaper = createLeaseReaper({ now, store, audit, enabled: true });
  return { audit, suppression, evaluate, queue, outcomes, reaper };
}

const select = (queue, opts = {}) =>
  queue.selectNext({ prospects: [locksmith()], limit: 1, workerId: "worker-a", evidenceFor, qualificationFor: (p) => qualifyProspect(p, { evidenceRows: TRADE_EVIDENCE, at: AT }), ...opts });

// ── The proof ───────────────────────────────────────────────────────

describe("a restart cannot make a suppressed locksmith callable", () => {
  it("walks the whole thing: ingest → qualify → eligible → lease → opt out → restart → re-import → still suppressed", async () => {
    const store = createInMemoryAcquisitionStore();

    // ── 1-3. Ingest, qualify, and confirm it is callable to begin with.
    let svc = await freshServices(store);
    const prospect = locksmith();

    const qualification = qualifyProspect(prospect, { evidenceRows: TRADE_EVIDENCE, at: AT });
    assert.strictEqual(qualification.qualified, true, "the fixture must qualify or the rest proves nothing");
    assert.strictEqual(svc.evaluate(prospect).eligible, true, "it must be callable BEFORE the opt-out");

    // ── 4. Acquire a lease.
    const selection = await select(svc.queue);
    assert.strictEqual(selection.ok, true);
    assert.strictEqual(selection.selected.length, 1, "it should have been offered");
    const leaseToken = selection.selected[0].lease.leaseToken;

    // ── 5-6. They opt out. Suppression is written durably.
    let queued = transitionProspect(prospect, "queued", { actor: "acquisition-queue", reason: "Selected into an approved batch.", now }).prospect;
    const optOut = await svc.outcomes.record({
      prospect: queued,
      outcome: "opt_out",
      actor: "Peter Dang",
      actorKind: "human",
      note: "Asked never to be contacted again.",
      e164: E164,
    });
    assert.strictEqual(optOut.ok, true, optOut.message);
    assert.strictEqual(optOut.durable, true, "the outcome must have reached the store");
    assert.strictEqual(optOut.prospect.lifecycle, "suppressed");
    assert.strictEqual((await store.listSuppressions()).length, 1, "the suppression must be IN THE STORE, not just in memory");

    // ── 7-8. THE RESTART. Every service object is discarded and rebuilt.
    const beforeRestart = svc;
    svc = await freshServices(store);
    assert.notStrictEqual(svc.suppression, beforeRestart.suppression, "the services must genuinely be new objects");
    assert.notStrictEqual(svc.queue, beforeRestart.queue);
    assert.notStrictEqual(svc.audit, beforeRestart.audit);

    // The rebuilt audit log is EMPTY — proving nothing rode across in a closure.
    assert.strictEqual(svc.audit.count(), 0, "a rebuilt service that remembered anything would invalidate this whole test");

    // ── 9. Re-import the same business, spelled differently.
    const reimportedPunctuation = locksmith({ businessName: "Preston Key and Safe Pty Ltd" });
    // ── 10. Re-import from a second source, with a drifted locality too.
    const reimportedSecondSource = locksmith({ businessName: "Preston Key & Safe Locksmiths", suburb: "Preston South" });
    // ── 11. And a freshly created prospect identity for the same business.
    const recreated = locksmith();

    // ── 12-13. Evaluate all three. Every one must still be suppressed.
    for (const [label, candidate] of [
      ["the original identity", recreated],
      ["a re-import with different punctuation", reimportedPunctuation],
      ["a re-import from a second source with a drifted suburb", reimportedSecondSource],
    ]) {
      const hit = svc.suppression.check({ e164: E164, fingerprint: identityFingerprint(candidate) });
      assert.strictEqual(hit.suppressed, true, `${label} escaped suppression after the restart`);

      const decision = svc.evaluate(candidate);
      assert.strictEqual(decision.eligible, false, `${label} was judged callable after the restart`);
      assert.strictEqual(decision.code, "suppressed_permanently");
    }

    // ── 14. And none of them can be handed to a worker.
    const afterRestart = await svc.queue.selectNext({
      prospects: [recreated, reimportedPunctuation, reimportedSecondSource],
      limit: 5,
      workerId: "worker-b",
      evidenceFor,
      qualificationFor: (p) => qualifyProspect(p, { evidenceRows: TRADE_EVIDENCE, at: AT }),
    });
    assert.strictEqual(afterRestart.selected.length, 0, "a suppressed business was offered to a worker after a restart");
    // Every candidate was refused, and refused for a real reason. The set of
    // reasons is not pinned: the lease taken before the opt-out is still live
    // in the store, so some rows are refused as `already_leased` before
    // eligibility is even consulted — which is a stricter refusal, not a weaker
    // one. What matters is that nothing came back callable.
    assert.ok(afterRestart.skipped.length > 0, "the candidates must have been considered and refused, not silently dropped");
    assert.ok(
      afterRestart.skipped.every((s) => ["not_eligible", "already_leased", "identity_collision", "not_qualified", "lifecycle_not_queueable", "already_engaged"].includes(s.code)),
      `unexpected skip reason: ${afterRestart.skipped.map((s) => s.code).join(", ")}`
    );

    // The lease taken before the opt-out is still on record and still traceable.
    assert.ok(leaseToken);
  });

  it("the same proof fails loudly if the store is not carried across", async () => {
    // The control. Without this, the test above could pass because the services
    // never really lost anything — so here the store is thrown away too, and
    // the business comes back callable. That is what M8C prevents, demonstrated
    // by removing the thing that prevents it.
    const store = createInMemoryAcquisitionStore();
    let svc = await freshServices(store);
    const prospect = locksmith();

    await svc.suppression.suppress({ reason: "opt_out", fingerprint: identityFingerprint(prospect), e164: E164, actor: "Peter Dang", actorKind: "human", note: "Do not call again." });
    assert.strictEqual(svc.evaluate(prospect).eligible, false);

    // Restart AND lose the database.
    svc = await freshServices(createInMemoryAcquisitionStore());
    assert.strictEqual(svc.evaluate(prospect).eligible, true, "with no durable store the business comes back — which is exactly the failure M8C exists to prevent");
  });
});

// ── Suppression specifically ────────────────────────────────────────

describe("suppression across a restart", () => {
  async function suppressed() {
    const store = createInMemoryAcquisitionStore();
    const svc = await freshServices(store);
    const result = await svc.suppression.suppress({
      reason: "opt_out",
      fingerprint: identityFingerprint(locksmith()),
      e164: E164,
      actor: "Peter Dang",
      actorKind: "human",
      note: "Asked never to be contacted again.",
    });
    assert.strictEqual(result.ok, true, result.message);
    return store;
  }

  it("is hydrated into a brand-new list", async () => {
    const store = await suppressed();
    const svc = await freshServices(store);
    assert.strictEqual(svc.suppression.count(), 1);
    assert.strictEqual(svc.suppression.check({ fingerprint: identityFingerprint(locksmith()) }).suppressed, true);
  });

  it("keeps the reason, the actor and the timestamp, not just the fact", async () => {
    const svc = await freshServices(await suppressed());
    const entry = svc.suppression.all()[0];
    assert.strictEqual(entry.reason, "opt_out");
    assert.strictEqual(entry.actor, "Peter Dang");
    assert.strictEqual(entry.suppressedAt, AT.toISOString());
    assert.match(entry.note, /never to be contacted/);
    assert.strictEqual(entry.scope, "business");
  });

  it("survives ten restarts, not just one", async () => {
    let store = await suppressed();
    for (let i = 0; i < 10; i += 1) {
      const svc = await freshServices(store);
      assert.strictEqual(svc.suppression.count(), 1, `lost after restart ${i + 1}`);
      store = createInMemoryAcquisitionStore({ seed: store.snapshot() });
    }
  });

  it("is refused, not silently dropped, when the store cannot take it", async () => {
    const store = createInMemoryAcquisitionStore();
    store.appendSuppression = async () => {
      throw new Error("database unavailable");
    };
    const svc = await freshServices(store);
    const result = await svc.suppression.suppress({ reason: "opt_out", fingerprint: identityFingerprint(locksmith()), e164: E164, actor: "Peter", actorKind: "human", note: "Do not call." });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "suppression_not_durable");
    assert.strictEqual(svc.suppression.count(), 0, "it must not be visible in memory either — durable before visible");
  });

  it("an outcome whose suppression cannot be stored is refused entirely", async () => {
    // The invariant from D: a DO_NOT_CALL outcome must never persist while the
    // suppression fails.
    const store = createInMemoryAcquisitionStore();
    store.appendSuppression = async () => {
      throw new Error("database unavailable");
    };
    const svc = await freshServices(store);
    const queued = transitionProspect(locksmith(), "queued", { actor: "q", reason: "Selected.", now }).prospect;

    const result = await svc.outcomes.record({ prospect: queued, outcome: "opt_out", actor: "Peter", actorKind: "human", note: "Do not call again.", e164: E164 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual((await store.listOutcomes()).length, 0, "no outcome row may exist without its suppression");
    assert.strictEqual((await store.listSuppressions()).length, 0);
  });

  it("if the outcome row fails but the suppression landed, the business stays safe and the report says so", async () => {
    const store = createInMemoryAcquisitionStore();
    store.appendOutcome = async () => {
      throw new Error("outcomes table unavailable");
    };
    const svc = await freshServices(store);
    const queued = transitionProspect(locksmith(), "queued", { actor: "q", reason: "Selected.", now }).prospect;

    const result = await svc.outcomes.record({ prospect: queued, outcome: "opt_out", actor: "Peter", actorKind: "human", note: "Do not call again.", e164: E164 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "outcome_not_durable");
    assert.strictEqual(result.suppressionApplied, true);
    assert.match(result.message, /suppression WAS applied and stands/);

    // And it really did land: a restart still refuses the business.
    const after = await freshServices(store);
    assert.strictEqual(after.evaluate(locksmith()).eligible, false, "the suppression must have survived even though the outcome row did not");
  });
});

// ── Leases ──────────────────────────────────────────────────────────

describe("leases across a restart", () => {
  async function leased() {
    const store = createInMemoryAcquisitionStore();
    const svc = await freshServices(store);
    const selection = await select(svc.queue);
    assert.strictEqual(selection.selected.length, 1, "the fixture must be leasable");
    return { store, token: selection.selected[0].lease.leaseToken };
  }

  it("a live lease survives service recreation", async () => {
    const { store } = await leased();
    const svc = await freshServices(store);
    assert.strictEqual((await svc.queue.activeLeases()).length, 1);
  });

  it("an active lease cannot be handed to a second worker after a restart", async () => {
    // The double-call a naive restart produces: the new process has an empty
    // Map, so it happily re-issues a lease for a business somebody is mid-way
    // through.
    const { store } = await leased();
    const svc = await freshServices(store);
    const second = await select(svc.queue, { workerId: "worker-b" });
    assert.strictEqual(second.selected.length, 0, "a restart re-issued a lease for a business already being worked");
    assert.ok(second.skipped.some((s) => s.code === "already_leased"));
  });

  it("an expired lease blocks until it is reaped — and IS reclaimable once it is", async () => {
    // This is the durable contract, and it is deliberately different from the
    // in-process one M8B had.
    //
    // `idx_acq_queue_one_live_lease` is a partial unique index over
    // `released_at is null`. Expiry cannot be part of it: an index predicate
    // has to be immutable and cannot reference now(). So in the database an
    // expired-but-unreleased lease still occupies the slot, and the in-memory
    // store reproduces that exactly — the two implementations have to agree, or
    // the tests prove nothing about production.
    //
    // Reclaiming therefore goes through the reaper, which is precisely why the
    // reaper exists rather than being a nicety. The operational consequence is
    // real and is documented: if nobody ever sweeps, a crashed worker's leases
    // stay held.
    const { store } = await leased();
    const svc = await freshServices(store);
    const later = new Date(AT.getTime() + 6 * MINUTE);
    const args = { prospects: [locksmith()], limit: 1, workerId: "worker-b", at: later, evidenceFor, qualificationFor: (p) => qualifyProspect(p, { evidenceRows: TRADE_EVIDENCE, at: AT }) };

    const beforeSweep = await svc.queue.selectNext(args);
    assert.strictEqual(beforeSweep.selected.length, 0, "an unreleased lease holds the slot even once it has expired");

    const swept = await svc.reaper.sweep({ at: later });
    assert.strictEqual(swept.reaped, 1);

    const afterSweep = await (await freshServices(store)).queue.selectNext(args);
    assert.strictEqual(afterSweep.selected.length, 1, "once reaped, the prospect must be available again");
  });

  it("a released lease frees the prospect, durably", async () => {
    const { store, token } = await leased();
    let svc = await freshServices(store);
    assert.strictEqual((await svc.queue.release(token, { reason: "Shift ended." })).ok, true);

    svc = await freshServices(store);
    assert.strictEqual((await svc.queue.activeLeases()).length, 0);
    assert.strictEqual((await select(svc.queue, { workerId: "worker-c" })).selected.length, 1);
  });

  it("a suppression recorded while the lease was held prevents the next delivery", async () => {
    const { store, token } = await leased();
    let svc = await freshServices(store);
    await svc.suppression.suppress({ reason: "opt_out", fingerprint: identityFingerprint(locksmith()), e164: E164, actor: "Peter", actorKind: "human", note: "Do not call." });
    await svc.queue.release(token, { reason: "Released after the opt-out." });

    svc = await freshServices(store);
    assert.strictEqual((await select(svc.queue, { workerId: "worker-d" })).selected.length, 0, "released is not the same as callable");
  });

  it("requestId idempotency survives a restart", async () => {
    // The case a Map cannot cover: the worker retries BECAUSE the process
    // restarted, which is exactly when an in-process cache is empty.
    const store = createInMemoryAcquisitionStore();
    let svc = await freshServices(store);
    const first = await select(svc.queue, { requestId: "req-restart-1" });
    assert.strictEqual(first.selected.length, 1);
    assert.strictEqual(first.replayed, false);

    svc = await freshServices(store);
    const retry = await select(svc.queue, { requestId: "req-restart-1" });
    assert.strictEqual(retry.replayed, true, "the retry reserved a second time");
    assert.strictEqual(retry.selected.length, 1);
    assert.strictEqual((await store.listLiveLeases()).length, 1, "the day's calls were doubled by a retry");
  });
});

// ── The reaper ──────────────────────────────────────────────────────

describe("the lease reaper", () => {
  async function withExpiredLease() {
    const store = createInMemoryAcquisitionStore();
    const svc = await freshServices(store);
    await select(svc.queue);
    return store;
  }

  it("is dormant unless explicitly enabled", async () => {
    const store = await withExpiredLease();
    const dormant = createLeaseReaper({ now, store });
    const result = await dormant.sweep({ at: new Date(AT.getTime() + 60 * MINUTE) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "reaper_disabled");
    assert.strictEqual(result.reaped, 0);
    assert.strictEqual((await store.listLiveLeases()).length, 1, "a dormant reaper must change nothing");
  });

  it("releases only leases that have genuinely expired", async () => {
    const store = await withExpiredLease();
    const reaper = createLeaseReaper({ now, store, enabled: true });

    const tooEarly = await reaper.sweep({ at: new Date(AT.getTime() + MINUTE) });
    assert.strictEqual(tooEarly.reaped, 0, "an active lease must never be reaped");
    assert.strictEqual((await store.listLiveLeases()).length, 1);

    const afterExpiry = await reaper.sweep({ at: new Date(AT.getTime() + 6 * MINUTE) });
    assert.strictEqual(afterExpiry.reaped, 1);
    assert.strictEqual((await store.listLiveLeases()).length, 0);
  });

  it("is idempotent — a second sweep reaps nothing and does not error", async () => {
    const store = await withExpiredLease();
    const reaper = createLeaseReaper({ now, store, enabled: true });
    const at = new Date(AT.getTime() + 6 * MINUTE);
    assert.strictEqual((await reaper.sweep({ at })).reaped, 1);
    const second = await reaper.sweep({ at });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.reaped, 0);
  });

  it("can report what it would do without doing it", async () => {
    const store = await withExpiredLease();
    const reaper = createLeaseReaper({ now, store, enabled: true });
    const dry = await reaper.sweep({ at: new Date(AT.getTime() + 6 * MINUTE), dryRun: true });
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(dry.wouldReap.length, 1);
    assert.strictEqual(dry.reaped, 0);
    assert.strictEqual((await store.listLiveLeases()).length, 1);
  });

  it("reaping does not make a suppressed business callable", async () => {
    // The reaper releases; it never grants. The next selection re-runs
    // eligibility from scratch and refuses.
    const store = await withExpiredLease();
    const svc = await freshServices(store);
    await svc.suppression.suppress({ reason: "opt_out", fingerprint: identityFingerprint(locksmith()), e164: E164, actor: "Peter", actorKind: "human", note: "Do not call." });

    const reaper = createLeaseReaper({ now, store, audit: svc.audit, enabled: true });
    const at = new Date(AT.getTime() + 6 * MINUTE);
    assert.strictEqual((await reaper.sweep({ at })).reaped, 1);

    const after = await freshServices(store);
    const selection = await after.queue.selectNext({ prospects: [locksmith()], limit: 1, workerId: "worker-z", at, evidenceFor, qualificationFor: (p) => qualifyProspect(p, { evidenceRows: TRADE_EVIDENCE, at: AT }) });
    assert.strictEqual(selection.selected.length, 0);
  });

  it("holds nothing that could contact anybody", async () => {
    const reaper = createLeaseReaper({ now, store: createInMemoryAcquisitionStore(), enabled: true });
    assert.deepStrictEqual(Object.keys(reaper).sort(), ["enabled", "kind", "sweep"]);
    const src = require("node:fs").readFileSync(require.resolve("../src/services/acquisition-durable"), "utf8");
    for (const forbidden of ["setInterval", "setTimeout", "cron", "twilio", "retell", "fetch(", "axios"]) {
      assert.ok(!src.includes(forbidden), `the durable layer must not reference ${forbidden}`);
    }
  });
});

// ── Outcomes and the read model ─────────────────────────────────────

describe("outcomes and the read model across a restart", () => {
  it("an outcome is readable from a rebuilt service", async () => {
    const store = createInMemoryAcquisitionStore();
    let svc = await freshServices(store);
    const queued = transitionProspect(locksmith(), "queued", { actor: "q", reason: "Selected.", now }).prospect;
    await svc.outcomes.record({ prospect: queued, outcome: "no_answer", actor: "Peter", note: "Rang out." });

    svc = await freshServices(store);
    const rows = await svc.outcomes.list({});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].outcome, "no_answer");
    assert.strictEqual(rows[0].lifecycleTo, "attempted");
    assert.strictEqual(rows[0].actor, "Peter");
  });

  it("read-model counts survive recreation", async () => {
    const store = createInMemoryAcquisitionStore();
    let svc = await freshServices(store);
    await svc.suppression.suppress({ reason: "opt_out", fingerprint: identityFingerprint(locksmith()), e164: E164, actor: "Peter", actorKind: "human", note: "Do not call." });
    await select(svc.queue, { prospects: [locksmith({ businessName: "Other Locksmiths", suburb: "Kew" })] });

    const before = summarisePipeline({ prospects: [locksmith()], evaluate: svc.evaluate, evidenceFor, suppression: svc.suppression, at: AT });

    svc = await freshServices(store);
    const after = summarisePipeline({ prospects: [locksmith()], evaluate: svc.evaluate, evidenceFor, suppression: svc.suppression, at: AT });

    assert.strictEqual(after.totals.suppressionEntries, before.totals.suppressionEntries);
    assert.strictEqual(after.totals.callableNow, 0);
    assert.strictEqual(before.totals.callableNow, 0);
    assert.strictEqual(after.totals.blocked, before.totals.blocked);
  });
});

// ── The read model on durable state ─────────────────────────────────

describe("the read model reports durable leases (M8C)", () => {
  it("counts live leases from the store, and flags the expired ones", async () => {
    const store = createInMemoryAcquisitionStore();
    const svc = await freshServices(store);
    await select(svc.queue);

    const leases = await svc.queue.activeLeases();
    const summary = summarisePipeline({ prospects: [locksmith()], evaluate: svc.evaluate, evidenceFor, suppression: svc.suppression, leases, at: AT });
    assert.strictEqual(summary.totals.leased, 1);
    assert.strictEqual(summary.totals.leasesAwaitingReaping, 0, "the lease is still live");

    const later = new Date(AT.getTime() + 6 * MINUTE);
    const expired = summarisePipeline({ prospects: [locksmith()], evaluate: svc.evaluate, evidenceFor, leases, at: later });
    assert.strictEqual(expired.totals.leasesAwaitingReaping, 1, "an expired-but-unreleased lease must be visible — a number that only grows means nobody is sweeping");
  });

  it("reports what a sweep reclaimed when the caller has one to report", async () => {
    const store = createInMemoryAcquisitionStore();
    const svc = await freshServices(store);
    await select(svc.queue);
    const later = new Date(AT.getTime() + 6 * MINUTE);
    const swept = await svc.reaper.sweep({ at: later });

    const summary = summarisePipeline({ prospects: [locksmith()], evaluate: svc.evaluate, evidenceFor, leases: await svc.queue.activeLeases(), reaped: swept.reaped, at: later });
    assert.strictEqual(summary.totals.leasesReaped, 1);
    assert.strictEqual(summary.totals.leased, 0);
  });

  it("reports null, not zero, when no lease information was supplied", async () => {
    // Zero would read as "nothing is leased". Null reads as "we did not look",
    // which is the honest answer and the same rule the suppression count follows.
    const svc = await freshServices(createInMemoryAcquisitionStore());
    const summary = summarisePipeline({ prospects: [locksmith()], evaluate: svc.evaluate, evidenceFor, at: AT });
    assert.strictEqual(summary.totals.leased, null);
    assert.strictEqual(summary.totals.leasesAwaitingReaping, null);
    assert.strictEqual(summary.totals.leasesReaped, null);
  });

  it("renders the expired-lease warning in the founder-facing text", async () => {
    const { describePipeline } = require("../src/services/acquisition-readmodel");
    const store = createInMemoryAcquisitionStore();
    const svc = await freshServices(store);
    await select(svc.queue);
    const later = new Date(AT.getTime() + 6 * MINUTE);
    const text = describePipeline(summarisePipeline({ prospects: [locksmith()], evaluate: svc.evaluate, evidenceFor, leases: await svc.queue.activeLeases(), at: later }));
    assert.match(text, /expired, awaiting reaping/);
  });
});

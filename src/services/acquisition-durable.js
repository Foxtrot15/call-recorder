// AIDA Locksmith Acquisition — durable services (M8C).
//
//   await createDurableSuppression({ now, store, audit })
//   await createDurableQueue({ now, evaluate, store, audit })
//   createDurableOutcomes({ now, suppression, store, audit })
//   createLeaseReaper({ now, store, audit })          dormant by default
//
// M8B's suppression list, lease table and outcome record lived in process
// memory. This module is the layer that makes them survive the process.
//
// ── IT WRAPS; IT DOES NOT REWRITE ───────────────────────────────────
// acquisition-suppression, -queue and -outcome are pure decision cores and stay
// exactly that. Each keeps its synchronous API, its rules and its tests
// unchanged. What this module adds around them is: hydrate from the store at
// construction, and write to the store before admitting a change.
//
// That split is the house style — pure cores, thin adapters — and it is also
// what keeps the eligibility engine synchronous. `check()` is called once per
// candidate per selection by code that is sync all the way up; turning it async
// would have rippled through eligibility, batch, queue and the read model, and
// through roughly seven hundred tests, to buy nothing the hydrated index does
// not already give.
//
// ── SO: READS SYNC, WRITES ASYNC ────────────────────────────────────
//   check(), all(), count(), preview()      synchronous, served from the index
//   suppress(), selectNext(), record()      async, durable before visible
//
// ── THE LIMITATION, STATED ──────────────────────────────────────────
// The index is hydrated at construction. A suppression written by a SECOND
// process is not visible here until `rehydrate()` is called. The pilot is
// single-process, so this is accepted, not solved. Two things still hold across
// processes and they are the ones that matter: the database's unique index
// refuses a second live lease no matter what any cache believes, and the
// suppression table is append-only, so nothing another process does can
// un-suppress anybody.
//
// Pure + dep-free (the store is injected). See test/acquisition-durable.test.js
// and test/acquisition-restart.test.js.

const { createSuppressionList } = require("./acquisition-suppression");
const { createCallQueue } = require("./acquisition-queue");
const { createOutcomeRecorder } = require("./acquisition-outcome");
const { assertStoreContract } = require("./acquisition-store");

// ── Suppression ─────────────────────────────────────────────────────

/**
 * A suppression list that outlives the process.
 *
 * @param {function} now
 * @param {object}   store   an acquisition store
 * @param {object}   [audit] the append-only decision log
 */
async function createDurableSuppression({ now, store, audit = null } = {}) {
  if (typeof now !== "function") throw new Error("createDurableSuppression requires an injected now().");
  assertStoreContract(store, "suppression store");

  let list = createSuppressionList({ now, audit, initialEntries: await store.listSuppressions() });

  /**
   * Re-read everything from the store.
   *
   * Exposed rather than hidden because the alternative — a background refresh —
   * would make "is this business suppressed?" depend on when a timer last
   * fired. A caller that wants to be current before a selection round says so.
   */
  async function rehydrate() {
    list = createSuppressionList({ now, audit, initialEntries: await store.listSuppressions() });
    return list.count();
  }

  /**
   * Record a permanent exclusion.
   *
   * DURABLE BEFORE VISIBLE, and in this order for a reason. The domain core is
   * asked to validate FIRST (a malformed entry must not reach the store), then
   * the row is persisted, and only then is it admitted to the in-memory index.
   *
   * If the store write throws, nothing is admitted and the caller gets the
   * failure. The alternative ordering — admit, then persist — has a failure
   * mode where this process believes a business is suppressed, the next process
   * does not, and the difference is a phone call.
   */
  async function suppress(entry) {
    // Validate against a throwaway list so a rejected entry cannot mutate the
    // live index on its way to being refused.
    const probe = createSuppressionList({ now });
    const validation = probe.suppress(entry);
    if (!validation.ok) return validation;

    const row = validation.entry;
    let stored;
    try {
      stored = await store.appendSuppression({
        reason: row.reason,
        scope: row.scope,
        fingerprint: row.fingerprint,
        e164: row.e164,
        actor: row.actor,
        actorKind: entry.actorKind === "human" ? "human" : "system",
        note: row.note,
        suppressedAt: row.suppressedAt,
      });
    } catch (err) {
      return {
        ok: false,
        code: "suppression_not_durable",
        message: `The suppression could not be stored, so it was not recorded: ${err.message}`,
        cause: err,
      };
    }

    // Now, and only now, does it become visible. Written through the real list
    // so the audit row and the in-memory entry are produced by the same code
    // path that has always produced them.
    const applied = list.suppress(entry);
    return applied.ok ? { ...applied, durable: true, stored } : applied;
  }

  return Object.freeze({
    kind: "durable-suppression",
    // Synchronous reads, delegated to the hydrated index.
    check: (query) => list.check(query),
    all: () => list.all(),
    count: () => list.count(),
    // Asynchronous, durable write.
    suppress,
    rehydrate,
    // Deliberately absent, as in the core: remove, delete, unsuppress, clear.
  });
}

// ── Queue ───────────────────────────────────────────────────────────

/**
 * A call queue whose leases and idempotency outlive the process.
 *
 * Composes acquisition-queue for assessment — eligibility, qualification,
 * ordering, collision collapse — and owns only the durable part: acquiring a
 * lease atomically, and remembering that a requestId has already been served.
 */
async function createDurableQueue({ now, evaluate, store, audit = null, leaseTtlMs = 5 * 60 * 1000 } = {}) {
  if (typeof now !== "function") throw new Error("createDurableQueue requires an injected now().");
  if (typeof evaluate !== "function") throw new Error("createDurableQueue requires an evaluate() function.");
  assertStoreContract(store, "queue store");

  let queue = createCallQueue({ now, evaluate, audit, leaseTtlMs, initialLeases: await store.listLiveLeases() });
  let counter = 0;

  async function rehydrate() {
    queue = createCallQueue({ now, evaluate, audit, leaseTtlMs, initialLeases: await store.listLiveLeases() });
    return queue.activeLeases().length;
  }

  /**
   * Reserve the next N, durably.
   *
   * Eligibility is re-run by preview() at the selection instant, exactly as in
   * M8B — the durable layer adds persistence, it does not add a cache. Nothing
   * stored is ever read back as authority for a call; `eligibilitySnapshot` is
   * written for the audit trail and a test asserts it is never consulted.
   */
  async function selectNext({ workerId, requestId = null, limit = 1, at = null, ...rest } = {}) {
    const worker = typeof workerId === "string" ? workerId.trim() : "";
    if (!worker) {
      return Object.freeze({ ok: false, code: "worker_required", message: "A selection has to name the worker taking the prospects." });
    }
    if (!Number.isInteger(limit) || limit < 1) {
      return Object.freeze({ ok: false, code: "limit_invalid", message: "Ask for at least one prospect." });
    }

    // IDEMPOTENCY, FROM THE STORE. A requestId held only in a Map stops working
    // at exactly the moment a worker is most likely to retry — a restart
    // mid-run — so it is looked up durably.
    if (requestId) {
      const prior = await store.findRequest(requestId);
      if (prior) {
        return Object.freeze({
          ok: true,
          replayed: true,
          workerId: worker,
          requestId,
          selected: Object.freeze((prior.leases || []).map((l) => Object.freeze({ ...l }))),
          note: "This request was already served. The same prospects are returned; nothing further was reserved.",
        });
      }
    }

    const instant = at instanceof Date && Number.isFinite(at.getTime()) ? at : now();
    // Ask for more than we need: some candidates will lose the race for their
    // lease, and a selection that came back short because of a race would look
    // like an empty queue.
    const assessed = queue.preview({ limit: limit * 3 + 5, at: instant, ...rest });

    const expiresAt = new Date(instant.getTime() + leaseTtlMs).toISOString();
    const selected = [];
    const contended = [];

    for (const row of assessed.next) {
      if (selected.length >= limit) break;
      counter += 1;
      const leaseToken = `lease_${row.prospectId}_${instant.getTime()}_${counter}`;

      // ATOMIC. In Postgres this races a partial unique index; null means
      // another worker already holds this business.
      const lease = await store.acquireLease({
        prospectId: row.prospectId,
        e164: row.e164,
        workerId: worker,
        leaseToken,
        grantedAt: instant.toISOString(),
        expiresAt,
        requestId: requestId || null,
        qualificationScore: row.score,
        // For the audit trail ONLY. Whatever eventually dials must re-run
        // eligibility itself; a wash can expire between reservation and call.
        eligibilitySnapshot: { code: row.eligibility.code, evaluatedAt: row.eligibility.evaluatedAt, canonicalNumber: row.e164 },
      });

      if (!lease) {
        contended.push(Object.freeze({ prospectId: row.prospectId, businessName: row.businessName, code: "already_leased", message: "Another worker acquired this business first." }));
        continue;
      }
      selected.push(Object.freeze({ ...row, position: selected.length + 1, lease: Object.freeze({ ...lease }) }));
    }

    if (requestId) await store.recordRequest(requestId, { leases: selected.map((r) => ({ ...r })) });

    if (audit && selected.length) {
      audit.record({
        entityType: "queue",
        entityId: requestId || `selection-${instant.toISOString()}`,
        event: "selection",
        decision: "record",
        actor: worker,
        actorKind: "system",
        reason: `Reserved ${selected.length} prospect(s) durably; ${contended.length} lost to another worker.`,
        detail: { prospectIds: selected.map((r) => r.prospectId), requestId, contended: contended.length },
      });
    }

    await rehydrate();

    return Object.freeze({
      ok: true,
      replayed: false,
      selectedAt: instant.toISOString(),
      workerId: worker,
      requestId,
      selected: Object.freeze(selected),
      contended: Object.freeze(contended),
      skipped: assessed.skipped,
      eligibleCount: assessed.eligibleCount,
      ordering: assessed.ordering,
      note: "These prospects are reserved for calling by a future milestone. Nothing here places, schedules or prepares a call.",
    });
  }

  async function release(token, { reason = null, at = null } = {}) {
    const instant = at instanceof Date ? at : now();
    const released = await store.releaseLease(token, { at: instant.toISOString(), reason });
    if (!released) {
      return { ok: false, code: "lease_not_found", message: "That lease is not held any more — it was already released, completed, or it never existed." };
    }
    if (audit) {
      audit.record({
        entityType: "queue",
        entityId: released.prospectId,
        event: "released",
        decision: "record",
        actor: released.workerId,
        actorKind: "system",
        reason: reason || "Lease released.",
        detail: { token },
      });
    }
    await rehydrate();
    return { ok: true, prospectId: released.prospectId, event: "released" };
  }

  const complete = (token, opts = {}) => release(token, { ...opts, reason: opts.reason || "Lease completed." });

  return Object.freeze({
    kind: "durable-queue",
    preview: (opts) => queue.preview(opts),
    selectNext,
    release,
    complete,
    activeLeases: async () => store.listLiveLeases(),
    rehydrate,
    compareQualifications: queue.compareQualifications,
    // Deliberately absent: dial, dispatch, place, ring, start, send, execute.
  });
}

// ── Outcomes ────────────────────────────────────────────────────────

/**
 * Contact outcomes that outlive the process.
 *
 * ── THE ORDERING, AND WHY IT IS THIS WAY ────────────────────────────
 * There is no cross-table transaction available here. Supabase's PostgREST
 * client issues one statement per call, so "suppress and record the outcome"
 * cannot be made atomic from this side. That leaves a choice about which half
 * may survive alone, and the two are not equally bad:
 *
 *   suppression written, outcome row lost
 *       → the business is safe. We have a gap in the narrative, recoverable
 *         from the decision log, which is written separately and is hash-chained.
 *
 *   outcome row written, suppression lost
 *       → the record says "they asked us never to call again" and the engine
 *         will happily hand them to a worker tomorrow. This is the accident the
 *         entire pipeline exists to prevent.
 *
 * So: SUPPRESSION FIRST, and if it fails the outcome is REFUSED — not recorded
 * with a warning, refused, so the caller has to deal with it. If suppression
 * succeeds and the outcome row then fails to persist, the failure is reported
 * with `suppressionApplied: true` so an operator can see the business is safe
 * and only the narrative is missing.
 *
 * The M8B core already orders suppression before the lifecycle transition for
 * the same reason; this extends the same rule across the durable boundary.
 */
function createDurableOutcomes({ now, suppression, store, audit = null, attemptPolicy = null } = {}) {
  if (typeof now !== "function") throw new Error("createDurableOutcomes requires an injected now().");
  assertStoreContract(store, "outcome store");

  // The core recorder drives the state machine and the suppression side-effect.
  // It is handed the DURABLE suppression service, so its "suppress first" step
  // is already a durable write — which is what makes the ordering above hold
  // rather than merely being described.
  const core = createOutcomeRecorder({ now, suppression, audit, attemptPolicy });

  async function record(input) {
    const result = await core.record(input);
    if (!result.ok) return result;

    try {
      await store.appendOutcome({
        prospectId: result.prospect.prospectId,
        outcome: result.outcome,
        reachedTheBusiness: result.reachedTheBusiness,
        e164: input.e164 || null,
        lifecycleFrom: result.from,
        lifecycleTo: result.to,
        hops: result.hops.map((h) => ({ ...h })),
        effect: result.consequence.effect,
        effectApproved: result.consequence.approved === true,
        suppressionApplied: result.suppression.applied === true,
        actor: input.actor,
        actorKind: input.actorKind === "human" ? "human" : "system",
        note: input.note,
        recordedAt: result.recordedAt,
      });
    } catch (err) {
      // Deliberately NOT a rollback. If a suppression was applied it stays
      // applied — un-applying it to keep two tables tidy would trade a missing
      // narrative for a callable business, which is the wrong way round.
      return {
        ok: false,
        code: "outcome_not_durable",
        message: `The outcome could not be stored: ${err.message}.${result.suppression.applied ? " The suppression WAS applied and stands — this business is not callable. Only the outcome record is missing." : ""}`,
        suppressionApplied: result.suppression.applied === true,
        prospect: result.prospect,
        cause: err,
      };
    }

    return Object.freeze({ ...result, durable: true });
  }

  return Object.freeze({
    kind: "durable-outcomes",
    record,
    recordConversion: (input) => core.recordConversion(input),
    describeOutcome: core.describeOutcome,
    lifecycleFor: core.lifecycleFor,
    outcomes: core.outcomes,
    list: (opts) => store.listOutcomes(opts || {}),
  });
}

// ── The lease reaper ────────────────────────────────────────────────

/**
 * Releases leases whose expiry has passed.
 *
 * ── DORMANT BY DEFAULT ──────────────────────────────────────────────
 * `enabled` is false unless a caller passes true. There is no timer, no
 * interval and no scheduler in this module: `sweep()` runs when something calls
 * it and never otherwise. The repository has no always-on scheduler for
 * acquisition and this milestone does not introduce one.
 *
 * ── IT CANNOT CONTACT ANYBODY ───────────────────────────────────────
 * It reads expired leases and releases them. It does not evaluate eligibility,
 * does not select, does not re-queue, and holds no reference to anything that
 * could dial. A released prospect simply becomes available to the next
 * selection, which will re-run eligibility from scratch — so a business that
 * became suppressed while its lease was held is not resurrected by the reaper;
 * it is refused by the engine the next time anybody asks.
 *
 * ── IDEMPOTENT ──────────────────────────────────────────────────────
 * Releasing an already-released lease matches zero rows and is counted as
 * `alreadyGone`, not as an error. Two sweeps racing produce one release each at
 * most, because the release is conditional on `released_at is null`.
 */
function createLeaseReaper({ now, store, audit = null, enabled = false } = {}) {
  if (typeof now !== "function") throw new Error("createLeaseReaper requires an injected now().");
  assertStoreContract(store, "reaper store");

  async function sweep({ at = null, limit = 100, dryRun = false } = {}) {
    if (!enabled) {
      return Object.freeze({ ok: false, code: "reaper_disabled", message: "The lease reaper is dormant. Construct it with { enabled: true } to run a sweep.", reaped: 0 });
    }

    const instant = at instanceof Date && Number.isFinite(at.getTime()) ? at : now();
    const expired = await store.listExpiredLeases({ at: instant.toISOString() });
    const considered = expired.slice(0, Math.max(0, limit));

    if (dryRun) {
      return Object.freeze({
        ok: true,
        dryRun: true,
        expiredCount: expired.length,
        wouldReap: Object.freeze(considered.map((l) => Object.freeze({ prospectId: l.prospectId, workerId: l.workerId, expiresAt: l.expiresAt }))),
        reaped: 0,
        note: "Nothing was released and nothing was contacted.",
      });
    }

    const reaped = [];
    let alreadyGone = 0;
    for (const lease of considered) {
      const released = await store.releaseLease(lease.leaseToken, {
        at: instant.toISOString(),
        reason: `Lease expired at ${lease.expiresAt} and was reclaimed.`,
      });
      if (!released) {
        alreadyGone += 1;
        continue;
      }
      reaped.push(Object.freeze({ prospectId: released.prospectId, workerId: released.workerId, expiresAt: released.expiresAt }));
      if (audit) {
        audit.record({
          entityType: "queue",
          entityId: released.prospectId,
          event: "lease_expired",
          decision: "record",
          actor: "lease-reaper",
          actorKind: "system",
          reason: `Lease held by ${released.workerId} expired at ${released.expiresAt} and was reclaimed.`,
          detail: { token: lease.leaseToken },
        });
      }
    }

    return Object.freeze({
      ok: true,
      dryRun: false,
      sweptAt: instant.toISOString(),
      expiredCount: expired.length,
      reaped: reaped.length,
      released: Object.freeze(reaped),
      alreadyGone,
      remaining: Math.max(0, expired.length - considered.length),
      note: "Expired leases were released. No prospect was contacted and no eligibility was granted.",
    });
  }

  return Object.freeze({ kind: "lease-reaper", enabled, sweep });
}

module.exports = {
  createDurableSuppression,
  createDurableQueue,
  createDurableOutcomes,
  createLeaseReaper,
};

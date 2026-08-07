// AIDA Locksmith Acquisition — the durable store (M8C).
//
//   createInMemoryAcquisitionStore()      the reference implementation
//   createSupabaseAcquisitionStore()      the durable one (laq1 + laq2)
//   assertStoreContract(store)            both must satisfy the same shape
//
// M8B kept suppressions, leases and outcomes in process memory. That is fine
// for a walkthrough and fatal for a pipeline: kill the process and the
// locksmith who opted out this morning becomes callable this afternoon. This
// module is the seam where that state becomes durable.
//
// ── READS ARE SYNCHRONOUS, WRITES ARE ASYNCHRONOUS ──────────────────
// The single most consequential decision in M8C, so it is written down here
// rather than discovered later.
//
// `suppression.check()` sits on the eligibility hot path. It is called by
// acquisition-eligibility, -batch, -queue and -readmodel, every one of which is
// synchronous, and by the queue once per candidate per selection. Making it
// async would ripple through all four and every test that drives them.
//
// So the domain keeps a synchronous in-memory INDEX, HYDRATED from the store at
// construction, and serves reads from it. Writes go through the store and are
// awaited — which strengthens durable-before-visible rather than weakening it,
// because the write now has to reach something that outlives the process before
// the domain will admit it happened.
//
// ── THE LIMITATION THIS BUYS, STATED PLAINLY ────────────────────────
// A suppression written by a SECOND process is not visible to this one until it
// rehydrates. The pilot is single-process, so this is a known and accepted
// limitation, not a solved problem. Two mitigations exist and both are real:
// the durable uniqueness constraints still hold across processes (the database
// refuses a second live lease regardless of what any cache believes), and
// `rehydrate()` is exposed so a long-lived process can refresh before a
// selection round. What is NOT claimed is that two concurrent processes see
// each other's suppressions instantly.
//
// ── NOTHING HERE RUNS SQL, AND NOTHING HERE APPLIES A MIGRATION ─────
// The Supabase adapter is a thin translation layer over tables that must
// already exist. It requires ./supabase LAZILY, inside each function, exactly
// as locksmith-profile-store.js / routing-profile.js / devices.js do — so a
// test that never calls the adapter never loads @supabase/supabase-js, and
// `npm test` keeps working on a bare checkout with no node_modules.
//
// If the tables are absent the adapter raises a provisioning error naming the
// migration to apply. It does not create them. There is deliberately no code
// path in this repository that executes a .sql file.
//
// See test/acquisition-store.test.js and test/acquisition-restart.test.js.

const TABLES = Object.freeze({
  suppressions: "acquisition_suppressions",
  leases: "acquisition_call_queue",
  outcomes: "acquisition_contact_outcomes",
});

// The migration that creates all three.
const REQUIRED_MIGRATION = "supabase/sql/laq2_create_acquisition_queue.sql";

// ── The contract ────────────────────────────────────────────────────
//
// Every implementation must provide exactly these. Named here so a new adapter
// is checked against a list rather than against whatever the tests happened to
// call, and so a missing method is a loud failure at construction.
const STORE_METHODS = Object.freeze([
  // suppression — append-only, no delete anywhere in the contract
  "listSuppressions",
  "appendSuppression",
  // leases
  "listLiveLeases",
  "acquireLease",
  "releaseLease",
  "findRequest",
  "recordRequest",
  "listExpiredLeases",
  // outcomes
  "listOutcomes",
  "appendOutcome",
]);

/**
 * Every store must satisfy the same shape. Called by each factory, so an
 * adapter that forgets a method fails at construction rather than at 3am when
 * something reaches for it.
 */
function assertStoreContract(store, label = "store") {
  if (!store || typeof store !== "object") throw new Error(`${label} must be an object.`);
  const missing = STORE_METHODS.filter((m) => typeof store[m] !== "function");
  if (missing.length) throw new Error(`${label} is missing: ${missing.join(", ")}.`);
  // The absence that matters. A store that can delete a suppression is not a
  // suppression store, whatever else it does.
  for (const forbidden of ["deleteSuppression", "removeSuppression", "unsuppress", "clearSuppressions", "purge"]) {
    if (typeof store[forbidden] === "function") {
      throw new Error(`${label} exposes ${forbidden}() — suppression is permanent and no store may offer a way out.`);
    }
  }
  return store;
}

function frozenCopy(row) {
  return Object.freeze({ ...row });
}

// ── The in-memory reference implementation ──────────────────────────
//
// Not a mock. It is the behaviour the Supabase adapter has to reproduce, it is
// what the walkthrough and the restart proof run against, and it is a
// legitimate production choice for a single-process run that accepts losing
// state on exit.
//
// The restart proof works by DESTROYING every service and rebuilding them
// around the SAME store instance — which is exactly what a real restart does to
// a process sitting in front of a database that does not restart with it.
function createInMemoryAcquisitionStore({ seed = null } = {}) {
  const suppressions = seed && Array.isArray(seed.suppressions) ? [...seed.suppressions] : [];
  const leases = seed && Array.isArray(seed.leases) ? [...seed.leases] : [];
  const outcomes = seed && Array.isArray(seed.outcomes) ? [...seed.outcomes] : [];
  const requests = new Map(seed && seed.requests ? Object.entries(seed.requests) : []);

  const store = {
    kind: "memory",

    // ── suppression ──
    async listSuppressions() {
      return suppressions.map(frozenCopy);
    },
    async appendSuppression(row) {
      suppressions.push({ ...row, sequence: suppressions.length + 1 });
      return frozenCopy(suppressions[suppressions.length - 1]);
    },

    // ── leases ──
    async listLiveLeases() {
      return leases.filter((l) => !l.releasedAt).map(frozenCopy);
    },

    /**
     * Atomic acquire. Returns null when the prospect already holds a live
     * lease, rather than throwing — the caller treats that as "somebody else
     * has it", which is a normal outcome of a selection, not an error.
     *
     * In Postgres this is an INSERT racing a partial unique index; here it is a
     * scan under Node's single thread. Both give the same answer, which is the
     * point of having one contract.
     */
    async acquireLease(lease) {
      if (leases.some((l) => !l.releasedAt && l.prospectId === lease.prospectId)) return null;
      const row = { ...lease, releasedAt: null, releaseReason: null };
      leases.push(row);
      return frozenCopy(row);
    },

    async releaseLease(token, { at, reason = null } = {}) {
      const row = leases.find((l) => l.leaseToken === token && !l.releasedAt);
      if (!row) return null;
      row.releasedAt = at;
      row.releaseReason = reason;
      return frozenCopy(row);
    },

    /** Live leases whose expiry has passed. The reaper's only input. */
    async listExpiredLeases({ at } = {}) {
      const cutoff = Date.parse(at);
      return leases.filter((l) => !l.releasedAt && Date.parse(l.expiresAt) <= cutoff).map(frozenCopy);
    },

    // ── idempotency ──
    // Kept in the store rather than in the queue object, because a requestId
    // that only survives while the process does is not idempotency — it is a
    // cache that silently stops working at the exact moment (a restart mid-run)
    // when a worker is most likely to retry.
    async findRequest(requestId) {
      const hit = requests.get(requestId);
      return hit ? JSON.parse(JSON.stringify(hit)) : null;
    },
    async recordRequest(requestId, payload) {
      if (requests.has(requestId)) return false;
      requests.set(requestId, JSON.parse(JSON.stringify(payload)));
      return true;
    },

    // ── outcomes ──
    async listOutcomes({ prospectId = null } = {}) {
      return outcomes.filter((o) => !prospectId || o.prospectId === prospectId).map(frozenCopy);
    },
    async appendOutcome(row) {
      outcomes.push({ ...row });
      return frozenCopy(outcomes[outcomes.length - 1]);
    },

    /**
     * Everything, so a test can hand the same state to a freshly built set of
     * services. This is the seam the restart proof turns on: it is what a
     * database still holds after the process using it has gone.
     */
    snapshot() {
      return {
        suppressions: suppressions.map(frozenCopy),
        leases: leases.map(frozenCopy),
        outcomes: outcomes.map(frozenCopy),
        requests: Object.fromEntries(requests),
      };
    },
  };

  return assertStoreContract(store, "in-memory acquisition store");
}

// ── The Supabase adapter ────────────────────────────────────────────
//
// Thin translation only. Every decision stays in the domain modules; this maps
// field names and turns errors into something a founder can act on.

/** Postgres/PostgREST codes meaning "that table is not there". */
function tableMissing(error) {
  if (!error) return false;
  return error.code === "42P01" || /relation .* does not exist/i.test(error.message || "") || /Could not find the table/i.test(error.message || "");
}

function provisioningError(table) {
  const err = new Error(`The acquisition table "${table}" does not exist. Apply ${REQUIRED_MIGRATION} (after laq1) and try again. This process will not create it.`);
  err.code = "acquisition_not_provisioned";
  return err;
}

/** Unique-violation, i.e. somebody else won the race for this lease. */
function uniqueViolation(error) {
  if (!error) return false;
  return error.code === "23505" || /duplicate key value/i.test(error.message || "");
}

function fail(table, verb, error) {
  if (tableMissing(error)) throw provisioningError(table);
  throw new Error(`acquisition ${verb} failed on ${table}: ${error.message}`);
}

const toSuppressionRow = (r) => ({
  reason: r.reason,
  scope: r.scope,
  fingerprint: r.fingerprint,
  e164: r.e164,
  actor: r.actor,
  actor_kind: r.actorKind === "human" ? "human" : "system",
  note: r.note,
  suppressed_at: r.suppressedAt,
});

const fromSuppressionRow = (r) => ({
  reason: r.reason,
  scope: r.scope,
  fingerprint: r.fingerprint,
  e164: r.e164,
  actor: r.actor,
  actorKind: r.actor_kind,
  note: r.note,
  suppressedAt: r.suppressed_at,
});

const toLeaseRow = (l) => ({
  prospect_id: l.prospectId,
  e164: l.e164,
  worker_id: l.workerId,
  lease_token: l.leaseToken,
  granted_at: l.grantedAt,
  expires_at: l.expiresAt,
  request_id: l.requestId || null,
  qualification_score: Number.isFinite(l.qualificationScore) ? l.qualificationScore : null,
  eligibility_snapshot: l.eligibilitySnapshot || null,
});

const fromLeaseRow = (l) => ({
  prospectId: l.prospect_id,
  e164: l.e164,
  workerId: l.worker_id,
  leaseToken: l.lease_token,
  grantedAt: l.granted_at,
  expiresAt: l.expires_at,
  releasedAt: l.released_at,
  releaseReason: l.release_reason,
  requestId: l.request_id,
  qualificationScore: l.qualification_score,
  eligibilitySnapshot: l.eligibility_snapshot,
});

const toOutcomeRow = (o) => ({
  prospect_id: o.prospectId,
  outcome: o.outcome,
  reached_the_business: o.reachedTheBusiness,
  e164: o.e164,
  lifecycle_from: o.lifecycleFrom,
  lifecycle_to: o.lifecycleTo,
  hops: o.hops || [],
  effect: o.effect,
  effect_approved: o.effectApproved === true,
  suppression_applied: o.suppressionApplied === true,
  actor: o.actor,
  actor_kind: o.actorKind === "human" ? "human" : "system",
  note: o.note,
  recorded_at: o.recordedAt,
});

const fromOutcomeRow = (o) => ({
  prospectId: o.prospect_id,
  outcome: o.outcome,
  reachedTheBusiness: o.reached_the_business,
  e164: o.e164,
  lifecycleFrom: o.lifecycle_from,
  lifecycleTo: o.lifecycle_to,
  hops: o.hops,
  effect: o.effect,
  effectApproved: o.effect_approved,
  suppressionApplied: o.suppression_applied,
  actor: o.actor,
  actorKind: o.actor_kind,
  note: o.note,
  recordedAt: o.recorded_at,
});

/**
 * The durable store. Requires laq1 + laq2 to have been applied by a human.
 *
 * @param {object} [client]  injected for contract tests; production passes none
 *                           and the adapter lazily requires ./supabase.
 */
function createSupabaseAcquisitionStore({ client = null } = {}) {
  // Lazy on purpose, and lazy per call rather than once at construction: the
  // dep-free test convention requires that building this object never pulls in
  // @supabase/supabase-js, so that `npm test` runs on a bare checkout.
  const db = () => client || require("./supabase");

  const store = {
    kind: "supabase",

    async listSuppressions() {
      const { data, error } = await db().from(TABLES.suppressions).select("*").order("suppressed_at", { ascending: true });
      if (error) fail(TABLES.suppressions, "read", error);
      return (data || []).map(fromSuppressionRow);
    },

    async appendSuppression(row) {
      const { data, error } = await db().from(TABLES.suppressions).insert(toSuppressionRow(row)).select().single();
      if (error) fail(TABLES.suppressions, "insert", error);
      return fromSuppressionRow(data);
    },

    async listLiveLeases() {
      const { data, error } = await db().from(TABLES.leases).select("*").is("released_at", null);
      if (error) fail(TABLES.leases, "read", error);
      return (data || []).map(fromLeaseRow);
    },

    /**
     * ATOMIC ACQUIRE.
     *
     * The insert races `idx_acq_queue_one_live_lease`, a partial unique index
     * over prospect_id where released_at is null. Two processes inserting at
     * the same instant produce one winner and one 23505 — which is reported as
     * null, meaning "somebody else has it". This is the reason the index exists
     * rather than a read-then-write in application code: only the database can
     * make that check and that write one operation.
     */
    async acquireLease(lease) {
      const { data, error } = await db().from(TABLES.leases).insert(toLeaseRow(lease)).select().single();
      if (error) {
        if (uniqueViolation(error)) return null;
        fail(TABLES.leases, "insert", error);
      }
      return fromLeaseRow(data);
    },

    async releaseLease(token, { at, reason = null } = {}) {
      const { data, error } = await db()
        .from(TABLES.leases)
        .update({ released_at: at, release_reason: reason })
        .eq("lease_token", token)
        .is("released_at", null)
        .select()
        .maybeSingle();
      if (error) fail(TABLES.leases, "update", error);
      return data ? fromLeaseRow(data) : null;
    },

    async listExpiredLeases({ at } = {}) {
      const { data, error } = await db().from(TABLES.leases).select("*").is("released_at", null).lte("expires_at", at);
      if (error) fail(TABLES.leases, "read", error);
      return (data || []).map(fromLeaseRow);
    },

    // Idempotency rides on the queue table's unique request_id rather than a
    // table of its own: the thing being made idempotent IS the reservation, and
    // a separate table could disagree with it.
    async findRequest(requestId) {
      const { data, error } = await db().from(TABLES.leases).select("*").eq("request_id", requestId).limit(500);
      if (error) fail(TABLES.leases, "read", error);
      if (!data || data.length === 0) return null;
      return { leases: data.map(fromLeaseRow) };
    },

    async recordRequest() {
      // Nothing to do: the request_id is written as part of acquireLease, so
      // the reservation and its idempotency key land in one row and cannot
      // disagree. Present to satisfy the contract.
      return true;
    },

    async listOutcomes({ prospectId = null } = {}) {
      let q = db().from(TABLES.outcomes).select("*");
      if (prospectId) q = q.eq("prospect_id", prospectId);
      const { data, error } = await q.order("recorded_at", { ascending: true });
      if (error) fail(TABLES.outcomes, "read", error);
      return (data || []).map(fromOutcomeRow);
    },

    async appendOutcome(row) {
      const { data, error } = await db().from(TABLES.outcomes).insert(toOutcomeRow(row)).select().single();
      if (error) fail(TABLES.outcomes, "insert", error);
      return fromOutcomeRow(data);
    },
  };

  return assertStoreContract(store, "supabase acquisition store");
}

module.exports = {
  createInMemoryAcquisitionStore,
  createSupabaseAcquisitionStore,
  assertStoreContract,
  STORE_METHODS,
  TABLES,
  REQUIRED_MIGRATION,
  tableMissing,
  uniqueViolation,
  provisioningError,
};

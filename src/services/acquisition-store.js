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
  // laq1, applied since M8D and until M8G written to by nothing.
  prospects: "acquisition_prospects",
  prospectPhones: "acquisition_prospect_phones",
  evidence: "acquisition_evidence",
  decisions: "acquisition_decisions",
});

// The migration that creates all three.
const REQUIRED_MIGRATION = "supabase/sql/laq2_create_acquisition_queue.sql";

// ── What the lifecycle COLUMN can hold (M8J) ────────────────────────
//
// THE EFFECTIVE CHECK IS LAQ2'S, NOT LAQ1'S. laq1 created the column with the
// six pre-engagement states; laq2 DROPS that constraint and re-adds it with all
// fourteen, and laq2 has been applied to dev since M8D. A list mirroring laq1
// would be describing a constraint that no longer exists — it would refuse
// `review_approved -> queued`, which the database permits, and a ratchet
// checking it against laq1 would pass while being wrong.
//
// Today this is identical to S.PROSPECT_STATES, and a test asserts all three
// agree — the domain, this list, and the CHECK parsed out of laq2. It is kept
// as its own list rather than aliased because the two constraints are
// independent: the domain could gain a state before a migration adds it, and
// the narrower one has to win. When they diverge, this refuses by name rather
// than letting a raw 23514 surface from Postgres.
const PERSISTABLE_LIFECYCLE_STATES = Object.freeze([
  // acquisition (laq1)
  "discovered",
  "evidence_captured",
  "review_pending",
  "review_approved",
  "review_rejected",
  "suppressed",
  // engagement (laq2 widened the CHECK to include these)
  "queued",
  "attempted",
  "connected",
  "callback_requested",
  "interested",
  "not_interested",
  "customer",
  "disqualified",
]);

/** Stable outcomes of a lifecycle projection write. Callers switch on these. */
const LIFECYCLE_TRANSITION_CODES = Object.freeze({
  TRANSITIONED: "transitioned",
  ALREADY_AT_TARGET: "already_at_target",
  STALE_LIFECYCLE: "stale_lifecycle",
  PROSPECT_MISSING: "prospect_missing",
  TRANSITION_ILLEGAL: "transition_illegal",
  STATE_NOT_PERSISTABLE: "state_not_persistable",
  INPUT_INVALID: "input_invalid",
});

// ── The contract ────────────────────────────────────────────────────
//
// Every implementation must provide exactly these. Named here so a new adapter
// is checked against a list rather than against whatever the tests happened to
// call, and so a missing method is a loud failure at construction.
const STORE_METHODS = Object.freeze([
  // suppression — append-only, no delete anywhere in the contract
  "listSuppressions",
  "appendSuppression",
  // The authoritative read (M8E). Narrow, targeted, and never served from a
  // cache: this is what the final authorisation gate asks before a call could
  // be permitted, and its whole purpose is to be right when the hydrated index
  // is not. See acquisition-authorisation.js.
  "lookupSuppression",
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
  // ── Imported prospects (M8G) ──
  //
  // The laq1 tables, which have existed and been applied since M8D and have had
  // nothing writing to them. M8F could turn a CSV into clean prospects; they
  // evaporated when the process exited. These are what make them survive.
  //
  // upsert, not insert: re-importing the same export must reuse the canonical
  // prospect rather than mint a second one, and the deterministic prospect_id
  // is what makes that safe. Evidence stays APPEND-ONLY — appendEvidence
  // refuses to write a row whose content already exists rather than updating
  // one, because the table's trigger would refuse an update anyway and a
  // silently-skipped duplicate is the correct outcome.
  "upsertProspect",
  "loadProspect",
  "findProspects",
  "upsertProspectPhone",
  "listProspectPhones",
  "appendEvidence",
  "listEvidence",
  // ── The decision log (M8H) ──
  //
  // Append-only and hash-chained. Nothing persisted decisions before M8H, so
  // the chain only ever lived inside one process; a durable review queue means
  // a fresh process must CONTINUE it rather than start a second one. See
  // createAuditLog initialHead / initialSequence.
  //
  // CONCURRENT WRITERS ARE SAFE SINCE M8I, and the safety is in Postgres, not
  // here: laq3 puts `unique (prev_hash)` on the table, so two processes that
  // hydrated the same head cannot both append. The loser gets a 23505 and must
  // re-read and re-mint. Nothing in Node is trusted to prevent a fork.
  "appendDecision",
  "listDecisions",
  // THE HEAD IS READ ON ITS OWN (M8I). Never off the end of a listDecisions
  // page: that call is limited, so at the limit the "last element" is the
  // limit-th row and every later append would hydrate a stale head and fork.
  "readChainHead",
  // ── The lifecycle projection (M8J / E-2) ──
  //
  // upsertProspect deliberately cannot touch lifecycle, so before M8J a
  // persisted prospect was permanently "discovered" and could never satisfy the
  // eligibility engine's review_approved check. This is the ONLY way the column
  // moves, it is a compare-and-set, and it refuses anything the state machine
  // or the column's CHECK would refuse.
  "transitionProspectLifecycle",
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

// ── The lifecycle projection, shared by both adapters (M8J) ─────────
//
// One validator, so the in-memory reference and the durable adapter refuse
// exactly the same things. A second copy would drift, and the copy that drifted
// would be the one that wrote a state the database then rejected — or worse,
// accepted.

/**
 * Everything that can be decided WITHOUT reading the row.
 * Returns null when the request is well-formed, or a refusal.
 */
function validateLifecycleRequest({ prospectId, expectedFrom, to, actor, reason }) {
  const S = require("./acquisition-schema");
  const text = (v) => (typeof v === "string" ? v.trim() : "");

  if (!text(prospectId)) return { ok: false, code: LIFECYCLE_TRANSITION_CODES.INPUT_INVALID, message: "A lifecycle transition needs a prospectId." };
  // WHO and WHY, on the same terms as transitionProspect. A projection write is
  // still a state change, and an unattributable one is indistinguishable from a
  // bug that moved the column.
  if (!text(actor)) return { ok: false, code: LIFECYCLE_TRANSITION_CODES.INPUT_INVALID, message: "Every change of state has to record who made it." };
  if (!text(reason)) return { ok: false, code: LIFECYCLE_TRANSITION_CODES.INPUT_INVALID, message: "Every change of state has to record why." };

  if (!S.PROSPECT_STATES.includes(to)) {
    return { ok: false, code: LIFECYCLE_TRANSITION_CODES.INPUT_INVALID, message: `"${String(to).slice(0, 40)}" is not a prospect state.` };
  }
  if (!PERSISTABLE_LIFECYCLE_STATES.includes(to)) {
    return {
      ok: false,
      code: LIFECYCLE_TRANSITION_CODES.STATE_NOT_PERSISTABLE,
      message: `"${to}" is a real prospect state but the acquisition_prospects.lifecycle CHECK does not allow it, so the write would be refused by Postgres as a 23514. The column accepts: ${PERSISTABLE_LIFECYCLE_STATES.join(", ")}. A migration has to widen the CHECK before the domain can use it.`,
    };
  }
  if (expectedFrom !== null && expectedFrom !== undefined && !S.PROSPECT_STATES.includes(expectedFrom)) {
    return { ok: false, code: LIFECYCLE_TRANSITION_CODES.INPUT_INVALID, message: `"${String(expectedFrom).slice(0, 40)}" is not a prospect state.` };
  }
  return null;
}

/** Is `from → to` in the domain whitelist? */
function lifecycleTransitionAllowed(from, to) {
  const S = require("./acquisition-schema");
  const allowed = S.PROSPECT_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/** The journal entry appended to acquisition_prospects.history. */
function lifecycleHistoryEntry({ from, to, actor, reason, at }) {
  return Object.freeze({ from, to, at, actor: String(actor).trim(), reason: String(reason).trim() });
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
  const prospects = seed && Array.isArray(seed.prospects) ? [...seed.prospects] : [];
  const phones = seed && Array.isArray(seed.phones) ? [...seed.phones] : [];
  const evidence = seed && Array.isArray(seed.evidence) ? [...seed.evidence] : [];
  const decisions = seed && Array.isArray(seed.decisions) ? [...seed.decisions] : [];
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
    async lookupSuppression({ fingerprint = null, e164 = null } = {}) {
      if (fingerprint === null && e164 === null) return [];
      // The same superset the Supabase adapter selects, so the two adapters
      // answer identically and the contract test can assert they do.
      return suppressions
        .filter((r) => (fingerprint !== null && r.fingerprint === fingerprint) || (e164 !== null && r.e164 === e164))
        .map(frozenCopy);
    },

    // ── imported prospects (M8G) ──
    async upsertProspect(row) {
      const idx = prospects.findIndex((p) => p.prospectId === row.prospectId);
      if (idx === -1) {
        prospects.push({ ...row });
        return { created: true, prospect: frozenCopy(prospects[prospects.length - 1]) };
      }
      // Only fields the import can legitimately learn are refreshed. Lifecycle
      // and history are NEVER overwritten by an import: a business that a human
      // moved to review_approved must not be dragged back to `discovered`
      // because somebody re-ran the CSV.
      const existing = prospects[idx];
      const merged = { ...existing };
      for (const [k, v] of Object.entries(row)) {
        if (k === "lifecycle" || k === "history" || k === "prospectId") continue;
        if (v !== null && v !== undefined) merged[k] = v;
      }
      prospects[idx] = merged;
      return { created: false, prospect: frozenCopy(merged) };
    },

    /**
     * The lifecycle projection, reference implementation (M8J / E-2).
     *
     * COMPARE-AND-SET. `expectedFrom` is the state the caller believes the row
     * is in, and the write happens only if that is still true. A caller working
     * from a record it loaded ten minutes ago is told the row moved rather than
     * overwriting whatever happened in between — which matters most for the one
     * transition that cannot be undone cheaply, review_approved.
     *
     * IDEMPOTENT AT THE TARGET. A row already at `to` reports
     * `already_at_target`, not a failure. Reconciliation reruns this after a
     * projection failure and must be safe to run twice.
     */
    async transitionProspectLifecycle({ prospectId, expectedFrom = null, to, actor, reason, at = null } = {}) {
      const bad = validateLifecycleRequest({ prospectId, expectedFrom, to, actor, reason });
      if (bad) return bad;

      const idx = prospects.findIndex((p) => p.prospectId === prospectId);
      if (idx === -1) {
        return { ok: false, code: LIFECYCLE_TRANSITION_CODES.PROSPECT_MISSING, message: `There is no persisted prospect "${String(prospectId).slice(0, 60)}" to transition.` };
      }
      const current = prospects[idx];
      const from = current.lifecycle;

      if (from === to) {
        return { ok: true, code: LIFECYCLE_TRANSITION_CODES.ALREADY_AT_TARGET, changed: false, from, to, prospect: frozenCopy(current) };
      }
      if (expectedFrom !== null && from !== expectedFrom) {
        return {
          ok: false,
          code: LIFECYCLE_TRANSITION_CODES.STALE_LIFECYCLE,
          from,
          expectedFrom,
          to,
          message: `"${prospectId}" is "${from}", not "${expectedFrom}". Something moved it since this decision was read; nothing was changed.`,
        };
      }
      if (!lifecycleTransitionAllowed(from, to)) {
        return { ok: false, code: LIFECYCLE_TRANSITION_CODES.TRANSITION_ILLEGAL, from, to, message: `A prospect cannot go from "${from}" to "${to}".` };
      }

      const entry = lifecycleHistoryEntry({ from, to, actor, reason, at: at || new Date().toISOString() });
      const moved = { ...current, lifecycle: to, history: [...(current.history || []), entry] };
      prospects[idx] = moved;
      return { ok: true, code: LIFECYCLE_TRANSITION_CODES.TRANSITIONED, changed: true, from, to, entry, prospect: frozenCopy(moved) };
    },
    async loadProspect(prospectId) {
      const found = prospects.find((p) => p.prospectId === prospectId);
      return found ? frozenCopy(found) : null;
    },
    async findProspects({ fingerprint = null, e164 = null, sourceId = null, limit = 200 } = {}) {
      let out = prospects;
      // prospectId IS the identity fingerprint, deterministically derived from
      // name and locality, so a fingerprint lookup is a prospectId lookup. The
      // Supabase adapter matches the same column; a test asserts they agree.
      if (fingerprint !== null) out = out.filter((p) => p.prospectId === fingerprint);
      if (sourceId !== null) out = out.filter((p) => p.sourceId === sourceId);
      if (e164 !== null) {
        // Phone rows store the number AS PUBLISHED, so the normalised form has
        // to be recomputed to compare — "(03) 5550 4101" and "03 5550 4101" are
        // one handset and never compare equal as strings. The Supabase adapter
        // does the same; a contract test asserts the two agree.
        const { normalisePhone } = require("./acquisition-phone");
        const ids = new Set(
          phones
            .filter((ph) => {
              const n = normalisePhone(ph.raw);
              return n.ok && n.e164 === e164;
            })
            .map((ph) => ph.prospectId)
        );
        out = out.filter((p) => ids.has(p.prospectId));
      }
      return out.slice(0, limit).map(frozenCopy);
    },
    async upsertProspectPhone(row) {
      const existing = phones.find((p) => p.prospectId === row.prospectId && p.raw === row.raw);
      if (existing) return { created: false, phone: frozenCopy(existing) };
      phones.push({ ...row });
      return { created: true, phone: frozenCopy(phones[phones.length - 1]) };
    },
    async listProspectPhones(prospectId) {
      return phones.filter((p) => p.prospectId === prospectId).map(frozenCopy);
    },
    async appendEvidence(row) {
      // APPEND-ONLY, AND IDEMPOTENT BY CONTENT. The ledger's contentHash is
      // computed on the claim alone — evidenceId folds in a sequence number and
      // a timestamp, so re-importing the same fact produces a new id for
      // identical content. Deduplicating on the id would append a row per
      // import forever; deduplicating on the content is what makes a re-import
      // add nothing.
      const existing = evidence.find((e) => e.prospectId === row.prospectId && e.contentHash === row.contentHash);
      if (existing) return { created: false, evidence: frozenCopy(existing) };
      evidence.push({ ...row });
      return { created: true, evidence: frozenCopy(evidence[evidence.length - 1]) };
    },
    async listEvidence(prospectId) {
      return evidence.filter((e) => e.prospectId === prospectId).map(frozenCopy);
    },
    /**
     * The reference implementation of the laq3 invariant (M8I).
     *
     * This store is not a mock, so it enforces what Postgres enforces: an
     * audit_id that already exists is an idempotent replay, and a prev_hash
     * that already has a successor is a LOST RACE, not a success. Without the
     * second rule every offline test would pass against a store that permits
     * precisely the fork the durable one refuses, and the tests would be
     * proving nothing about the code that ships.
     */
    async appendDecision(row) {
      const existing = decisions.find((d) => d.auditId === row.auditId);
      if (existing) return { created: false, reason: "duplicate_entry", decision: frozenCopy(existing) };
      if (decisions.some((d) => d.prevHash === row.prevHash)) {
        return { created: false, conflict: "head_taken", reason: "head_taken", decision: null };
      }
      decisions.push({ ...row });
      return { created: true, reason: "appended", decision: frozenCopy(decisions[decisions.length - 1]) };
    },
    async readChainHead() {
      if (decisions.length === 0) return null;
      let head = decisions[0];
      for (const d of decisions) if (d.sequence > head.sequence) head = d;
      return frozenCopy(head);
    },
    async listDecisions({ entityType = null, entityId = null, limit = 1000 } = {}) {
      let out = decisions;
      if (entityType !== null) out = out.filter((d) => d.entityType === entityType);
      if (entityId !== null) out = out.filter((d) => d.entityId === entityId);
      return out.slice(0, limit).map(frozenCopy);
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

/**
 * Which uniqueness rule fired (M8I).
 *
 * Postgres names the constraint in the error, and on this table the two
 * possible names mean opposite things — a replay versus a lost race. Matched on
 * the index name laq3 creates and on the column, because PostgREST surfaces the
 * detail in `message` or `details` depending on the path.
 */
const errorText = (error) => `${(error && error.message) || ""} ${(error && error.details) || ""} ${(error && error.hint) || ""}`;
const headTakenViolation = (error) => /uq_acq_decisions_prev_hash|\bprev_hash\b/i.test(errorText(error));
const auditIdViolation = (error) => /audit_id/i.test(errorText(error));

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

// ── laq1 row mappings (M8G) ────────────────────────────────────────

const toProspectRow = (p) => ({
  prospect_id: p.prospectId,
  schema_version: p.schemaVersion,
  business_name: p.businessName,
  legal_name: p.legalName,
  abn: p.abn,
  trade_category: p.tradeCategory,
  suburb: p.suburb,
  state: p.state,
  postcode: p.postcode,
  region: p.region,
  timezone: p.timezone,
  origin: p.origin,
  discovered_at: p.discoveredAt,
  discovered_by: p.discoveredBy,
  notes: p.notes,
  updated_at: p.updatedAt || new Date().toISOString(),
});

const fromProspectRow = (r) => ({
  prospectId: r.prospect_id,
  schemaVersion: r.schema_version,
  businessName: r.business_name,
  legalName: r.legal_name,
  abn: r.abn,
  tradeCategory: r.trade_category,
  suburb: r.suburb,
  state: r.state,
  postcode: r.postcode,
  region: r.region,
  timezone: r.timezone,
  origin: r.origin,
  discoveredAt: r.discovered_at,
  discoveredBy: r.discovered_by,
  notes: r.notes,
  lifecycle: r.lifecycle,
  history: r.history || [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toPhoneRow = (p) => ({
  prospect_id: p.prospectId,
  raw: p.raw,
  label: p.label,
  evidence_id: p.evidenceId,
});

const fromPhoneRow = (r) => ({
  prospectId: r.prospect_id,
  raw: r.raw,
  label: r.label,
  evidenceId: r.evidence_id,
});

const toEvidenceRow = (e) => ({
  evidence_id: e.evidenceId,
  schema_version: e.schemaVersion,
  sequence: e.sequence,
  prospect_id: e.prospectId,
  kind: e.kind,
  capture_mode: e.captureMode,
  value: e.value,
  excerpt: e.excerpt,
  note: e.note,
  observed_at: e.observedAt,
  recorded_at: e.recordedAt,
  captured_by: e.capturedBy,
  source_type: e.source ? e.source.sourceType : "unknown",
  source_official: e.source ? e.source.official === true : false,
  source_url: e.source ? e.source.url : null,
  source_domain: e.source ? e.source.domain : null,
  source_register: e.source ? e.source.register : null,
  source_identifier: e.source ? e.source.identifier : null,
  source_label: e.source ? e.source.label : null,
  source_caveats: e.source && Array.isArray(e.source.caveats) ? e.source.caveats : [],
  authoritative: e.authoritative === true,
  supersedes_id: e.supersedes || null,
  content_hash: e.contentHash,
});

const fromEvidenceRow = (r) => ({
  evidenceId: r.evidence_id,
  schemaVersion: r.schema_version,
  sequence: Number(r.sequence),
  prospectId: r.prospect_id,
  kind: r.kind,
  captureMode: r.capture_mode,
  value: r.value,
  excerpt: r.excerpt,
  note: r.note,
  observedAt: r.observed_at,
  recordedAt: r.recorded_at,
  capturedBy: r.captured_by,
  source: {
    sourceType: r.source_type,
    official: r.source_official,
    url: r.source_url,
    domain: r.source_domain,
    register: r.source_register,
    identifier: r.source_identifier,
    label: r.source_label,
    caveats: r.source_caveats || [],
  },
  authoritative: r.authoritative,
  supersedes: r.supersedes_id,
  contentHash: r.content_hash,
});

const toDecisionRow = (d) => ({
  audit_id: d.auditId,
  schema_version: d.schemaVersion,
  sequence: d.sequence,
  entity_type: d.entityType,
  entity_id: d.entityId,
  event: d.event,
  decision: d.decision,
  actor: d.actor,
  actor_kind: d.actorKind,
  reason: d.reason,
  detail: d.detail || null,
  correlation_id: d.correlationId || null,
  prev_hash: d.prevHash,
  entry_hash: d.entryHash,
  recorded_at: d.recordedAt,
});

/**
 * Read one decision back so that it RE-HASHES to the value it was stored with.
 *
 * THE ROUND TRIP HAS TO BE EXACT, and two columns do not survive it naively.
 *
 * `recorded_at` is a timestamptz. It goes in as `2026-08-08T03:00:00.000Z` and
 * comes back as `2026-08-08T03:00:00+00:00` — the same instant, a different
 * string, and therefore a different sha256. `sequence` is a bigint and comes
 * back as a string for the same reason. Either one silently breaks
 * verifyChain(), which then reports an untampered log as altered — the worst
 * possible failure for an integrity control, because it destroys trust in the
 * one thing that was supposed to be trustworthy.
 *
 * So both are canonicalised to the exact forms the hash was computed over.
 * A test asserts a stored row still verifies.
 */
const fromDecisionRow = (r) => ({
  auditId: r.audit_id,
  schemaVersion: r.schema_version,
  sequence: Number(r.sequence),
  entityType: r.entity_type,
  entityId: r.entity_id,
  event: r.event,
  decision: r.decision,
  actor: r.actor,
  actorKind: r.actor_kind,
  reason: r.reason,
  detail: r.detail,
  correlationId: r.correlation_id,
  prevHash: r.prev_hash,
  entryHash: r.entry_hash,
  recordedAt: new Date(r.recorded_at).toISOString(),
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
  // Carried since M8J so the durable history fold can order two outcomes
  // recorded in the same millisecond deterministically. Read-only; nothing
  // writes them and no hash covers them.
  id: o.id === undefined ? null : o.id,
  createdAt: o.created_at === undefined ? null : o.created_at,
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

    /**
     * THE AUTHORITATIVE SUPPRESSION READ (M8E).
     *
     * Returns the rows that COULD match this business, for the domain to decide
     * on. It deliberately does not decide anything itself.
     *
     * ── WHY THE MATCHING RULE IS NOT IN THIS QUERY ──────────────────
     * The rule is subtle: a number-scoped row matches on the number only, and a
     * business-scoped row matches on the identity fingerprint OR on the number
     * it was recorded against. Writing that in SQL would be a SECOND copy of
     * acquisition-suppression.check(), and the eligibility engine's own header
     * says why that is unacceptable — "a parallel implementation would drift,
     * and the copy that drifted would be the one that authorised a call".
     *
     * So the database NARROWS and the domain DECIDES. `fingerprint = $1 or
     * e164 = $2` is a provable superset of all three matching rules, so feeding
     * this result through the same check() gives the same answer as checking
     * the whole table. A test asserts that equivalence rather than trusting it.
     *
     * ── WHY TWO QUERIES AND NOT ONE `.or()` ─────────────────────────
     * PostgREST's or-filter is a comma-separated string, so a fingerprint
     * containing a comma or a dot — "St. Kilda Locks" — would change the
     * meaning of the filter rather than be matched by it. Two equality filters
     * cannot be confused by their own values, and each uses the partial index
     * laq2 already created for exactly this column.
     *
     * No new SQL. laq2 built idx_acq_suppressions_fingerprint and
     * idx_acq_suppressions_e164 for this read before it existed.
     */
    async lookupSuppression({ fingerprint = null, e164 = null } = {}) {
      if (fingerprint === null && e164 === null) return [];

      const rows = [];
      if (fingerprint !== null) {
        const { data, error } = await db().from(TABLES.suppressions).select("*").eq("fingerprint", fingerprint);
        if (error) fail(TABLES.suppressions, "read", error);
        rows.push(...(data || []));
      }
      if (e164 !== null) {
        const { data, error } = await db().from(TABLES.suppressions).select("*").eq("e164", e164);
        if (error) fail(TABLES.suppressions, "read", error);
        rows.push(...(data || []));
      }

      // A row matching on both predicates comes back twice; the domain would
      // then report one opt-out as two, which reads as a business that objected
      // repeatedly. De-duplicated on the primary key.
      const seen = new Set();
      const unique = [];
      for (const row of rows) {
        const key = row.id === undefined || row.id === null ? JSON.stringify(row) : row.id;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row);
      }
      return unique.map(fromSuppressionRow);
    },

    // ── imported prospects (M8G) ──

    /**
     * Create or refresh one prospect, keyed on the deterministic prospect_id.
     *
     * LIFECYCLE AND HISTORY ARE NEVER SENT. A human moving a business to
     * review_approved is a decision; re-running a CSV is not, and an upsert
     * that carried `lifecycle: "discovered"` would quietly undo the review
     * every time the file was imported again. Those columns keep their
     * defaults on insert and are left untouched on update.
     */
    async upsertProspect(row) {
      const existing = await store.loadProspect(row.prospectId);
      const { data, error } = await db()
        .from(TABLES.prospects)
        .upsert(toProspectRow(row), { onConflict: "prospect_id" })
        .select()
        .single();
      if (error) fail(TABLES.prospects, existing ? "update" : "insert", error);
      return { created: existing === null, prospect: fromProspectRow(data) };
    },

    /**
     * The lifecycle projection (M8J / E-2).
     *
     * ── A REAL COMPARE-AND-SET, IN ONE STATEMENT ──────────────────────
     * The write is
     *
     *   update acquisition_prospects set lifecycle = $to, history = $journal
     *    where prospect_id = $id and lifecycle = $expectedFrom
     *
     * which PostgREST expresses as two `.eq()` filters on an `.update()`. That
     * is a single statement, so the predicate and the write are evaluated
     * against the same row version by Postgres — the same shape as the lease
     * acquire, and for the same reason: two processes reconciling the same
     * review must not both apply a transition.
     *
     * `.select()` returns the rows the UPDATE actually touched. **Zero rows is
     * the interesting answer**, and it is deliberately not treated as success:
     * either the prospect is gone, or its lifecycle is no longer what the
     * caller believed. The row is re-read to say which, because "nothing
     * happened" and "somebody else moved it" need different responses.
     *
     * ── WHY history IS READ FIRST, AND WHY THAT IS STILL SAFE ─────────
     * The journal is a jsonb array and appending to it needs its current value,
     * so there is a read before the write. That is not a race: the append rides
     * on the same CAS. A second writer that read the same history loses the
     * UPDATE outright — its predicate no longer matches — so a lost journal
     * entry and a lost transition are the same event, and the caller is told.
     */
    async transitionProspectLifecycle({ prospectId, expectedFrom = null, to, actor, reason, at = null } = {}) {
      const bad = validateLifecycleRequest({ prospectId, expectedFrom, to, actor, reason });
      if (bad) return bad;

      const current = await store.loadProspect(prospectId);
      if (current === null) {
        return { ok: false, code: LIFECYCLE_TRANSITION_CODES.PROSPECT_MISSING, message: `There is no persisted prospect "${String(prospectId).slice(0, 60)}" to transition.` };
      }
      const from = current.lifecycle;

      if (from === to) {
        return { ok: true, code: LIFECYCLE_TRANSITION_CODES.ALREADY_AT_TARGET, changed: false, from, to, prospect: current };
      }
      if (expectedFrom !== null && from !== expectedFrom) {
        return {
          ok: false,
          code: LIFECYCLE_TRANSITION_CODES.STALE_LIFECYCLE,
          from,
          expectedFrom,
          to,
          message: `"${prospectId}" is "${from}", not "${expectedFrom}". Something moved it since this decision was read; nothing was changed.`,
        };
      }
      if (!lifecycleTransitionAllowed(from, to)) {
        return { ok: false, code: LIFECYCLE_TRANSITION_CODES.TRANSITION_ILLEGAL, from, to, message: `A prospect cannot go from "${from}" to "${to}".` };
      }

      const entry = lifecycleHistoryEntry({ from, to, actor, reason, at: at || new Date().toISOString() });
      const journal = [...(current.history || []), entry];

      // The CAS. `from` is used rather than `expectedFrom` so an unguarded
      // caller still gets a guarded write — an optional argument must not be
      // the difference between a checked update and a blind one.
      const { data, error } = await db()
        .from(TABLES.prospects)
        .update({ lifecycle: to, history: journal, updated_at: entry.at })
        .eq("prospect_id", prospectId)
        .eq("lifecycle", from)
        .select();
      if (error) fail(TABLES.prospects, "update", error);

      if (!data || data.length === 0) {
        // The predicate stopped matching between the read and the write.
        const after = await store.loadProspect(prospectId);
        if (after === null) {
          return { ok: false, code: LIFECYCLE_TRANSITION_CODES.PROSPECT_MISSING, message: `"${prospectId}" disappeared while its lifecycle was being changed.` };
        }
        if (after.lifecycle === to) {
          return { ok: true, code: LIFECYCLE_TRANSITION_CODES.ALREADY_AT_TARGET, changed: false, from: after.lifecycle, to, prospect: after };
        }
        return {
          ok: false,
          code: LIFECYCLE_TRANSITION_CODES.STALE_LIFECYCLE,
          from: after.lifecycle,
          expectedFrom: from,
          to,
          message: `"${prospectId}" moved to "${after.lifecycle}" while this transition was being applied; nothing was changed.`,
        };
      }

      return { ok: true, code: LIFECYCLE_TRANSITION_CODES.TRANSITIONED, changed: true, from, to, entry, prospect: fromProspectRow(data[0]) };
    },

    async loadProspect(prospectId) {
      const { data, error } = await db().from(TABLES.prospects).select("*").eq("prospect_id", prospectId).maybeSingle();
      if (error) fail(TABLES.prospects, "read", error);
      return data ? fromProspectRow(data) : null;
    },

    /**
     * Find candidate prospects to compare a new import against.
     *
     * Narrow, like lookupSuppression: the database finds rows that COULD be the
     * same business and acquisition-dedupe decides whether they are. Loading
     * every prospect to compare in memory would work today and stop working at
     * the first few thousand.
     */
    async findProspects({ fingerprint = null, e164 = null, sourceId = null, limit = 200 } = {}) {
      const collected = new Map();

      const add = (rows) => {
        for (const r of rows || []) collected.set(r.prospect_id, r);
      };

      if (fingerprint !== null) {
        // The identity fingerprint is derived, not stored, so it is matched via
        // the evidence that carries the same source identifier, and by name +
        // locality below. Callers pass what they have.
        const { data, error } = await db().from(TABLES.prospects).select("*").eq("prospect_id", fingerprint).limit(limit);
        if (error) fail(TABLES.prospects, "read", error);
        add(data);
      }

      if (sourceId !== null) {
        const { data, error } = await db().from(TABLES.evidence).select("prospect_id").eq("source_identifier", sourceId).limit(limit);
        if (error) fail(TABLES.evidence, "read", error);
        const ids = [...new Set((data || []).map((r) => r.prospect_id))];
        if (ids.length > 0) {
          const found = await db().from(TABLES.prospects).select("*").in("prospect_id", ids).limit(limit);
          if (found.error) fail(TABLES.prospects, "read", found.error);
          add(found.data);
        }
      }

      if (e164 !== null) {
        // Phones are stored AS PUBLISHED, so the normalised form is matched
        // through the evidence row that recorded it rather than by comparing
        // formatted strings — "(03) 5550 2201" and "03 5550 2201" are the same
        // handset and would never compare equal.
        const { data, error } = await db().from(TABLES.prospectPhones).select("prospect_id, raw").limit(2000);
        if (error) fail(TABLES.prospectPhones, "read", error);
        const { normalisePhone } = require("./acquisition-phone");
        const ids = [...new Set((data || []).filter((r) => {
          const n = normalisePhone(r.raw);
          return n.ok && n.e164 === e164;
        }).map((r) => r.prospect_id))];
        if (ids.length > 0) {
          const found = await db().from(TABLES.prospects).select("*").in("prospect_id", ids).limit(limit);
          if (found.error) fail(TABLES.prospects, "read", found.error);
          add(found.data);
        }
      }

      return [...collected.values()].map(fromProspectRow);
    },

    /**
     * One row per published number, idempotent on (prospect_id, raw).
     *
     * That unique constraint is laq1's, and it is exactly the right key: the
     * same listing re-imported publishes the same raw string, and a genuinely
     * new number published later is a genuinely new row.
     */
    async upsertProspectPhone(row) {
      const before = await db().from(TABLES.prospectPhones).select("*").eq("prospect_id", row.prospectId).eq("raw", row.raw).maybeSingle();
      if (before.error) fail(TABLES.prospectPhones, "read", before.error);
      if (before.data) return { created: false, phone: fromPhoneRow(before.data) };

      const { data, error } = await db().from(TABLES.prospectPhones).insert(toPhoneRow(row)).select().single();
      if (error) {
        // A racing insert loses to the unique constraint; the row it wanted now
        // exists, which is the outcome it was asking for.
        if (uniqueViolation(error)) return { created: false, phone: { ...row } };
        fail(TABLES.prospectPhones, "insert", error);
      }
      return { created: true, phone: fromPhoneRow(data) };
    },

    async listProspectPhones(prospectId) {
      const { data, error } = await db().from(TABLES.prospectPhones).select("*").eq("prospect_id", prospectId);
      if (error) fail(TABLES.prospectPhones, "read", error);
      return (data || []).map(fromPhoneRow);
    },

    /**
     * Append one evidence row, or recognise that its content is already there.
     *
     * APPEND-ONLY AND IDEMPOTENT BY CONTENT. The table's trigger refuses UPDATE
     * outright, so there is no "upsert" available and none wanted. The ledger's
     * contentHash covers the claim alone; evidenceId folds in a sequence number
     * and a timestamp, so the same fact re-imported carries a NEW id and the
     * SAME hash. Deduplicating on the id would append a row per import forever.
     */
    async appendEvidence(row) {
      const before = await db().from(TABLES.evidence).select("*").eq("prospect_id", row.prospectId).eq("content_hash", row.contentHash).maybeSingle();
      if (before.error) fail(TABLES.evidence, "read", before.error);
      if (before.data) return { created: false, evidence: fromEvidenceRow(before.data) };

      const { data, error } = await db().from(TABLES.evidence).insert(toEvidenceRow(row)).select().single();
      if (error) {
        if (uniqueViolation(error)) return { created: false, evidence: { ...row } };
        fail(TABLES.evidence, "insert", error);
      }
      return { created: true, evidence: fromEvidenceRow(data) };
    },

    async listEvidence(prospectId) {
      const { data, error } = await db().from(TABLES.evidence).select("*").eq("prospect_id", prospectId).order("sequence", { ascending: true });
      if (error) fail(TABLES.evidence, "read", error);
      return (data || []).map(fromEvidenceRow);
    },

    /**
     * Append one decision to the hash-chained log.
     *
     * ── TWO UNIQUE VIOLATIONS THAT MEAN OPPOSITE THINGS (M8I) ─────────
     * M8H treated every 23505 as "already there, nothing to do". Once laq3
     * added `unique (prev_hash)` that became actively dangerous, because the
     * two collisions this table can now raise are opposites:
     *
     *   audit_id    the SAME decision, written twice. Genuinely idempotent —
     *               a retried request, a replayed job. Report created:false
     *               and hand back the row that is already there.
     *
     *   prev_hash   a DIFFERENT decision claiming a head somebody else has
     *               already extended. This writer lost the race. Reporting
     *               success would drop the decision on the floor while telling
     *               the caller it was stored, which is the exact failure the
     *               milestone exists to prevent.
     *
     * So the second returns `conflict: "head_taken"` and never `created: true`.
     * The caller must re-read the head, re-mint and try again — the row cannot
     * simply be re-inserted, because its own hash covers the head it named.
     * See appendDecisionSerialised in acquisition-decision-log.js.
     *
     * Nothing is deleted or rewritten to resolve a conflict. A losing row was
     * never durably inserted; there is nothing to clean up.
     */
    async appendDecision(row) {
      const before = await db().from(TABLES.decisions).select("*").eq("audit_id", row.auditId).maybeSingle();
      if (before.error) fail(TABLES.decisions, "read", before.error);
      if (before.data) return { created: false, reason: "duplicate_entry", decision: fromDecisionRow(before.data) };

      const { data, error } = await db().from(TABLES.decisions).insert(toDecisionRow(row)).select().single();
      if (error) {
        if (uniqueViolation(error)) {
          // Which constraint? Postgres names it, and the two mean opposite
          // things. An unrecognised unique violation is treated as a lost race
          // rather than as success: refusing to append something that may be a
          // fork is recoverable, and claiming to have stored it is not.
          if (headTakenViolation(error)) {
            return { created: false, conflict: "head_taken", reason: "head_taken", decision: null };
          }
          if (auditIdViolation(error)) {
            const again = await db().from(TABLES.decisions).select("*").eq("audit_id", row.auditId).maybeSingle();
            if (!again.error && again.data) return { created: false, reason: "duplicate_entry", decision: fromDecisionRow(again.data) };
          }
          return { created: false, conflict: "head_taken", reason: "unique_violation_unrecognised", decision: null };
        }
        fail(TABLES.decisions, "insert", error);
      }
      return { created: true, reason: "appended", decision: fromDecisionRow(data) };
    },

    /**
     * The AUTHORITATIVE head: highest sequence, one row, no filter (M8I).
     *
     * M8H derived the head from the last element of listDecisions(). That was
     * correct for eighteen rows and silently wrong from the thousand-and-first:
     * the list is capped, so at the cap the "last element" is the 1000th row,
     * every append would then hydrate a two-year-old head, and the first one
     * would be refused by laq3 as a fork attempt. This asks the database for
     * the head instead of inferring it from a page.
     *
     * NO ENTITY FILTER, deliberately. The chain is global: a review decision
     * links to whatever came before it, review or not. Filtering here would
     * return the head of a subsequence and mint a row pointing into the middle
     * of the log.
     */
    async readChainHead() {
      const { data, error } = await db()
        .from(TABLES.decisions)
        .select("*")
        .order("sequence", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail(TABLES.decisions, "read", error);
      return data ? fromDecisionRow(data) : null;
    },

    /**
     * Read the chain, oldest first.
     *
     * Ordered by `sequence` because that is the chain's own order; ordering by
     * a timestamp would reorder two rows written in the same millisecond and
     * make a valid chain look broken.
     *
     * NOT A HEAD READ. `limit` caps the page, so the last element of the result
     * is the last element OF THE PAGE and not necessarily of the chain. Use
     * readChainHead() for that. See acquisition-decision-log.js.
     */
    async listDecisions({ entityType = null, entityId = null, limit = 1000 } = {}) {
      let query = db().from(TABLES.decisions).select("*").order("sequence", { ascending: true }).limit(limit);
      if (entityType !== null) query = query.eq("entity_type", entityType);
      if (entityId !== null) query = query.eq("entity_id", entityId);
      const { data, error } = await query;
      if (error) fail(TABLES.decisions, "read", error);
      return (data || []).map(fromDecisionRow);
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
  // Exported for the read-only chain verifier (M8I) so it re-hashes the same
  // shapes the application does. A verifier with its own row mapper would drift
  // from this one, and the drift is exactly the class of defect it exists to
  // catch — M8H's timestamptz round trip was found that way.
  fromDecisionRow,
  PERSISTABLE_LIFECYCLE_STATES,
  LIFECYCLE_TRANSITION_CODES,
};

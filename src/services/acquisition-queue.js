// AIDA Locksmith Acquisition — the outbound call queue boundary (M8B).
//
//   const queue = createCallQueue({ now, evaluate, audit, leaseTtlMs })
//   queue.preview({ ... })        who WOULD be next, nothing reserved
//   queue.selectNext({ ... })     hand the next N to a named worker
//   queue.release(token, ...)     give one back
//   queue.complete(token, ...)    the worker is finished with it
//
// Answers one question:
//
//     Which locksmith prospects should be called next, and in what order?
//
// ── THIS QUEUE CANNOT PLACE A CALL ──────────────────────────────────
// There is no dialler here, no scheduler, no provider client, no transport and
// no function that could become one by configuration. The terminal artifact is
// a frozen list of prospects with a lease token — data describing an intention,
// exactly as the approved batch is. Tests assert the module reaches no network,
// imports nothing non-local, and exports nothing that dispatches.
//
// What eventually calls these people is a FUTURE milestone. It will read this
// queue; it does not exist yet, and nothing here waits for it.
//
// ── ELIGIBILITY IS RE-RUN, ALWAYS, AT THE SELECTION INSTANT ─────────
// This is the single most important property in the file.
//
// A decision computed during ingestion is a statement about the world at
// ingestion time. Calling hours pass. A DNCR wash expires. Somebody opts out at
// 4pm. A batch approval goes stale. If the queue trusted a stored verdict, the
// prospect who opted out this afternoon would be dialled this evening on the
// strength of a decision made this morning — which is precisely the complaint
// this pipeline exists to prevent.
//
// So the queue holds NO cached eligibility. It calls the injected `evaluate` for
// every candidate, every selection, with `at` set to the instant being asked
// about. Any `eligibility` property already sitting on an incoming prospect is
// ignored outright — a test forges one and asserts the record is still refused.
//
// ── TWO QUESTIONS, BOTH MUST SAY YES ────────────────────────────────
// Qualification (is this worth calling?) and eligibility (is this permitted?)
// are separate modules with separate owners, and the queue is where they meet.
// It never merges them into one number: a prospect is skipped as
// `not_qualified` OR as `not_eligible`, never as "low score", because those
// need entirely different actions from a founder.
//
// Ordering comes from qualification. Permission comes from eligibility.
// Neither substitutes for the other.
//
// ── LEASES, BECAUSE A PROSPECT MUST NOT BE CALLED TWICE ─────────────
// `selectNext` reserves what it returns against a named worker for a bounded
// time. A second worker asking at the same instant gets different prospects,
// not the same ones. A worker that dies stops renewing and the lease expires,
// so nothing is stranded — the failure mode is "called later than intended",
// never "called twice at once".
//
// `requestId` makes selection idempotent: a retried request returns the
// identical selection and does NOT reserve a second set. A network timeout
// between a worker and this queue must not silently double the day's calls.
//
// The in-memory lease table here is the domain model, not the storage. The
// durable form is `acquisition_call_queue` in supabase/sql/laq2_*.sql, where
// the "one live lease per prospect" rule is a partial unique index rather than
// a Map — a constraint the database enforces even when two processes race.
// See §"Storage" in docs/LOCKSMITH_ACQUISITION_SPEC.md.
//
// Pure + dep-free. See test/acquisition-queue.test.js.

const S = require("./acquisition-schema");
const { qualifyProspect, rankQualified, compareQualifications, TIE_BREAKERS } = require("./acquisition-qualification");

// How long a reservation lasts before it is assumed abandoned. Deliberately
// short: the cost of an expired-too-early lease is one prospect called later
// than intended; the cost of an expired-too-late lease is a worker holding
// prospects nobody can reach for an hour.
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

// A hard ceiling on one selection, so a caller that passes `limit: 100000`
// gets a refusal rather than an hour of eligibility evaluation.
const MAX_SELECTION = 500;

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function skip(prospect, code, detail = null) {
  return Object.freeze({
    prospectId: prospect ? prospect.prospectId : null,
    businessName: prospect ? prospect.businessName : null,
    code,
    label: S.QUEUE_SKIP_LABELS[code],
    message: detail || S.QUEUE_SKIP_LABELS[code],
  });
}

/**
 * Create a call queue.
 *
 * @param {function} now
 * @param {function} evaluate    (prospect, context) => eligibility decision.
 *                               REQUIRED. The queue must not compute
 *                               eligibility itself — one implementation, and it
 *                               lives in acquisition-eligibility.js.
 * @param {object}   [audit]     the append-only decision log
 * @param {number}   [leaseTtlMs]
 */
function createCallQueue({ now, evaluate, audit = null, leaseTtlMs = DEFAULT_LEASE_TTL_MS } = {}) {
  if (typeof now !== "function") throw new Error("createCallQueue requires an injected now().");
  if (typeof evaluate !== "function") {
    throw new Error("createCallQueue requires an evaluate() function — the queue must not decide eligibility itself.");
  }

  /** prospectId → { token, workerId, expiresAt, grantedAt } */
  const leases = new Map();
  /** requestId → frozen selection, so a retry cannot reserve twice */
  const completedRequests = new Map();
  let leaseCounter = 0;

  function liveLease(prospectId, instant) {
    const held = leases.get(prospectId);
    if (!held) return null;
    // Expiry is evaluated at read time rather than swept on a timer: a timer
    // would make the queue's answers depend on when it last ticked.
    if (Date.parse(held.expiresAt) <= instant.getTime()) {
      leases.delete(prospectId);
      return null;
    }
    return held;
  }

  /**
   * Assess every candidate. Shared by preview() and selectNext() so the two can
   * never disagree about who is next — a UI that shows a different order from
   * the one the workers get is a support ticket nobody can reproduce.
   */
  function assess({ prospects, at, evidenceFor, qualificationFor, duplicateResolution, context, market, excludeLeasedFor }) {
    const instant = at instanceof Date && Number.isFinite(at.getTime()) ? at : now();
    const list = (Array.isArray(prospects) ? prospects : []).filter((p) => p && typeof p === "object" && !Array.isArray(p));

    const skipped = [];
    const candidates = [];

    for (const prospect of list) {
      // 1. Is it in a state a call could start from? Checked first because it
      //    is the cheapest and because a `customer` or a `suppressed` record
      //    should never reach an eligibility evaluation at all.
      if (!S.QUEUEABLE_STATES.includes(prospect.lifecycle)) {
        const engaged = S.ENGAGEMENT_STATES.includes(prospect.lifecycle);
        skipped.push(
          skip(prospect, engaged ? "already_engaged" : "lifecycle_not_queueable", `"${S.PROSPECT_STATE_LABELS[prospect.lifecycle] || prospect.lifecycle}" is not a state a call can start from.`)
        );
        continue;
      }

      // 2. Is somebody else already holding it?
      const held = liveLease(prospect.prospectId, instant);
      if (held && held.workerId !== excludeLeasedFor) {
        skipped.push(skip(prospect, "already_leased", `Held by ${held.workerId} until ${held.expiresAt}.`));
        continue;
      }

      // 3. Is it worth calling? A caller may supply a precomputed
      //    qualification (they are pure and deterministic, so caching one is
      //    safe in a way that caching an eligibility decision is not).
      const qualification = (qualificationFor && qualificationFor(prospect)) || qualifyProspect(prospect, { evidenceRows: evidenceFor(prospect.prospectId) || [], market, at: instant });

      if (!qualification.ok || !qualification.qualified) {
        skipped.push(skip(prospect, "not_qualified", qualification.message));
        continue;
      }

      // 4. Are we PERMITTED to call it — right now, decided right now?
      //
      //    Note what is NOT read here: prospect.eligibility, or any stored
      //    verdict of any kind. The engine is asked afresh, with `at` set to
      //    the instant being asked about, so a wash that expires between
      //    ingestion and selection expires in this answer.
      const eligibility = evaluate(prospect, {
        ...context,
        evidenceRows: evidenceFor(prospect.prospectId) || [],
        duplicateResolution,
        at: instant,
      });

      if (!eligibility || !eligibility.eligible) {
        skipped.push(skip(prospect, "not_eligible", eligibility ? eligibility.message : "The eligibility engine returned nothing, so this prospect cannot be called."));
        continue;
      }

      candidates.push({ prospect, qualification, eligibility });
    }

    // ── ONE BUSINESS, ONE PLACE IN THE QUEUE ───────────────────────
    //
    // A1 derives prospectId from the identity fingerprint, so two records for
    // the same locksmith in the same suburb ALREADY share an id — "Preston Key
    // & Safe" and "Preston Key and Safe Pty Ltd" are one prospectId, and the
    // batch module carries the same warning about them.
    //
    // Left uncollapsed this is not a cosmetic duplicate in a list: leases are
    // keyed by prospectId, so the second grant silently overwrites the first,
    // two workers walk away believing they hold it, and the business is called
    // twice. Dedupe resolution does not save us here either — it runs over the
    // set the caller passed, and a caller can pass whatever it likes.
    //
    // Collapsing deterministically (best score, then earliest discovery, then
    // name) means the same input always yields the same representative.
    const bestById = new Map();
    const collided = [];
    for (const c of [...candidates].sort((a, b) => {
      const s = b.qualification.score - a.qualification.score;
      if (s !== 0) return s;
      const d = String(a.prospect.discoveredAt || "").localeCompare(String(b.prospect.discoveredAt || ""));
      if (d !== 0) return d;
      return String(a.prospect.businessName || "").localeCompare(String(b.prospect.businessName || ""));
    })) {
      const id = c.prospect.prospectId;
      if (bestById.has(id)) {
        collided.push(skip(c.prospect, "identity_collision", `"${bestById.get(id).prospect.businessName}" is the same business (${id}) and is already in this selection.`));
        continue;
      }
      bestById.set(id, c);
    }
    skipped.push(...collided);

    const deduped = [...bestById.values()];

    // Ordering is qualification's, not the queue's — one ranking rule, in the
    // module that owns the signals it ranks on.
    const ranked = rankQualified(deduped.map((c) => c.qualification));
    const byId = new Map(deduped.map((c) => [c.qualification.prospectId, c]));
    const ordered = ranked.map((q) => byId.get(q.prospectId)).filter(Boolean);

    return { instant, ordered, skipped, considered: list.length };
  }

  function buildRow(entry, position, lease) {
    const { prospect, qualification, eligibility } = entry;
    return Object.freeze({
      position,
      prospectId: prospect.prospectId,
      businessName: prospect.businessName,
      // The number the eligibility engine cleared — not "a number from the
      // record". If those two ever differ, the cleared one is the only safe
      // answer, and it is the engine that did the clearing.
      e164: eligibility.canonicalNumber,
      timezone: prospect.timezone,
      localTime: eligibility.localTime,

      tier: qualification.tier,
      score: qualification.score,
      // Why this one, at this position, in words.
      whyRanked: Object.freeze(qualification.contributing.slice(0, 3).map((s) => s.why)),
      whyCallable: eligibility.message,

      qualification,
      eligibility,
      lease: lease ? Object.freeze({ ...lease }) : null,
    });
  }

  /**
   * Who would be next, without reserving anything.
   *
   * Runs exactly the same assessment selectNext does, including re-running
   * eligibility. A read model that showed a cached order would eventually show
   * a suppressed business as "callable now".
   */
  function preview({ prospects = [], limit = 10, at = null, evidenceFor = () => [], qualificationFor = null, duplicateResolution = null, context = {}, market = null } = {}) {
    const n = Math.max(0, Math.min(Number.isInteger(limit) ? limit : 0, MAX_SELECTION));
    const { instant, ordered, skipped, considered } = assess({ prospects, at, evidenceFor, qualificationFor, duplicateResolution, context, market, excludeLeasedFor: null });

    return Object.freeze({
      previewedAt: instant.toISOString(),
      considered,
      eligibleCount: ordered.length,
      next: Object.freeze(ordered.slice(0, n).map((e, i) => buildRow(e, i + 1, null))),
      skipped: Object.freeze(skipped),
      ordering: ORDERING_EXPLANATION,
      // Said out loud on the artifact itself, as the approved batch does.
      note: "Nothing is reserved and no call is placed by looking at this.",
    });
  }

  /**
   * Reserve the next N prospects for a named worker.
   *
   * @param {string} workerId    who is taking them. Required — an unattributed
   *                             lease cannot be released by anybody.
   * @param {string} [requestId] idempotency key. A retry with the same id
   *                             returns the identical selection and reserves
   *                             nothing further.
   */
  function selectNext({ prospects = [], limit = 1, workerId, requestId = null, at = null, evidenceFor = () => [], qualificationFor = null, duplicateResolution = null, context = {}, market = null } = {}) {
    const worker = clip(workerId, 120);
    if (!worker) {
      return Object.freeze({ ok: false, code: "worker_required", message: "A selection has to name the worker taking the prospects, or nothing can release them again." });
    }

    const key = clip(requestId, 200);
    if (key && completedRequests.has(key)) {
      // The retry path. Returning the stored selection is the whole point: a
      // timeout between a worker and this queue must not double the day's calls.
      return completedRequests.get(key);
    }

    if (!Number.isInteger(limit) || limit < 1) {
      return Object.freeze({ ok: false, code: "limit_invalid", message: "Ask for at least one prospect." });
    }
    if (limit > MAX_SELECTION) {
      return Object.freeze({ ok: false, code: "limit_too_large", message: `A single selection is capped at ${MAX_SELECTION} prospects.` });
    }

    const { instant, ordered, skipped, considered } = assess({ prospects, at, evidenceFor, qualificationFor, duplicateResolution, context, market, excludeLeasedFor: null });

    const taken = ordered.slice(0, limit);
    const expiresAt = new Date(instant.getTime() + leaseTtlMs).toISOString();

    const rows = taken.map((entry, i) => {
      leaseCounter += 1;
      // Deterministic, unguessable-enough, and unique per grant. Not a random
      // token: Math.random() in a domain module makes every test that touches
      // it non-reproducible, and this identifier's job is bookkeeping, not
      // security — nothing authorises off it.
      const token = `lease_${entry.prospect.prospectId}_${leaseCounter}`;
      const lease = { token, workerId: worker, grantedAt: instant.toISOString(), expiresAt };
      leases.set(entry.prospect.prospectId, lease);
      return buildRow(entry, i + 1, lease);
    });

    if (audit) {
      audit.record({
        entityType: "queue",
        entityId: key || `selection-${instant.toISOString()}`,
        event: "selection",
        decision: "record",
        actor: worker,
        actorKind: "system",
        reason: `Reserved ${rows.length} of ${ordered.length} eligible prospects (${considered} considered).`,
        detail: { prospectIds: rows.map((r) => r.prospectId), skipped: skipped.length, requestId: key },
      });
    }

    const result = Object.freeze({
      ok: true,
      selectedAt: instant.toISOString(),
      workerId: worker,
      requestId: key,
      considered,
      eligibleCount: ordered.length,
      selected: Object.freeze(rows),
      // Everything eligible we did not hand over this time. Not an error —
      // it is the rest of the queue.
      remaining: ordered.length - rows.length,
      skipped: Object.freeze(skipped),
      ordering: ORDERING_EXPLANATION,
      leaseExpiresAt: rows.length ? expiresAt : null,
      note: "These prospects are reserved for calling by a future milestone. Nothing here places, schedules or prepares a call.",
    });

    if (key) completedRequests.set(key, result);
    return result;
  }

  /** Give a prospect back, unworked. The lease must be held by whoever releases it. */
  function release(token, { reason = null } = {}) {
    return endLease(token, "released", reason);
  }

  /** The worker is finished. Identical bookkeeping to release; distinct in the audit. */
  function complete(token, { reason = null } = {}) {
    return endLease(token, "completed", reason);
  }

  function endLease(token, event, reason) {
    const t = clip(token, 200);
    if (!t) return { ok: false, code: "token_required", message: "Releasing a prospect needs its lease token." };

    for (const [prospectId, lease] of leases) {
      if (lease.token !== t) continue;
      leases.delete(prospectId);
      if (audit) {
        audit.record({
          entityType: "queue",
          entityId: prospectId,
          event,
          decision: "record",
          actor: lease.workerId,
          actorKind: "system",
          reason: reason || `Lease ${event}.`,
          detail: { token: t },
        });
      }
      return { ok: true, prospectId, event };
    }

    // An unknown token is almost always an expired one. Say so, because
    // "not found" sends somebody looking for a bug that is not there.
    return { ok: false, code: "lease_not_found", message: "That lease is not held any more — it was already released, completed, or it expired." };
  }

  /** Live leases, for the read model and for tests. Expired ones are not live. */
  function activeLeases({ at = null } = {}) {
    const instant = at instanceof Date ? at : now();
    const out = [];
    for (const [prospectId] of [...leases]) {
      const lease = liveLease(prospectId, instant);
      if (lease) out.push(Object.freeze({ prospectId, ...lease }));
    }
    return Object.freeze(out.sort((a, b) => (a.prospectId < b.prospectId ? -1 : 1)));
  }

  return Object.freeze({
    preview,
    selectNext,
    release,
    complete,
    activeLeases,
    compareQualifications,
    leaseTtlMs,
    // Deliberately absent: dial, dispatch, place, ring, start, send, execute.
    // The thing that eventually calls these people is a future milestone and
    // does not live here.
  });
}

/** How the order was arrived at, carried on every result so a UI need not guess. */
const ORDERING_EXPLANATION = Object.freeze({
  by: "qualification",
  tieBreakers: Object.freeze(TIE_BREAKERS.map((t) => Object.freeze({ key: t.key, label: t.label, direction: t.direction }))),
  note: "Order is decided by the qualification signals, in this fixed sequence. Eligibility decides who is in the list at all, never where they sit in it.",
});

module.exports = {
  createCallQueue,
  ORDERING_EXPLANATION,
  DEFAULT_LEASE_TTL_MS,
  MAX_SELECTION,
};

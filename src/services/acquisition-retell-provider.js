// AIDA Locksmith Acquisition — the Retell dial provider (E-7B2A).
//
//   createRetellAcquisitionProvider({ routing, transport })
//   buildRetellCallPayload({ execution, routing })     pure, deterministic
//   classifyProviderFailure(code)                      refused vs ambiguous
//   RETELL_ROUTING_KEYS / AMBIGUOUS_FAILURE_CODES
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────
// It is the payload builder and result mapper for one outbound acquisition
// call, in the exact shape Retell's create-phone-call endpoint accepts.
//
// IT CANNOT PLACE A CALL. It states `live: false`, it imports no transport, it
// reads no environment, it names no host, and it holds no key. The only way it
// reaches anything is if a caller injects a `transport` function — and nothing
// in this repository constructs one. E-7B2A deliberately stops one step short
// of that, and E-7B2B is the founder-authorised milestone that takes it.
//
// The seam is the point. E-7A proved what may consume an authorisation; E-7B1
// proved the database arbitrates who may dispatch. This proves we can build the
// exact request without acquiring the ability to send it.
//
// ── WHY IT IS A SEPARATE FILE FROM acquisition-dial-provider.js ─────
// That file's registry ratchet asserts it exports exactly
// createDisabledDialProvider and createFakeDialProvider — the two providers
// that cannot call anybody under any circumstances. Adding a third factory
// there would have meant relaxing the ratchet that says so. The ratchet is
// right; this file lives beside it instead, under its own equivalent ratchets.
//
// ── IT IS A MECHANISM, AND IT DECIDES NOTHING ───────────────────────
// No DNCR, no suppression, no batch approval, no duplicate resolution, no
// attempt policy, no calling window, no holiday, no eligibility. It receives an
// already-authorised, already-claimed, frozen execution and turns it into a
// request body. Every one of those questions was answered durably upstream, and
// this file cannot see the answers, let alone revisit them.

const { PROVIDER_STATUS } = require("./acquisition-dial-provider");

/** What a caller must supply from trusted server-side configuration. */
const RETELL_ROUTING_KEYS = Object.freeze(["agentId", "fromNumber"]);

/**
 * Normalised failure codes that mean THE CALL WAS DEFINITELY NOT PLACED.
 *
 * Retell answered, and its answer was a rejection. Nothing rang. These may be
 * reported as a plain refusal, and the dispatch keeps its locks.
 */
const DEFINITIVE_FAILURE_CODES = Object.freeze([
  "invalid_request",
  "provider_unauthorized",
  "provider_not_found",
  "operation_not_permitted",
  "provider_disabled",
  "provider_misconfigured",
  "operation_unsupported",
  // A 429 is refused BEFORE the provider does any work, so no call exists.
  // It is definitive — which is not the same as retryable. Nothing here
  // retries anything, ever. See the header of acquisition-dial-execution.js.
  "provider_rate_limited",
]);

/**
 * Failure codes that CANNOT distinguish "never arrived" from "arrived, placed
 * the call, and the answer was lost".
 *
 * ── THIS IS THE MOST IMPORTANT LIST IN THE FILE ─────────────────────
 * The shared voice-platform port marks provider_timeout, provider_unreachable
 * and provider_error as RETRYABLE — and for a consenting client expecting a
 * setup call that is correct, because the cost of a second call is mild
 * annoyance. For a COLD ACQUISITION CALL to a business that never asked to hear
 * from us, retrying an ambiguous timeout is how one authorisation becomes two
 * telephone calls to the same locksmith.
 *
 * So this provider DISCARDS the port's `retryable` flag entirely. It is not
 * read, not mapped, and not passed upward. An ambiguous outcome is raised as an
 * AmbiguousSubmission, which the executor records as provider_status
 * 'unknown', leaves the dispatch UNRESOLVED, and does not retry.
 */
const AMBIGUOUS_FAILURE_CODES = Object.freeze([
  "provider_timeout",
  "provider_unreachable",
  "provider_error",
]);

/**
 * Raised when we cannot tell whether a call was placed.
 *
 * Thrown rather than returned, deliberately. The executor's contract is that a
 * provider which THROWS yields provider_status 'unknown' with no submitted_at —
 * the one status laq5 permits to stand alone, precisely because not knowing
 * whether the provider was reached is what it means. Returning a refusal
 * instead would assert `submitted_at`, and would be a lie in the ledger.
 */
class AmbiguousSubmission extends Error {
  constructor(message, { code = null, providerRequestId = null } = {}) {
    super(message);
    this.name = "AmbiguousSubmission";
    this.ambiguous = true;
    this.code = code;
    this.providerRequestId = providerRequestId;
  }
}

const isE164 = (value) => typeof value === "string" && /^\+[1-9][0-9]{6,14}$/.test(value);

/**
 * Routing comes from trusted server-side configuration and NEVER from the
 * execution. A provider that could be handed a from-number by whoever called it
 * is a provider that can be pointed at a different carrier account.
 */
function assertRetellRouting(routing, label = "retell routing") {
  if (!routing || typeof routing !== "object") throw new Error(`${label}: routing configuration is required.`);
  // forEach rather than a loop keyword: the no-retry ratchet on this file bans
  // `for (` outright, and a validation loop is not worth an exception to a rule
  // whose whole value is that it has none.
  RETELL_ROUTING_KEYS.forEach((key) => {
    if (typeof routing[key] !== "string" || !routing[key].trim()) {
      throw new Error(`${label}: ${key} must be a non-empty string supplied from server-side configuration.`);
    }
  });
  if (!isE164(routing.fromNumber)) {
    throw new Error(`${label}: fromNumber must be E.164.`);
  }
  return routing;
}

/**
 * THE EXACT REQUEST BODY, built from an already-authorised execution.
 *
 * Pure. No clock, no entropy, no I/O — the same execution always produces the
 * same payload, which is what lets a test assert the destination rather than
 * hope about it.
 *
 * ── THE DESTINATION HAS EXACTLY ONE SOURCE ──────────────────────────
 * `to_number` is `execution.destination`, which the executor took straight off
 * the slip the pre-dial gate minted. There is no parameter, no override, no
 * fallback and no second number anywhere in this function. A caller who wants a
 * different number has to obtain a different authorisation.
 */
function buildRetellCallPayload({ execution, routing } = {}) {
  if (!execution || typeof execution !== "object") throw new Error("buildRetellCallPayload requires an execution.");
  assertRetellRouting(routing);

  if (!isE164(execution.destination)) {
    throw new Error("buildRetellCallPayload refused: the execution carries no usable E.164 destination.");
  }
  // CORRELATION IS NOT OPTIONAL. A request that reaches a provider without the
  // durable key is one whose lost response would be unreconcilable, so it
  // cannot be built at all. This fails loudly here rather than quietly at
  // reconciliation time, months later, with a telephone call in between.
  if (typeof execution.dispatchId !== "string" || !execution.dispatchId.trim()) {
    throw new Error(
      "buildRetellCallPayload refused: the execution carries no dispatchId. Without the durable LAQ5 " +
        "identity in the payload, a lost response leaves a call nothing can be matched back to."
    );
  }
  if (execution.destination === routing.fromNumber) {
    // Cheap, and it closes a genuinely bad failure: a misconfigured from-number
    // equal to the target would have us ring ourselves and bill for it.
    throw new Error("buildRetellCallPayload refused: the destination is the outbound number.");
  }

  return Object.freeze({
    from_number: routing.fromNumber,
    to_number: execution.destination,
    override_agent_id: routing.agentId,
    // ── CORRELATION. Retell echoes metadata back on call events. ─────
    //
    // aida_dispatch_id is THE LAQ5 PRIMARY KEY, verbatim: not hashed, not
    // truncated, not derived, and not the execution id. It is the field that
    // makes the worst case survivable — the provider accepts, our HTTP response
    // is lost, provider_ref is never written, and the only thing tying the
    // eventual webhook to an unresolved dispatch is what we put in here.
    //
    // A reconciler must be able to take this value and look the dispatch up
    // DIRECTLY. Anything that has to be recomputed to be matched — a hash, a
    // prefix, a truncation — puts a second copy of a derivation in a second
    // file and makes correlation depend on the two never diverging.
    //
    // aida_execution_id is kept beside it, unchanged, because it names this
    // attempt in logs. It is not a substitute and must never become one.
    metadata: Object.freeze({
      aida_purpose: "locksmith_acquisition",
      aida_dispatch_id: execution.dispatchId || null,
      aida_execution_id: execution.executionId || null,
      aida_prospect_id: execution.prospectId || null,
    }),
    // Variables the agent may interpolate. Business name only: nothing here
    // carries a permission, a policy answer or a second number.
    retell_llm_dynamic_variables: Object.freeze({
      business_name: execution.businessName || "",
      authorised_at: execution.authorisedAt || "",
    }),
  });
}

/** Definitive refusal, ambiguous, or neither (an unrecognised code). */
function classifyProviderFailure(code) {
  if (DEFINITIVE_FAILURE_CODES.includes(code)) return "refused";
  if (AMBIGUOUS_FAILURE_CODES.includes(code)) return "ambiguous";
  // FAIL TOWARDS AMBIGUITY. An unrecognised failure is one nobody has reasoned
  // about, and the safe reading of "I do not know what this means" is "I do not
  // know whether a telephone rang".
  return "ambiguous";
}

/**
 * Map a voice-platform-port result to the acquisition provider vocabulary.
 *
 * Throws AmbiguousSubmission for anything that might have placed a call.
 */
function mapRetellResponse(response) {
  if (!response || typeof response !== "object") {
    throw new AmbiguousSubmission("The Retell transport returned nothing recognisable, so whether a call was placed is unknown.");
  }

  if (response.ok === true) {
    const callId = response.resource && response.resource.id ? String(response.resource.id) : null;
    if (!callId) {
      // Accepted, but we did not learn the one identifier that makes the call
      // findable afterwards. Treated as ambiguous rather than accepted: a
      // successful dispatch we cannot reconcile is worse than an unknown one,
      // because it looks settled.
      throw new AmbiguousSubmission(
        "Retell reported success without a call id, so the call cannot be reconciled afterwards.",
        { providerRequestId: response.providerRequestId || null }
      );
    }
    return Object.freeze({
      status: PROVIDER_STATUS.ACCEPTED,
      accepted: true,
      reason: null,
      message: "Retell accepted the call request. THIS IS NOT EVIDENCE THAT ANYBODY WAS CONTACTED.",
      providerRef: callId,
      providerRequestId: response.providerRequestId || null,
    });
  }

  const code = response.error && response.error.code ? response.error.code : null;
  const providerRequestId = response.providerRequestId || (response.error && response.error.providerRequestId) || null;

  if (classifyProviderFailure(code) === "ambiguous") {
    throw new AmbiguousSubmission(
      `Retell did not give a usable answer (${code || "no code"}), so whether a call was placed is UNKNOWN. It was not retried.`,
      { code, providerRequestId }
    );
  }

  return Object.freeze({
    status: PROVIDER_STATUS.REFUSED,
    accepted: false,
    reason: code || "provider_refused",
    message: "Retell refused the call request. Nothing was dialled.",
    providerRef: null,
    providerRequestId,
  });
}

/**
 * THE PROVIDER.
 *
 * `live` is the literal `false`, not a parameter, not derived from whether a
 * transport was supplied, and not settable by a caller. Making acquisition
 * calling possible is therefore a visible edit to this line that a reviewer has
 * to approve — which is the same rule E-7A set for the disabled provider, and
 * the reason the live-call-impossibility ratchet still passes with this file in
 * the repository.
 *
 * @param {object}   routing    { agentId, fromNumber } from server-side config
 * @param {function} [transport] injected submitter. Absent → every submit refuses.
 */
function createRetellAcquisitionProvider({ routing, transport = null } = {}) {
  assertRetellRouting(routing);

  return Object.freeze({
    name: "retell",

    // ── NOT LIVE. See the note above. ──────────────────────────────
    live: false,

    describe: () =>
      "The Retell acquisition provider. It builds the exact outbound call request and maps the " +
      "response, and it states live: false — no transport is wired anywhere in this repository, so it " +
      "reaches nothing. Enabling acquisition calling is a founder-authorised milestone, not configuration.",

    /** The request that WOULD be sent. For proofs and for a founder to read. */
    describeSubmission: (execution) => buildRetellCallPayload({ execution, routing }),

    async submit(execution) {
      const payload = buildRetellCallPayload({ execution, routing });

      if (typeof transport !== "function") {
        // The ordinary state of this repository.
        return Object.freeze({
          status: PROVIDER_STATUS.REFUSED,
          accepted: false,
          reason: "acquisition_retell_transport_absent",
          message:
            "No Retell transport is wired to the acquisition provider, so nothing was submitted. " +
            "Compliance may well have permitted this call; the means to place it is deliberately absent.",
          providerRef: null,
        });
      }

      // ONE call. No loop, no timer, no second attempt on any outcome.
      const response = await transport({ payload, idempotencyKey: execution.executionId || null });
      return mapRetellResponse(response);
    },
  });
}

module.exports = {
  createRetellAcquisitionProvider,
  buildRetellCallPayload,
  mapRetellResponse,
  classifyProviderFailure,
  assertRetellRouting,
  AmbiguousSubmission,
  RETELL_ROUTING_KEYS,
  DEFINITIVE_FAILURE_CODES,
  AMBIGUOUS_FAILURE_CODES,
};

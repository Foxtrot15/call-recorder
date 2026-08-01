// AIDA Locksmith Acquisition — the discovery adapter contract (A1).
//
//   registerDiscoveryAdapter(name, { requiresNetwork, origin, run })
//   discoverProspects({ adapter, query, now, ledger, capturedBy })
//
// The pipeline's first step is "business discovered". This module owns the seam
// between "how did we find candidate businesses?" and everything downstream, so
// that changing the former never changes the latter.
//
// THIS BUILD SHIPS EXACTLY ONE ADAPTER: the deterministic fixture. There is no
// search adapter, no crawler, no directory client — and the registry will not
// accept one, because registerDiscoveryAdapter REFUSES any adapter that
// declares `requiresNetwork: true` while the offline boundary is closed
// (src/config/acquisition.js).
//
// That refusal is the point. "We haven't written the crawler yet" is a state
// that changes the moment somebody writes a crawler. "The registry rejects
// network adapters, and the constant that would permit them is hardcoded and
// has no env override" is a state that changes only through a reviewable code
// change that deletes a line with a comment explaining why it is there.
//
// WHAT AN ADAPTER MUST DO — the contract the fixture demonstrates and any
// future adapter must also satisfy:
//   1. Return CANDIDATES, never prospects. A candidate is raw; this module
//      validates it, builds the prospect and writes the evidence.
//   2. Declare its own provenance. Every candidate carries the sources it came
//      from; a candidate with no source is rejected here, not stored and
//      cleaned up later.
//   3. Never guess. A business with no published phone yields a candidate with
//      no phone, which becomes a review gap — not a plausible-looking number.
//   4. Be deterministic for the same input, so the whole pipeline is testable
//      without a network.
//
// Pure + dep-free. See test/acquisition-discovery.test.js.

const S = require("./acquisition-schema");
const { EXTERNAL_ACCESS_SUPPORTED, acquisitionReady } = require("../config/acquisition");
const { createProspect } = require("./acquisition-prospect");
const { summariseSources } = require("./acquisition-source");

const adapters = new Map();

/**
 * Register a discovery adapter.
 *
 * @param {string} name
 * @param {object} spec
 * @param {boolean} spec.requiresNetwork  MUST be declared. An adapter that
 *                                        needs the outside world says so, and
 *                                        is refused while the boundary is shut.
 * @param {string} spec.origin            a DISCOVERY_ORIGINS value — how
 *                                        businesses found this way entered the
 *                                        system, recorded on every prospect.
 * @param {function} spec.run             ({ query }) => candidate[]
 */
function registerDiscoveryAdapter(name, spec) {
  if (!name || typeof name !== "string") throw new Error("a discovery adapter needs a name");
  if (!spec || typeof spec !== "object") throw new Error("a discovery adapter needs a spec object");
  if (typeof spec.run !== "function") throw new Error("a discovery adapter needs a run() function");

  if (typeof spec.requiresNetwork !== "boolean") {
    throw new Error(
      `discovery adapter "${name}" must declare requiresNetwork: true or false. ` +
        "An adapter that does not say whether it touches the network cannot be trusted not to."
    );
  }
  if (spec.requiresNetwork && !EXTERNAL_ACCESS_SUPPORTED) {
    throw new Error(
      `discovery adapter "${name}" requires network access, which this build does not have. ` +
        "The acquisition engine runs offline: use a fixture or an operator import."
    );
  }
  if (!S.DISCOVERY_ORIGINS.includes(spec.origin)) {
    throw new Error(`discovery adapter "${name}" declared an unknown origin "${String(spec.origin).slice(0, 40)}".`);
  }

  adapters.set(name, Object.freeze({ name, requiresNetwork: spec.requiresNetwork, origin: spec.origin, run: spec.run }));
}

function listDiscoveryAdapters() {
  return [...adapters.keys()];
}

function describeDiscoveryAdapters() {
  return [...adapters.values()].map((a) => ({ name: a.name, origin: a.origin, requiresNetwork: a.requiresNetwork }));
}

// ── Candidate → prospect + evidence ─────────────────────────────────

/**
 * Turn one raw candidate into a prospect and write its evidence.
 * Returns { ok:true, prospect, evidence } or { ok:false, code, message, errors }.
 */
function admitCandidate(candidate, { origin, adapterName, ledger, now, capturedBy, captureMode }) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, code: "candidate_invalid", message: "A discovery adapter returned something that is not a candidate object." };
  }

  // Provenance first: a candidate with no usable source is refused outright.
  // Storing it "for later" is how an unsourced business ends up in a batch.
  const sources = summariseSources(candidate.sourceRefs);
  if (sources.sources.length === 0) {
    return {
      ok: false,
      code: "candidate_unsourced",
      message: `"${String(candidate.businessName || "(unnamed)").slice(0, 60)}" was discovered with no usable source, so it cannot be admitted.`,
      detail: sources.unusable,
    };
  }

  const built = createProspect({ ...candidate, origin, discoveredAt: now().toISOString(), discoveredBy: adapterName });
  if (!built.ok) {
    return { ok: false, code: "candidate_invalid", message: `"${String(candidate.businessName || "(unnamed)").slice(0, 60)}" is not a valid prospect.`, errors: built.errors };
  }

  const prospect = built.prospect;
  const written = [];

  // Evidence is written for every claim the candidate makes. The ledger
  // validates each row and THROWS if it cannot store one — which propagates,
  // because a prospect whose evidence failed to persist must not exist.
  const claims = [];
  if (prospect.businessName) claims.push({ kind: "business_name", value: prospect.businessName });
  if (prospect.legalName) claims.push({ kind: "legal_name", value: prospect.legalName });
  if (prospect.abn) claims.push({ kind: "abn", value: prospect.abn });
  if (prospect.tradeCategory) claims.push({ kind: "trade_category", value: prospect.tradeCategory });
  if (prospect.suburb || prospect.region) claims.push({ kind: "address", value: [prospect.suburb, prospect.state, prospect.postcode].filter(Boolean).join(" ") || prospect.region });
  for (const phone of prospect.phones) claims.push({ kind: "phone", value: phone.raw, note: phone.label });

  // PER-CLAIM ATTRIBUTION, AND WHY IT IS STRICT
  //
  // Each evidence row records the source THAT PARTICULAR CLAIM came from — not
  // the candidate's best source. The difference is the whole ballgame: if a
  // business name came from its own website but the phone number came from an
  // aggregator, recording both as "official website" would manufacture exactly
  // the confidence this pipeline exists to withhold, and assessEvidence's
  // `phoneFromOfficialSource` would start lying.
  //
  // So: a candidate with more than one source MUST say which source each claim
  // came from. If it does not, the candidate is refused rather than guessed at.
  // A candidate with exactly one source is unambiguous and needs no declaration.
  const perClaimSource = candidate.evidenceSources && typeof candidate.evidenceSources === "object" ? candidate.evidenceSources : {};
  const refs = candidate.sourceRefs;
  const soleRef = refs.length === 1 ? refs[0] : null;

  const unattributed = claims.filter((c) => !perClaimSource[c.kind]).map((c) => c.kind);
  if (!soleRef && unattributed.length > 0) {
    return {
      ok: false,
      code: "claim_source_ambiguous",
      message:
        `"${String(candidate.businessName || "(unnamed)").slice(0, 60)}" cites ${refs.length} sources but does not say which one each fact came from ` +
        `(${unattributed.join(", ")}). Attributing a fact to the wrong source would overstate how well we know it.`,
    };
  }

  for (const claim of claims) {
    written.push(
      ledger.record({
        prospectId: prospect.prospectId,
        kind: claim.kind,
        captureMode,
        value: claim.value,
        note: claim.note || null,
        observedAt: candidate.observedAt || now().toISOString(),
        capturedBy,
        source: perClaimSource[claim.kind] || soleRef,
      })
    );
  }

  return { ok: true, prospect, evidence: written };
}

/**
 * Run a discovery adapter and admit everything it produced.
 *
 * Returns { ok, prospects, evidence, rejected, adapter } — `rejected` carries
 * every candidate that could not be admitted and why. A partial result is the
 * expected outcome, not a failure: real discovery datasets contain records that
 * cannot be used, and hiding them would hide the data-quality signal.
 */
function discoverProspects({ adapter = "fixture-v1", query = {}, now, ledger, capturedBy = "discovery", env = process.env } = {}) {
  const gate = acquisitionReady("discovery", env);
  if (!gate.ok) return { ok: false, code: gate.code, message: gate.message };

  if (typeof now !== "function") {
    return { ok: false, code: "clock_missing", message: "discoverProspects requires an injected now()." };
  }
  if (!ledger || typeof ledger.record !== "function") {
    return { ok: false, code: "ledger_missing", message: "discoverProspects requires an evidence ledger — discovery without evidence is not permitted." };
  }

  const spec = adapters.get(adapter);
  if (!spec) {
    return { ok: false, code: "unknown_adapter", message: `No discovery adapter named "${String(adapter).slice(0, 60)}".` };
  }

  // Belt and braces: the registry already refused network adapters, and we
  // check again at run time in case a future build flips the constant without
  // revisiting every call site.
  if (spec.requiresNetwork && !EXTERNAL_ACCESS_SUPPORTED) {
    return { ok: false, code: "network_unavailable", message: `Adapter "${adapter}" needs network access, which this build does not have.` };
  }

  let candidates;
  try {
    candidates = spec.run({ query });
  } catch (err) {
    return { ok: false, code: "adapter_failed", message: `Discovery adapter failed: ${err.message}` };
  }
  if (!Array.isArray(candidates)) {
    return { ok: false, code: "adapter_output_invalid", message: `Adapter "${adapter}" did not return a list of candidates.` };
  }

  const captureMode = spec.origin === "fixture" ? "fixture" : spec.origin === "operator_import" ? "operator_import" : "operator_entry";

  const prospects = [];
  const evidence = [];
  const rejected = [];

  for (const candidate of candidates) {
    let admitted;
    try {
      admitted = admitCandidate(candidate, { origin: spec.origin, adapterName: adapter, ledger, now, capturedBy, captureMode });
    } catch (err) {
      // An evidence write that fails is fatal FOR THAT CANDIDATE. It is
      // recorded as rejected rather than silently dropped, and the prospect is
      // not created — no evidence, no prospect.
      rejected.push({ businessName: candidate && candidate.businessName, code: err.code || "evidence_write_failed", message: err.message });
      continue;
    }
    if (!admitted.ok) {
      rejected.push({ businessName: candidate && candidate.businessName, code: admitted.code, message: admitted.message, errors: admitted.errors, detail: admitted.detail });
      continue;
    }
    prospects.push(admitted.prospect);
    evidence.push(...admitted.evidence);
  }

  return {
    ok: true,
    adapter,
    origin: spec.origin,
    prospects,
    evidence,
    rejected,
    // Explicit and asserted by test: discovery never approves and never calls.
    approved: false,
  };
}

module.exports = {
  registerDiscoveryAdapter,
  listDiscoveryAdapters,
  describeDiscoveryAdapters,
  discoverProspects,
  admitCandidate,
};

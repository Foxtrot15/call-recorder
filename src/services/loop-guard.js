// VoIP Phase 1a — PSTN loop guard (INV-1, decision D10).
//
// THE INVARIANT: while a client has CFU active (clients.voip_enabled = true),
// the platform must NEVER place a PSTN call to that client's real_number —
// the carrier would forward our own call straight back to /inbound/voice,
// creating an infinite loop (VOIP_V2_ARCHITECTURE.md §2). There is no header
// or caller-ID trick that avoids this; refusing the dial is the only fix.
//
// Deliberate design points:
//   * INDEPENDENT of the VOIP_V2_ENABLED server flag. That flag gates the
//     VoIP feature; this guard is a safety property. CFU is carrier-side
//     state — if the server flag is flipped off while a client's *21* rule
//     is still active, a PSTN dial to their number STILL loops. So the guard
//     keys off clients.voip_enabled alone (refines D7 for guard purposes).
//   * Fail-safe before provisioning: the voip_enabled column ships in
//     supabase/sql/phase1a_add_voip_enabled.sql (review-only, human-applied).
//     Until it exists, queries error with 42703 — handled by treating the
//     fleet as having no VoIP clients (correct: no column ⇒ no client can be
//     flagged ⇒ no CFU cutover has happened under our runbook).
//   * D10 / backlog P2-5: the owner's number comes from the clients row,
//     falling back to the CLIENT_REAL_NUMBER env var only when no row exists
//     (legacy single-tenant transitional state, logged).
//
// Structure: pure decision functions (unit-tested without a DB) + a thin
// fetch adapter. supabase is required lazily inside the adapter so the pure
// parts load in test environments without node_modules.

// Same normalisation algorithm as inbound.js's normaliseAU/normaliseForMatch
// (owner recognition). Duplicated here rather than refactoring inbound.js —
// the inbound voicemail pipeline is out of scope for Phase 1a by explicit
// constraint. Dedup into a shared services/phone.js is a Phase 1b follow-up.
function normalisePhone(n) {
  if (!n) return null;
  const digits = String(n).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("04") && digits.length === 10) return "+61" + digits.slice(1);
  if (digits.startsWith("0") && digits.length === 10) return "+61" + digits.slice(1);
  if (digits.startsWith("61") && digits.length === 11) return "+" + digits;
  return "+" + digits;
}

// Find the VoIP-enabled client (if any) whose real_number matches `number`.
function findVoipClientByNumber(number, voipClients) {
  const target = normalisePhone(number);
  if (!target) return null;
  return (
    (voipClients || []).find((c) => normalisePhone(c.real_number) === target) || null
  );
}

/**
 * Pure verdict for POST /call/initiate (two PSTN legs: owner + destination).
 *
 * @param clientRow      the caller's clients row ({slug, real_number,
 *                       voip_enabled}) or null if none exists
 * @param voipClients    all rows with voip_enabled = true ([{slug, real_number}])
 * @param destination    the number the operator asked to call
 * @param envRealNumber  process.env.CLIENT_REAL_NUMBER (legacy fallback)
 * @returns { blocked, reason, ownerNumber, ownerNumberSource }
 */
function decidePstnDial({ clientRow, voipClients, destination, envRealNumber }) {
  const ownerNumber = clientRow?.real_number || envRealNumber || null;
  const ownerNumberSource = clientRow?.real_number ? "clients.real_number" : "CLIENT_REAL_NUMBER env (legacy fallback)";

  // INV-1 case 1: this client is VoIP/CFU — the owner leg of this endpoint
  // dials their real_number by construction, so the whole request is a loop.
  if (clientRow?.voip_enabled === true) {
    return {
      blocked: true,
      reason: `client '${clientRow.slug}' is VoIP-enabled (CFU active) — dialling their real number would loop; calls must be placed from the app`,
      ownerNumber,
      ownerNumberSource,
    };
  }

  // INV-1 case 2: the owner leg's target happens to be some OTHER
  // VoIP-enabled client's real_number (misconfiguration / shared numbers).
  const ownerHit = findVoipClientByNumber(ownerNumber, voipClients);
  if (ownerHit) {
    return {
      blocked: true,
      reason: `owner leg targets VoIP-enabled client '${ownerHit.slug}''s real number — PSTN dial would loop`,
      ownerNumber,
      ownerNumberSource,
    };
  }

  // INV-1 case 3: the requested destination is a VoIP-enabled client's
  // real_number — the destination leg would loop.
  const destHit = findVoipClientByNumber(destination, voipClients);
  if (destHit) {
    return {
      blocked: true,
      reason: `destination is VoIP-enabled client '${destHit.slug}''s real number — PSTN dial would loop`,
      ownerNumber,
      ownerNumberSource,
    };
  }

  return { blocked: false, reason: null, ownerNumber, ownerNumberSource };
}

/**
 * Pure verdict for a single outbound dial target (used by the owner bridge
 * /inbound/connect, where the destination is the only PSTN leg we add).
 */
function checkOutboundDialTarget(destination, voipClients) {
  const hit = findVoipClientByNumber(destination, voipClients);
  return hit
    ? { blocked: true, reason: `destination is VoIP-enabled client '${hit.slug}''s real number — PSTN dial would loop` }
    : { blocked: false, reason: null };
}

// ── DB adapter ───────────────────────────────────────────────────────────────

const COLUMN_MISSING = "42703";
let warnedColumnMissing = false;

function isColumnMissing(error) {
  return Boolean(error && (error.code === COLUMN_MISSING || /voip_enabled/.test(error.message || "")));
}

/**
 * Load everything decidePstnDial needs. Never throws for the
 * column-not-yet-provisioned case (see header note); other DB errors throw so
 * callers fail loudly rather than dialling on unknown state.
 */
async function fetchLoopGuardData(clientSlug) {
  const supabase = require("./supabase"); // lazy: keeps pure parts test-loadable

  // All VoIP-enabled clients (the guarded number set).
  let voipClients = [];
  {
    const { data, error } = await supabase
      .from("clients")
      .select("slug, real_number, voip_enabled")
      .eq("voip_enabled", true);
    if (error) {
      if (!isColumnMissing(error)) throw new Error(`loop-guard fleet query failed: ${error.message}`);
      if (!warnedColumnMissing) {
        warnedColumnMissing = true;
        console.warn("⚠️  loop-guard: clients.voip_enabled column not provisioned yet (phase1a_add_voip_enabled.sql) — treating fleet as non-VoIP");
      }
    } else {
      voipClients = data || [];
    }
  }

  // The calling operator's client row.
  let clientRow = null;
  if (clientSlug) {
    const { data, error } = await supabase
      .from("clients")
      .select("slug, real_number, voip_enabled")
      .eq("slug", clientSlug)
      .single();
    if (error && !isColumnMissing(error) && error.code !== "PGRST116") {
      throw new Error(`loop-guard client query failed: ${error.message}`);
    }
    if (isColumnMissing(error)) {
      // Retry without the not-yet-provisioned column.
      const retry = await supabase
        .from("clients")
        .select("slug, real_number")
        .eq("slug", clientSlug)
        .single();
      clientRow = retry.data || null;
    } else {
      clientRow = data || null;
    }
  }

  return { clientRow, voipClients };
}

module.exports = {
  normalisePhone,
  findVoipClientByNumber,
  decidePstnDial,
  checkOutboundDialTarget,
  fetchLoopGuardData,
};

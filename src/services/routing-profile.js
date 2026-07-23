// WCS-1b — routing-profile persistence for the call-setup flow
// (docs/WEB_CALL_SETUP_SPEC.md; table: supabase/sql/
// wcs1b_create_client_phone_routing_profiles.sql, review-only until applied).
//
// Pure field-building/shaping logic up top (unit-testable, no deps); thin DB
// adapter below with a lazy supabase require — same structure as devices.js.
// In WCS-1b-i NOTHING imports this module: it ships dormant, exactly like
// divert-codes.js did in WCS-1a. Routes arrive in WCS-1b-ii behind the flag.
//
// Tenancy invariants (spec I1–I3):
//   * Every DB call filters on client_id — the caller passes req.clientId and
//     nothing else. There is deliberately NO function that takes a row id and
//     no id in any public shape, so id-based cross-tenant access can't exist.
//   * clients is touched by exactly one function, getClientAidaNumber, and
//     only as a SELECT of twilio_number. business_number lives on the profile
//     row alone and is NEVER written to clients.real_number (owner recognition
//     and the INV-1 loop guard read that column).
//   * generated_codes stores the buildDivertCodes result verbatim (including
//     templateVersion) — the snapshot IS the audit record of what the user saw.

const STATUS_TIMESTAMP_FIELDS = {
  // Which extra timestamp column each route-facing status action stamps.
  // claimed_done_at / test_passed_at record SELF-REPORTED claims (spec §1) —
  // the column being set is not evidence the diversion works.
  claim_done: "claimed_done_at",
  report_test_passed: "test_passed_at",
  needs_help: null,
  back_to_instructions: null,
};

/**
 * Build the upsert payload for a profile save (PUT). Every successful save
 * RESETS the generated snapshot and status: edited inputs must never leave
 * stale codes (an old number in a live instruction is worse than no
 * instruction). Regeneration is one click, so bluntness is the safe trade.
 */
function buildProfileUpsertFields(clientId, { businessNumber, phonePlatform, carrier, loops, noAnswerDelaySeconds }, nowIso) {
  return {
    client_id: clientId,
    business_number: businessNumber || null, // already normalised via validateOptionalAuNumber
    phone_platform: phonePlatform,
    carrier,
    divert_no_answer: loops.no_answer === true,
    divert_busy: loops.busy === true,
    divert_unreachable: loops.unreachable === true,
    no_answer_delay_seconds: noAnswerDelaySeconds == null ? null : noAnswerDelaySeconds,
    // The reset: snapshot cleared, status back to the start, claim stamps gone.
    setup_status: "not_started",
    generated_codes: null,
    target_number: null,
    needs_help_note: null,
    instructions_generated_at: null,
    claimed_done_at: null,
    test_passed_at: null,
    status_updated_at: nowIso,
    updated_at: nowIso,
    // created_at deliberately absent: DB default on insert, preserved on update.
  };
}

/**
 * Build the update payload for a successful generate. The snapshot is the
 * exact buildDivertCodes result; target_number echoes result.target (the
 * server-derived AIDA number). A fresh generate also closes any open
 * needs_help episode — new instructions supersede the old stuck state.
 */
function buildGeneratedCodesFields(result, nowIso) {
  return {
    generated_codes: result,
    target_number: result.target,
    setup_status: "instructions_generated",
    needs_help_note: null,
    instructions_generated_at: nowIso,
    status_updated_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Build the update payload for a status action the route has ALREADY
 * validated via divert-codes' applyStatusAction (legality lives in the
 * module; this maps the approved transition to columns). needs_help stores
 * the note; leaving needs_help clears it — the note belongs to that episode.
 */
function buildStatusUpdateFields({ action, nextStatus, note }, nowIso) {
  const fields = {
    setup_status: nextStatus,
    status_updated_at: nowIso,
    updated_at: nowIso,
  };
  const stamp = STATUS_TIMESTAMP_FIELDS[action];
  if (stamp) fields[stamp] = nowIso;
  if (action === "needs_help") {
    fields.needs_help_note = note || null;
  } else {
    fields.needs_help_note = null;
  }
  return fields;
}

/** Shape a DB row for API responses — camelCase, and NO id (spec: no id-based access). */
function toPublicProfile(row) {
  if (!row) return null;
  return {
    businessNumber: row.business_number || null,
    phonePlatform: row.phone_platform || null,
    carrier: row.carrier || null,
    loops: {
      no_answer: row.divert_no_answer === true,
      busy: row.divert_busy === true,
      unreachable: row.divert_unreachable === true,
    },
    noAnswerDelaySeconds: row.no_answer_delay_seconds == null ? null : row.no_answer_delay_seconds,
    targetNumber: row.target_number || null,
    generatedCodes: row.generated_codes || null,
    setupStatus: row.setup_status,
    needsHelpNote: row.needs_help_note || null,
    statusUpdatedAt: row.status_updated_at || null,
    instructionsGeneratedAt: row.instructions_generated_at || null,
    claimedDoneAt: row.claimed_done_at || null, // self-reported
    testPassedAt: row.test_passed_at || null,   // self-reported
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── DB adapter ───────────────────────────────────────────────────────────────

function tableMissing(error) {
  return Boolean(
    error &&
      (error.code === "42P01" ||
        /client_phone_routing_profiles.*does not exist|relation .*client_phone_routing_profiles/i.test(error.message || ""))
  );
}

function provisioningError() {
  return new Error(
    "client_phone_routing_profiles table not provisioned — apply supabase/sql/wcs1b_create_client_phone_routing_profiles.sql first"
  );
}

/** The caller's profile row, or null when none exists yet. */
async function getProfile(clientId) {
  const supabase = require("./supabase"); // lazy — keeps pure parts test-loadable
  const { data, error } = await supabase
    .from("client_phone_routing_profiles")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`routing profile lookup failed: ${error.message}`);
  }
  return data || null;
}

/**
 * Save the user-editable inputs (single-statement upsert on client_id — no
 * select-then-insert race). Applies the reset semantics from
 * buildProfileUpsertFields. Returns the saved row.
 */
async function saveProfileInputs(clientId, inputs, nowIso = new Date().toISOString()) {
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from("client_phone_routing_profiles")
    .upsert(buildProfileUpsertFields(clientId, inputs, nowIso), { onConflict: "client_id" })
    .select()
    .single();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`routing profile save failed: ${error.message}`);
  }
  return data;
}

/**
 * Persist a generate snapshot onto the caller's existing profile.
 * Returns { row } or { notFound: true } when no profile exists yet (the
 * route turns that into "save your setup details first"). Generate is
 * deliberately last-write-wins (allowed from every status — the WCS-1a
 * machine's universal recovery), so no optimistic status check here.
 */
async function saveGeneratedCodes(clientId, result, nowIso = new Date().toISOString()) {
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from("client_phone_routing_profiles")
    .update(buildGeneratedCodesFields(result, nowIso))
    .eq("client_id", clientId)
    .select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`routing profile snapshot failed: ${error.message}`);
  }
  if (!data || data.length === 0) return { notFound: true };
  return { row: data[0] };
}

/**
 * Apply an already-validated status transition with optimistic concurrency:
 * the update matches BOTH client_id and the status the decision was made
 * against, so two racing actions can't double-apply — zero rows updated
 * means the row moved underneath the caller ({ conflict: true } → 409,
 * client refetches).
 */
async function applyStatus(clientId, { action, fromStatus, nextStatus, note }, nowIso = new Date().toISOString()) {
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from("client_phone_routing_profiles")
    .update(buildStatusUpdateFields({ action, nextStatus, note }, nowIso))
    .eq("client_id", clientId)
    .eq("setup_status", fromStatus)
    .select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`routing profile status update failed: ${error.message}`);
  }
  if (!data || data.length === 0) return { conflict: true };
  return { row: data[0] };
}

/**
 * The server-derived AIDA forwarding target: clients.twilio_number for this
 * tenant. READ-ONLY — this is the module's only touch of the clients table,
 * and it must stay a SELECT (spec I3). Any failure (no row, null value,
 * column not provisioned in dev, DB error) reports not-provisioned — fail
 * closed for feature access, same philosophy as devices.isClientVoipEnabled.
 */
async function getClientAidaNumber(clientId) {
  try {
    const supabase = require("./supabase");
    const { data, error } = await supabase
      .from("clients")
      .select("twilio_number")
      .eq("slug", clientId)
      .single();
    if (error || !data || !data.twilio_number) return { provisioned: false, twilioNumber: null };
    return { provisioned: true, twilioNumber: data.twilio_number };
  } catch {
    return { provisioned: false, twilioNumber: null };
  }
}

module.exports = {
  STATUS_TIMESTAMP_FIELDS,
  buildProfileUpsertFields,
  buildGeneratedCodesFields,
  buildStatusUpdateFields,
  toPublicProfile,
  tableMissing,
  provisioningError,
  getProfile,
  saveProfileInputs,
  saveGeneratedCodes,
  applyStatus,
  getClientAidaNumber,
};

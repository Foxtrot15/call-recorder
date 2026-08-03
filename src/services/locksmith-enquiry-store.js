// AIDA — caller enquiry persistence (M7J).
//
// The thin DB adapter behind services/locksmith-caller-enquiry.js. House style:
// a pure decision core plus a thin adapter, with Supabase lazily required so the
// core stays testable on a bare checkout with no node_modules.
//
// ─── IDEMPOTENCY IS ENFORCED BY THE DATABASE ────────────────────────
// The insert relies on the unique index `le_idempotency` on
// (client_id, environment, idempotency_key). A duplicate is not an error to
// swallow — it is the CORRECT answer, and it is reported back as
// `created: false` so the agent says "already recorded" rather than reading the
// whole enquiry back a second time.
//
// This uses upsert-with-ignore rather than SELECT-then-INSERT on purpose: two
// tool calls racing on the same call would both see "not found" and both write.
// The index is the only thing that can actually decide.
//
// ─── SERVICE ROLE ONLY ──────────────────────────────────────────────
// The table has RLS enabled and no policies, so this path works only with the
// service-role client — the same one every other server-side write uses. There
// is no browser read path and no anon access.

const STORE_VERSION = "locksmith-enquiry-store-2026-08-03";

/** Columns we are willing to write. An allow-list, not a spread of the row. */
const WRITABLE = Object.freeze([
  "client_id", "environment", "source", "provider",
  "provider_call_id", "provider_agent_id", "profile_version",
  "caller_name", "callback_number", "suburb", "street_address",
  "property_type", "service_id", "problem_description", "property_secure",
  "desired_timing", "urgency", "idempotency_key",
]);

function pickWritable(row) {
  const out = {};
  for (const key of WRITABLE) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

/**
 * The production store.
 *
 * Returns { ok, created, id }:
 *   created true   a new row was inserted
 *   created false  the idempotency key already existed — still a success
 *
 * Throws only on a genuine database failure, which captureEnquiry turns into a
 * truthful "could not save" for the agent.
 */
function createEnquiryStore(deps = {}) {
  // services/supabase.js exports the service-role client ITSELF, not a factory.
  // An earlier version invoked a non-existent factory method on that export —
  // a function defined nowhere in this codebase. It failed safe (captureEnquiry
  // catches, the agent says it could not save) but it would have failed EVERY
  // time, silently, on a live call. Caught by the M7J-LV pre-call route proof
  // before any caller met it; a test now pins the export shape.
  const getClient = deps.getClient || (() => require("./supabase"));

  return async function storeEnquiry({ row }) {
    const supabase = getClient();
    const values = pickWritable(row);

    // onConflict names the unique index's columns. ignoreDuplicates means a
    // second identical enquiry returns no row rather than raising — which is
    // how "already recorded" is distinguished from "saved".
    const { data, error } = await supabase
      .from("locksmith_enquiries")
      .upsert(values, { onConflict: "client_id,environment,idempotency_key", ignoreDuplicates: true })
      .select("id");

    if (error) {
      const err = new Error(`enquiry insert failed: ${error.message}`);
      err.code = error.code || null;
      throw err;
    }

    const inserted = Array.isArray(data) && data.length ? data[0] : null;
    if (inserted && inserted.id) return { ok: true, created: true, id: inserted.id };

    // No row came back: the conflict target already held this key. Look it up so
    // the agent can still be given a reference for the enquiry that DOES exist.
    const { data: existing, error: lookupError } = await supabase
      .from("locksmith_enquiries")
      .select("id")
      .eq("client_id", values.client_id)
      .eq("environment", values.environment)
      .eq("idempotency_key", values.idempotency_key)
      .limit(1);

    if (lookupError) {
      // The write itself succeeded (or was a genuine duplicate); only the
      // read-back failed. Report the duplicate honestly without an id rather
      // than claiming a failure that would make the agent retract a true
      // "saved" it may already have said.
      return { ok: true, created: false, id: null };
    }
    return { ok: true, created: false, id: (existing && existing[0] && existing[0].id) || null };
  };
}

/**
 * Append-only audit of every tool invocation, successful or not.
 *
 * Deliberately separate from the enquiry row: an enquiry that was REFUSED still
 * needs a trace, and a row that was never written cannot carry its own audit.
 * Reuses the existing provider event log rather than adding a second audit
 * table — one place to look when asking "what did the agent do on that call".
 */
function createToolAudit(deps = {}) {
  const logger = deps.logger || console;
  const sink = deps.sink || null;

  return async function auditToolCall(entry) {
    // Structured single-line log, house style, PII-free: ids, outcome and the
    // NAMES of any missing fields — never a caller's name, number or address.
    logger.log(
      `retell.tool.audit tool=${entry.tool} client=${entry.clientId} env=${entry.environment} ` +
        `call=${entry.providerCallId || "-"} outcome=${entry.outcome} saved=${entry.saved} ` +
        `enquiry=${entry.enquiryId || "-"} missing=${(entry.missingFields || []).join("|") || "-"} ` +
        `latency_ms=${entry.latencyMs}`
    );
    if (typeof sink === "function") await sink(entry);
  };
}

// ── Notification state transitions (M7K) ────────────────────────────
//
// THE CLAIM IS THE GUARD. `claimForNotification` moves pending -> sending in
// ONE conditional statement and reports how many rows it changed. Exactly one
// caller can win, so exactly one caller sends.
//
// A select-then-update would leave a window in which two concurrent tool calls
// both read 'pending' and both send — and the symptom is the locksmith getting
// the same 3am job twice, which nobody notices until they are annoyed.
function createNotificationStore(deps = {}) {
  const getClient = deps.getClient || (() => require("./supabase"));
  const now = deps.now || (() => new Date().toISOString());

  async function claimForNotification({ enquiryId }) {
    const supabase = getClient();
    // .eq("notification_state","pending") is the whole guard: the row must
    // still be pending at the moment of the write, not when we read it.
    const { data, error } = await supabase
      .from("locksmith_enquiries")
      // attempts is set to 1 rather than incremented. M7K claims a row exactly
      // once and never retries, so a pending row has always had 0 attempts and
      // a literal is both correct and free of a read-modify-write race. The
      // retry milestone will need an atomic increment (an RPC); it can change
      // this line and nothing else.
      .update({ notification_state: "sending", notification_attempts: 1, updated_at: now() })
      .eq("id", enquiryId)
      .eq("notification_state", "pending")
      .select("id, notification_state");

    if (error) return { ok: false, claimed: false, state: null, error: error.message };
    const claimed = Array.isArray(data) && data.length === 1;
    if (claimed) return { ok: true, claimed: true, state: "sending" };

    // Lost the race, or it was never pending. Report what it actually holds so
    // the caller can tell "already sent" from "nobody configured".
    const { data: current } = await supabase
      .from("locksmith_enquiries").select("notification_state").eq("id", enquiryId).limit(1);
    return { ok: true, claimed: false, state: (current && current[0] && current[0].notification_state) || null };
  }

  async function markSent({ enquiryId, provider, reference }) {
    const supabase = getClient();
    const stamp = now();
    const { error } = await supabase
      .from("locksmith_enquiries")
      .update({
        notification_state: "sent",
        notified_at: stamp,
        notification_failed_at: null,
        notification_provider: provider || null,
        notification_reference: reference || null,
        last_notification_code: null,
        updated_at: stamp,
      })
      .eq("id", enquiryId);
    if (error) throw new Error(`markSent failed: ${error.message}`);
    return { ok: true };
  }

  async function markFailed({ enquiryId, provider, code }) {
    const supabase = getClient();
    const stamp = now();
    const { error } = await supabase
      .from("locksmith_enquiries")
      .update({
        notification_state: "failed",
        notification_failed_at: stamp,
        notified_at: null,
        notification_provider: provider || null,
        last_notification_code: code ? String(code).slice(0, 100) : "unknown",
        updated_at: stamp,
      })
      .eq("id", enquiryId);
    if (error) throw new Error(`markFailed failed: ${error.message}`);
    return { ok: true };
  }

  /** Nobody is configured to be told. Recorded so a sweep never chases it. */
  async function markNotRequired({ enquiryId }) {
    const supabase = getClient();
    const stamp = now();
    const { error } = await supabase
      .from("locksmith_enquiries")
      .update({ notification_state: "not_required", notified_at: null, notification_failed_at: null, updated_at: stamp })
      .eq("id", enquiryId)
      .eq("notification_state", "pending");
    if (error) throw new Error(`markNotRequired failed: ${error.message}`);
    return { ok: true };
  }

  return { claimForNotification, markSent, markFailed, markNotRequired };
}

module.exports = { STORE_VERSION, WRITABLE, pickWritable, createEnquiryStore, createToolAudit, createNotificationStore };

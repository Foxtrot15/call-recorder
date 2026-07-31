// AIDA — onboarding-call consent (M4).
//
// Consent to receive ONE onboarding call, from this business, to this number,
// now. It is deliberately narrow:
//
//   * It is NOT cold-marketing consent and never becomes it. Nothing in this
//     module produces a record that could be read as permission to ring someone
//     who did not ask.
//   * It is bound to a specific NORMALISED destination number. A different
//     number requires new consent — a typo corrected after the fact is a new
//     decision, not an amendment.
//   * The wording is VERSIONED, and the version the client actually saw is
//     stored with the consent. If the disclosure changes, old consents remain
//     evidence of what was actually agreed to.
//   * Transcription and recording are SEPARATE decisions. Transcription is
//     required for onboarding to work at all and is disclosed plainly.
//     Recording defaults OFF and stays off until the founder's legal wording is
//     settled — this module records a preference and makes no claim about
//     Australian recording law.
//   * Nothing may be pre-ticked. buildConsent refuses a payload that does not
//     carry an explicit affirmative for each required item.
//   * Expiry and revocation both make a consent unusable, and a call cannot
//     start without a usable one.
//
// Pure core + thin adapter, house style.

const crypto = require("crypto");
const { normaliseAuNumber } = require("./locksmith-profile");

const TABLE = "onboarding_call_consents";

// Versioned wording. Changing the text means adding a version, never editing
// one — an old consent must stay readable as what the client agreed to.
const DISCLOSURE_VERSIONS = Object.freeze({
  "onboarding-call-disclosure-2026-08-01": Object.freeze({
    version: "onboarding-call-disclosure-2026-08-01",
    callConsent:
      "I'm asking AIDA to ring me on the number shown above to set up my receptionist. " +
      "I understand this is an automated call from an AI assistant, not a person.",
    transcriptionConsent:
      "I understand the call will be transcribed so my answers can be written up, " +
      "and that I will see everything before anything goes live.",
    recordingConsent:
      "Optional: I'm happy for the call audio to be recorded as well as transcribed. " +
      "You do not need to agree to this, and onboarding works either way.",
    notMarketing:
      "This is only about the call you are requesting. It is not permission to " +
      "contact you for marketing, and you can change your mind at any time.",
    // Flagged, not decided. See docs/LOCKSMITH_ONBOARDING_RUNTIME_SPEC.md.
    legalReviewPending: true,
  }),
});

const CURRENT_DISCLOSURE_VERSION = "onboarding-call-disclosure-2026-08-01";

// A consent is good for one working day's worth of attempts. Long enough that a
// client can request a call and take it later; short enough that a stale
// agreement cannot be used weeks afterwards.
const CONSENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const REFUSAL_CODES = Object.freeze({
  missing: "consent_missing",
  notAffirmative: "consent_not_affirmative",
  badNumber: "destination_number_invalid",
  numberChanged: "destination_number_changed",
  revoked: "consent_revoked",
  expired: "consent_expired",
  exhausted: "attempt_limit_reached",
  wrongClient: "consent_client_mismatch",
  wrongSession: "consent_session_mismatch",
});

function getDisclosure(version = CURRENT_DISCLOSURE_VERSION) {
  return DISCLOSURE_VERSIONS[version] || null;
}

/**
 * An affirmative is an explicit `true`. Not "on", not "1", not a present key —
 * the client's browser must send a real boolean for a box they actually ticked.
 * This is what makes a pre-ticked or defaulted box impossible to honour.
 */
function isAffirmative(value) {
  return value === true;
}

/**
 * Build a consent record. Returns { ok, fields } or { ok:false, code, message }.
 * Pure: the caller supplies `now` and the id.
 */
function buildConsent({
  consentId,
  clientId,
  sessionId,
  userId,
  destinationNumber,
  callConsent,
  transcriptionConsent,
  recordingConsent = false,
  disclosureVersion = CURRENT_DISCLOSURE_VERSION,
  ip = null,
  userAgent = null,
}, nowIso = new Date().toISOString()) {
  if (!consentId || !clientId || !sessionId || !userId) {
    return { ok: false, code: REFUSAL_CODES.missing, message: "Consent needs a client, a session and the person giving it." };
  }
  if (!getDisclosure(disclosureVersion)) {
    return { ok: false, code: REFUSAL_CODES.missing, message: `Unknown disclosure version "${String(disclosureVersion).slice(0, 60)}".` };
  }

  // Both required items must be explicitly affirmed. Recording is optional and
  // defaults to false; an absent value is a "no", never an assumed "yes".
  if (!isAffirmative(callConsent)) {
    return { ok: false, code: REFUSAL_CODES.notAffirmative, message: "Tick the box agreeing to the call before we can ring you." };
  }
  if (!isAffirmative(transcriptionConsent)) {
    return { ok: false, code: REFUSAL_CODES.notAffirmative, message: "The call has to be transcribed for setup to work. Tick that box to continue." };
  }

  const normalised = normaliseAuNumber(destinationNumber);
  if (!normalised) {
    return { ok: false, code: REFUSAL_CODES.badNumber, message: "That is not a number we can ring. Enter an Australian mobile or landline." };
  }

  const expiresAt = new Date(new Date(nowIso).getTime() + CONSENT_TTL_MS).toISOString();

  return {
    ok: true,
    fields: {
      consent_id: consentId,
      client_id: clientId,
      session_id: sessionId,
      user_id: String(userId).slice(0, 200),
      // Both are kept: the raw value so the client can be shown exactly what
      // they typed, the normalised value so what we dial is unambiguous.
      destination_number_raw: String(destinationNumber).slice(0, 40),
      destination_number: normalised,
      // A digest of the number the consent is FOR. Comparing digests lets the
      // start-call service prove the number has not changed without passing the
      // number around.
      destination_fingerprint: crypto.createHash("sha256").update(normalised).digest("hex"),
      call_consent: true,
      transcription_consent: true,
      recording_consent: isAffirmative(recordingConsent),
      disclosure_version: disclosureVersion,
      // Recorded only because the client is asking us to ring them and a
      // dispute would turn on who asked. Bounded, and never rendered back.
      request_ip: ip ? String(ip).slice(0, 64) : null,
      request_user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
      revoked_at: null,
      revocation_reason: null,
      attempt_count: 0,
      expires_at: expiresAt,
      created_at: nowIso,
      updated_at: nowIso,
    },
  };
}

/**
 * Can this consent start a call right now? Returns { ok } or a refusal with a
 * code the caller maps to a status and a message the client can act on.
 */
function evaluateConsent({ consent, clientId, sessionId, destinationNumber = null, nowMs = Date.now() }) {
  if (!consent) return { ok: false, code: REFUSAL_CODES.missing, message: "We need your go-ahead before we can ring you." };

  if (consent.client_id !== clientId) return { ok: false, code: REFUSAL_CODES.wrongClient, message: "That consent belongs to a different account." };
  if (sessionId && consent.session_id !== sessionId) {
    return { ok: false, code: REFUSAL_CODES.wrongSession, message: "That consent was given for a different setup session." };
  }

  if (consent.revoked_at) return { ok: false, code: REFUSAL_CODES.revoked, message: "You withdrew permission for this call. Give it again if you'd like us to ring." };
  if (consent.expires_at && new Date(consent.expires_at).getTime() <= nowMs) {
    return { ok: false, code: REFUSAL_CODES.expired, message: "That permission has expired. Confirm your number again and we'll ring you." };
  }
  if ((consent.attempt_count || 0) >= MAX_ATTEMPTS) {
    return { ok: false, code: REFUSAL_CODES.exhausted, message: `We've tried ${MAX_ATTEMPTS} times. Get in touch and we'll sort it out.` };
  }

  // A changed number invalidates the consent outright — it is consent to ring
  // THAT number, not to ring the client.
  if (destinationNumber) {
    const normalised = normaliseAuNumber(destinationNumber);
    if (!normalised) return { ok: false, code: REFUSAL_CODES.badNumber, message: "That is not a number we can ring." };
    if (normalised !== consent.destination_number) {
      return { ok: false, code: REFUSAL_CODES.numberChanged, message: "That is a different number from the one you confirmed. Confirm the new one and we'll ring it." };
    }
  }

  if (consent.call_consent !== true || consent.transcription_consent !== true) {
    return { ok: false, code: REFUSAL_CODES.notAffirmative, message: "We don't have a complete go-ahead for this call." };
  }

  return { ok: true };
}

function buildRevocationFields({ reason = null } = {}, nowIso = new Date().toISOString()) {
  return {
    revoked_at: nowIso,
    revocation_reason: reason ? String(reason).slice(0, 500) : null,
    updated_at: nowIso,
  };
}

function buildAttemptFields(currentCount, nowIso = new Date().toISOString()) {
  return { attempt_count: (currentCount || 0) + 1, updated_at: nowIso };
}

/**
 * Client-facing shape. The number is shown back in full DELIBERATELY — the
 * client must be able to check the number we are about to ring. Everything
 * else (ip, user agent, fingerprint) stays internal.
 */
function toPublicConsent(row) {
  if (!row) return null;
  return Object.freeze({
    consentId: row.consent_id,
    destinationNumber: row.destination_number,
    destinationNumberAsEntered: row.destination_number_raw,
    callConsent: row.call_consent === true,
    transcriptionConsent: row.transcription_consent === true,
    recordingConsent: row.recording_consent === true,
    disclosureVersion: row.disclosure_version,
    attemptCount: row.attempt_count || 0,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - (row.attempt_count || 0)),
    expiresAt: row.expires_at,
    revoked: Boolean(row.revoked_at),
    createdAt: row.created_at,
  });
}

// ── DB adapter ──────────────────────────────────────────────────────

const { tableMissing: m3TableMissing } = require("./provider-resource-registry");

function tableMissing(error) {
  return Boolean(error && (error.code === "42P01" || /onboarding_call_consents|onboarding_calls.*does not exist/i.test(error.message || ""))) || m3TableMissing(error);
}

function provisioningError() {
  return new Error("onboarding call tables not provisioned — apply supabase/sql/lpm4_create_onboarding_call_runtime.sql first");
}

async function getConsent(clientId, consentId) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).select("*").eq("client_id", clientId).eq("consent_id", consentId).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`consent lookup failed: ${error.message}`);
  }
  return data || null;
}

async function getLatestConsentForSession(clientId, sessionId) {
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("session_id", sessionId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`consent lookup failed: ${error.message}`);
  }
  return data && data.length ? data[0] : null;
}

async function recordConsent(fields) {
  const supabase = require("./supabase");
  const { data, error } = await supabase.from(TABLE).insert(fields).select().single();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`recording consent failed: ${error.message}`);
  }
  return data;
}

async function revokeConsent(clientId, consentId, { reason = null } = {}) {
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from(TABLE)
    .update(buildRevocationFields({ reason }))
    .eq("client_id", clientId)
    .eq("consent_id", consentId)
    .is("revoked_at", null)
    .select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`revoking consent failed: ${error.message}`);
  }
  return { ok: Boolean(data && data.length) };
}

async function incrementAttempt(clientId, consentId, currentCount) {
  const supabase = require("./supabase");
  // Optimistic: only increments when the count is still what we read, so two
  // racing requests cannot both consume the same attempt slot.
  const { data, error } = await supabase
    .from(TABLE)
    .update(buildAttemptFields(currentCount))
    .eq("client_id", clientId)
    .eq("consent_id", consentId)
    .eq("attempt_count", currentCount || 0)
    .select();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`recording the attempt failed: ${error.message}`);
  }
  return { ok: Boolean(data && data.length), conflict: !(data && data.length) };
}

module.exports = {
  TABLE,
  DISCLOSURE_VERSIONS,
  CURRENT_DISCLOSURE_VERSION,
  CONSENT_TTL_MS,
  MAX_ATTEMPTS,
  REFUSAL_CODES,
  getDisclosure,
  isAffirmative,
  buildConsent,
  evaluateConsent,
  buildRevocationFields,
  buildAttemptFields,
  toPublicConsent,
  tableMissing,
  provisioningError,
  getConsent,
  getLatestConsentForSession,
  recordConsent,
  revokeConsent,
  incrementAttempt,
};

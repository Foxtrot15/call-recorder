// Device registration for VoIP v2 (backend spec §3.1/§5.2/§5.4).
//
// Pure validation + cap logic up top (unit-testable, no deps); thin DB
// adapter below with a lazy supabase require. The devices table ships as
// supabase/sql/phase1b_create_devices.sql (review-only, human-applied) —
// until it exists, adapter calls fail with a clear provisioning message.
//
// Privacy invariant: the server NEVER sees a raw push token. The app hashes
// it (sha256 hex) before sending; the raw token lives only in Twilio's
// binding. Listings never return even the hash.

const MAX_ACTIVE_DEVICES = 5; // spec §5.2 — app-level cap under Twilio's ~10 binding limit
const ACTIVE_WINDOW_DAYS = 30; // registrations older than this count as stale (spec §10)

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const PLATFORMS = new Set(["ios", "android"]);

function validateDeviceRegistration({ platform, pushTokenHash, label, appVersion, osVersion } = {}) {
  const errors = [];
  if (!PLATFORMS.has(platform)) errors.push('platform must be "ios" or "android"');
  if (!pushTokenHash || !SHA256_HEX_RE.test(String(pushTokenHash))) {
    errors.push("pushTokenHash must be a sha256 hex digest (64 hex chars) — never send the raw push token");
  }
  if (label != null && String(label).length > 80) errors.push("label must be 80 characters or fewer");
  if (appVersion != null && String(appVersion).length > 40) errors.push("appVersion must be 40 characters or fewer");
  if (osVersion != null && String(osVersion).length > 40) errors.push("osVersion must be 40 characters or fewer");
  return { ok: errors.length === 0, errors };
}

// Cap applies to NEW devices only; re-registering an existing binding always
// succeeds (that's the normal every-launch path and must never be blocked).
function canRegisterNewDevice(activeCount) {
  return activeCount < MAX_ACTIVE_DEVICES;
}

// Shape a DB row for API responses — id/platform/label/versions/timestamps,
// never push_token_hash.
function toPublicDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    label: row.label || null,
    appVersion: row.app_version || null,
    osVersion: row.os_version || null,
    lastRegisteredAt: row.last_registered_at,
    createdAt: row.created_at,
  };
}

// ── DB adapter ───────────────────────────────────────────────────────────────

function tableMissing(error) {
  return Boolean(error && (error.code === "42P01" || /devices.*does not exist|relation .*devices/i.test(error.message || "")));
}

function provisioningError() {
  return new Error("devices table not provisioned — apply supabase/sql/phase1b_create_devices.sql first");
}

/**
 * Upsert a device registration for a client.
 * Returns { device } on success or { capExceeded: true } when a NEW device
 * would exceed the active cap.
 */
async function registerDevice(clientId, { platform, pushTokenHash, label, appVersion, osVersion }) {
  const supabase = require("./supabase"); // lazy — keeps pure parts test-loadable

  // Existing binding? Re-registration refreshes it and clears revocation.
  const { data: existing, error: findErr } = await supabase
    .from("devices")
    .select("id, revoked_at")
    .eq("client_id", clientId)
    .eq("push_token_hash", pushTokenHash)
    .maybeSingle();
  if (findErr) {
    if (tableMissing(findErr)) throw provisioningError();
    throw new Error(`device lookup failed: ${findErr.message}`);
  }

  const nowIso = new Date().toISOString();
  const fields = {
    platform,
    label: label || null,
    app_version: appVersion || null,
    os_version: osVersion || null,
    last_registered_at: nowIso,
    last_seen_at: nowIso,
    revoked_at: null,
  };

  if (existing) {
    const { data, error } = await supabase
      .from("devices").update(fields).eq("id", existing.id).select().single();
    if (error) throw new Error(`device update failed: ${error.message}`);
    return { device: toPublicDevice(data) };
  }

  // New device: enforce the active cap.
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countErr } = await supabase
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .gte("last_registered_at", cutoff);
  if (countErr) throw new Error(`device count failed: ${countErr.message}`);
  if (!canRegisterNewDevice(count || 0)) return { capExceeded: true };

  const { data, error } = await supabase
    .from("devices")
    .insert({ client_id: clientId, push_token_hash: pushTokenHash, ...fields })
    .select()
    .single();
  if (error) throw new Error(`device insert failed: ${error.message}`);
  return { device: toPublicDevice(data) };
}

/** Active (non-revoked) devices for a client — public shape only. */
async function listDevices(clientId) {
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from("devices")
    .select("id, platform, label, app_version, os_version, last_registered_at, created_at")
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .order("last_registered_at", { ascending: false });
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw new Error(`device list failed: ${error.message}`);
  }
  return (data || []).map(toPublicDevice);
}

/**
 * Active-device count for delivery decisions (spec: revoked_at null AND
 * registered within the 30-day window — same definition as the cap check).
 * NEVER throws: any failure (incl. table not provisioned, 42P01) returns 0,
 * which callers treat as "cannot deliver via VoIP" (INV-3 fail-safe).
 */
async function countActiveDevices(clientId) {
  try {
    const supabase = require("./supabase");
    const cutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from("devices")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId)
      .is("revoked_at", null)
      .gte("last_registered_at", cutoff);
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

/** 42703-safe voip_enabled check (column may not be provisioned yet). */
async function isClientVoipEnabled(slug) {
  const supabase = require("./supabase");
  const { data, error } = await supabase
    .from("clients").select("voip_enabled").eq("slug", slug).single();
  if (error) return false; // missing column/row: not enabled — fail closed for feature access
  return data?.voip_enabled === true;
}

module.exports = {
  MAX_ACTIVE_DEVICES,
  ACTIVE_WINDOW_DAYS,
  validateDeviceRegistration,
  canRegisterNewDevice,
  toPublicDevice,
  registerDevice,
  listDevices,
  countActiveDevices,
  isClientVoipEnabled,
};

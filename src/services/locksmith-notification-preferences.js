// AIDA — client notification preferences (M5).
//
// Decides WHAT a client should be told, THROUGH WHICH CHANNEL, and TO WHOM.
// It does not send anything. The output is a delivery intent that a transport
// adapter would act on; no transport exists in this milestone, and nothing here
// requires twilio, axios or a mail library.
//
// Three ideas are kept deliberately separate, because collapsing them is how
// notification systems end up texting a customer's emergency line with a
// monthly usage summary:
//
//   DESTINATION  — a verified place a message can go (a number, an address).
//   PREFERENCE   — the client's decision about one event type.
//   INTENT       — the resolved "send this, there, now", produced per event.
//
// A destination is owned by the client and verified once. A preference points
// at destinations by id. Changing your mobile number therefore updates one
// record, not eleven preferences, and a destination that fails verification
// stops receiving everything at once.
//
// Notification preferences are ordinary configuration: they change through
// services/locksmith-change-request.js like anything else, from either the
// portal or (later) the configuration agent.
//
// Pure + dep-free core; thin Supabase adapter at the bottom.

const { validateTargetNumber } = require("./divert-codes");

const PREFERENCES_VERSION = "notification-preferences-2026-08-01";

// ── Channels ────────────────────────────────────────────────────────
// portal is always on and costs nothing: it is the floor, not a choice.
// Removing every channel still leaves the record in the portal, so a client
// can never silence themselves into missing work entirely.
const CHANNELS = Object.freeze({
  portal: { label: "In the portal", costPerMessageAud: 0, alwaysOn: true, requiresVerification: false },
  email: { label: "Email", costPerMessageAud: 0, alwaysOn: false, requiresVerification: true },
  sms: { label: "Text message", costPerMessageAud: 0.05, alwaysOn: false, requiresVerification: true },
});

const CHANNEL_KEYS = Object.freeze(Object.keys(CHANNELS));
const SENDABLE_CHANNELS = Object.freeze(CHANNEL_KEYS.filter((c) => !CHANNELS[c].alwaysOn));

// ── Destination kinds ───────────────────────────────────────────────
const DESTINATION_KINDS = Object.freeze({
  mobile: { channels: ["sms"], label: "Mobile number" },
  email: { channels: ["email"], label: "Email address" },
});

// ── The ten notification types ──────────────────────────────────────
// `operational` events are about work happening right now. `administrative`
// events are about the account. `promotional` is anything AIDA might one day
// want to tell a client about a product — there are no members yet, and the
// category exists so that the rule below has something to refuse.
//
// The distinction matters for the transfer-number rule in destinationMayCarry:
// a transfer number is frequently NOT the account holder's own phone. It is
// often a partner, an after-hours subcontractor or a second van. Operational
// alerts belong there by definition. Account and billing detail does not,
// unless the client says that number is theirs.
const NOTIFICATION_TYPES = Object.freeze({
  urgent_enquiry: {
    label: "Urgent job (lockout, break-in, vehicle)",
    detail: "AIDA classified the caller as urgent.",
    category: "operational",
    timeSensitive: true,
    defaultChannels: ["portal", "sms", "email"],
    canDisableEntirely: false,
    estimatedMonthly: 22,
  },
  new_enquiry: {
    label: "New enquiry captured",
    detail: "Any call AIDA turned into an enquiry.",
    category: "operational",
    timeSensitive: true,
    defaultChannels: ["portal", "email"],
    canDisableEntirely: true,
    estimatedMonthly: 60,
  },
  missed_transfer: {
    label: "Transfer not answered",
    detail: "AIDA tried to put a caller through and nobody picked up.",
    category: "operational",
    timeSensitive: true,
    defaultChannels: ["portal", "sms", "email"],
    canDisableEntirely: false,
    estimatedMonthly: 8,
  },
  after_hours_enquiry: {
    label: "After-hours enquiry",
    detail: "A call outside your published hours.",
    category: "operational",
    timeSensitive: true,
    defaultChannels: ["portal", "email"],
    canDisableEntirely: true,
    estimatedMonthly: 15,
  },
  out_of_area_enquiry: {
    label: "Out-of-area enquiry",
    detail: "A caller outside your service areas.",
    category: "operational",
    timeSensitive: false,
    defaultChannels: ["portal"],
    canDisableEntirely: true,
    estimatedMonthly: 10,
  },
  callback_promised: {
    label: "Callback promised",
    detail: "AIDA told a caller you would ring them back.",
    category: "operational",
    timeSensitive: true,
    defaultChannels: ["portal", "email"],
    canDisableEntirely: false,
    estimatedMonthly: 12,
  },
  daily_summary: {
    label: "Daily summary",
    detail: "One message at the end of the day.",
    category: "administrative",
    timeSensitive: false,
    defaultChannels: ["portal", "email"],
    canDisableEntirely: true,
    estimatedMonthly: 30,
  },
  receptionist_health: {
    label: "Receptionist problem",
    detail: "AIDA could not answer, or a configuration failed to apply.",
    category: "administrative",
    timeSensitive: true,
    defaultChannels: ["portal", "sms", "email"],
    canDisableEntirely: false,
    estimatedMonthly: 1,
  },
  configuration_change: {
    label: "Configuration change status",
    detail: "A change you requested was accepted, needs approval, or went live.",
    category: "administrative",
    timeSensitive: false,
    defaultChannels: ["portal", "email"],
    canDisableEntirely: false,
    estimatedMonthly: 6,
  },
  billing_and_usage: {
    label: "Usage and billing",
    detail: "Approaching an included limit, or an invoice event.",
    category: "administrative",
    timeSensitive: false,
    defaultChannels: ["portal", "email"],
    canDisableEntirely: false,
    estimatedMonthly: 4,
  },
});

const NOTIFICATION_TYPE_KEYS = Object.freeze(Object.keys(NOTIFICATION_TYPES));

// Types that must always reach a human somewhere other than the portal alone.
// A locksmith who never opens the portal still needs to hear that AIDA stopped
// answering their phone.
const MUST_REACH_A_HUMAN = Object.freeze(
  NOTIFICATION_TYPE_KEYS.filter((k) => NOTIFICATION_TYPES[k].canDisableEntirely === false)
);

// ── Destinations ────────────────────────────────────────────────────

/**
 * Validate one destination. Numbers are normalised through the same validator
 * the call-forwarding module uses, so a number that cannot be dialled cannot be
 * saved as a place to send alerts either.
 */
function validateDestination(raw, { transferNumbers = [] } = {}) {
  const errors = [];
  const kind = raw && typeof raw.kind === "string" ? raw.kind : "";
  if (!DESTINATION_KINDS[kind]) {
    return { ok: false, errors: [`Choose a destination type: ${Object.keys(DESTINATION_KINDS).join(" or ")}.`] };
  }

  const label = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  let value = typeof raw.value === "string" ? raw.value.trim() : "";
  let normalised = "";

  if (kind === "mobile") {
    const check = validateTargetNumber(value);
    if (!check.ok) {
      errors.push("Enter an Australian mobile or landline number.");
    } else {
      normalised = check.e164;
    }
  } else {
    // Deliberately permissive but anchored: one @, a dot in the domain, no
    // whitespace. Address validation beyond this belongs to the verification
    // email, which is the only thing that actually proves an address works.
    value = value.replace(/[.\s]+$/, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      errors.push("Enter a valid email address.");
    } else {
      normalised = value.toLowerCase();
    }
  }

  if (!label) errors.push("Give this destination a short label, for example \"My mobile\" or \"Office email\".");

  if (errors.length) return { ok: false, errors };

  // Is this the number the receptionist transfers live calls to? Allowed, but
  // marked, so the rule below can keep account admin off it.
  const isTransferNumber = kind === "mobile" && transferNumbers.some((t) => normaliseForCompare(t) === normalised);

  return {
    ok: true,
    destination: {
      kind,
      label,
      value: normalised,
      isTransferNumber,
      // Set only by an explicit client acknowledgement that a transfer number
      // is their own phone. Never inferred, and reset if the number changes.
      confirmedOwnNumber: isTransferNumber ? raw.confirmedOwnNumber === true : false,
      // Verification is a separate act. A destination is inert until proven.
      verified: false,
      verifiedAt: null,
      // Consecutive hard failures; the resolver stops using a destination that
      // keeps bouncing rather than silently retrying forever.
      failureCount: 0,
      suppressed: false,
    },
  };
}

function normaliseForCompare(number) {
  const check = validateTargetNumber(String(number || ""));
  return check.ok ? check.e164 : String(number || "").replace(/\D/g, "");
}

/** Channels a destination can actually serve. */
function channelsFor(destination) {
  const kind = DESTINATION_KINDS[destination && destination.kind];
  return kind ? kind.channels.slice() : [];
}

/**
 * May this destination carry this notification type?
 *
 * The transfer-number rule lives here, and it is deliberately narrow.
 *
 * An operational alert to the number that already answers your jobs is
 * obviously fine — that is what the number is for. The hazard is the other two
 * categories. A transfer number is often not the account holder's own phone:
 * plenty of locksmiths transfer to a partner, a second van, or an after-hours
 * subcontractor. Sending billing and account detail there leaks the business's
 * commercial information to someone who is not the account holder.
 *
 * But refusing outright would be wrong for the far more common solo trader
 * whose mobile is both things at once. So administrative messaging to a
 * transfer number is blocked *until the client confirms the number is theirs*
 * — one deliberate acknowledgement, rather than a rule that is either
 * paternalistic or leaky.
 *
 * Promotional messaging to a transfer number is refused permanently and cannot
 * be acknowledged away. That line is answered by someone mid-job, and it exists
 * to serve the business's own customers.
 */
function destinationMayCarry(destination, notificationType) {
  const meta = NOTIFICATION_TYPES[notificationType];
  if (!meta) return { allowed: false, reason: "Unknown notification type." };
  if (!destination.verified) {
    return { allowed: false, reason: "This destination has not been verified yet." };
  }
  if (destination.suppressed) {
    return { allowed: false, reason: "Delivery to this destination is paused after repeated failures." };
  }
  if (destination.isTransferNumber && meta.category === "promotional") {
    return {
      allowed: false,
      reason: "This is the number AIDA transfers live calls to. It is never used for product or promotional messages.",
      acknowledgeable: false,
    };
  }
  if (destination.isTransferNumber && meta.category === "administrative" && destination.confirmedOwnNumber !== true) {
    return {
      allowed: false,
      reason:
        "This is the number AIDA transfers live calls to. Confirm it is your own number before sending account and billing messages there.",
      acknowledgeable: true,
    };
  }
  return { allowed: true, reason: null };
}

// ── Preferences ─────────────────────────────────────────────────────

/**
 * Conservative defaults. Every type is on in the portal; email carries the
 * detail; SMS is reserved for the three things worth interrupting someone for.
 * The client turns more on deliberately, having seen the cost.
 */
function defaultPreferences() {
  const prefs = {};
  for (const key of NOTIFICATION_TYPE_KEYS) {
    prefs[key] = {
      channels: NOTIFICATION_TYPES[key].defaultChannels.slice(),
      // Destination ids per channel; empty means "the account's primary for
      // that channel", resolved at send time.
      destinationIds: {},
      quietHoursExempt: NOTIFICATION_TYPES[key].timeSensitive === true,
    };
  }
  return prefs;
}

/**
 * Quiet hours suppress non-urgent SMS only. Email and portal are unaffected —
 * they do not wake anyone — and a time-sensitive type is exempt, because a
 * lockout at 2am is the product working, not a disturbance.
 */
const DEFAULT_QUIET_HOURS = Object.freeze({ enabled: false, startHour: 21, endHour: 7 });

function validatePreferences(raw, { destinations = {}, quietHours = DEFAULT_QUIET_HOURS } = {}) {
  const errors = [];
  const warnings = [];
  const clean = {};

  const incoming = raw && typeof raw === "object" ? raw : {};
  for (const key of Object.keys(incoming)) {
    if (!NOTIFICATION_TYPE_KEYS.includes(key)) {
      errors.push(`"${String(key).slice(0, 40)}" is not a notification type.`);
    }
  }

  for (const key of NOTIFICATION_TYPE_KEYS) {
    const meta = NOTIFICATION_TYPES[key];
    const given = incoming[key] || {};
    const requested = Array.isArray(given.channels) ? given.channels : meta.defaultChannels;

    const unknown = requested.filter((c) => !CHANNEL_KEYS.includes(c));
    for (const c of unknown) errors.push(`"${String(c).slice(0, 20)}" is not a notification channel.`);

    // The portal floor: it cannot be switched off, so add it back silently
    // rather than erroring at someone for omitting an immovable option.
    const channels = Array.from(new Set(requested.filter((c) => CHANNEL_KEYS.includes(c)).concat(["portal"])));

    // Things that must reach a human need at least one channel that leaves the
    // portal. Refusing this is a real restriction, so say why.
    const reachesAHuman = channels.some((c) => SENDABLE_CHANNELS.includes(c));
    if (!meta.canDisableEntirely && !reachesAHuman) {
      errors.push(`"${meta.label}" needs at least one of email or text message — it is too important to leave in the portal only.`);
    }

    // Destination assignments must exist, match the channel, and be permitted
    // to carry this type.
    const destinationIds = {};
    const givenDests = given.destinationIds && typeof given.destinationIds === "object" ? given.destinationIds : {};
    for (const channel of Object.keys(givenDests)) {
      if (!SENDABLE_CHANNELS.includes(channel)) {
        errors.push(`Destinations cannot be set for the "${String(channel).slice(0, 20)}" channel.`);
        continue;
      }
      const ids = Array.isArray(givenDests[channel]) ? givenDests[channel] : [givenDests[channel]];
      const kept = [];
      for (const id of ids) {
        const dest = destinations[id];
        if (!dest) {
          errors.push(`"${meta.label}" points at a destination that no longer exists.`);
          continue;
        }
        if (!channelsFor(dest).includes(channel)) {
          errors.push(`"${dest.label}" cannot receive ${CHANNELS[channel].label.toLowerCase()}.`);
          continue;
        }
        const permitted = destinationMayCarry(dest, key);
        if (!permitted.allowed) {
          // An unverified destination is a warning, not an error: the client
          // chose correctly and just has not confirmed it yet. A transfer-number
          // misuse is an error, because it is the wrong choice.
          if (dest.verified) errors.push(`"${dest.label}" cannot receive "${meta.label}". ${permitted.reason}`);
          else warnings.push(`"${dest.label}" will start receiving "${meta.label}" once it is verified.`);
        }
        kept.push(id);
      }
      if (kept.length) destinationIds[channel] = kept;
    }

    clean[key] = {
      channels,
      destinationIds,
      quietHoursExempt: given.quietHoursExempt === undefined ? meta.timeSensitive === true : given.quietHoursExempt === true,
    };
  }

  const qh = normaliseQuietHours(quietHours, errors);

  return { ok: errors.length === 0, errors, warnings, preferences: clean, quietHours: qh };
}

function normaliseQuietHours(raw, errors) {
  const src = raw && typeof raw === "object" ? raw : DEFAULT_QUIET_HOURS;
  const start = Number.isInteger(src.startHour) ? src.startHour : DEFAULT_QUIET_HOURS.startHour;
  const end = Number.isInteger(src.endHour) ? src.endHour : DEFAULT_QUIET_HOURS.endHour;
  if (start < 0 || start > 23 || end < 0 || end > 23) {
    errors.push("Quiet hours must be whole hours between 0 and 23.");
    return { ...DEFAULT_QUIET_HOURS };
  }
  return { enabled: src.enabled === true, startHour: start, endHour: end };
}

/** Quiet hours may wrap midnight, which is the normal case (21:00 to 07:00). */
function isWithinQuietHours(hour, quietHours) {
  if (!quietHours || !quietHours.enabled) return false;
  const { startHour, endHour } = quietHours;
  if (startHour === endHour) return false;
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

// ── Resolution ──────────────────────────────────────────────────────

/**
 * Given an event, produce the delivery intents. Pure: takes the hour rather
 * than reading a clock, so the tests can put a call at 2am without waiting.
 *
 * Returns intents plus `suppressed`, because a client asking "why didn't I get
 * a text?" deserves an answer the portal can actually show them.
 */
function resolveDeliveries({
  notificationType,
  preferences,
  destinations = {},
  quietHours = DEFAULT_QUIET_HOURS,
  localHour = 12,
}) {
  const meta = NOTIFICATION_TYPES[notificationType];
  if (!meta) return { ok: false, code: "unknown_type", intents: [], suppressed: [] };

  const pref = (preferences && preferences[notificationType]) || {
    channels: meta.defaultChannels.slice(),
    destinationIds: {},
    quietHoursExempt: meta.timeSensitive === true,
  };

  const intents = [];
  const suppressed = [];

  for (const channel of pref.channels) {
    if (channel === "portal") {
      // Always recorded; no destination, no cost, no quiet hours.
      intents.push({ channel: "portal", destinationId: null, destination: null, costAud: 0 });
      continue;
    }

    const quiet = isWithinQuietHours(localHour, quietHours) && !pref.quietHoursExempt;
    if (quiet && channel === "sms") {
      suppressed.push({ channel, reason: "quiet_hours", detail: "Held until quiet hours end." });
      continue;
    }

    const ids = (pref.destinationIds && pref.destinationIds[channel]) || [];
    const candidates = ids.length ? ids.map((id) => [id, destinations[id]]) : defaultDestinationsFor(destinations, channel);

    if (!candidates.length) {
      suppressed.push({ channel, reason: "no_destination", detail: `No ${CHANNELS[channel].label.toLowerCase()} destination is set.` });
      continue;
    }

    for (const [id, dest] of candidates) {
      if (!dest) {
        suppressed.push({ channel, reason: "missing_destination", detail: "The saved destination no longer exists." });
        continue;
      }
      const permitted = destinationMayCarry(dest, notificationType);
      if (!permitted.allowed) {
        suppressed.push({ channel, reason: dest.verified ? "not_permitted" : "unverified", detail: permitted.reason, destinationId: id });
        continue;
      }
      intents.push({
        channel,
        destinationId: id,
        // Masked; the resolver's output is shown in the portal and logged.
        destination: maskDestination(dest),
        costAud: CHANNELS[channel].costPerMessageAud,
      });
    }
  }

  return {
    ok: true,
    notificationType,
    intents,
    suppressed,
    estimatedCostAud: round2(intents.reduce((sum, i) => sum + i.costAud, 0)),
  };
}

/**
 * Which destinations serve a channel when a preference names none explicitly.
 *
 * A destination marked `primary` wins. If none is marked — which is the normal
 * case, since validateDestination does not presume to choose one — every
 * destination that can serve the channel is used.
 *
 * The alternative (requiring an explicit `primary`) silently delivered nothing:
 * a client who added their email address and switched on enquiry notifications
 * would have every message suppressed as "no destination set". Silently sending
 * nothing is the worst failure this module can have, so the fallback is
 * deliberately generous and the portal shows exactly who will be contacted.
 */
function defaultDestinationsFor(destinations, channel) {
  const serving = Object.entries(destinations).filter(([, d]) => d && channelsFor(d).includes(channel));
  const primary = serving.filter(([, d]) => d.primary === true);
  return primary.length ? primary : serving;
}

function maskDestination(dest) {
  if (!dest) return null;
  if (dest.kind === "email") {
    const [user, domain] = String(dest.value).split("@");
    const head = user.slice(0, 2);
    return `${head}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
  }
  const digits = String(dest.value).replace(/\D/g, "");
  return digits.length >= 3 ? `••• ••• ${digits.slice(-3)}` : "•••";
}

// ── Cost visibility ─────────────────────────────────────────────────

/**
 * What will these settings cost per month?
 *
 * SMS is the only channel that costs anything, and the client is the one who
 * pays for it, so the number goes next to the toggle rather than into an
 * invoice they see four weeks later. Volumes are the modelled averages on each
 * type; `basis` says so plainly rather than implying a measurement.
 */
function estimateMonthlyCost(preferences, { volumeOverrides = {} } = {}) {
  const lines = [];
  let totalSms = 0;

  for (const key of NOTIFICATION_TYPE_KEYS) {
    const pref = (preferences && preferences[key]) || { channels: NOTIFICATION_TYPES[key].defaultChannels };
    if (!pref.channels.includes("sms")) continue;
    const volume = Number.isFinite(volumeOverrides[key]) ? volumeOverrides[key] : NOTIFICATION_TYPES[key].estimatedMonthly;
    const cost = volume * CHANNELS.sms.costPerMessageAud;
    totalSms += volume;
    lines.push({
      notificationType: key,
      label: NOTIFICATION_TYPES[key].label,
      estimatedMessages: volume,
      estimatedCostAud: round2(cost),
    });
  }

  lines.sort((a, b) => b.estimatedCostAud - a.estimatedCostAud);

  return {
    basis: Object.keys(volumeOverrides).length ? "your recent call volume" : "a typical solo locksmith",
    smsMessagesPerMonth: totalSms,
    smsCostPerMessageAud: CHANNELS.sms.costPerMessageAud,
    estimatedMonthlyCostAud: round2(totalSms * CHANNELS.sms.costPerMessageAud),
    lines,
    note: "Email and portal notifications are included. Text messages are charged at cost.",
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Human-readable summary for the portal and for a spoken read-back. */
function summarisePreferences(preferences) {
  const on = [];
  const smsOn = [];
  for (const key of NOTIFICATION_TYPE_KEYS) {
    const pref = (preferences && preferences[key]) || { channels: NOTIFICATION_TYPES[key].defaultChannels };
    const external = pref.channels.filter((c) => SENDABLE_CHANNELS.includes(c));
    if (external.length) on.push(NOTIFICATION_TYPES[key].label);
    if (pref.channels.includes("sms")) smsOn.push(NOTIFICATION_TYPES[key].label);
  }
  return {
    notifiedCount: on.length,
    totalCount: NOTIFICATION_TYPE_KEYS.length,
    smsTypes: smsOn,
    spoken: smsOn.length
      ? `You get a text for ${joinList(smsOn)}. Everything else is email and the portal.`
      : "Everything comes by email and the portal. No text messages are switched on.",
  };
}

function joinList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ── Adapter ─────────────────────────────────────────────────────────
// Lazy require, tenant-scoped, same shape as the other M2–M4 stores.

const TABLE = "locksmith_notification_settings";

function tableMissing(err) {
  const msg = err && (err.message || err.details || "");
  return /relation .* does not exist|could not find the table|schema cache/i.test(String(msg));
}

function provisioningError() {
  const e = new Error("Notification settings are not provisioned yet. Apply supabase/sql/lpm5_create_client_portal.sql.");
  e.code = "notification_settings_unavailable";
  return e;
}

async function loadSettings(clientId, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const { data, error } = await db.from(TABLE).select("*").eq("client_id", clientId).maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw error;
  }
  if (!data) {
    return { clientId, destinations: {}, preferences: defaultPreferences(), quietHours: { ...DEFAULT_QUIET_HOURS }, isDefault: true, updatedAt: null };
  }
  return {
    clientId,
    destinations: data.destinations || {},
    preferences: data.preferences || defaultPreferences(),
    quietHours: data.quiet_hours || { ...DEFAULT_QUIET_HOURS },
    isDefault: false,
    updatedAt: data.updated_at || null,
  };
}

async function saveSettings(clientId, { destinations, preferences, quietHours, expectedUpdatedAt }, { supabase } = {}) {
  const db = supabase || require("./supabase");
  const row = {
    client_id: clientId,
    destinations,
    preferences,
    quiet_hours: quietHours,
    settings_version: PREFERENCES_VERSION,
    updated_at: new Date().toISOString(),
  };

  // Optimistic concurrency, matching the profile store: an update that matches
  // no row means someone else saved first.
  if (expectedUpdatedAt) {
    const { data, error } = await db.from(TABLE).update(row).eq("client_id", clientId).eq("updated_at", expectedUpdatedAt).select().maybeSingle();
    if (error) {
      if (tableMissing(error)) throw provisioningError();
      throw error;
    }
    if (!data) return { ok: false, code: "stale", message: "These settings changed somewhere else. Reload and try again." };
    return { ok: true, saved: data };
  }

  const { data, error } = await db.from(TABLE).upsert(row, { onConflict: "client_id" }).select().maybeSingle();
  if (error) {
    if (tableMissing(error)) throw provisioningError();
    throw error;
  }
  return { ok: true, saved: data };
}

module.exports = {
  PREFERENCES_VERSION,
  CHANNELS,
  CHANNEL_KEYS,
  SENDABLE_CHANNELS,
  DESTINATION_KINDS,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_KEYS,
  MUST_REACH_A_HUMAN,
  DEFAULT_QUIET_HOURS,
  validateDestination,
  channelsFor,
  destinationMayCarry,
  defaultPreferences,
  validatePreferences,
  isWithinQuietHours,
  resolveDeliveries,
  defaultDestinationsFor,
  maskDestination,
  estimateMonthlyCost,
  summarisePreferences,
  loadSettings,
  saveSettings,
  TABLE,
};

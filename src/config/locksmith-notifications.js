// AIDA — enquiry notification configuration (M7K).
//
// TWO GATES, both dormant by default, both strict-parse:
//
//   LOCKSMITH_NOTIFICATIONS_ENABLED   may AIDA attempt a notification at all
//   LOCKSMITH_NOTIFY_MODE             "live" actually sends; anything else is a
//                                     dry run that contacts nobody
//
// They are separate because they answer different questions. The first is "is
// this capability switched on for this deployment"; the second is "may a real
// message leave the building". A founder proving the pipeline wants the first
// without the second, and that must be an ordinary configuration rather than a
// code change.
//
// Off, the notification service returns its `disabled` outcome, the row stays
// `pending`, and the agent is forbidden from claiming a notification — which is
// exactly the M7J behaviour. That is the rollback: unset one variable.
//
// Pure + dep-free.

const NOTIFY_CONFIG_VERSION = "locksmith-notifications-config-2026-08-03";

/** Only the exact string "true". Unset, "TRUE", "1", "yes" are all off. */
function strictTrue(value) {
  return value === "true";
}

function areNotificationsEnabled(env = process.env) {
  return strictTrue(env.LOCKSMITH_NOTIFICATIONS_ENABLED);
}

/** Only the exact string "live" permits a real message. */
function isLiveSendEnabled(env = process.env) {
  return env.LOCKSMITH_NOTIFY_MODE === "live";
}

/**
 * The resolved configuration the notification service consumes.
 *
 * `environment` comes from the deployment tag, never from a request — it is
 * what stamps a sandbox notification as a test in its own first line.
 */
function getNotificationConfig(env = process.env) {
  const live = isLiveSendEnabled(env);
  return Object.freeze({
    version: NOTIFY_CONFIG_VERSION,
    enabled: areNotificationsEnabled(env),
    live,
    provider: live ? "twilio_sms" : "dry_run",
    mode: live ? "live" : "dry_run",
    environment: env.RETELL_ALLOWED_TAG || "dev",
  });
}

/**
 * Why notifications cannot run, for an operator. Empty when they can.
 *
 * Live sending additionally needs Twilio credentials and a sender number —
 * reported here rather than discovered at the moment a caller is waiting.
 */
function assessNotificationConfig(env = process.env) {
  const config = getNotificationConfig(env);
  const blockers = [];
  if (!config.enabled) blockers.push('LOCKSMITH_NOTIFICATIONS_ENABLED is not "true"');
  if (config.live) {
    if (!env.TWILIO_ACCOUNT_SID) blockers.push("TWILIO_ACCOUNT_SID is not set (required for live sending)");
    if (!env.TWILIO_AUTH_TOKEN) blockers.push("TWILIO_AUTH_TOKEN is not set (required for live sending)");
    if (!env.TWILIO_NUMBER && !env.TWILIO_PHONE_NUMBER) blockers.push("no Twilio sender number is set (TWILIO_NUMBER)");
  }
  return { ok: blockers.length === 0, config, blockers };
}

module.exports = {
  NOTIFY_CONFIG_VERSION,
  areNotificationsEnabled,
  isLiveSendEnabled,
  getNotificationConfig,
  assessNotificationConfig,
};

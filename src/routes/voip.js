// VoIP v2 Phase 1b — the first REAL VoIP routes (backend spec §5.1/§5.2/§5.4).
// Replaces the corresponding Phase 0 placeholders (removed from
// voip-scaffold.js per its route-by-route replacement contract).
//
// Gate order (deliberate): voipRouterGate FIRST — with VOIP_V2_ENABLED off
// (every production deploy today), next("router") exits before auth ever
// runs and these paths 404 exactly as if this file didn't exist. Then
// requireClientAuth (B1: refresh-capable client sessions — the reason this
// phase is buildable at all), then per-client voip_enabled, then work.
//
// No calls are placed here. Minting an Access Token is a local JWT signing
// operation; SDK registration/dialling is app/Phase-2+ territory.

const express = require("express");
const router = express.Router();
const { voipRouterGate } = require("../config/voip");
const { requireClientAuth } = require("../middleware/auth");
const { buildTokenConfig } = require("../services/voip-identity");
const { createRateLimiter } = require("../services/rate-limit");
const {
  validateDeviceRegistration,
  registerDevice,
  listDevices,
  isClientVoipEnabled,
} = require("../services/devices");

router.use(voipRouterGate());

// D11: cheap-abuse throttles on the two POST endpoints. Keyed by session
// client + IP so one tenant can't starve another from behind the same NAT.
const tokenLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 1000 });
const registerLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 1000 });

function limiterKey(req) {
  return `${req.clientId || "anon"}|${req.ip || "?"}`;
}

// Per-client feature check shared by all three routes: the server flag got
// us here; the client flag decides 403 vs proceed (D7 two-level gating).
async function requireVoipEnabledClient(req, res, next) {
  try {
    if (!(await isClientVoipEnabled(req.clientId))) {
      return res.status(403).json({ error: "VoIP is not enabled for this account" });
    }
    next();
  } catch (err) {
    console.error("⚠️  voip_enabled check failed:", err.message);
    res.status(500).json({ error: "Could not verify VoIP status" });
  }
}

// ── POST /voice/token — mint a Twilio Access Token (spec §5.1) ──────────────
router.post("/voice/token", requireClientAuth, requireVoipEnabledClient, async (req, res) => {
  const rl = tokenLimiter.check(limiterKey(req));
  if (!rl.allowed) {
    return res.status(429).json({ error: "Too many token requests — retry shortly" });
  }

  const built = buildTokenConfig({ slug: req.clientId, platform: req.body?.platform, env: process.env });
  if (!built.ok) {
    return res.status(built.status).json({ error: built.error });
  }
  const c = built.config;

  try {
    // Lazy require: the twilio lib loads only when a token is actually minted.
    const twilio = require("twilio");
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(c.accountSid, c.apiKeySid, c.apiKeySecret, {
      identity: c.identity,
      ttl: c.ttlSeconds,
    });
    token.addGrant(new VoiceGrant({ incomingAllow: true, pushCredentialSid: c.pushCredentialSid }));

    console.log(`voip.token.mint client=${req.clientId} platform=${req.body?.platform}`);
    res.json({ token: token.toJwt(), identity: c.identity, ttlSeconds: c.ttlSeconds });
  } catch (err) {
    console.error("❌ Access Token mint failed:", err.message);
    res.status(500).json({ error: "Token generation failed" });
  }
});

// ── POST /devices/register — upsert a device binding record (spec §5.2) ─────
router.post("/devices/register", requireClientAuth, requireVoipEnabledClient, async (req, res) => {
  const rl = registerLimiter.check(limiterKey(req));
  if (!rl.allowed) {
    return res.status(429).json({ error: "Too many registration requests — retry shortly" });
  }

  const check = validateDeviceRegistration(req.body || {});
  if (!check.ok) {
    return res.status(400).json({ error: check.errors.join("; ") });
  }

  try {
    const result = await registerDevice(req.clientId, req.body);
    if (result.capExceeded) {
      return res.status(409).json({ error: "device limit reached — revoke an old device first" });
    }
    console.log(`voip.device.register client=${req.clientId} platform=${req.body.platform}`);
    res.json({ device: result.device });
  } catch (err) {
    console.error("❌ Device registration failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /devices — list this client's active devices (spec §5.4) ────────────
router.get("/devices", requireClientAuth, requireVoipEnabledClient, async (req, res) => {
  try {
    res.json({ devices: await listDevices(req.clientId) });
  } catch (err) {
    console.error("❌ Device list failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

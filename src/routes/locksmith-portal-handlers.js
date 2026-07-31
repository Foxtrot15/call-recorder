// AIDA — client portal handlers (M5).
//
// Express-free and injectable, the locksmith-onboarding-handlers.js precedent,
// so the whole surface is testable on a bare checkout with fake req/res.
//
// ─── TENANT KEY ─────────────────────────────────────────────────────
// req.clientId comes from the verified client session and is the ONLY tenant
// key used anywhere in this file. Nothing reads a client id from the body, the
// query or the path. The read models scope strictly (no legacy `default`/NULL
// widening — see the note at the top of locksmith-portal-readmodel.js).
//
// ─── CSRF ───────────────────────────────────────────────────────────
// Same posture as M2: httpOnly + SameSite=Lax session cookies and JSON-only
// state-changing endpoints, asserted at the route rather than assumed. A
// cross-site form POST cannot set application/json without a CORS preflight.
//
// ─── CHANGE REQUESTS ────────────────────────────────────────────────
// Every mutation goes through services/locksmith-change-request.js with
// sourceChannel "client_ui". The handler does not validate changes itself and
// does not write a profile — if it did, the voice agent would later need its
// own copy of the same rules, which is exactly what the architecture rule
// forbids.

const { getLocksmithConfig } = require("../config/locksmith");
const readModel = require("../services/locksmith-portal-readmodel");
const changeRequests = require("../services/locksmith-change-request");
const notifications = require("../services/locksmith-notification-preferences");
const forwarding = require("../services/locksmith-call-forwarding");
const store = require("../services/locksmith-profile-store");
const { renderPortalPage, resolveTab } = require("../views/locksmith-portal-page");
const { renderClientOpsList, renderClientOpsDetail } = require("../views/locksmith-client-ops-page");
const { createRateLimiter } = require("../services/rate-limit");

const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // The portal shows a business's full call history and operating
  // configuration. It must never sit in a shared or browser cache.
  "Cache-Control": "no-store, private",
});

const ACTION_LIMIT = 60;
const ACTION_WINDOW_MS = 5 * 60 * 1000;
const PRUNE_EVERY = 100;

function isJsonRequest(req) {
  const type = (req.headers && (req.headers["content-type"] || req.headers["Content-Type"])) || "";
  return String(type).toLowerCase().includes("application/json");
}

// Request ids are server-generated. randomUUID is in node's core crypto, so
// this adds no dependency.
function newRequestId() {
  return `cr_${require("crypto").randomUUID()}`;
}

function createPortalHandlers(deps = {}) {
  const rm = deps.readModel || readModel;
  const changes = deps.changeRequests || changeRequests;
  const notify = deps.notifications || notifications;
  const fwd = deps.forwarding || forwarding;
  const profileStore = deps.store || store;
  const render = deps.render || renderPortalPage;
  const renderOpsList = deps.renderOpsList || renderClientOpsList;
  const renderOpsDetail = deps.renderOpsDetail || renderClientOpsDetail;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const config = deps.config || getLocksmithConfig(env);
  const limiter = deps.limiter || createRateLimiter({ limit: ACTION_LIMIT, windowMs: ACTION_WINDOW_MS });
  const now = deps.now || (() => new Date().toISOString());
  const genRequestId = deps.newRequestId || newRequestId;
  let sincePrune = 0;

  function rateLimited(req, res) {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    if ((sincePrune += 1) >= PRUNE_EVERY) {
      sincePrune = 0;
      limiter.prune();
    }
    if (limiter.check(key).allowed) return false;
    res.status(429).json({ error: "Too many requests. Give it a minute." });
    return true;
  }

  function sendPage(res, html) {
    res.set(PAGE_SECURITY_HEADERS);
    res.type("html").send(html);
  }

  /**
   * Assemble every read model for one client.
   *
   * Each source is fetched defensively: an unprovisioned table or a failing
   * dependency degrades that panel, it does not blank the portal. A locksmith
   * whose change-request table is missing should still be able to see today's
   * calls.
   */
  async function buildModel(clientId, { supabase } = {}) {
    const problems = [];

    const callList = await safely(() => rm.fetchCalls(clientId, { supabase, limit: 50 }), { calls: [], total: 0, truncated: false }, problems, "calls");

    const rows = callList.calls;
    const usage = rm.projectUsage(rows.map(toRowish));
    const enquiryList = rm.projectEnquiryList(rows.map(toRowish));

    const approved = await safely(() => profileStore.getApprovedVersion(clientId, { supabase }), null, problems, "profile");
    const profileSummary = rm.projectProfileSummary(approved);

    const notificationSettings = await safely(() => notify.loadSettings(clientId, { supabase }), null, problems, "notifications");
    const forwardingState = await safely(() => fwd.loadForwarding(clientId, { supabase }), null, problems, "forwarding");
    const requestRows = await safely(() => changes.listRequests(clientId, { supabase }), [], problems, "changes");

    const changeRequestsModel = rm.projectChangeRequests(requestRows);
    const testStatus = rm.projectTestStatus([], { profileVersion: profileSummary.versionNumber });

    const forwardingView = forwardingState
      ? fwd.projectForwardingView({
          storedState: forwardingState.state,
          // The AIDA number comes from provisioning, never from a placeholder.
          aidaNumber: forwardingState.setup ? forwardingState.setup.aidaNumber : null,
          verification: forwardingState.verification,
          setup: forwardingState.setup,
        })
      : null;

    const launchReadiness = rm.projectLaunchReadiness({
      profileSummary,
      testStatus,
      provisioning: null,
      forwarding: forwardingView,
      notificationSettings,
    });

    const overview = rm.projectOverview({ callList, usage, profileSummary, testStatus, changeRequests: changeRequestsModel, launchReadiness, enquiryList });

    return {
      overview,
      callList,
      enquiryList,
      usage,
      profileSummary,
      testStatus,
      changeRequests: changeRequestsModel,
      launchReadiness,
      forwarding: forwardingView,
      notifications: notificationSettings
        ? {
            summary: notify.summarisePreferences(notificationSettings.preferences),
            cost: notify.estimateMonthlyCost(notificationSettings.preferences),
            isDefault: notificationSettings.isDefault,
          }
        : null,
      problems,
    };
  }

  async function safely(fn, fallback, problems, label) {
    try {
      return await fn();
    } catch (err) {
      // An unprovisioned table is expected before the SQL is applied and is not
      // an error worth alarming anyone about; anything else is logged.
      const expected = err && /unavailable$/.test(String(err.code || ""));
      if (!expected) logger.error(`[portal] ${label} unavailable: ${err.message}`);
      problems.push({ area: label, expected: Boolean(expected) });
      return fallback;
    }
  }

  // The read models take stored rows; the call list has already projected them.
  // Re-wrapping keeps one projection path rather than two.
  function toRowish(projected) {
    return {
      id: projected.id,
      recorded_at: projected.at,
      direction: projected.direction,
      duration: projected.durationSeconds,
      status: projected.status,
      analysis: {
        caller_name: projected.callerName,
        suburb: projected.suburb,
        service_type: projected.serviceType,
        urgency: projected.urgency,
        transferred: projected.outcome === "transferred",
        out_of_area: projected.outcome === "out_of_area",
        callback_number: projected.callbackNumber ? "present" : null,
        call_summary: projected.summary,
      },
    };
  }

  // ── GET /client/locksmith ─────────────────────────────────────────
  async function portalPage(req, res) {
    try {
      const tab = resolveTab(req.query && req.query.tab);
      const model = await buildModel(req.clientId, { supabase: deps.supabase });
      sendPage(
        res,
        render({
          tab,
          model,
          basePath: config.portalPath,
          businessName: (req.client && req.client.name) || null,
          isDemo: false,
        })
      );
    } catch (err) {
      logger.error(`[portal] page failed for ${req.clientId}: ${err.message}`);
      res.status(500).type("html").send("<h1>Something went wrong</h1><p>We could not load your portal. Please try again.</p>");
    }
  }

  // ── POST /client/locksmith/change-requests ────────────────────────
  // Creates a change request from the portal. Channel-neutral underneath: the
  // only thing this handler contributes is sourceChannel "client_ui".
  async function createChangeRequest(req, res) {
    if (!isJsonRequest(req)) return res.status(415).json({ error: "Send application/json." });
    if (rateLimited(req, res)) return;

    try {
      const body = req.body || {};
      const built = changes.buildChangeRequest({
        // Server-generated. A client-supplied id would let one tenant guess or
        // collide with another's request id.
        requestId: genRequestId(),
        clientId: req.clientId,
        sourceChannel: "client_ui",
        requestedBy: (req.client && req.client.id) || null,
        changes: Array.isArray(body.changes) ? body.changes : [],
        clientNote: typeof body.note === "string" ? body.note : null,
        status: "submitted",
      });

      if (!built.ok) return res.status(400).json({ error: built.message, code: built.code, errors: built.errors || [] });

      const saved = await changes.createRequest(req.clientId, built.fields, { supabase: deps.supabase });
      logger.log(`[portal] change_request_created client=${req.clientId} target_count=${built.fields.changes.length}`);
      return res.status(201).json({ request: changes.toPublicChangeRequest(saved) });
    } catch (err) {
      if (err.code && /unavailable$/.test(err.code)) {
        return res.status(503).json({ error: "Change requests are not switched on yet." });
      }
      logger.error(`[portal] change request failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ error: "Could not save your request." });
    }
  }

  // ── POST /client/locksmith/notifications ──────────────────────────
  async function saveNotificationPreferences(req, res) {
    if (!isJsonRequest(req)) return res.status(415).json({ error: "Send application/json." });
    if (rateLimited(req, res)) return;

    try {
      const current = await notify.loadSettings(req.clientId, { supabase: deps.supabase });
      const body = req.body || {};
      const validated = notify.validatePreferences(body.preferences, {
        destinations: current.destinations,
        quietHours: body.quietHours || current.quietHours,
      });

      if (!validated.ok) return res.status(400).json({ errors: validated.errors, warnings: validated.warnings });

      const saved = await notify.saveSettings(
        req.clientId,
        {
          destinations: current.destinations,
          preferences: validated.preferences,
          quietHours: validated.quietHours,
          expectedUpdatedAt: body.expectedUpdatedAt || null,
        },
        { supabase: deps.supabase }
      );

      if (!saved.ok) return res.status(409).json({ error: saved.message });

      return res.json({
        preferences: validated.preferences,
        warnings: validated.warnings,
        cost: notify.estimateMonthlyCost(validated.preferences),
        summary: notify.summarisePreferences(validated.preferences),
      });
    } catch (err) {
      if (err.code && /unavailable$/.test(err.code)) {
        return res.status(503).json({ error: "Notification settings are not switched on yet." });
      }
      logger.error(`[portal] notification save failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ error: "Could not save your settings." });
    }
  }

  // ── POST /client/locksmith/forwarding/instructions ────────────────
  // Generates dialling codes. Never activates anything, and refuses outright
  // when no AIDA number is provisioned.
  async function forwardingInstructions(req, res) {
    if (!isJsonRequest(req)) return res.status(415).json({ error: "Send application/json." });
    if (rateLimited(req, res)) return;

    try {
      const state = await fwd.loadForwarding(req.clientId, { supabase: deps.supabase });
      const body = req.body || {};
      const built = fwd.buildForwardingInstructions({
        aidaNumber: state.setup ? state.setup.aidaNumber : null,
        businessNumber: body.businessNumber || null,
        carrier: body.carrier,
        phonePlatform: body.phonePlatform,
        loops: body.loops,
        noAnswerDelaySeconds: body.noAnswerDelaySeconds,
      });

      if (!built.ok) {
        const status = built.code === "no_aida_number" || built.code === "invalid_aida_number" ? 409 : 400;
        // `internal` is diagnostic detail about our own provisioning and is
        // logged, never returned.
        if (built.internal) logger.error(`[portal] forwarding blocked client=${req.clientId} reason=${built.internal}`);
        return res.status(status).json({ error: built.message, code: built.code, errors: built.errors || [] });
      }

      logger.log(`[portal] forwarding_instructions_generated client=${req.clientId} carrier=${built.instructions.carrier}`);
      return res.json({ instructions: built.instructions, reassurance: built.reassurance, verification: built.verification });
    } catch (err) {
      if (err.code && /unavailable$/.test(err.code)) {
        return res.status(503).json({ error: "Call forwarding is not switched on yet." });
      }
      logger.error(`[portal] forwarding failed for ${req.clientId}: ${err.message}`);
      return res.status(500).json({ error: "Could not build your forwarding codes." });
    }
  }

  // ── GET /locksmith-founder/clients ────────────────────────────────
  // Operator-only, cross-tenant by design. Cannot approve anything: approval
  // is the client's act, and an operator-side approve control would make the
  // product's central promise false.
  async function founderClientList(req, res) {
    try {
      const clients = await listPilotClients({ supabase: deps.supabase });
      const rows = [];
      for (const client of clients) {
        const model = await buildModel(client.clientId, { supabase: deps.supabase });
        const r = model.launchReadiness;
        rows.push({
          clientId: client.clientId,
          businessName: client.businessName,
          live: r.live,
          readinessPercent: r.percent,
          waitingOn: r.waitingOn,
          nextStepLabel: r.nextStep ? r.nextStep.label : null,
          callsThisMonth: model.usage.calls,
          lastCallAt: model.callList.calls.length ? model.callList.calls[0].at : null,
          openChangeRequests: model.changeRequests.open,
        });
      }
      res.set(PAGE_SECURITY_HEADERS);
      res.type("html").send(renderOpsList({ clients: rows, basePath: "/locksmith-founder/clients" }));
    } catch (err) {
      logger.error(`[portal] founder list failed: ${err.message}`);
      res.status(500).type("html").send("<h1>Could not load clients</h1>");
    }
  }

  // ── GET /locksmith-founder/clients/:clientId ──────────────────────
  async function founderClientDetail(req, res) {
    try {
      const clientId = String(req.params.clientId || "");
      const clients = await listPilotClients({ supabase: deps.supabase });
      const client = clients.find((c) => c.clientId === clientId);
      if (!client) return res.status(404).type("html").send("<h1>No such client</h1>");

      const model = await buildModel(clientId, { supabase: deps.supabase });
      res.set(PAGE_SECURITY_HEADERS);
      res.type("html").send(renderOpsDetail({ client, model, basePath: "/locksmith-founder/clients" }));
    } catch (err) {
      logger.error(`[portal] founder detail failed: ${err.message}`);
      res.status(500).type("html").send("<h1>Could not load that client</h1>");
    }
  }

  async function listPilotClients({ supabase } = {}) {
    if (deps.listClients) return deps.listClients();
    const db = supabase || require("../services/supabase");
    const { data, error } = await db.from("clients").select("slug, name").order("name");
    if (error) throw error;
    return (data || []).map((c) => ({ clientId: c.slug, businessName: c.name }));
  }

  return {
    portalPage,
    createChangeRequest,
    saveNotificationPreferences,
    forwardingInstructions,
    founderClientList,
    founderClientDetail,
    buildModel,
    PAGE_SECURITY_HEADERS,
  };
}

module.exports = { createPortalHandlers, PAGE_SECURITY_HEADERS, isJsonRequest };

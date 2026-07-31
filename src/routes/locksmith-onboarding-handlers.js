// AIDA Locksmith Receptionist — onboarding request handlers (M2).
//
// Express-free and injectable, the client-auth-handlers.js precedent, so the
// whole surface is testable on a bare checkout with fake req/res objects.
//
// Two audiences, one file, strictly separated:
//   client*   — behind requireClientAuth. req.clientId comes from the verified
//               session and is the ONLY tenant key used; nothing reads a client
//               id from the body, the query or the path.
//   founder*  — behind requireLogin (operator). Reads across tenants by design,
//               and cannot approve anything.
//
// CSRF: the repo's existing convention is httpOnly + SameSite=Lax session
// cookies with JSON-only state-changing endpoints (see middleware/auth.js and
// services/client-session.js — there is no token library anywhere in the repo).
// A cross-site form POST cannot set Content-Type: application/json without a
// CORS preflight, and Lax withholds the cookie on cross-site POSTs anyway. Every
// mutating handler here enforces that JSON content type explicitly, so the
// protection is asserted at the route rather than assumed from the cookie flag.

const { getOnboardingConfig, isExtractionRerunAllowed } = require("../config/locksmith-onboarding");
const sessions = require("../services/locksmith-onboarding-session");
const store = require("../services/locksmith-profile-store");
const { assessProvisioning } = require("../services/locksmith-profile");
const { extractLocksmithProfile } = require("../services/locksmith-extraction");
const { receiveOnboardingTranscript } = require("../services/locksmith-transcript-intake");
const { renderReviewPage } = require("../views/locksmith-review-page");
const { renderFounderList, renderFounderSession } = require("../views/locksmith-founder-page");
const { createRateLimiter } = require("../services/rate-limit");
const { CONFIRMATION_KEYS } = require("../services/locksmith-profile-schema");

const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // These pages contain a business's full operating configuration and its
  // transcribed interview. They must never sit in a shared or browser cache.
  "Cache-Control": "no-store, private",
});

const ACTION_LIMIT = 60;
const ACTION_WINDOW_MS = 5 * 60 * 1000;
const PRUNE_EVERY = 100;

function isJsonRequest(req) {
  const type = (req.headers && (req.headers["content-type"] || req.headers["Content-Type"])) || "";
  return String(type).toLowerCase().includes("application/json");
}

function createOnboardingHandlers(deps = {}) {
  const sessionsApi = deps.sessions || sessions;
  const storeApi = deps.store || store;
  const extract = deps.extract || extractLocksmithProfile;
  const receiveTranscript = deps.receiveTranscript || receiveOnboardingTranscript;
  const renderReview = deps.renderReview || renderReviewPage;
  const renderList = deps.renderFounderList || renderFounderList;
  const renderSession = deps.renderFounderSession || renderFounderSession;
  const logger = deps.logger || console;
  const env = deps.env || process.env;
  const config = deps.config || getOnboardingConfig(env);
  const limiter = deps.limiter || createRateLimiter({ limit: ACTION_LIMIT, windowMs: ACTION_WINDOW_MS });
  let sincePrune = 0;

  function rateLimited(req, res) {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    if ((sincePrune += 1) >= PRUNE_EVERY) {
      sincePrune = 0;
      limiter.prune();
    }
    if (!limiter.check(key).allowed) {
      res.status(429).json({ ok: false, code: "rate_limited", message: "Too many requests. Wait a moment and try again." });
      return true;
    }
    return false;
  }

  function requireJson(req, res) {
    if (!isJsonRequest(req)) {
      res.status(415).json({ ok: false, code: "unsupported_media_type", message: "Send this request as application/json." });
      return false;
    }
    return true;
  }

  // Never leak a provisioning error's file path to a client browser; the
  // operator console is allowed to see it because that message is the fix.
  function handleError(res, err, { operator = false } = {}) {
    const notProvisioned = /not provisioned/i.test(err.message || "");
    logger.error("locksmith.onboarding.error", err.message);
    if (notProvisioned && operator) {
      return res.status(503).json({ ok: false, code: "not_provisioned", message: err.message });
    }
    if (notProvisioned) {
      return res.status(503).json({ ok: false, code: "not_provisioned", message: "Onboarding is not available yet." });
    }
    return res.status(500).json({ ok: false, code: "error", message: "Something went wrong." });
  }

  // ── Client: the review page ───────────────────────────────────────

  async function clientReviewPage(req, res) {
    const clientId = req.clientId;
    const sessionId = req.params && req.params.sessionId;
    if (!clientId) return res.status(401).json({ ok: false, code: "not_authenticated", message: "Sign in to review your settings." });
    if (!sessionId) return res.status(400).json({ ok: false, code: "bad_request", message: "Missing session." });

    try {
      const row = await sessionsApi.getSession(clientId, sessionId);
      // A session belonging to another tenant is reported as absent, never as
      // forbidden — existence itself is tenant information.
      if (!row) return res.status(404).json({ ok: false, code: "not_found", message: "That setup session was not found." });

      const session = sessionsApi.toPublicSession(row);
      const versionRow = row.profile_version == null ? null : await storeApi.getVersion(clientId, row.profile_version);
      const profileVersion = versionRow ? storeApi.toPublicProfileVersion(versionRow) : null;
      if (!profileVersion) {
        return res.status(409).json({ ok: false, code: "no_draft", message: "This session has no draft to review yet." });
      }

      const assessment = assessProvisioning(profileVersion.profile);
      const readOnly = ["approved", "superseded", "rejected"].includes(profileVersion.status);
      const html = renderReview({
        session,
        profileVersion,
        assessment,
        warnings: session.reviewWarnings || [],
        readOnly,
        isDemo: session.provider === "fixture",
      });

      res.set(PAGE_SECURITY_HEADERS);
      res.type("html");
      return res.status(200).send(html);
    } catch (err) {
      return handleError(res, err);
    }
  }

  // ── Client: confirm one section ───────────────────────────────────

  async function clientConfirmSection(req, res) {
    if (rateLimited(req, res)) return undefined;
    if (!requireJson(req, res)) return undefined;
    const clientId = req.clientId;
    const sessionId = req.params && req.params.sessionId;
    const { section, expectedUpdatedAt } = req.body || {};

    if (!CONFIRMATION_KEYS.includes(section)) {
      return res.status(400).json({ ok: false, code: "bad_section", message: "Unknown section." });
    }

    try {
      const row = await sessionsApi.getSession(clientId, sessionId);
      if (!row || row.profile_version == null) return res.status(404).json({ ok: false, code: "not_found", message: "Draft not found." });
      const versionRow = await storeApi.getVersion(clientId, row.profile_version);
      if (!versionRow) return res.status(404).json({ ok: false, code: "not_found", message: "Draft not found." });
      if (["approved", "superseded", "rejected"].includes(versionRow.status)) {
        return res.status(409).json({ ok: false, code: "closed", message: "This version can no longer be changed." });
      }
      if (expectedUpdatedAt && versionRow.updated_at !== expectedUpdatedAt) {
        return res.status(409).json({ ok: false, code: "stale_review", message: "This draft changed. Reload before confirming." });
      }

      const confirmations = storeApi.applyConfirmation(versionRow.confirmations, { section, actorId: req.clientAuth && req.clientAuth.user ? req.clientAuth.user.id : null });
      const updated = await storeApi.updateReviewState({ clientId, version: versionRow.version, confirmations, expectedUpdatedAt: versionRow.updated_at });
      if (!updated.ok) return res.status(409).json(updated);

      await storeApi.recordAuditEvent(
        storeApi.buildAuditEvent({
          clientId,
          sessionId,
          profileVersion: versionRow.version,
          eventType: "profile.section_confirmed",
          actorType: "client",
          actorId: req.clientAuth && req.clientAuth.user ? req.clientAuth.user.id : null,
          source: "review_ui",
          detail: { section },
        })
      );
      return res.status(200).json({ ok: true, code: "confirmed", section, updatedAt: updated.row.updated_at, confirmations: updated.row.confirmations });
    } catch (err) {
      return handleError(res, err);
    }
  }

  // ── Client: save a correction note (invalidates that confirmation) ─

  async function clientSaveNote(req, res) {
    if (rateLimited(req, res)) return undefined;
    if (!requireJson(req, res)) return undefined;
    const clientId = req.clientId;
    const sessionId = req.params && req.params.sessionId;
    const { section, note, forDiscussion, expectedUpdatedAt } = req.body || {};

    if (!CONFIRMATION_KEYS.includes(section)) {
      return res.status(400).json({ ok: false, code: "bad_section", message: "Unknown section." });
    }
    const text = typeof note === "string" ? note.trim() : "";
    if (!text) return res.status(400).json({ ok: false, code: "empty_note", message: "Tell us what should change." });
    if (text.length > 1000) return res.status(400).json({ ok: false, code: "note_too_long", message: "Keep the note under 1000 characters." });

    try {
      const row = await sessionsApi.getSession(clientId, sessionId);
      if (!row || row.profile_version == null) return res.status(404).json({ ok: false, code: "not_found", message: "Draft not found." });
      const versionRow = await storeApi.getVersion(clientId, row.profile_version);
      if (!versionRow) return res.status(404).json({ ok: false, code: "not_found", message: "Draft not found." });
      if (["approved", "superseded", "rejected"].includes(versionRow.status)) {
        return res.status(409).json({ ok: false, code: "closed", message: "This version can no longer be changed." });
      }
      if (expectedUpdatedAt && versionRow.updated_at !== expectedUpdatedAt) {
        return res.status(409).json({ ok: false, code: "stale_review", message: "This draft changed. Reload before saving." });
      }

      const notes = { ...(versionRow.review_notes || {}) };
      notes[section] = { note: text, forDiscussion: forDiscussion === true, savedAt: new Date().toISOString() };
      // A correction always clears that section's tick: something the reviewer
      // has just disputed is not something they have confirmed.
      const confirmations = storeApi.clearConfirmation(versionRow.confirmations, section);

      const updated = await storeApi.updateReviewState({ clientId, version: versionRow.version, confirmations, reviewNotes: notes, expectedUpdatedAt: versionRow.updated_at });
      if (!updated.ok) return res.status(409).json(updated);

      await storeApi.recordAuditEvent(
        storeApi.buildAuditEvent({
          clientId,
          sessionId,
          profileVersion: versionRow.version,
          eventType: forDiscussion === true ? "profile.section_flagged" : "profile.section_corrected",
          actorType: "client",
          actorId: req.clientAuth && req.clientAuth.user ? req.clientAuth.user.id : null,
          source: "review_ui",
          detail: { section },
        })
      );
      return res.status(200).json({ ok: true, code: "saved", section, updatedAt: updated.row.updated_at });
    } catch (err) {
      return handleError(res, err);
    }
  }

  // ── Client: approve ───────────────────────────────────────────────

  async function clientApprove(req, res) {
    if (rateLimited(req, res)) return undefined;
    if (!requireJson(req, res)) return undefined;
    const clientId = req.clientId;
    const sessionId = req.params && req.params.sessionId;
    const { expectedUpdatedAt, reason } = req.body || {};

    try {
      const row = await sessionsApi.getSession(clientId, sessionId);
      if (!row || row.profile_version == null) return res.status(404).json({ ok: false, code: "not_found", message: "Draft not found." });

      const actor = { type: "client", clientId, id: req.clientAuth && req.clientAuth.user ? req.clientAuth.user.id : null };
      const result = await storeApi.approveVersion({ clientId, version: row.profile_version, actor, reason: reason || null, expectedUpdatedAt: expectedUpdatedAt || null });

      if (!result.ok) {
        // Worst kind wins the status code: auth beats conflict beats state
        // beats content, so the client sees the most actionable failure.
        const kinds = result.blockers.map((b) => b.kind);
        const status = kinds.includes("auth") ? 403 : kinds.includes("conflict") ? 409 : kinds.includes("state") ? 409 : 422;
        return res.status(status).json({ ok: false, code: "approval_refused", message: "These settings can't be approved yet.", blockers: result.blockers });
      }

      // The session follows the profile, not the other way around: the approval
      // above is what counts. A session that refuses the transition (it moved,
      // or was already terminal) is bookkeeping drift worth logging, not a
      // reason to tell the client their approval failed.
      const followed = await sessionsApi.transitionSession({ clientId, sessionId, to: "approved", actor, reason: "profile approved", source: "review_ui" });
      if (followed && followed.ok === false) {
        logger.error("locksmith.onboarding.session_not_followed", `session=${sessionId} code=${followed.code}`);
      }
      return res.status(200).json({ ok: true, code: "approved", version: row.profile_version });
    } catch (err) {
      return handleError(res, err);
    }
  }

  // ── Client: reject ────────────────────────────────────────────────

  async function clientReject(req, res) {
    if (rateLimited(req, res)) return undefined;
    if (!requireJson(req, res)) return undefined;
    const clientId = req.clientId;
    const sessionId = req.params && req.params.sessionId;
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ ok: false, code: "reason_required", message: "Tell us what's wrong so we can fix it." });
    }

    try {
      const row = await sessionsApi.getSession(clientId, sessionId);
      if (!row || row.profile_version == null) return res.status(404).json({ ok: false, code: "not_found", message: "Draft not found." });
      const actor = { type: "client", clientId, id: req.clientAuth && req.clientAuth.user ? req.clientAuth.user.id : null };
      const result = await storeApi.rejectVersion({ clientId, version: row.profile_version, actor, reason: String(reason) });
      if (!result.ok) {
        const kinds = result.blockers.map((b) => b.kind);
        const status = kinds.includes("auth") ? 403 : 409;
        return res.status(status).json({ ok: false, code: "rejection_refused", blockers: result.blockers });
      }
      return res.status(200).json({ ok: true, code: "rejected" });
    } catch (err) {
      return handleError(res, err);
    }
  }

  // ── Founder: session list ─────────────────────────────────────────

  async function founderList(req, res) {
    try {
      const rows = await sessionsApi.listSessions({ limit: 100 });
      const html = renderList({ sessions: rows.map(sessionsApi.toPublicSession) });
      res.set(PAGE_SECURITY_HEADERS);
      res.type("html");
      return res.status(200).send(html);
    } catch (err) {
      if (/not provisioned/i.test(err.message || "")) {
        // The console is the place that tells the founder what to apply.
        const html = renderList({ sessions: [], tablesMissing: true });
        res.set(PAGE_SECURITY_HEADERS);
        res.type("html");
        return res.status(200).send(html);
      }
      return handleError(res, err, { operator: true });
    }
  }

  // ── Founder: one session ──────────────────────────────────────────

  async function founderSession(req, res) {
    const sessionId = req.params && req.params.sessionId;
    try {
      const row = await sessionsApi.getSessionForOperator(sessionId);
      if (!row) return res.status(404).json({ ok: false, code: "not_found", message: "Session not found." });

      const session = sessionsApi.toPublicSession(row);
      const versionRow = row.profile_version == null ? null : await storeApi.getVersion(row.client_id, row.profile_version);
      const profileVersion = versionRow ? storeApi.toPublicProfileVersion(versionRow) : null;
      const assessment = profileVersion ? assessProvisioning(profileVersion.profile) : { ready: false, blockers: [], warnings: [] };
      const events = await storeApi.listAuditEvents(row.client_id, { sessionId });

      const html = renderSession({
        session,
        transcriptText: row.transcript_text,
        profileVersion,
        assessment,
        events,
        rerunAllowed: isExtractionRerunAllowed(env),
        isDemo: session.provider === "fixture",
      });
      res.set(PAGE_SECURITY_HEADERS);
      res.type("html");
      return res.status(200).send(html);
    } catch (err) {
      return handleError(res, err, { operator: true });
    }
  }

  // ── Founder: mark failed ──────────────────────────────────────────

  async function founderFailSession(req, res) {
    if (rateLimited(req, res)) return undefined;
    if (!requireJson(req, res)) return undefined;
    const sessionId = req.params && req.params.sessionId;
    const { code, detail } = req.body || {};
    if (!code || !String(code).trim()) {
      return res.status(400).json({ ok: false, code: "reason_required", message: "A failure reason is required." });
    }
    try {
      const row = await sessionsApi.getSessionForOperator(sessionId);
      if (!row) return res.status(404).json({ ok: false, code: "not_found", message: "Session not found." });
      const result = await sessionsApi.failSession({
        clientId: row.client_id,
        sessionId,
        code: String(code),
        detail: detail ? String(detail) : null,
        actor: { type: "operator", id: req.clientId || "operator" },
      });
      if (!result.ok) return res.status(result.code === "not_found" ? 404 : 409).json({ ok: false, ...result });
      return res.status(200).json({ ok: true, code: "failed" });
    } catch (err) {
      return handleError(res, err, { operator: true });
    }
  }

  // ── Founder: re-run the deterministic extraction (dev/test only) ──

  async function founderRerunExtraction(req, res) {
    if (rateLimited(req, res)) return undefined;
    if (!requireJson(req, res)) return undefined;
    if (!isExtractionRerunAllowed(env)) {
      // Not 403: outside dev/test this action does not exist at all.
      return res.status(404).json({ ok: false, code: "not_available", message: "Re-running extraction is a development-only action." });
    }
    const sessionId = req.params && req.params.sessionId;
    try {
      const row = await sessionsApi.getSessionForOperator(sessionId);
      if (!row) return res.status(404).json({ ok: false, code: "not_found", message: "Session not found." });
      if (!row.transcript_text) return res.status(409).json({ ok: false, code: "no_transcript", message: "This session has no transcript." });

      // An approved profile is never re-extracted over. A re-run always makes a
      // NEW draft version, leaving the approved one exactly as it was.
      const approved = await storeApi.getApprovedVersion(row.client_id);
      const result = extract({
        transcript: row.transcript_text,
        existingProfile: null,
        clientId: row.client_id,
        adapter: row.extraction_version || "fixture-v1",
      });
      if (!result.ok) return res.status(422).json({ ok: false, code: result.code, message: result.message });

      const draft = await storeApi.createDraftVersion({
        clientId: row.client_id,
        profile: result.profile,
        sessionId,
        extractionVersion: result.extractionVersion,
        actor: { type: "operator", id: req.clientId || "operator" },
        reason: "operator re-ran deterministic extraction",
        source: "founder_console",
      });

      return res.status(200).json({
        ok: true,
        code: "re_extracted",
        version: draft.version,
        approvedVersionUntouched: approved ? approved.version : null,
        warnings: result.warnings,
      });
    } catch (err) {
      return handleError(res, err, { operator: true });
    }
  }

  // ── Founder: fixture transcript submission (test path) ────────────
  // The ONLY ingestion entry point in M2, and it is behind the operator login.
  // There is deliberately no public transcript endpoint (spec §6).

  async function founderSubmitTranscript(req, res) {
    if (rateLimited(req, res)) return undefined;
    if (!requireJson(req, res)) return undefined;
    const sessionId = req.params && req.params.sessionId;
    const { transcript, provider, providerCallId, metadata } = req.body || {};
    try {
      const row = await sessionsApi.getSessionForOperator(sessionId);
      if (!row) return res.status(404).json({ ok: false, code: "not_found", message: "Session not found." });

      const result = await receiveTranscript({
        clientId: row.client_id,
        sessionId,
        provider: provider || "fixture",
        providerCallId: providerCallId || null,
        transcript,
        metadata: metadata || null,
        actor: { type: "operator", id: req.clientId || "operator" },
      });
      const status = result.ok ? 200 : result.code === "invalid" ? 400 : result.code === "session_not_found" ? 404 : 409;
      return res.status(status).json(result);
    } catch (err) {
      return handleError(res, err, { operator: true });
    }
  }

  return {
    clientReviewPage,
    clientConfirmSection,
    clientSaveNote,
    clientApprove,
    clientReject,
    founderList,
    founderSession,
    founderFailSession,
    founderRerunExtraction,
    founderSubmitTranscript,
    config,
  };
}

module.exports = { createOnboardingHandlers, PAGE_SECURITY_HEADERS, ACTION_LIMIT, ACTION_WINDOW_MS, isJsonRequest };

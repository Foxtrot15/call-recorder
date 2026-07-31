// AIDA — founder provisioning handlers (M3). Express-free and injectable.
//
// Operator-only (requireLogin at the router). Read-only by default: the preview
// compiles and plans in memory and shows the result. Nothing here can reach a
// provider unless every gate in evaluateExecutionGate passes, which is
// impossible under the shipped configuration.

const { getRetellConfig, toSafeConfigSummary, canWriteLive } = require("../config/retell");
const { compileReceptionist, toRetellPayload } = require("../services/locksmith-receptionist-compiler");
const plans = require("../services/provisioning-plan");
const registry = require("../services/provider-resource-registry");
const store = require("../services/locksmith-profile-store");
const { assessProvisioning } = require("../services/locksmith-profile");
const { renderProvisioningPage } = require("../views/locksmith-provisioning-page");
const { createMockAdapter, createDryRunAdapter, MODES } = require("../services/voice-platform-port");
const { isExtractionRerunAllowed } = require("../config/locksmith-onboarding");

const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "no-store, private",
});

function isJsonRequest(req) {
  const type = (req.headers && (req.headers["content-type"] || req.headers["Content-Type"])) || "";
  return String(type).toLowerCase().includes("application/json");
}

function createProvisioningHandlers(deps = {}) {
  const storeApi = deps.store || store;
  const registryApi = deps.registry || registry;
  const compile = deps.compile || compileReceptionist;
  const toPayload = deps.toRetellPayload || toRetellPayload;
  const render = deps.render || renderProvisioningPage;
  const planApi = deps.plans || plans;
  const logger = deps.logger || console;
  const env = deps.env || process.env;

  /**
   * Build everything the preview needs. Shared by the page and the mock
   * execution path so they can never disagree about what the plan is.
   */
  async function buildPreview(clientId) {
    const config = getRetellConfig(env);
    const approvedRow = await storeApi.getApprovedVersion(clientId);

    if (!approvedRow) {
      return { config, approvedRow: null, compiled: null, retellPayload: null, plan: null, resources: [], assessment: null };
    }

    const assessment = assessProvisioning(approvedRow.profile);
    const compiled = compile({
      profile: approvedRow.profile,
      profileVersion: approvedRow.version,
      profileStatus: approvedRow.status,
      clientId,
      templateVersion: config.receptionistTemplateVersion,
      config,
      // Supplied, not read from the clock inside the compiler — hashing stays pure.
      generatedAt: deps.now ? deps.now() : null,
    });

    const retellPayload = compiled.ok ? toPayload({ compiled, config }) : null;

    let resources = [];
    try {
      resources = await registryApi.listResources(clientId, { provider: config.provider });
    } catch (err) {
      // Tables not provisioned yet is the normal M3 state; the page says so
      // rather than failing.
      logger.error(`provisioning.resources_unavailable code=${/not provisioned/i.test(err.message) ? "not_provisioned" : "db_error"}`);
      resources = [];
    }

    const plan = compiled.ok
      ? planApi.createPlan({
          clientId,
          approvedProfileVersion: approvedRow.version,
          profileStatus: approvedRow.status,
          provisioningReady: assessment.ready,
          compiled,
          retellPayload,
          existingResources: resources,
          templateVersions: {
            receptionist: config.receptionistTemplateVersion,
            onboarding: config.onboardingTemplateVersion,
          },
          provider: config.provider,
          createdBy: null,
          createdAt: deps.now ? deps.now() : null,
        })
      : planApi.createPlan({
          clientId,
          approvedProfileVersion: approvedRow.version,
          profileStatus: approvedRow.status,
          provisioningReady: assessment.ready,
          compiled,
          retellPayload: null,
          existingResources: resources,
        });

    return { config, approvedRow, assessment, compiled, retellPayload, plan, resources };
  }

  async function provisioningPage(req, res) {
    const clientId = req.params && req.params.clientId;
    if (!clientId) return res.status(400).json({ ok: false, code: "bad_request", message: "Missing client." });

    try {
      const preview = await buildPreview(clientId);
      const configSummary = toSafeConfigSummary(env);

      if (!preview.approvedRow) {
        res.set(PAGE_SECURITY_HEADERS);
        res.type("html");
        return res.status(200).send(
          render({
            clientId,
            configSummary,
            approvedVersion: null,
            provisioningReady: false,
            compiled: null,
            retellPayload: null,
            plan: null,
            resources: [],
            auditEvents: [],
            executionAllowed: false,
            mockExecutionAllowed: isExtractionRerunAllowed(env),
          })
        );
      }

      // Execution is revealed ONLY when every gate passes. Computed here,
      // server-side, from the real plan and the real config.
      const gate = planApi.evaluateExecutionGate({
        plan: { ...preview.plan, status: "approved_for_execution" },
        config: preview.config,
        actor: { type: "operator", id: req.clientId || "operator" },
        currentApprovedVersion: preview.approvedRow.version,
        explicitRequest: true,
        capability: canWriteLive(env),
      });

      let auditEvents = [];
      try {
        auditEvents = await storeApi.listAuditEvents(clientId, { limit: 30 });
      } catch {
        auditEvents = [];
      }

      res.set(PAGE_SECURITY_HEADERS);
      res.type("html");
      return res.status(200).send(
        render({
          clientId,
          configSummary,
          approvedVersion: preview.approvedRow.version,
          provisioningReady: preview.assessment.ready,
          compiled: preview.compiled,
          retellPayload: preview.retellPayload,
          plan: preview.plan,
          resources: preview.resources.map(registryApi.toOperatorResource),
          auditEvents,
          executionAllowed: gate.allowed,
          mockExecutionAllowed: isExtractionRerunAllowed(env),
          transferNumbersMasked: {
            primary: preview.approvedRow.transfer_primary_number || null,
            backup: preview.approvedRow.transfer_backup_number || null,
          },
        })
      );
    } catch (err) {
      logger.error("provisioning.preview_failed", err.message);
      return res.status(500).json({ ok: false, code: "error", message: "Could not build the preview." });
    }
  }

  /**
   * Mock execution. Development/test only. Exercises the REAL planning,
   * execution and registry code against an in-memory adapter, so the path being
   * proven is the one that would run for real.
   */
  async function mockExecute(req, res) {
    if (!isJsonRequest(req)) return res.status(415).json({ ok: false, code: "unsupported_media_type" });
    if (!isExtractionRerunAllowed(env)) {
      return res.status(404).json({ ok: false, code: "not_available", message: "Mock execution is a development-only action." });
    }
    const clientId = req.params && req.params.clientId;

    try {
      const preview = await buildPreview(clientId);
      if (!preview.plan || preview.plan.blockingReasons.length) {
        return res.status(409).json({ ok: false, code: "plan_blocked", blockers: preview.plan ? preview.plan.blockingReasons : [] });
      }

      const adapter = deps.mockAdapter || createMockAdapter();
      const recorded = [];
      const result = await planApi.executePlan({
        plan: preview.plan,
        adapter,
        alreadyDone: new Set(),
        onResourceProvisioned: async (r) => {
          recorded.push(r);
        },
        logger,
      });

      logger.log(`provisioning.mock_execute client=${clientId} status=${result.status} succeeded=${result.summary.succeeded}`);
      return res.status(200).json({
        ok: true,
        mode: MODES.mock,
        status: result.status,
        summary: result.summary,
        // Mock ids only. Nothing external exists.
        resources: recorded.map((r) => ({ purpose: r.purpose, resourceType: r.resourceType, providerResourceId: r.providerResourceId, mode: r.mode })),
      });
    } catch (err) {
      logger.error("provisioning.mock_execute_failed", err.message);
      return res.status(500).json({ ok: false, code: "error" });
    }
  }

  /** Dry run: produce the plan and record what WOULD be sent. No network. */
  async function dryRun(req, res) {
    if (!isJsonRequest(req)) return res.status(415).json({ ok: false, code: "unsupported_media_type" });
    const clientId = req.params && req.params.clientId;
    try {
      const preview = await buildPreview(clientId);
      if (!preview.plan || preview.plan.blockingReasons.length) {
        return res.status(409).json({ ok: false, code: "plan_blocked", blockers: preview.plan ? preview.plan.blockingReasons : [] });
      }
      const recorder = [];
      const adapter = createDryRunAdapter({ recorder });
      const result = await planApi.executePlan({ plan: preview.plan, adapter, logger });
      return res.status(200).json({
        ok: true,
        mode: MODES.dryRun,
        status: result.status,
        summary: result.summary,
        wouldSend: recorder.map((r) => ({ operation: r.operation, payloadHash: r.payloadHash.slice(0, 16) })),
        networkRequestsMade: 0,
      });
    } catch (err) {
      logger.error("provisioning.dry_run_failed", err.message);
      return res.status(500).json({ ok: false, code: "error" });
    }
  }

  return { provisioningPage, mockExecute, dryRun, buildPreview };
}

module.exports = { createProvisioningHandlers, PAGE_SECURITY_HEADERS, isJsonRequest };

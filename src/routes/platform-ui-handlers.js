// AIDA PLATFORM UI — the HTML surface (P29-P35). Behaviour only.
//
// Imports no express, so every handler is testable without node_modules —
// the same split platform-config-handlers.js and locksmith-portal-handlers.js
// use.
//
// ── IT ADDS NO AUTHORITY ────────────────────────────────────────────
// Every one of these handlers calls the SAME config service and provisioning
// service the JSON API calls, with the SAME principal, resolved the same way.
// There is no UI-only operation, no UI-only store, and no path here that can
// do something the JSON surface cannot.
//
// That is the whole design: the eventual voice configuration agent will call
// the same service, and its drafts will appear on these screens with nothing
// special about them except `source: "voice"`.
//
// ── AND IT PROVISIONS NOTHING ───────────────────────────────────────
// There is no execute handler. Not disabled — absent, as in the JSON surface.
// This file imports no provider module, no transport, and no executor; a
// ratchet reads it and asserts so.
//
// ── THE TENANT IS NEVER FROM THE URL ────────────────────────────────
// `:clientId` says which client the caller WANTS. Authority comes from
// req.clientId, resolved server-side by src/middleware/auth.js, and
// config-access decides. A screen that renders is a screen the service already
// agreed to answer.

const { principalFromRequest, authorise } = require("../platform/config-access");
const VM = require("../platform/ui/ui-view-models");
const F = require("../platform/ui/ui-fields");
const pages = require("../views/platform-config-pages");
const provPages = require("../views/platform-provisioning-pages");
const wizard = require("../views/platform-wizard-page");
const { escapeHtml } = require("../views/escape");

/** The repo's page CSP. Inline script and inline style are both forbidden. */
const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
});

const SAFE_REFUSALS = Object.freeze({
  forbidden: "Not authorised for this client.",
  not_found: "Not found.",
});

const basePathFor = (clientId) => `/platform/clients/${encodeURIComponent(clientId)}`;

function errorPage(title, message, status) {
  const S = require("../views/platform-shell");
  return S.page({
    title,
    heading: title,
    active: "overview",
    basePath: "/platform",
    state: { screen: "error", status: String(status) },
    body: S.notice(message, status >= 500 ? "danger" : "warn"),
  });
}

function createPlatformUiHandlers({ configService, provisioningService, logger = console } = {}) {
  if (!configService) throw new Error("createPlatformUiHandlers requires a config service");
  if (!provisioningService) throw new Error("createPlatformUiHandlers requires a provisioning service");

  function html(res, body, status = 200) {
    res.set(PAGE_SECURITY_HEADERS);
    // Configuration is per-client and changes on every save. Caching it is how
    // one client sees another's page out of a shared proxy.
    res.set("Cache-Control", "no-store, private");
    res.type("html");
    return res.status(status).send(body);
  }

  /**
   * Principal + tenant, or a rendered refusal.
   *
   * ── WHY THIS ASKS CONFIG-ACCESS ITSELF ────────────────────────────
   * The JSON surface can rely on each service call to refuse, because a
   * refusal IS its response. A page is different: it composes several reads,
   * and a page-builder that treats "could not load" as "nothing to show" turns
   * a cross-tenant refusal into an empty 200 for any client id somebody types.
   *
   * That happened here and a test caught it. So authority is now checked ONCE,
   * explicitly, before a page is built — and every service call underneath
   * still refuses independently, because two checks is the right number when
   * one of them is a convenience.
   */
  function begin(req, res, operation = "config:view") {
    const principal = principalFromRequest(req);
    const clientId = req.params && req.params.clientId;
    if (!principal) {
      html(res, errorPage("Not authorised", SAFE_REFUSALS.forbidden, 403), 403);
      return null;
    }
    if (!clientId) {
      html(res, errorPage("Not found", SAFE_REFUSALS.not_found, 404), 404);
      return null;
    }
    const decision = authorise({ principal, operation, clientId });
    if (!decision.ok) {
      // One indistinguishable refusal. A caller poking at other clients' URLs
      // learns only that they may not — never whether the client exists.
      html(res, errorPage("Not authorised", SAFE_REFUSALS.forbidden, 403), 403);
      return null;
    }
    return { principal, clientId, basePath: basePathFor(clientId) };
  }

  /**
   * A refused service result becomes a page, with the SAME narrow vocabulary
   * the JSON surface uses. A caller poking at another client's URL learns only
   * that they may not — never whether the client exists.
   */
  function refuse(res, result) {
    const status = { forbidden: 403, not_found: 404, invalid: 422, conflict: 409, unavailable: 503 }[result.outcome] || 400;
    const message = SAFE_REFUSALS[result.outcome] || result.message || "That request was refused.";
    return html(res, errorPage(status === 403 ? "Not authorised" : "Unavailable", message, status), status);
  }

  const guard = (name, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      logger.error(`[platform-ui] ${name} failed: ${error && error.message}`);
      html(res, errorPage("Something went wrong", "This screen could not be built. Nothing was changed.", 500), 500);
    }
  };

  // ── shared loads ──────────────────────────────────────────────────

  async function loadActive(ctx) {
    const r = await configService.getActive(ctx);
    return r.ok ? r.version : null;
  }

  /** The newest version that is still open for editing, if any. */
  async function loadDraft(ctx) {
    const listed = await configService.listVersions(ctx);
    if (!listed.ok) return null;
    const open = (listed.versions || []).filter((v) => ["draft", "validated", "approved"].includes(v.status));
    if (!open.length) return null;
    const newest = open.reduce((a, b) => ((b.configVersion ?? 0) > (a.configVersion ?? 0) ? b : a));
    const full = await configService.getVersion({ ...ctx, configVersion: newest.configVersion });
    return full.ok ? full.version : null;
  }

  async function loadPlan(ctx) {
    const listed = await provisioningService.listPlans(ctx);
    if (!listed.ok) return null;
    const open = (listed.plans || []).filter((p) => ["draft", "validated", "approved"].includes(p.status));
    if (!open.length) return null;
    const full = await provisioningService.getPlan({ ...ctx, planId: open[open.length - 1].planId });
    return full.ok ? { plan: full.plan, staleness: full.staleness } : null;
  }

  return {
    // ── P30 dashboard ───────────────────────────────────────────────
    dashboard: guard("dashboard", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;

      const [active, draft, planned, readiness] = await Promise.all([
        loadActive(ctx), loadDraft(ctx), loadPlan(ctx), provisioningService.readiness(ctx),
      ]);
      const desired = await provisioningService.getDesiredPayloads(ctx).catch(() => null);

      const model = VM.dashboardModel({
        clientId: ctx.clientId,
        principal: ctx.principal,
        active, draft,
        plan: planned ? planned.plan : null,
        readiness: readiness && readiness.ok ? readiness.readiness : null,
        desired: desired && desired.ok ? desired : null,
      });
      html(res, pages.renderDashboard(model, ctx.basePath));
    }),

    // ── P30A history ────────────────────────────────────────────────
    history: guard("history", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const listed = await configService.listVersions(ctx);
      if (!listed.ok) return refuse(res, listed);
      const events = await configService.history(ctx);

      const model = VM.historyModel({
        clientId: ctx.clientId,
        principal: ctx.principal,
        versions: listed.versions || [],
        events: events.ok ? events.events || [] : [],
      });
      html(res, pages.renderHistory(model, ctx.basePath));
    }),

    // ── P31 editor ──────────────────────────────────────────────────
    editor: guard("editor", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;

      const key = (req.params && req.params.section) || F.SECTION_KEYS[0];
      const section = F.sectionFor(key);
      if (!section) return refuse(res, { outcome: "not_found" });

      const draft = await loadDraft(ctx);
      const source = draft || (await loadActive(ctx));
      if (!source) {
        return html(res, errorPage("Nothing to edit", "This client has no configuration yet. Start the setup wizard to create one.", 404), 404);
      }

      const values = F.readSection(source, key);
      const items = section.repeatable ? F.getPath(source, section.repeatable.path) || [] : null;
      const secondaryItems = section.secondaryRepeatable ? F.getPath(source, section.secondaryRepeatable.path) || [] : null;

      html(res, pages.renderEditor({
        clientId: ctx.clientId,
        section, values, items, secondaryItems,
        configVersion: source.metadata ? source.metadata.configVersion : null,
        expectedUpdatedAt: source.metadata ? source.metadata.updatedAt ?? null : null,
        // A draft that is already approved cannot be edited; the service
        // refuses, and the screen says so rather than pretending otherwise.
        readOnly: Boolean(draft && draft.metadata && draft.metadata.status === "approved"),
        conflict: null,
      }, ctx.basePath));
    }),

    /**
     * The save. It is the ONLY write this file performs on a blueprint, it
     * goes through configService.updateDraft, and it passes the CAS token
     * straight through — never omitting it to make a conflict go away.
     */
    saveSection: guard("saveSection", async (req, res) => {
      const ctx = begin(req, res, "config:draft");
      if (!ctx) return;
      const body = req.body || {};
      const key = body.section || (req.params && req.params.section);
      const section = F.sectionFor(key);
      if (!section) return res.status(404).json({ error: SAFE_REFUSALS.not_found });

      const configVersion = Number(req.params.versionId);
      if (!Number.isInteger(configVersion) || configVersion <= 0) {
        return res.status(404).json({ error: SAFE_REFUSALS.not_found });
      }

      const args = {
        ...ctx,
        configVersion,
        mutate: (draft) => {
          const next = F.applySection(draft, key, body.values || {});
          // applySection is pure; copy the result back onto the draft the
          // authority handed us, section by section, so nothing outside the
          // edited section can be touched by a crafted payload.
          for (const s of ["identity", "services", "serviceArea", "hours", "callHandling",
            "knowledge", "booking", "voice", "compliance", "outbound", "integrations"]) {
            if (next[s] !== undefined) draft[s] = next[s];
          }
        },
      };
      if (Object.prototype.hasOwnProperty.call(body, "expectedUpdatedAt")) {
        args.expectedUpdatedAt = body.expectedUpdatedAt;
      }

      const result = await configService.updateDraft(args);
      if (!result.ok) {
        const status = { forbidden: 403, not_found: 404, invalid: 422, conflict: 409, unavailable: 503 }[result.outcome] || 400;
        // A conflict returns the conflict, never a merged result.
        return res.status(status).json({
          error: result.outcome === "forbidden" ? SAFE_REFUSALS.forbidden : result.message,
          code: result.code,
          errors: result.errors,
        });
      }
      return res.status(200).json({
        ok: true,
        configVersion: result.version ? result.version.metadata.configVersion : configVersion,
        updatedAt: result.version && result.version.metadata ? result.version.metadata.updatedAt ?? null : null,
      });
    }),

    // ── P32/P32A/P32B review ────────────────────────────────────────
    review: guard("review", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;

      const draft = await loadDraft(ctx);
      if (!draft) {
        return html(res, errorPage("Nothing to review", "There is no open draft. Edit the configuration to create one.", 404), 404);
      }
      const toVersion = draft.metadata.configVersion;

      const [diff, validation] = await Promise.all([
        configService.diff({ ...ctx, fromVersion: null, toVersion }),
        configService.validate({ ...ctx, configVersion: toVersion }),
      ]);

      const model = VM.diffModel({
        clientId: ctx.clientId,
        principal: ctx.principal,
        fromVersion: null,
        toVersion,
        diff: diff.ok ? diff.diff : null,
        // validate() returns ok:false with errors when the blueprint is bad —
        // that is a RESULT, not a failure of the request.
        validation: validation.ok
          ? { ok: true, errors: [], warnings: validation.warnings || [] }
          : { ok: false, errors: validation.errors || [], warnings: validation.warnings || [] },
        draftStatus: draft.metadata.status,
      });

      html(res, pages.renderReview(model, ctx.basePath, {
        showRaw: VM.can(ctx.principal, "provisioning:create"),
      }));
    }),

    validateDraft: guard("validateDraft", async (req, res) => {
      const ctx = begin(req, res, "config:validate");
      if (!ctx) return;
      const configVersion = Number(req.params.versionId);
      const result = await configService.validate({ ...ctx, configVersion });
      return res.status(result.ok ? 200 : 422).json({
        ok: result.ok,
        errors: result.errors || [],
        warnings: result.warnings || [],
      });
    }),

    approve: guard("approve", async (req, res) => {
      const ctx = begin(req, res, "config:approve");
      if (!ctx) return;
      const configVersion = Number(req.params.versionId);
      const reason = req.body && typeof req.body.reason === "string" ? req.body.reason.slice(0, 2000) : null;
      const result = await configService.approve({ ...ctx, configVersion, reason });
      if (!result.ok) return refuse(res, result);
      return res.redirect(303, `${ctx.basePath}/activate?version=${encodeURIComponent(String(configVersion))}`);
    }),

    // ── P32C activation ─────────────────────────────────────────────
    activatePage: guard("activatePage", async (req, res) => {
      const ctx = begin(req, res, "config:view");
      if (!ctx) return;
      const requested = Number((req.query && req.query.version) || 0);
      const draft = await loadDraft(ctx);
      const active = await loadActive(ctx);
      const version = Number.isInteger(requested) && requested > 0
        ? requested
        : draft ? draft.metadata.configVersion : null;

      if (!version) {
        return html(res, errorPage("Nothing to activate", "There is no approved version waiting.", 404), 404);
      }
      const target = await configService.getVersion({ ...ctx, configVersion: version });
      if (!target.ok) return refuse(res, target);

      const approved = target.version.metadata.status === "approved";
      const allowed = VM.can(ctx.principal, "config:activate");
      const blocked = [];
      if (!approved) blocked.push(`Version ${version} is ${target.version.metadata.status}. Only an APPROVED version can be activated.`);
      if (!allowed) blocked.push("Activation is an operator decision and your role does not hold it.");

      html(res, pages.renderActivate({
        clientId: ctx.clientId,
        configVersion: version,
        approvedBy: target.version.metadata.approvedBy,
        currentActiveVersion: active ? active.metadata.configVersion : null,
        canActivate: blocked.length === 0,
        blockedBecause: blocked,
      }, ctx.basePath));
    }),

    /** Calls configService.activate and NOTHING else. No provider code exists here. */
    activate: guard("activate", async (req, res) => {
      const ctx = begin(req, res, "config:activate");
      if (!ctx) return;
      const configVersion = Number((req.body && req.body.version) || (req.query && req.query.version) || 0);
      const result = await configService.activate({ ...ctx, configVersion });
      if (!result.ok) return refuse(res, result);
      return res.redirect(303, ctx.basePath);
    }),

    restore: guard("restore", async (req, res) => {
      const ctx = begin(req, res, "config:draft");
      if (!ctx) return;
      const configVersion = Number(req.params.versionId);
      const result = await configService.restore({ ...ctx, configVersion });
      if (!result.ok) return refuse(res, result);
      return res.redirect(303, `${ctx.basePath}/edit`);
    }),

    // ── P33 behaviour preview ───────────────────────────────────────
    behaviourPreview: guard("behaviourPreview", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const direction = req.query && req.query.direction === "outbound" ? "outbound" : "inbound";

      const preview = await configService.preview({ ...ctx, configVersion: null, direction });
      if (!preview.ok) {
        return html(res, provPages.renderBehaviourPreview(
          { clientId: ctx.clientId, available: false, direction, reason: preview.message || "There is no valid active configuration to preview." },
          ctx.basePath,
        ));
      }

      const active = await loadActive(ctx);
      const { compileBehaviourSpec } = require("../platform/behaviour-spec");
      const { spec } = compileBehaviourSpec(active);

      const model = VM.behaviourPreviewModel({
        clientId: ctx.clientId, spec, direction, openingLine: preview.openingLine,
      });
      html(res, provPages.renderBehaviourPreview(model, ctx.basePath));
    }),

    // ── P33A provider preview ───────────────────────────────────────
    providerPreview: guard("providerPreview", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const direction = req.query && req.query.direction === "outbound" ? "outbound" : "inbound";
      const preview = await configService.preview({ ...ctx, configVersion: null, direction });

      const model = VM.providerPreviewModel({
        clientId: ctx.clientId,
        principal: ctx.principal,
        preview: preview.ok ? preview : null,
        rawPayload: preview.ok ? { responseEngine: { general_prompt: preview.prompt, begin_message: preview.openingLine } } : null,
      });
      html(res, provPages.renderProviderPreview(model, ctx.basePath));
    }),

    // ── P34 provisioning ────────────────────────────────────────────
    provisioning: guard("provisioning", async (req, res) => {
      const ctx = begin(req, res, "provisioning:view");
      if (!ctx) return;
      const planned = await loadPlan(ctx);
      if (!planned) {
        return html(res, provPages.renderPlan(
          { clientId: ctx.clientId, available: false, reason: "No provisioning plan has been created for the active configuration." },
          ctx.basePath,
        ));
      }
      const current = await provisioningService.getDiff(ctx).catch(() => null);

      const model = VM.planModel({
        clientId: ctx.clientId,
        principal: ctx.principal,
        plan: planned.plan,
        staleness: planned.staleness,
        currentResources: current && current.ok ? current.current || [] : [],
      });
      html(res, provPages.renderPlan(model, ctx.basePath));
    }),

    createPlan: guard("createPlan", async (req, res) => {
      const ctx = begin(req, res, "provisioning:create");
      if (!ctx) return;
      const result = await provisioningService.createPlan({ ...ctx, direction: "inbound", notes: null });
      if (!result.ok) return refuse(res, result);
      return res.redirect(303, `${ctx.basePath}/provisioning`);
    }),

    approvePlan: guard("approvePlan", async (req, res) => {
      const ctx = begin(req, res, "provisioning:approve");
      if (!ctx) return;
      const body = req.body || {};
      const result = await provisioningService.approvePlan({
        ...ctx,
        planId: req.params.planId,
        reason: typeof body.reason === "string" ? body.reason.slice(0, 2000) : null,
        expectedPlanHash: typeof body.expectedPlanHash === "string" ? body.expectedPlanHash : null,
      });
      if (!result.ok) return refuse(res, result);
      return res.redirect(303, `${ctx.basePath}/provisioning`);
    }),

    // ── P35 wizard ──────────────────────────────────────────────────
    wizard: guard("wizard", async (req, res) => {
      const ctx = begin(req, res);
      if (!ctx) return;
      const draft = await loadDraft(ctx);
      const active = await loadActive(ctx);
      const source = draft || active;

      // Step state is DERIVED from the draft, so leaving and returning needs no
      // resume logic and there is no wizard-only state to fall out of sync.
      const stepState = {};
      for (const step of wizard.WIZARD_STEPS) {
        if (step.kind !== "edit") {
          stepState[step.key] = "todo";
          continue;
        }
        const values = source ? F.readSection(source, step.section) : {};
        const required = F.fieldsFor(step.section).filter((f) => f.required && !f.locked);
        const done = required.length > 0 && required.every((f) => {
          const v = values[f.name];
          return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
        });
        stepState[step.key] = done ? "done" : "todo";
      }
      if (draft && draft.metadata.status === "approved") stepState.approve = "done";
      if (active) { stepState.activate = "done"; stepState.review = "done"; stepState.validate = "done"; }

      html(res, wizard.renderWizard({
        clientId: ctx.clientId,
        draftVersion: draft ? draft.metadata.configVersion : null,
        draftStatus: draft ? require("../platform/ui/ui-vocabulary").configChip(draft.metadata.status) : null,
        createdAt: draft ? draft.metadata.createdAt : null,
        currentStep: (req.query && req.query.step) || null,
        stepState,
      }, ctx.basePath));
    }),

    startWizard: guard("startWizard", async (req, res) => {
      const ctx = begin(req, res, "config:draft");
      if (!ctx) return;
      const { emptyBlueprint } = require("../platform/client-blueprint");
      const blueprint = emptyBlueprint({ clientId: ctx.clientId, vertical: (req.body && req.body.vertical) || null });
      const result = await configService.createDraft({ ...ctx, blueprint, source: "ui" });
      if (!result.ok) return refuse(res, result);
      return res.redirect(303, `${ctx.basePath}/edit/identity`);
    }),
  };
}

module.exports = { createPlatformUiHandlers, PAGE_SECURITY_HEADERS, SAFE_REFUSALS, basePathFor, escapeHtml };

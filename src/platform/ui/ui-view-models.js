// AIDA PLATFORM UI — what each screen shows, decided in Node (P30-P34).
//
//   dashboardModel({ ... })        the configuration home
//   historyModel({ ... })          version history
//   diffModel({ ... })             review changes
//   behaviourPreviewModel({ ... }) what the assistant will broadly do
//   providerPreviewModel({ ... })  the operator's provider view
//   planModel({ ... })             provisioning plan review
//
// ── WHY THE VIEW MODEL IS NOT IN THE BROWSER ────────────────────────
// Everything on these screens is a decision: whether Approve is offered,
// whether a state is dangerous, whether readiness may look like permission.
// Decisions made in a <script> tag are decisions nothing can test without a
// browser, and this repo has no browser in its test stack.
//
// So the browser receives a model that has already decided, and its only job is
// to draw it. That also means every rule below is covered by an ordinary
// node:test assertion rather than by clicking.
//
// ── THE RULE THESE MODELS EXIST TO KEEP ─────────────────────────────
// A control is offered only when the BACKEND would allow it. Never the reverse:
// no model here grants anything, and hiding a button is not security. The
// backend refuses regardless, and tests prove it by calling the handlers
// directly with principals whose buttons would have been hidden.

const V = require("./ui-vocabulary");
const { presentDiff } = require("./ui-diff");
const { CAPABILITIES, ROLES } = require("../config-access");

// CAPABILITIES is a LIST of capability strings, not a keyed object. Naming them
// here keeps the call sites readable and — more usefully — makes a typo fail
// loudly at import instead of silently evaluating to `undefined`, which reads
// as "this role cannot" and quietly hides every control on every screen.
const CAP = Object.freeze({
  VIEW: "config:view",
  DRAFT: "config:draft",
  VALIDATE: "config:validate",
  APPROVE: "config:approve",
  ACTIVATE: "config:activate",
  PREVIEW: "config:preview",
  PROV_VIEW: "provisioning:view",
  PROV_CREATE: "provisioning:create",
  PROV_VALIDATE: "provisioning:validate",
  PROV_APPROVE: "provisioning:approve",
});
for (const [name, value] of Object.entries(CAP)) {
  if (!CAPABILITIES.includes(value)) {
    throw new Error(`ui-view-models: CAP.${name} = "${value}" is not a capability config-access declares`);
  }
}

const can = (principal, capability) =>
  Boolean(principal && ROLES[principal.role] && ROLES[principal.role].includes(capability));

/** A control the screen may draw, and — always — why it is or is not offered. */
const action = (id, labelText, offered, why) =>
  Object.freeze({ id, label: labelText, offered: Boolean(offered), why });

// ════════════════════════════════════════════════════════════════════
// P30 — CONFIGURATION HOME
// ════════════════════════════════════════════════════════════════════

/**
 * @param active     the active version, or null
 * @param draft      the newest open draft, or null
 * @param plan       the newest open provisioning plan, or null
 * @param readiness  the readiness assessment from provisioning-readiness.js
 */
function dashboardModel({ clientId, principal, active = null, draft = null, plan = null, readiness = null, desired = null } = {}) {
  const identity = (active || draft || {}).identity || {};
  const meta = (active || {}).metadata || {};
  const draftMeta = (draft || {}).metadata || {};

  const client = Object.freeze({
    clientId,
    legalName: identity.legalName || null,
    tradingName: identity.tradingName || null,
    assistantName: identity.assistantName || null,
    vertical: identity.vertical || null,
    locale: identity.locale || null,
    timezone: identity.timezone || null,
    country: identity.country || null,
  });

  const configuration = Object.freeze({
    activeVersion: meta.configVersion ?? null,
    activeStatus: active ? V.configChip(meta.status) : null,
    activatedAt: meta.activatedAt ?? null,
    activatedBy: meta.activatedBy ?? null,
    contentHash: meta.contentHash ?? null,
    draftVersion: draftMeta.configVersion ?? null,
    draftStatus: draft ? V.configChip(draftMeta.status) : null,
    // "validated" is a lifecycle state, so asking the metadata is asking the
    // authority rather than re-deciding here.
    draftValidated: draft ? draftMeta.status === "validated" || draftMeta.status === "approved" : null,
    draftApproved: draft ? draftMeta.status === "approved" : null,
    draftApprovedBy: draftMeta.approvedBy ?? null,
    hasOpenDraft: Boolean(draft),
  });

  const provisioning = Object.freeze({
    desiredReady: desired ? Boolean(desired.ok) : null,
    unresolved: Object.freeze((desired && desired.unresolved) || []),
    planId: plan ? plan.planId : null,
    planStatus: plan ? V.planChip(plan.status) : null,
    mutatingCount: plan ? plan.mutatingCount ?? null : null,
    // The sentence that must accompany every approved plan, everywhere.
    approvedNotExecuted: Boolean(plan && plan.status === "approved"),
    executionNote: "Provider changes require a separately authorised provisioning operation.",
  });

  const readinessView = readiness
    ? Object.freeze({
        // Never recomputed here. The service decided; this only styles it.
        ready: readiness.ready,
        isPermission: false,
        disclaimer: V.READINESS_DISCLAIMER,
        reason: readiness.readyReason || null,
        blockerCount: readiness.blockerCount ?? (readiness.blockers || []).length,
        dimensions: Object.freeze(
          (readiness.dimensions || []).map((d) =>
            Object.freeze({
              ...d,
              tone: V.READINESS_TONE[d.status] || "neutral",
              mark: V.TONE_MARK[V.READINESS_TONE[d.status] || "neutral"],
            }),
          ),
        ),
      })
    : null;

  // Every control states, in order, the FIRST reason it is unavailable. A
  // greyed-out button with no explanation is a support call, and the reason is
  // usually the thing the person needs to go and do.
  const gated = (id, labelText, checks) => {
    const failed = checks.find((c) => !c.pass);
    return action(id, labelText, !failed, failed ? failed.why : null);
  };
  const hasDraft = { pass: Boolean(draft), why: "There is no open draft. Start editing to create one." };

  const actions = Object.freeze([
    gated("edit", "Edit configuration", [
      { pass: can(principal, CAP.DRAFT), why: "Your role can view this configuration but not change it." },
    ]),
    gated("validate", "Validate draft", [
      hasDraft,
      { pass: can(principal, CAP.VALIDATE), why: "Your role cannot run validation." },
    ]),
    gated("review", "Review changes", [hasDraft]),
    gated("approve", "Approve", [
      hasDraft,
      { pass: can(principal, CAP.APPROVE), why: "Approval is a named human decision and your role does not hold it." },
    ]),
    gated("activate", "Activate", [
      { pass: Boolean(draft && draftMeta.status === "approved"), why: "Only an APPROVED version can be activated." },
      { pass: can(principal, CAP.ACTIVATE), why: "Activation is an operator decision and your role does not hold it." },
    ]),
    gated("plan", "Build provisioning plan", [
      { pass: Boolean(active), why: "A provisioning plan is built from the ACTIVE configuration, and none is active yet." },
      { pass: can(principal, CAP.PROV_CREATE), why: "Building a provisioning plan is an operator action." },
    ]),
  ]);

  // There is no execute action, in any branch, for any role. A test asserts the
  // id "execute" never appears in any model this module produces.
  return Object.freeze({
    screen: "dashboard",
    clientId,
    client,
    configuration,
    provisioning,
    readiness: readinessView,
    actions,
  });
}

// ════════════════════════════════════════════════════════════════════
// P30A — VERSION HISTORY
// ════════════════════════════════════════════════════════════════════

const SOURCE_WORDS = Object.freeze({
  ui: "Web form",
  voice: "Voice configuration agent",
  api: "API",
  import: "Imported",
  operator: "Operator",
});

/**
 * History never offers an edit control for anything but an open draft. The
 * backend refuses to edit an approved or active version too — but a screen that
 * shows an Edit button next to an ACTIVE version teaches people the wrong model
 * of the system, which they then rely on.
 */
function historyModel({ clientId, principal, versions = [], events = [] } = {}) {
  const rows = versions
    .slice()
    .sort((a, b) => (b.configVersion ?? 0) - (a.configVersion ?? 0))
    .map((v) => {
      const editable = v.status === "draft" || v.status === "validated";
      return Object.freeze({
        configVersion: v.configVersion ?? null,
        status: V.configChip(v.status),
        source: SOURCE_WORDS[v.source] || v.source || "unknown",
        sourceKey: v.source || null,
        createdAt: v.createdAt ?? null,
        createdBy: v.createdBy ?? null,
        approvedAt: v.approvedAt ?? null,
        approvedBy: v.approvedBy ?? null,
        activatedAt: v.activatedAt ?? null,
        activatedBy: v.activatedBy ?? null,
        supersededAt: v.supersededAt ?? null,
        superseded: Boolean(v.supersededAt) || v.status === "superseded",
        isActive: v.status === "active",
        // What may be done WITH this row.
        canView: true,
        canEdit: editable && can(principal, CAP.DRAFT),
        // Restore never rewrites: it creates a NEW draft from this content.
        canRestore: !editable && can(principal, CAP.DRAFT),
        restoreNote: "Restoring copies this version into a NEW draft. History is never rewritten and this version is not changed.",
        readOnlyReason: editable ? null
          : v.status === "approved" ? "Approved versions are immutable. Restore it into a new draft instead."
          : v.status === "active" ? "The active version is what AIDA is using now. Restore it into a new draft instead."
          : "Superseded versions are kept exactly as they were.",
      });
    });

  return Object.freeze({
    screen: "history",
    clientId,
    versions: Object.freeze(rows),
    events: Object.freeze(events.slice()),
    // Stated on the screen, because "restore" reads like "roll back" and it is not.
    neverRewritten: "Every version is kept exactly as it was approved or activated. Nothing here edits history.",
  });
}

// ════════════════════════════════════════════════════════════════════
// P32 / P32A / P32B — VALIDATION, REVIEW, APPROVAL
// ════════════════════════════════════════════════════════════════════

/**
 * The review screen, and the gate in front of Approve.
 *
 * Approve is offered only when all four hold — valid, diff seen, no conflict,
 * capability — and when it is withheld the model says which one failed, in
 * order. "Approve is greyed out" with no reason is a support call.
 */
function diffModel({
  clientId, principal, fromVersion = null, toVersion = null,
  diff = null, validation = null, conflict = null, draftStatus = null,
} = {}) {
  const presented = presentDiff(diff);
  const valid = Boolean(validation && validation.ok);
  const hasCapability = can(principal, CAP.APPROVE);
  const stale = Boolean(conflict);

  const reasons = [];
  if (!valid) reasons.push("This draft has not passed validation.");
  if (stale) reasons.push("This draft changed after you opened it. Reload before approving.");
  if (!hasCapability) reasons.push("Approval is a named human decision and your role does not hold it.");
  if (!presented.hasChanges) reasons.push("There is nothing to approve — this draft is identical to the active version.");

  return Object.freeze({
    screen: "review",
    clientId,
    fromVersion,
    toVersion,
    draftStatus: draftStatus ? V.configChip(draftStatus) : null,
    diff: presented,
    validation: Object.freeze({
      ran: Boolean(validation),
      ok: valid,
      errors: Object.freeze((validation && validation.errors) || []),
      warnings: Object.freeze((validation && validation.warnings) || []),
      // The backend is the authority; the browser never decides this.
      authority: "Validation is performed by the configuration service. This screen displays its result.",
    }),
    conflict: conflict ? Object.freeze({ ...conflict, mayForce: false }) : null,
    approve: Object.freeze({
      offered: valid && !stale && hasCapability && presented.hasChanges,
      blockedBecause: Object.freeze(reasons),
      // The exact sentence the founder specified.
      consequence: "Approving locks this version. Further edits will create a new draft.",
      // Approval and activation are two decisions in this lifecycle, so the
      // screen must not imply one button does both.
      alsoActivates: false,
      separationNote: "Approving does NOT activate. Activation is a separate decision made by an operator.",
    }),
  });
}

// ════════════════════════════════════════════════════════════════════
// P33 — AGENT BEHAVIOUR PREVIEW
// ════════════════════════════════════════════════════════════════════

/**
 * Built from the compiled behaviour spec — the provider-independent layer —
 * never from the blueprint directly, so what the screen promises is what the
 * assistant was actually compiled to do.
 */
function behaviourPreviewModel({ clientId, spec = null, direction = "inbound", openingLine = null } = {}) {
  if (!spec) {
    return Object.freeze({
      screen: "behaviour-preview", clientId, direction, available: false,
      reason: "There is no valid configuration to preview.",
    });
  }

  const s = spec;
  const outbound = direction === "outbound";

  return Object.freeze({
    screen: "behaviour-preview",
    title: "AGENT BEHAVIOUR PREVIEW",
    // Said plainly, because a screen showing an opening line looks like a demo.
    notASimulator: "This describes what the assistant is configured to do. It is not a live conversation and no call is placed.",
    clientId,
    direction,
    available: true,

    identity: Object.freeze({
      assistantName: (s.assistant && s.assistant.name) || null,
      businessName: (s.business && (s.business.tradingName || s.business.legalName)) || null,
      vertical: (s.business && s.business.vertical) || null,
      language: (s.assistant && s.assistant.language) || null,
      tone: (s.assistant && s.assistant.tone) || null,
    }),

    opening: Object.freeze({
      // For INBOUND this is the client's configured greeting, verbatim.
      line: openingLine,
      isClientConfigured: !outbound,
      disclosesAiInOpening: outbound,
      disclosureSentence: outbound ? V.OUTBOUND_DISCLOSURE_SENTENCE : V.INBOUND_DISCLOSURE_SENTENCE,
      // True on BOTH directions, always, and not configurable on either.
      answersTruthfullyIfAsked: true,
      truthfulnessNote: "If a caller asks whether they are speaking to a person, the assistant always answers that it is an AI assistant. This cannot be switched off.",
    }),

    services: Object.freeze(
      ((s.services || [])).map((x) =>
        Object.freeze({
          name: x.name, urgency: x.urgencyCategory,
          alsoCalled: Object.freeze(x.aliases || []),
          qualification: Object.freeze(x.qualificationRequirements || []),
          exclusions: Object.freeze(x.exclusions || []),
          collects: Object.freeze(x.collect || []),
        }),
      ),
    ),

    serviceArea: s.serviceArea || null,
    availability: s.availability || null,
    urgency: Object.freeze((s.urgency && s.urgency.rules) || s.urgencyRules || []),
    escalation: (s.escalation || s.transfer) || null,
    knowledge: Object.freeze({
      facts: Object.freeze((s.knowledge && s.knowledge.approvedFacts) || []),
      uncertainty: (s.knowledge && s.knowledge.uncertaintyPolicy) || null,
      pricing: (s.knowledge && s.knowledge.pricingDisclosure) || null,
      pricingWording: (s.knowledge && s.knowledge.pricingWording) || null,
      boundary: "The assistant answers from approved facts. Anything else follows the uncertainty policy above.",
    }),
    prohibitedClaims: Object.freeze((s.knowledge && s.knowledge.prohibitedClaims) || []),
    mandatoryProhibitions: Object.freeze([...V.LOCKED_FIELDS["knowledge.prohibitedClaims.mandatory"] ? [] : []]),
    compliance: s.compliance || null,
  });
}

// ════════════════════════════════════════════════════════════════════
// P33A — PROVIDER PREVIEW (operator)
// ════════════════════════════════════════════════════════════════════

/** Field names that must never reach a browser, whatever they contain. */
const SECRET_KEYS = /(api[_-]?key|secret|token|password|credential|authorization|bearer|signing)/i;

/**
 * Recursively drop anything secret-shaped. Belt and braces: the compiler does
 * not put credentials in a preview payload, and this refuses to relay them
 * anyway, because "the compiler does not do that" is a property of today.
 */
function sanitise(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitise(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : sanitise(v, depth + 1);
  }
  return out;
}

function providerPreviewModel({ clientId, principal, preview = null, rawPayload = null } = {}) {
  const isOperator = can(principal, CAP.PROV_CREATE);
  if (!preview) {
    return Object.freeze({ screen: "provider-preview", clientId, available: false, reason: "No preview is available for this configuration." });
  }
  return Object.freeze({
    screen: "provider-preview",
    clientId,
    available: true,
    operatorOnly: true,
    provider: preview.provider || "retell",
    configVersion: preview.configVersion ?? null,
    direction: preview.direction || "inbound",
    behaviourHash: preview.behaviourHash ?? null,
    blueprintHash: preview.blueprintHash ?? null,
    responseEngineHash: preview.responseEngineHash ?? null,
    agentHash: preview.agentHash ?? null,
    payloadHash: preview.payloadHash ?? null,
    language: (preview.language) ?? null,
    voiceRef: preview.voiceRef ?? null,
    webhookTarget: preview.webhookUrl ?? null,
    unresolved: Object.freeze(preview.unresolved || []),
    ready: Boolean(preview.ready),
    // The raw payload is operator-only AND sanitised. Both, not either.
    rawPayload: isOperator && rawPayload ? Object.freeze(sanitise(rawPayload)) : null,
    rawWithheldBecause: isOperator ? null : "The raw provider payload is shown to operators only.",
    // Repeated at every layer, deliberately.
    note: "PREVIEW ONLY. Nothing was sent to any provider and no resource exists because of this screen.",
    networkCallMade: false,
  });
}

// ════════════════════════════════════════════════════════════════════
// P34 / P34A / P34B — PROVISIONING PLAN REVIEW
// ════════════════════════════════════════════════════════════════════

function planModel({ clientId, principal, plan = null, staleness = null, currentResources = [] } = {}) {
  if (!plan) {
    return Object.freeze({
      screen: "plan", clientId, available: false,
      reason: "No provisioning plan has been created for the active configuration.",
    });
  }

  const byPurpose = new Map(
    (currentResources || []).filter((r) => r && r.active !== false).map((r) => [`${r.purpose}:${r.resourceType || r.resource_type}`, r]),
  );

  const actions = (plan.actions || []).map((a) => {
    const chip = V.planActionChip(a.action);
    const current = byPurpose.get(a.key) || null;
    return Object.freeze({
      key: a.key,
      action: chip,
      highRisk: V.HIGH_RISK_ACTIONS.includes(a.action),
      purpose: a.purpose ?? (a.key || "").split(":")[0] ?? null,
      resourceType: a.resourceType ?? (a.key || "").split(":")[1] ?? null,
      currentResourceId: current ? current.providerResourceId || current.provider_resource_id || null : null,
      currentPayloadHash: current ? current.payloadHash || current.payload_hash || null : null,
      desiredPayloadHash: a.desiredPayloadHash ?? a.payloadHash ?? null,
      reason: a.reason ?? null,
      dependsOn: Object.freeze(a.dependsOn || []),
      // Whatever the plan says about a previous execution, said honestly.
      executionStatus: a.executionStatus ? V.executionChip(a.executionStatus) : null,
      // The critical one: a dangerous state never gets an action control.
      mayOfferRetry: a.executionStatus ? V.mayOfferRetry(a.executionStatus) : true,
      uncertainOutcome: a.executionStatus === "unknown" || a.executionStatus === "persist_failed_after_provider_success",
    });
  });

  const highRisk = actions.filter((a) => a.highRisk);
  const uncertain = actions.filter((a) => a.uncertainOutcome);
  const stale = Boolean(staleness && staleness.stale);
  const canApprove = can(principal, CAP.PROV_APPROVE);

  const approveReasons = [];
  if (plan.status !== "validated" && plan.status !== "draft") approveReasons.push(`A plan with status "${plan.status}" cannot be approved.`);
  if (stale) approveReasons.push(staleness.why || "This plan no longer matches the configuration it was built from.");
  if (!canApprove) approveReasons.push("Approving provider changes is an operator decision and your role does not hold it.");
  if (uncertain.length) approveReasons.push(V.UNCERTAIN_OUTCOME_SENTENCE);

  return Object.freeze({
    screen: "plan",
    clientId,
    available: true,
    planId: plan.planId,
    status: V.planChip(plan.status),
    planHash: plan.planHash ?? null,
    configVersion: plan.configVersion ?? null,
    mutatingCount: plan.mutatingCount ?? actions.filter((a) => a.action.value !== "no_change").length,
    actions: Object.freeze(actions),
    highRiskCount: highRisk.length,
    highRisk: Object.freeze(highRisk),
    stale,
    staleWhy: stale ? staleness.why : null,

    uncertain: Object.freeze(uncertain),
    uncertainSentence: uncertain.length ? V.UNCERTAIN_OUTCOME_SENTENCE : null,
    // No screen, in any state, offers to run an ambiguous action again.
    retryOffered: false,

    approve: Object.freeze({
      offered: approveReasons.length === 0,
      blockedBecause: Object.freeze(approveReasons),
      consequence: "Approving records that a named person reviewed these provider changes. It does NOT perform them.",
    }),

    // After approval, and always.
    approvedNotExecuted: plan.status === "approved",
    executionNote: "Provider changes require a separately authorised provisioning operation.",
    // There is no execute control anywhere in this model.
    executeOffered: false,
  });
}

module.exports = {
  dashboardModel, historyModel, diffModel,
  behaviourPreviewModel, providerPreviewModel, planModel,
  sanitise, SOURCE_WORDS, can,
};

// AIDA PLATFORM UI — previews and provisioning review (P33, P33A, P34).
//
//   renderBehaviourPreview(model)   what the assistant will broadly do
//   renderProviderPreview(model)    the operator's provider-detail view
//   renderPlan(model)               provisioning plan review
//
// ── THE TWO SENTENCES THESE SCREENS EXIST TO HOLD ───────────────────
//
//   APPROVED — NOT EXECUTED
//   Provider outcome is uncertain. Reconciliation is required before another
//   mutation can be attempted.
//
// There is no execute control on any screen in this file, in any state, for
// any role — and no retry control beside an uncertain outcome. A ratchet reads
// this file for the strings that would create one.

const { escapeHtml, escapeAttr } = require("./escape");
const S = require("./platform-shell");
const V = require("../platform/ui/ui-vocabulary");

// ════════════════════════════════════════════════════════════════════
// P33 — AGENT BEHAVIOUR PREVIEW
// ════════════════════════════════════════════════════════════════════

function renderBehaviourPreview(model, basePath) {
  if (!model.available) {
    return S.page({
      title: "Agent behaviour preview", heading: "AGENT BEHAVIOUR PREVIEW",
      active: "preview", basePath, state: { client: model.clientId, screen: "behaviour-preview" },
      body: S.notice(model.reason || "There is nothing to preview.", "warn"),
    });
  }

  const id = model.identity;
  const op = model.opening;

  const directionNav = `<nav class="direction-nav" aria-label="Call direction">
  <ul>
    <li><a href="${escapeAttr(basePath)}/preview?direction=inbound" class="direction-nav__link${model.direction === "inbound" ? " direction-nav__link--active" : ""}"${model.direction === "inbound" ? ' aria-current="page"' : ""}>Inbound</a></li>
    <li><a href="${escapeAttr(basePath)}/preview?direction=outbound" class="direction-nav__link${model.direction === "outbound" ? " direction-nav__link--active" : ""}"${model.direction === "outbound" ? ' aria-current="page"' : ""}>Outbound</a></li>
  </ul>
</nav>`;

  const openingCard = S.card("How the call opens", `
  ${op.line ? `<blockquote class="opening"><p>${escapeHtml(op.line)}</p></blockquote>` : S.notice("No greeting is configured. AIDA composes one from the business name.", "neutral")}
  ${op.isClientConfigured ? '<p class="muted small">These are your configured words, spoken as written.</p>' : ""}
  ${op.disclosesAiInOpening
      ? S.statement("AI disclosure", V.OUTBOUND_DISCLOSURE_SENTENCE, "Included in the opening. Platform policy — there is no toggle.")
      : S.statement("AI disclosure", V.INBOUND_DISCLOSURE_SENTENCE, "Platform policy.")}
  ${S.statement("If a caller asks", op.truthfulnessNote, "This cannot be switched off in either direction.")}
`);

  const servicesCard = S.card("What it will help with", S.table({
    caption: "Services the assistant offers, in order",
    columns: [
      { key: "name", label: "Service" },
      { key: "urgency", label: "Urgency" },
      { key: "also", label: "Also called" },
      { key: "qualify", label: "Establishes first" },
      { key: "collect", label: "Collects" },
    ],
    rows: model.services.map((s) => ({
      name: `<strong>${escapeHtml(s.name)}</strong>`,
      urgency: escapeHtml(s.urgency || ""),
      also: escapeHtml((s.alsoCalled || []).join(", ")),
      qualify: escapeHtml((s.qualification || []).join("; ")),
      collect: escapeHtml((s.collects || []).join(", ")),
    })),
  }));

  const urgencyCard = model.urgency.length
    ? S.card("How it decides something is urgent", S.table({
      caption: "Urgency rules, in order",
      columns: [
        { key: "when", label: "When" },
        { key: "level", label: "Treated as" },
        { key: "action", label: "What it does" },
      ],
      rows: model.urgency.map((r) => ({
        when: escapeHtml(r.when || ""),
        level: escapeHtml(r.level || ""),
        action: escapeHtml(String(r.action || "").replace(/_/g, " ")),
      })),
    }))
    : S.card("How it decides something is urgent", S.notice("No urgency rules. Every call is treated the same way.", "warn"));

  const knowledgeCard = S.card("What it will and will not say", `
  ${S.facts([
      ["When unsure", escapeHtml(String(model.knowledge.uncertainty || "").replace(/_/g, " "))],
      ["Pricing", escapeHtml(String(model.knowledge.pricing || "").replace(/_/g, " "))],
      model.knowledge.pricingWording ? ["Pricing wording", escapeHtml(model.knowledge.pricingWording)] : null,
    ])}
  <p>${escapeHtml(model.knowledge.boundary)}</p>
  ${model.knowledge.facts.length
      ? `<h3>Approved facts</h3><ul class="facts-list">${model.knowledge.facts.map((f) => `<li>${escapeHtml(f.statement || String(f))}</li>`).join("")}</ul>`
      : S.notice("No approved facts. The assistant can only describe the business in general terms.", "warn")}
  <h3>Never claims</h3>
  <ul class="prohibited">${model.prohibitedClaims.map((c) => `<li>${escapeHtml(String(c).replace(/_/g, " "))}</li>`).join("")}</ul>
`);

  return S.page({
    title: "Agent behaviour preview",
    heading: "AGENT BEHAVIOUR PREVIEW",
    active: "preview",
    basePath,
    state: { client: model.clientId, screen: "behaviour-preview", direction: model.direction },
    banner: S.notice(model.notASimulator, "info"),
    body: `${directionNav}
${S.card("Who the caller is speaking to", S.facts([
      ["Assistant name", escapeHtml(id.assistantName || "")],
      ["Business", escapeHtml(id.businessName || "")],
      ["Trade", escapeHtml(id.vertical || "")],
      ["Language", escapeHtml(id.language || "")],
      ["Tone", escapeHtml(id.tone || "")],
    ]))}
${openingCard}${servicesCard}${urgencyCard}${knowledgeCard}`,
  });
}

// ════════════════════════════════════════════════════════════════════
// P33A — PROVIDER PREVIEW (operator)
// ════════════════════════════════════════════════════════════════════

function renderProviderPreview(model, basePath) {
  if (!model.available) {
    return S.page({
      title: "Provider preview", heading: "Provider preview", active: "preview", basePath,
      state: { client: model.clientId, screen: "provider-preview" },
      body: S.notice(model.reason || "No preview available.", "warn"),
    });
  }

  const hashes = S.table({
    caption: "Content hashes — what the desired provider state is derived from",
    columns: [{ key: "what", label: "Hash" }, { key: "value", label: "Value" }],
    rows: [
      ["Blueprint", model.blueprintHash],
      ["Behaviour spec", model.behaviourHash],
      ["Response engine", model.responseEngineHash],
      ["Agent", model.agentHash],
      ["Payload", model.payloadHash],
    ].map(([what, v]) => ({ what: escapeHtml(what), value: v ? `<code>${escapeHtml(v)}</code>` : '<span class="muted">not computed</span>' })),
  });

  return S.page({
    title: "Provider preview",
    heading: "Provider preview",
    active: "preview",
    basePath,
    state: { client: model.clientId, screen: "provider-preview" },
    banner: S.notice(model.note, "info"),
    body: `${S.card("Provider view", S.facts([
      ["Provider", escapeHtml(model.provider)],
      ["Configuration version", model.configVersion === null ? null : `v${escapeHtml(String(model.configVersion))}`],
      ["Direction", escapeHtml(model.direction)],
      ["Language", escapeHtml(model.language || "")],
      ["Voice reference", model.voiceRef ? `<code>${escapeHtml(model.voiceRef)}</code>` : null],
      ["Webhook target", model.webhookTarget ? `<code>${escapeHtml(model.webhookTarget)}</code>` : null],
      ["Complete", model.ready ? "yes" : "no"],
    ]), { blurb: "Operator view. No credential, key or secret appears on this screen." })}
${model.unresolved.length ? S.card("Missing deployment facts", `${S.notice("These are never guessed. Provisioning reports them by name and stops.", "warn")}<ul class="issues issues--warn">${model.unresolved.map((u) => `<li><code>${escapeHtml(u)}</code></li>`).join("")}</ul>`) : ""}
${S.card("Hashes", hashes)}
${model.rawPayload
      ? S.card("Raw payload", `<details><summary>Show the compiled provider payload</summary><pre class="raw"><code>${escapeHtml(JSON.stringify(model.rawPayload, null, 2))}</code></pre></details>
  <p class="muted small">Sanitised: any field whose name looks like a key, token, secret or credential is replaced with [redacted] before it reaches this page.</p>`)
      : S.notice(model.rawWithheldBecause || "The raw payload is not shown.", "neutral")}`,
  });
}

// ════════════════════════════════════════════════════════════════════
// P34 / P34A / P34B — PROVISIONING PLAN REVIEW
// ════════════════════════════════════════════════════════════════════

/**
 * One action. Replace, retire and reconciliation-required are given their own
 * prominence class, because each one can take away something a business is
 * currently being served by, and a table that styles them like "update" is
 * inviting somebody to skim past the dangerous row.
 */
function renderAction(a) {
  const dependencies = a.dependsOn.length
    ? `<span class="muted small">after ${escapeHtml(a.dependsOn.join(", "))}</span>`
    : '<span class="muted">—</span>';

  return {
    action: `${S.chip(a.action)}${a.highRisk ? '<span class="flag flag--risk">higher risk</span>' : ""}`,
    resource: `<strong>${escapeHtml(a.purpose || "")}</strong><br><span class="muted">${escapeHtml(a.resourceType || "")}</span>`,
    current: a.currentResourceId
      ? `<code>${escapeHtml(a.currentResourceId)}</code>${a.currentPayloadHash ? `<br><span class="muted small">${escapeHtml(String(a.currentPayloadHash).slice(0, 12))}…</span>` : ""}`
      : '<span class="muted">none recorded</span>',
    desired: a.desiredPayloadHash ? `<code>${escapeHtml(String(a.desiredPayloadHash).slice(0, 12))}…</code>` : '<span class="muted">—</span>',
    reason: escapeHtml(a.reason || a.action.help || ""),
    dependencies,
    state: a.executionStatus
      ? `${S.chip(a.executionStatus)}${a.uncertainOutcome ? `<p class="uncertain">${escapeHtml(V.UNCERTAIN_OUTCOME_SENTENCE)}</p>` : ""}`
      : '<span class="muted">not attempted</span>',
    _notable: a.highRisk || a.uncertainOutcome,
  };
}

function renderPlan(model, basePath) {
  if (!model.available) {
    return S.page({
      title: "Provisioning", heading: "Provisioning", active: "provisioning", basePath,
      state: { client: model.clientId, screen: "plan" },
      body: `${S.notice(model.reason, "neutral")}
${S.card("Build a plan", `<p>A provisioning plan is computed from the ACTIVE configuration and compared with what is already recorded. Building one changes nothing.</p>
<form method="post" action="${escapeAttr(basePath)}/provisioning/plans">
  <button type="submit" class="btn btn--primary" data-action="create-plan">Build provisioning plan</button>
</form>`)}`,
    });
  }

  const uncertainBanner = model.uncertain.length
    ? `<div class="uncertain-banner" role="alert">
  <h2>Reconciliation required</h2>
  <p>${escapeHtml(model.uncertainSentence)}</p>
  <ul>${model.uncertain.map((a) => `<li><code>${escapeHtml(a.key)}</code> — ${escapeHtml(a.executionStatus.text)}</li>`).join("")}</ul>
  <p class="muted">There is no retry here, deliberately. An uncertain provider outcome may mean the change DID happen, so sending it again is how one authorised change becomes two resources. A person compares the registry with the provider first.</p>
</div>`
    : "";

  const highRiskBanner = model.highRiskCount
    ? S.notice(`${model.highRiskCount} higher-risk action${model.highRiskCount === 1 ? "" : "s"} in this plan — replace, retire or reconciliation. Read those rows before approving.`, "warn")
    : "";

  const approveBlock = `<div class="approve">
  <h3>Approve this plan</h3>
  <p class="approve__consequence">${escapeHtml(model.approve.consequence)}</p>
  ${model.approve.offered
    ? `<form method="post" action="${escapeAttr(basePath)}/provisioning/plans/${escapeAttr(model.planId)}/approve" data-confirm="Approving records that you reviewed these provider changes. It does not perform them.">
    <input type="hidden" name="expectedPlanHash" value="${escapeAttr(model.planHash || "")}">
    <div class="field">
      <label for="f-plan-reason">Why you are approving this <span class="opt">(optional)</span></label>
      <p class="field__hint" id="f-plan-reason-hint">Recorded against this exact plan hash.</p>
      <textarea id="f-plan-reason" name="reason" rows="2" aria-describedby="f-plan-reason-hint f-plan-reason-error"></textarea>
      <p class="field__error" id="f-plan-reason-error" data-error-for="reason"></p>
    </div>
    <button type="submit" class="btn btn--primary" data-action="approve-plan">Approve plan</button>
  </form>`
    : `<button type="button" class="btn btn--primary" disabled aria-disabled="true">Approve plan</button>
  <ul class="blocked">${model.approve.blockedBecause.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`}
</div>`;

  // The state after approval. This block is the whole point of P34A.
  const notExecuted = model.approvedNotExecuted
    ? `<div class="not-executed" role="note">
  <p class="not-executed__headline">APPROVED — NOT EXECUTED</p>
  <p>${escapeHtml(model.executionNote)}</p>
  <p class="muted">There is no button on this page, or anywhere in this interface, that performs these changes.</p>
</div>`
    : "";

  return S.page({
    title: "Provisioning plan",
    heading: "Provisioning plan",
    active: "provisioning",
    basePath,
    state: { client: model.clientId, screen: "plan", plan: model.planId },
    banner: uncertainBanner || highRiskBanner || null,
    body: `${uncertainBanner && highRiskBanner ? highRiskBanner : ""}
${notExecuted}
${S.card("Plan", S.facts([
      ["Plan", `<code>${escapeHtml(model.planId)}</code>`],
      ["Status", S.chip(model.status)],
      ["Built from configuration", model.configVersion === null ? null : `v${escapeHtml(String(model.configVersion))}`],
      ["Plan hash", model.planHash ? `<code>${escapeHtml(model.planHash)}</code>` : null],
      ["Provider changes it would make", escapeHtml(String(model.mutatingCount))],
    ]))}
${model.stale ? S.notice(`This plan is stale: ${model.staleWhy}. Build a new one — a stale plan is never silently regenerated.`, "danger") : ""}
${S.card("Actions", S.table({
      caption: "Every action in this plan. Nothing here has been performed.",
      columns: [
        { key: "action", label: "Action" },
        { key: "resource", label: "Resource" },
        { key: "current", label: "Currently recorded" },
        { key: "desired", label: "Desired" },
        { key: "reason", label: "Why" },
        { key: "dependencies", label: "Order" },
        { key: "state", label: "Execution state" },
      ],
      rows: model.actions.map(renderAction),
      className: "plan-table",
    }))}
${S.card("Approval", approveBlock)}`,
  });
}

module.exports = { renderBehaviourPreview, renderProviderPreview, renderPlan, renderAction };

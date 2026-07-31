// AIDA — founder provisioning preview (M3).
//
// Behind the operator login. Shows exactly what WOULD be sent to a provider, so
// the founder can read the compiled receptionist before any of it is real.
//
// WHAT THIS PAGE MUST NEVER SHOW
//   * the API key (it shows only whether one is configured)
//   * a full transfer number (masked to the last two digits)
//   * a raw provider id (masked)
//   * unescaped prompt or profile text — the whole point of the compiled prompt
//     is that it contains client prose, and this is the page that renders it
//
// The execution control is hidden unless live writes are genuinely enabled AND
// the plan is approved and current. In M3 it never appears, because
// RETELL_LIVE_WRITES_ENABLED is off everywhere. A mock-execution control is
// offered instead in development.

const { escapeHtml, escapeAttr } = require("./escape");
const { maskPhone } = require("../config/retell");

function chip(text, tone = "neutral") {
  const marker = { good: "✓", bad: "✕", attention: "!", neutral: "·", active: "▶" }[tone] || "·";
  return `<span class="chip chip--${escapeAttr(tone)}"><span aria-hidden="true">${marker}</span> ${escapeHtml(text)}</span>`;
}

function fact(label, value) {
  return `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function textValue(value) {
  if (value === null || value === undefined || value === "") return '<span class="value value--missing">Not set</span>';
  if (value === true) return '<span class="value value--yes">Yes</span>';
  if (value === false) return '<span class="value value--no">No</span>';
  return `<span class="value">${escapeHtml(String(value))}</span>`;
}

function renderFlagRow(summary) {
  const caps = summary.capabilities || {};
  return `<dl class="facts">
    ${fact("Integration", summary.enabled ? chip("enabled", "active") : chip("disabled", "neutral"))}
    ${fact("Dry run", summary.dryRun ? chip("on — nothing is sent", "good") : chip("OFF", "attention"))}
    ${fact("Live writes", summary.liveWritesEnabled ? chip("ENABLED", "attention") : chip("disabled", "good"))}
    ${fact("Live calls", summary.liveCallsEnabled ? chip("ENABLED", "attention") : chip("disabled", "good"))}
    ${fact("Webhook", summary.webhookEnabled ? chip("enabled", "active") : chip("disabled", "neutral"))}
    ${fact("API key", summary.apiKeyConfigured ? chip("configured", "good") : chip("not set", "neutral"))}
    ${fact("Voice id", textValue(summary.defaultVoiceId))}
    ${fact("Language", textValue(summary.defaultLanguage))}
    ${fact("Environment tag", textValue(summary.allowedTag))}
    ${fact("Outbound number", textValue(summary.outboundOnboardingNumber))}
    ${fact("Can write live", caps.canWriteLive && caps.canWriteLive.allowed ? chip("yes", "attention") : chip("no", "good"))}
  </dl>
  ${
    caps.canWriteLive && !caps.canWriteLive.allowed && caps.canWriteLive.reasons.length
      ? `<div class="issues issues--warning"><h4>Live writes are blocked because</h4><ul>${caps.canWriteLive.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>`
      : ""
  }`;
}

function renderPlan(plan) {
  if (!plan) return '<p class="empty">No plan has been generated for this client.</p>';

  if (plan.blockingReasons && plan.blockingReasons.length) {
    return `<div class="issues issues--blocking">
      <h4>This plan is blocked</h4>
      <ul>${plan.blockingReasons.map((b) => `<li><code>${escapeHtml(b.code)}</code> ${escapeHtml(b.message)}</li>`).join("")}</ul>
    </div>`;
  }

  const rows = plan.actions
    .map(
      (a) => `<tr>
        <td data-label="Action">${chip(a.kind, a.kind === "create" ? "active" : a.kind === "update" ? "attention" : a.kind === "noop" ? "good" : "neutral")}</td>
        <td data-label="Purpose">${escapeHtml(a.purpose)}</td>
        <td data-label="Resource">${escapeHtml(a.resourceType)}</td>
        <td data-label="Why">${escapeHtml(a.reason || "")}</td>
        <td data-label="Payload hash">${escapeHtml(a.payloadHash ? a.payloadHash.slice(0, 12) : "—")}</td>
      </tr>`
    )
    .join("");

  return `<dl class="facts">
      ${fact("Plan hash", textValue(plan.planHash ? plan.planHash.slice(0, 24) : null))}
      ${fact("Approved profile version", textValue(plan.approvedProfileVersion))}
      ${fact("Provider", textValue(plan.provider))}
      ${fact("Create / update / no-op / archive", textValue(`${plan.createActions} / ${plan.updateActions} / ${plan.noopActions} / ${plan.archiveActions}`))}
      ${fact("Estimated API operations", textValue(plan.estimatedApiOperations))}
    </dl>
    <div class="table-scroll">
      <table class="sessions">
        <caption class="visually-hidden">Provisioning actions</caption>
        <thead><tr><th scope="col">Action</th><th scope="col">Purpose</th><th scope="col">Resource</th><th scope="col">Why</th><th scope="col">Payload hash</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${
      plan.warnings && plan.warnings.length
        ? `<div class="issues issues--warning"><h4>Warnings</h4><ul>${plan.warnings.map((w) => `<li>${escapeHtml(w.message)}</li>`).join("")}</ul></div>`
        : ""
    }`;
}

function renderCompiled(compiled, retellPayload) {
  if (!compiled || !compiled.ok) {
    return `<div class="issues issues--blocking"><h4>The receptionist did not compile</h4><p>${escapeHtml(compiled ? `${compiled.code}: ${compiled.message}` : "no compile result")}</p></div>`;
  }
  const spec = compiled.spec;

  const suspicious = (compiled.reviewFlags || []).filter((f) => f.code === "instruction_like");
  const otherFlags = (compiled.reviewFlags || []).filter((f) => f.code !== "instruction_like");

  return `
    <dl class="facts">
      ${fact("Compiler version", textValue(compiled.provenance.compilerVersion))}
      ${fact("Template version", textValue(compiled.provenance.templateVersion))}
      ${fact("Profile version", textValue(compiled.provenance.profileVersion))}
      ${fact("Spec hash", textValue(compiled.hashes.specHash.slice(0, 24)))}
      ${fact("Knowledge hash", textValue(compiled.hashes.knowledgeHash.slice(0, 24)))}
      ${fact("Tool schema hash", textValue(compiled.hashes.toolSchemaHash.slice(0, 24)))}
      ${fact("Safety validation", compiled.safety.passed ? chip("passed", "good") : chip("FAILED", "bad"))}
    </dl>

    ${
      suspicious.length
        ? `<div class="issues issues--blocking">
             <h4>Profile text that reads like an instruction</h4>
             <p>These fields are compiled as quoted data, not as instructions, but a human should look at them.</p>
             <ul>${suspicious.map((f) => `<li><strong>${escapeHtml(f.field)}</strong>: ${escapeHtml(f.message)}</li>`).join("")}</ul>
           </div>`
        : ""
    }
    ${
      otherFlags.length
        ? `<div class="issues issues--warning"><h4>Compile notes</h4><ul>${otherFlags.map((f) => `<li>${escapeHtml(f.message)}</li>`).join("")}</ul></div>`
        : ""
    }

    <h3>Dynamic variables</h3>
    <p class="note-inline">A fixed allow-list. Values shown as <code>{{runtime}}</code> are resolved per call and are never baked into the agent.</p>
    <dl class="facts">
      ${Object.entries(spec.dynamicVariables).map(([k, v]) => fact(k, textValue(v))).join("")}
    </dl>

    <h3>Tools</h3>
    <ul class="service-list">
      ${spec.tools.map((t) => `<li><span class="service-name">${escapeHtml(t.name)}</span><span class="service-note">${escapeHtml(t.description)}</span></li>`).join("")}
    </ul>

    <h3>Compiled prompt</h3>
    <p class="note-inline">Exactly what would be sent as the response engine's general prompt. Client text appears between « and », which the agent is instructed to treat as data.</p>
    <details class="transcript">
      <summary>Show the compiled prompt (${escapeHtml(String(retellPayload ? retellPayload.responseEngine.general_prompt.length : 0))} characters)</summary>
      <pre class="prompt-preview">${escapeHtml(retellPayload ? retellPayload.responseEngine.general_prompt : "")}</pre>
    </details>

    <h3>Knowledge content</h3>
    <p class="note-inline">Elaboration only. No routing, exclusion, urgency, transfer or pricing rule depends on this being retrieved.</p>
    <details class="transcript">
      <summary>Show the knowledge content (${escapeHtml(String(spec.knowledge.text.length))} characters)</summary>
      <pre class="prompt-preview">${escapeHtml(spec.knowledge.text)}</pre>
    </details>`;
}

function renderResources(resources) {
  if (!resources || !resources.length) return '<p class="empty">No provider resources are recorded for this client.</p>';
  return `<div class="table-scroll"><table class="sessions">
    <caption class="visually-hidden">Provider resources</caption>
    <thead><tr><th scope="col">Purpose</th><th scope="col">Type</th><th scope="col">Provider id</th><th scope="col">Active</th><th scope="col">Profile version</th></tr></thead>
    <tbody>${resources
      .map(
        (r) => `<tr>
          <td data-label="Purpose">${escapeHtml(r.purpose)}</td>
          <td data-label="Type">${escapeHtml(r.resourceType)}</td>
          <td data-label="Provider id">${escapeHtml(r.providerResourceIdMasked || "—")}</td>
          <td data-label="Active">${r.active ? chip("active", "good") : chip("superseded", "neutral")}</td>
          <td data-label="Profile version">${escapeHtml(String(r.profileVersion ?? "—"))}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table></div>`;
}

/**
 * @param args.executionAllowed  the ONLY thing that reveals the live-execution
 *                               control. Computed server-side from the config
 *                               gate, never from a query parameter.
 */
function renderProvisioningPage({
  clientId,
  configSummary,
  approvedVersion,
  provisioningReady,
  compiled,
  retellPayload,
  plan,
  resources,
  auditEvents = [],
  executionAllowed = false,
  mockExecutionAllowed = false,
  dryRunResult = null,
  transferNumbersMasked = {},
}) {
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Provisioning preview — ${escapeHtml(clientId)}</title>
<link rel="stylesheet" href="/locksmith/onboarding.css">
</head>
<body class="locksmith locksmith-founder">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">AIDA Locksmith</span>
    <span class="site-header__provider">Provisioning preview</span>
  </p>
  <nav class="site-nav" aria-label="Console"><ul><li><a href="/locksmith-founder/sessions">All sessions</a></li></ul></nav>
</header>

<main id="main">
  <h1>Provisioning preview</h1>
  <p class="lead">Everything that would be sent to the provider for <strong>${escapeHtml(clientId)}</strong>. Nothing here has been sent.</p>

  <section aria-labelledby="flags-heading">
    <h2 id="flags-heading">Provider configuration</h2>
    ${renderFlagRow(configSummary)}
  </section>

  <section aria-labelledby="profile-heading">
    <h2 id="profile-heading">Approved profile</h2>
    <dl class="facts">
      ${fact("Approved version", textValue(approvedVersion))}
      ${fact("Provisioning ready", provisioningReady ? chip("yes", "good") : chip("no", "bad"))}
      ${fact("Primary transfer number", textValue(transferNumbersMasked.primary ? maskPhone(transferNumbersMasked.primary) : null))}
      ${fact("Backup transfer number", textValue(transferNumbersMasked.backup ? maskPhone(transferNumbersMasked.backup) : null))}
    </dl>
    <p class="note-inline">Transfer numbers are masked. The full values live in the approved profile and are resolved at call time.</p>
  </section>

  <section aria-labelledby="compiled-heading">
    <h2 id="compiled-heading">Compiled receptionist</h2>
    ${renderCompiled(compiled, retellPayload)}
  </section>

  <section aria-labelledby="plan-heading">
    <h2 id="plan-heading">Provisioning plan</h2>
    ${renderPlan(plan)}
  </section>

  <section aria-labelledby="resources-heading">
    <h2 id="resources-heading">Existing provider resources</h2>
    ${renderResources(resources)}
  </section>

  ${
    dryRunResult
      ? `<section aria-labelledby="dryrun-heading">
           <h2 id="dryrun-heading">Dry-run result</h2>
           <p class="note-inline">Recorded what would have been sent. No network request was made.</p>
           <dl class="facts">
             ${fact("Status", textValue(dryRunResult.status))}
             ${fact("Succeeded / failed / skipped", textValue(`${dryRunResult.summary.succeeded} / ${dryRunResult.summary.failed} / ${dryRunResult.summary.skipped}`))}
           </dl>
         </section>`
      : ""
  }

  <section aria-labelledby="execute-heading">
    <h2 id="execute-heading">Execution</h2>
    ${
      executionAllowed
        ? `<div class="issues issues--blocking">
             <h4>This would mutate an external provider</h4>
             <p>Live writes are enabled and this plan is approved and current. Running it creates or updates real resources in the Retell account and may incur charges.</p>
           </div>
           <button type="button" class="btn btn--danger" id="execute-plan">Execute this plan against Retell</button>`
        : `<p class="ok-line"><span aria-hidden="true">✓</span> Live execution is not available. ${escapeHtml(
            configSummary.liveWritesEnabled ? "The plan is not approved and current." : "Live writes are disabled."
          )}</p>`
    }
    ${
      mockExecutionAllowed
        ? `<button type="button" class="btn btn--ghost" id="mock-execute">Run mock execution (development only)</button>
           <p class="note-inline">Mock execution exercises the real planning and registry code against an in-memory provider. It contacts nothing.</p>`
        : ""
    }
    <div class="form-status" id="form-status" role="status" aria-live="polite" data-state="idle"></div>
  </section>

  <section aria-labelledby="audit-heading">
    <h2 id="audit-heading">Audit history</h2>
    ${
      auditEvents.length
        ? `<ol class="audit">${auditEvents
            .map(
              (e) => `<li><span class="audit-when">${escapeHtml(e.created_at || "")}</span><span class="audit-type">${escapeHtml(e.event_type)}</span><span class="audit-actor">${escapeHtml(e.actor_type || "")}</span>${e.reason ? `<span class="audit-reason">${escapeHtml(e.reason)}</span>` : ""}</li>`
            )
            .join("")}</ol>`
        : '<p class="empty">No audit events recorded.</p>'
    }
  </section>
</main>

<footer class="footer">
  <p>Operator view. No API key, full phone number or raw provider identifier is shown on this page.</p>
</footer>
<script src="/locksmith/onboarding.js" defer></script>
</body>
</html>
`;
}

module.exports = { renderProvisioningPage, renderPlan, renderCompiled, renderResources, renderFlagRow };

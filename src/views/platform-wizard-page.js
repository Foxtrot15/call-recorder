// AIDA PLATFORM UI — the new-client wizard (P35).
//
//   WIZARD_STEPS
//   renderWizard(model)
//
// ── IT IS A ROUTE THROUGH THE EDITOR, NOT A SECOND SYSTEM ───────────
// The tempting shape is a wizard that collects everything into its own object
// and creates a configuration at the end. That object would be a second place a
// client's configuration lives, with its own idea of what is valid, and the day
// the two disagree the wizard wins because it is what somebody is looking at.
//
// So there is no wizard state. Step 1 creates a real DRAFT through the real
// service; every later step edits that same draft through the same section
// editor a returning user sees. The wizard contributes an ORDER and a sense of
// progress, and nothing else.
//
// That is also why leaving and coming back works with no resume logic: the
// draft is the state, the step is derived from what the draft already has.

const { escapeHtml, escapeAttr } = require("./escape");
const S = require("./platform-shell");

/**
 * The founder's fifteen steps, mapped onto what actually performs them. `kind`
 * says which machinery a step uses — no step invents its own.
 */
const WIZARD_STEPS = Object.freeze([
  { key: "identity", n: 1, title: "Business identity", kind: "edit", section: "identity" },
  { key: "services", n: 2, title: "Services", kind: "edit", section: "services" },
  { key: "serviceArea", n: 3, title: "Service area", kind: "edit", section: "serviceArea" },
  { key: "hours", n: 4, title: "Hours", kind: "edit", section: "hours" },
  { key: "callHandling", n: 5, title: "Call handling", kind: "edit", section: "callHandling" },
  { key: "knowledge", n: 6, title: "Knowledge and pricing", kind: "edit", section: "knowledge" },
  { key: "booking", n: 7, title: "Booking and integrations", kind: "edit", section: "booking" },
  { key: "integrations", n: 8, title: "Integrations", kind: "edit", section: "integrations" },
  { key: "voice", n: 9, title: "Voice", kind: "edit", section: "voice" },
  { key: "compliance", n: 10, title: "Compliance", kind: "edit", section: "compliance" },
  { key: "review", n: 11, title: "Review", kind: "review" },
  { key: "validate", n: 12, title: "Validate", kind: "review" },
  { key: "approve", n: 13, title: "Approve", kind: "review" },
  { key: "activate", n: 14, title: "Activate", kind: "activate" },
  { key: "preview", n: 15, title: "Provider preview and provisioning plan", kind: "provisioning" },
]);

const STEP_KEYS = Object.freeze(WIZARD_STEPS.map((s) => s.key));

/**
 * Where a step leads. Every one of these is an EXISTING screen driven by an
 * EXISTING service operation — the wizard adds no endpoint of its own.
 */
function hrefFor(step, basePath) {
  if (step.kind === "edit") return `${basePath}/edit/${step.section}`;
  if (step.kind === "review") return `${basePath}/review`;
  if (step.kind === "activate") return `${basePath}/activate`;
  return `${basePath}/provisioning`;
}

function renderWizard(model, basePath) {
  const current = model.currentStep;

  const steps = WIZARD_STEPS.map((s) => {
    const state = model.stepState[s.key] || "todo";
    const on = s.key === current;
    const mark = state === "done" ? "✓" : state === "blocked" ? "!" : "•";
    return `<li class="step step--${escapeAttr(state)}${on ? " step--current" : ""}">
  <a href="${escapeAttr(hrefFor(s, basePath))}"${on ? ' aria-current="step"' : ""}>
    <span class="step__n" aria-hidden="true">${escapeHtml(String(s.n))}</span>
    <span class="step__mark" aria-hidden="true">${mark}</span>
    <span class="step__title">${escapeHtml(s.title)}</span>
    <span class="step__state">${escapeHtml(state === "done" ? "done" : state === "blocked" ? "needs attention" : "not started")}</span>
  </a>
</li>`;
  }).join("");

  const start = !model.draftVersion
    ? S.card("Start", `<p class="lede">This creates a real draft configuration straight away. There is no separate wizard state to lose — everything you enter is saved into that draft, and you can leave and come back at any point.</p>
<form method="post" action="${escapeAttr(basePath)}/wizard/start">
  <button type="submit" class="btn btn--primary" data-action="start-wizard">Create a draft and begin</button>
</form>`)
    : S.card("Your draft", `${S.facts([
        ["Draft version", `v${escapeHtml(String(model.draftVersion))}`],
        ["Status", S.chip(model.draftStatus)],
        ["Started", escapeHtml(model.createdAt || "")],
      ])}
<p>Leave whenever you like. This draft is saved and waiting; nothing is live until it is approved and activated.</p>`);

  return S.page({
    title: "Set up a new client",
    heading: "Set up a new client",
    active: "overview",
    basePath,
    state: { client: model.clientId, screen: "wizard", step: current || "", version: model.draftVersion ?? "" },
    banner: S.notice("Nothing in this wizard contacts a telephony provider, buys a number, or provisions anything. It ends at a reviewed plan.", "info"),
    body: `${start}
${S.card("Steps", `<ol class="steps">${steps}</ol>
<p class="muted small">Steps 11 to 15 become available once the earlier ones pass validation. The order is the order the platform's own lifecycle requires — it is not a suggestion this screen invented.</p>`)}
${S.card("Where this ends", `<p>The last step produces an <strong>approved provisioning plan</strong>, and stops there.</p>
${S.notice("APPROVED — NOT EXECUTED. Provider changes require a separately authorised provisioning operation.", "warn")}`)}`,
  });
}

module.exports = { renderWizard, WIZARD_STEPS, STEP_KEYS, hrefFor };

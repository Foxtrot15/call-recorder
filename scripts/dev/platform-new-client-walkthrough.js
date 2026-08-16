#!/usr/bin/env node
// ============================================================================
// AIDA PLATFORM — a whole new client, from nothing to a compiled payload (P12).
//
//   node scripts/dev/platform-new-client-walkthrough.js
//
// ── WHAT THIS DEMONSTRATES ──────────────────────────────────────────
// A business that has never existed before becomes a working assistant
// configuration without one line of code being written for it. Every step
// prints what it did and, more usefully, what it REFUSED to do.
//
// The client is fictional and new — not one of the four fixtures — so nothing
// here can quietly lean on something prepared earlier.
//
// ── WHAT IT CANNOT DO ───────────────────────────────────────────────
// In-memory store, injected clock, fake adapters, fake provider references.
// No network, no database, no Retell, no provisioning, no call. The boundary
// ratchets assert that by reading the source of everything it imports.
// ============================================================================

const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const P = (m) => require(path.join(ROOT, "src/platform", m));

const { emptyBlueprint, validateBlueprint, MANDATORY_PROHIBITED_CLAIMS } = P("client-blueprint");
const { createBlueprintAuthority, createInMemoryBlueprintStore } = P("blueprint-authority");
const { proposeConfigPatch } = P("config-patch");
const { compileBehaviourSpec } = P("behaviour-spec");
const { compileRetellPreview } = P("provider-compiler-retell");
const { createIntegrationRegistry, registerFakeAdaptersFor } = P("integrations");

// ── presentation ────────────────────────────────────────────────────
let stepNumber = 0;
const step = (title) => {
  stepNumber += 1;
  console.log(`\n${"─".repeat(72)}\n${stepNumber}. ${title}\n${"─".repeat(72)}`);
};
const did = (text) => console.log(`   ok      ${text}`);
const refused = (text) => console.log(`   REFUSED ${text}`);
const note = (text) => console.log(`           ${text}`);

// A clock that only moves when this script says so, so the output is stable.
let clockMs = Date.UTC(2026, 7, 16, 9, 0, 0);
const now = () => new Date(clockMs);
const tick = (minutes = 5) => { clockMs += minutes * 60_000; };

const CLIENT_ID = "harbour_electrical";
const OWNER = "Nadia Farrell";

/**
 * A brand-new business, described entirely as configuration. An electrician —
 * a fourth trade, and one no fixture, test or module has ever mentioned.
 */
function harbourElectrical() {
  const bp = emptyBlueprint({ clientId: CLIENT_ID, vertical: "electrical" });

  bp.identity = {
    ...bp.identity,
    legalName: "Harbour Electrical Services Pty Ltd",
    tradingName: "Harbour Electrical",
    assistantName: "Robin",
    timezone: "Australia/Sydney",
    description: "Residential and small-commercial electricians on Sydney's lower north shore.",
    businessPhone: "+61355500501",
  };

  bp.services = [
    { serviceId: "power_outage", name: "Power outage", aliases: ["no power", "lights are out", "power's gone"], enabled: true, urgencyCategory: "emergency", description: "No power to part or all of a property." },
    { serviceId: "burning_smell", name: "Burning smell or sparking", aliases: ["burning smell", "sparks", "smoke from a powerpoint"], enabled: true, urgencyCategory: "emergency", description: "A possible fire risk." },
    { serviceId: "switchboard_fault", name: "Switchboard fault", aliases: ["safety switch keeps tripping", "fuse box"], enabled: true, urgencyCategory: "urgent" },
    { serviceId: "hot_water_electrical", name: "Electric hot water fault", aliases: ["no hot water"], enabled: true, urgencyCategory: "priority" },
    { serviceId: "lighting", name: "Lighting installation and repair", aliases: ["downlights", "light not working"], enabled: true, urgencyCategory: "standard" },
    { serviceId: "powerpoint_install", name: "Powerpoint installation", aliases: ["new powerpoint", "extra outlet"], enabled: true, urgencyCategory: "non_urgent" },
    { serviceId: "smoke_alarms", name: "Smoke alarm compliance", enabled: true, urgencyCategory: "standard" },
    { serviceId: "solar", name: "Solar installation", enabled: false, urgencyCategory: "standard", description: "Not offered. We service solar faults but do not install." },
  ];

  bp.serviceArea = {
    ...bp.serviceArea,
    regions: ["Sydney Lower North Shore"],
    suburbs: ["Neutral Bay", "Cremorne", "Mosman", "Cammeray", "Crows Nest"],
    postcodes: ["2089", "2090", "2088", "2062", "2065"],
    exclusions: ["Western Sydney"],
    radiusKm: 15,
    remoteServiceAvailable: false,
    outsideAreaAction: "collect_details_for_confirmation",
    outsideAreaWording: "That's outside where we normally work — I'll take your details and someone will confirm.",
  };

  const weekday = { open: "07:00", close: "16:00" };
  bp.hours = {
    timezone: "Australia/Sydney",
    weekly: {
      monday: weekday, tuesday: weekday, wednesday: weekday, thursday: weekday, friday: weekday,
      saturday: { open: "08:00", close: "12:00" },
      sunday: { closed: true },
    },
    closedPeriods: [],
    afterHours: { available: true, policy: "Emergencies only — no power, burning smells, sparking.", surchargeApplies: true },
    publicHolidays: { byArrangement: true },
  };

  bp.callHandling = {
    ...bp.callHandling,
    greetingStyle: "Calm and quick. Name the business, say you are an AI assistant, ask what's happening.",
    collectAlways: ["caller_name", "callback_number", "service_address", "problem_description"],
    collectByService: {
      power_outage: ["on_site_now", "property_type"],
      burning_smell: ["on_site_now"],
    },
    additionalQuestions: [
      { id: "neighbours_too", question: "Are your neighbours out too, or just you?", appliesToServices: ["power_outage"] },
      { id: "turn_off_at_board", question: "If it's safe to do so, please switch that circuit off at the board.", appliesToServices: ["burning_smell"] },
    ],
    urgencyRules: [
      { ruleId: "burning_or_sparking", when: "there is a burning smell, smoke or sparking", level: "emergency", action: "transfer_immediately", transferEligible: true, wording: "Please switch it off at the board if you safely can. I'm putting you through now." },
      { ruleId: "total_outage", when: "a property has no power at all and the neighbours do", level: "emergency", action: "transfer_immediately", transferEligible: true },
      { ruleId: "safety_switch_tripping", when: "a safety switch keeps tripping", level: "urgent", action: "notify_urgently_and_collect", transferEligible: false },
      { ruleId: "planned_work", when: "the work is planned rather than a fault", level: "non_urgent", action: "collect_for_business_hours", transferEligible: false },
    ],
    escalation: {
      primaryNumber: "+61355500511",
      backupNumber: "+61355500512",
      permittedHours: { always: true },
      eligibleServices: ["power_outage", "burning_smell"],
      minimumUrgency: "emergency",
      timeoutSeconds: 30,
      preTransferWording: "I'm putting you through to one of our electricians now.",
      unansweredAction: "try_backup_number",
      maxAttempts: 2,
    },
    callbackPolicy: "Same-day callback for urgent faults.",
    unavailableAction: "take_message_and_notify",
    intentTaxonomy: [
      { intentId: "electrical_fault", label: "Electrical fault", examples: ["the power's gone off"] },
      { intentId: "planned_work", label: "Planned work", examples: ["I want some downlights put in"] },
    ],
  };

  bp.knowledge = {
    approvedFacts: [
      { factId: "licensed", statement: "Our electricians are licensed.", sourceRef: "owner_brief" },
      { factId: "no_phone_advice", statement: "We do not talk people through electrical work over the phone.", sourceRef: "owner_brief" },
    ],
    sourceReferences: [{ refId: "owner_brief", description: "Owner briefing, 2026-08", url: null }],
    prohibitedClaims: [...MANDATORY_PROHIBITED_CLAIMS, "advice_on_working_on_live_wiring"],
    uncertaintyPolicy: "say_unsure_and_take_message",
    pricingDisclosure: "callout_fee_only",
    pricingWording: "There's a call-out fee, and the electrician confirms the price before starting.",
  };

  bp.booking = { ...bp.booking, enabled: false };
  bp.voice = { profileRef: "neutral_professional_au", language: "en-AU", pronunciationHints: [{ term: "Cammeray", hint: "CAM-uh-ray" }], tone: "calm, plain" };
  bp.compliance = {
    callsMayBeRecorded: true,
    recordingDisclosure: "Quick heads up, this call is recorded.",
    transcriptRetention: "keep_12_months",
    recordingRetention: "keep_6_months",
    redactSensitiveData: true,
    privacyPolicyReference: null,
  };
  bp.outbound = { ...bp.outbound, enabled: false };
  bp.integrations = [
    { capability: "sms", enabled: true, adapterRef: "sms_default", notes: "On-call notifications." },
    { capability: "job_management", enabled: true, adapterRef: "jobs_default", notes: null },
    { capability: "crm", enabled: false, adapterRef: null, notes: null },
  ];

  return bp;
}

(async () => {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  AIDA PLATFORM — a new client, start to finish, entirely offline     ║");
  console.log("║  Harbour Electrical: a fourth trade, described only as configuration ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  const store = createInMemoryBlueprintStore();
  const authority = createBlueprintAuthority({ store, now });
  let failures = 0;
  const expect = (condition, message) => {
    if (!condition) { failures += 1; console.log(`   !!!!!!! EXPECTATION FAILED: ${message}`); }
  };

  // ── 1 ──
  step("Describe the business. No code is written for it.");
  const described = harbourElectrical();
  did(`${described.identity.tradingName} — ${described.services.filter((s) => s.enabled).length} services, vertical "${described.identity.vertical}"`);
  note("Nothing in src/platform mentions electricians. A ratchet asserts that.");

  // ── 2 ──
  step("Create a draft. Editing configuration changes nothing that is live.");
  const draft = await authority.createDraft({ clientId: CLIENT_ID, blueprint: described, createdBy: OWNER, source: "ui" });
  expect(draft.ok, "the draft should be created");
  const v1 = draft.version.metadata.configVersion;
  did(`v${v1} created as "${draft.version.metadata.status}"`);
  const noneYet = await authority.getActiveVersion(CLIENT_ID);
  expect(!noneYet.ok, "there must be no active version yet");
  refused(`getActiveVersion — ${noneYet.message}`);

  // ── 3 ──
  step("Try to break it, and watch validation refuse each one.");
  for (const [what, mutate] of [
    ["a transfer rule with no number to transfer to", (bp) => { bp.callHandling.escalation.primaryNumber = null; }],
    ["dropping a mandatory prohibition", (bp) => { bp.knowledge.prohibitedClaims = bp.knowledge.prohibitedClaims.filter((c) => c !== "claiming_to_be_human"); }],
    ["recording calls without telling anybody", (bp) => { bp.compliance.recordingDisclosure = null; }],
    ["a provider voice id in the blueprint", (bp) => { bp.voice.profileRef = "custom_voice_000000000000000000000000"; }],
    ["an invented urgency level", (bp) => { bp.services[0].urgencyCategory = "extremely_urgent"; }],
    ["a Wednesday nobody mentioned", (bp) => { delete bp.hours.weekly.wednesday; }],
  ]) {
    const broken = JSON.parse(JSON.stringify(described));
    mutate(broken);
    const result = validateBlueprint(broken);
    expect(!result.ok, `"${what}" should be refused`);
    refused(`${what} — ${result.errors[0].path}`);
  }

  // ── 4 ──
  step("Validate the real one, then try to approve it the wrong ways.");
  const validated = await authority.validateDraft(CLIENT_ID, v1);
  expect(validated.ok, "the real configuration should validate");
  did(`v${v1} is now "${validated.version.metadata.status}"`);

  const early = await authority.activateApprovedVersion({ clientId: CLIENT_ID, configVersion: v1 });
  expect(!early.ok, "validated is not approved");
  refused(`activating before approval — ${early.message}`);

  const byMachine = await authority.approveDraft({ clientId: CLIENT_ID, configVersion: v1, approvedBy: "aida" });
  expect(!byMachine.ok, "a machine must not approve");
  refused(`approval by "aida" — ${byMachine.message}`);

  // ── 5 ──
  step("A named person approves. It is still not live.");
  tick();
  const approved = await authority.approveDraft({
    clientId: CLIENT_ID, configVersion: v1, approvedBy: OWNER, reason: "Read the whole thing aloud with the owner.",
  });
  expect(approved.ok, "a person should be able to approve");
  did(`approved by ${approved.version.metadata.approvedBy} at ${approved.version.metadata.approvedAt}`);
  const stillNothing = await authority.getActiveVersion(CLIENT_ID);
  expect(!stillNothing.ok, "approval must not activate");
  refused(`getActiveVersion — approval and activation are separate decisions`);

  // ── 6 ──
  step("Activate, deliberately.");
  tick();
  const active = await authority.activateApprovedVersion({ clientId: CLIENT_ID, configVersion: v1, activatedBy: OWNER });
  expect(active.ok, "an approved version should activate");
  did(`v${v1} is ACTIVE as of ${active.version.metadata.activatedAt}`);

  const edit = await authority.updateDraft({
    clientId: CLIENT_ID, configVersion: v1, mutate: (bp) => { bp.identity.tradingName = "Something Else"; },
  });
  expect(!edit.ok, "an active version must be immutable");
  refused(`editing the active version — ${edit.message}`);

  // ── 7 ──
  step("The owner telephones to change something. It becomes a draft.");
  tick();
  const proposal = await proposeConfigPatch({
    authority, clientId: CLIENT_ID, source: "voice", proposedBy: "owner via telephone",
    patch: {
      explanation: "We've stopped doing Saturday mornings.",
      transcriptRef: "call_demo_0001",
      operations: [{ op: "set", path: "hours.weekly.saturday", value: { closed: true } }],
    },
  });
  expect(proposal.ok && proposal.status === "draft", "a voice change must become a draft");
  did(`heard "${proposal.provenance.explanation}" -> v${proposal.version.metadata.configVersion} (${proposal.status})`);
  for (const change of proposal.diff.changes) note(`change: ${change.summary}`);
  const unchanged = await authority.getActiveVersion(CLIENT_ID);
  expect(unchanged.version.metadata.configVersion === v1, "the active version must not have moved");
  refused(`changing what is live — still v${unchanged.version.metadata.configVersion}, awaiting a person`);

  const sneaky = await proposeConfigPatch({
    authority, clientId: CLIENT_ID, source: "voice",
    patch: { operations: [{ op: "set", path: "metadata.status", value: "active" }] },
  });
  expect(!sneaky.ok, "a patch must not be able to activate itself");
  refused(`a patch setting metadata.status — ${sneaky.message}`);

  // ── 8 ──
  step("Compile the behaviour. Still no vendor anywhere in it.");
  const { spec, behaviourHash } = compileBehaviourSpec(active.version);
  did(`behaviour hash ${behaviourHash}`);
  did(`${spec.services.length} enabled services, ${spec.urgency.rules.length} urgency rules`);
  const specJson = JSON.stringify(spec);
  for (const vendor of ["retell", "twilio", "11labs", "custom_voice_"]) {
    expect(!specJson.toLowerCase().includes(vendor), `the spec must not mention ${vendor}`);
  }
  did("no provider identifier appears in the behaviour spec");
  expect(spec.assistant.disclosesAiWhenAsked === true, "AI disclosure is platform-owned");
  did("AI disclosure is on, and the blueprint has no way to switch it off");

  // ── 9 ──
  step("Compile a provider payload — with the references deliberately absent.");
  const blind = compileRetellPreview({ spec, providerRefs: {} });
  expect(!blind.ready, "a payload with no references must not be ready");
  refused(`compiling without references — unresolved: ${blind.unresolved.join(", ")}`);
  note("Reported by name rather than defaulted. A substituted placeholder is how the wrong voice reaches a caller.");

  // ── 10 ──
  step("Compile it properly, with fake references.");
  const compiled = compileRetellPreview({
    spec,
    providerRefs: {
      llmId: "llm_demo0000000000000000000",
      voiceId: "custom_voice_demo00000000000",
      webhookUrl: "https://example.invalid/hooks/harbour",
      agentNamePrefix: "aida",
    },
  });
  expect(compiled.ready, "the payload should be ready");
  did(`agent "${compiled.agent.agent_name}"`);
  did(`engine hash ${compiled.responseEngineHash}`);
  did(`agent  hash ${compiled.agentHash}`);
  note("Two resources, because the prompt belongs to a response engine and the agent references it.");
  console.log(`\n   ── the first thing a caller hears ──\n   ${compiled.responseEngine.begin_message}\n`);
  const promptLines = compiled.responseEngine.general_prompt.split("\n");
  console.log(`   ── the prompt (${promptLines.length} lines, first 22) ──`);
  for (const line of promptLines.slice(0, 22)) console.log(`   ${line}`);
  console.log("   ...");

  // ── 11 ──
  step("Wire up the integrations the configuration asks for, and nothing else.");
  const registry = createIntegrationRegistry();
  const wired = registerFakeAdaptersFor({ registry, blueprint: active.version, now });
  expect(wired.ok, "adapters should register");
  did(`registered: ${registry.registeredFor(CLIENT_ID).join(", ")}`);

  const disabled = registry.resolve({ clientId: CLIENT_ID, capability: "crm", blueprint: active.version });
  expect(!disabled.ok, "a disabled capability must not resolve");
  refused(`resolving crm — ${disabled.message}`);

  const job = await registry.invoke({
    clientId: CLIENT_ID, capability: "job_management", operation: "createJob", blueprint: active.version,
    request: { serviceId: "power_outage", callerName: "Sam Okafor", callbackNumber: "+61355500599", description: "No power to the whole house." },
  });
  expect(job.ok, "a well-formed job should be created");
  did(`fake job management created ${job.result.jobRef}`);

  const badRequest = await registry.invoke({
    clientId: CLIENT_ID, capability: "sms", operation: "deliverMessage", blueprint: active.version,
    request: { body: "job for you" },
  });
  expect(!badRequest.ok, "a malformed request must be refused");
  refused(`sms with no recipient — missing ${badRequest.missing.join(", ")}`);

  // ── 12 ──
  step("And after all of that, nothing can place a call.");
  const surface = [
    ...Object.keys(authority),
    ...Object.keys(registry),
    ...Object.keys(require(path.join(ROOT, "src/platform/config-patch"))),
    ...Object.keys(require(path.join(ROOT, "src/platform/provider-compiler-retell"))),
  ];
  const acting = surface.filter((name) => /^(dial|placeCall|makeCall|provision|deploy|enableCalling)/i.test(name));
  expect(acting.length === 0, `nothing should expose an acting operation, found ${acting.join(", ")}`);
  did(`${surface.length} operations across the platform, and none of them dials`);
  expect(active.version.outbound.enabled === false, "outbound stays described-and-off");
  did("outbound is a capability description, switched off, with no field that could authorise a call");
  note("Calling, DNCR, suppression, dispatch and provisioning are separate authorities.");
  note("No module in src/platform imports one, and a ratchet reads the source to prove it.");

  console.log(`\n${"═".repeat(72)}`);
  if (failures === 0) {
    console.log("A fourth trade, configured end to end, entirely offline. No expectation failed.");
    console.log(`${"═".repeat(72)}\n`);
    process.exit(0);
  }
  console.log(`${failures} EXPECTATION${failures === 1 ? "" : "S"} FAILED — see above.`);
  console.log(`${"═".repeat(72)}\n`);
  process.exit(1);
})();

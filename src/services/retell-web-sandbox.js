// AIDA — Retell web-call sandbox orchestration (M7B).
//
// Creates a throwaway knowledge base, response engine, agent and ONE web call,
// verifies them, and cleans up. Its purpose is to find out whether the request
// shapes M7B derived from documentation are actually accepted.
//
// ─── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────
//   * buy, import or bind a telephone number
//   * place or receive a telephone call
//   * enable recording or any webhook
//   * touch a client record, a provisioning plan or the resource registry
//   * touch the database, billing, or call allowances
//   * update any existing Retell resource, including the dashboard's own agent
//
// Every resource it creates is fresh and disposable, so the whole provisioning
// path is exercised rather than partially reused.
//
// ─── NO SECOND SET OF PAYLOADS ──────────────────────────────────────
// This service builds nothing itself. The multipart knowledge-base request, the
// dynamic-variable rules and the provider error normalisation all come from the
// modules the production path uses. A sandbox with its own improvised payloads
// would validate the sandbox rather than the product.
//
// The agent and response-engine payloads are assembled here from a small
// fictional profile because the production compiler is client-shaped and this
// must never touch a client — but every FIELD NAME comes from the corrected
// contract, and a test asserts the sandbox agent carries the same field set the
// compiler emits.
//
// Pure orchestration: the adapter is injected. Nothing here opens a socket.

const multipart = require("./retell-multipart");
const dynamicVars = require("./retell-dynamic-variables");

const SANDBOX_VERSION = "retell-web-sandbox-2026-08-01";

// ── Fictional demonstration business ────────────────────────────────
// RFC-2606 / ACMA-safe: no real business, no real number, no customer data.
const DEMO = Object.freeze({
  businessName: "Harbour Locksmith Demo",
  serviceArea: "Frankston and surrounding suburbs",
  scenario: "residential_lockout",
});

const DEMO_KNOWLEDGE = [
  `${DEMO.businessName} is a demonstration locksmith business used only for testing.`,
  `It services ${DEMO.serviceArea}.`,
  "It accepts residential lockouts.",
  "It does not perform automotive key replacement.",
  "Pricing must always be confirmed by a locksmith; never quote a final price.",
  "Never guarantee an arrival time.",
  "Never provide lock-bypass or forced-entry instructions to a caller.",
].join("\n");

/** Unique, obviously-disposable names. Under the provider's 40-character limit. */
function sandboxNames(stamp) {
  return {
    knowledgeBase: `AIDA Sandbox KB ${stamp}`,
    responseEngine: `AIDA Sandbox LLM ${stamp}`,
    agent: `AIDA Sandbox Agent ${stamp}`,
  };
}

/** YYYYMMDD-HHMMSS from an injected clock, so runs are traceable and testable. */
function stampFrom(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

// ── Payloads ────────────────────────────────────────────────────────

function buildSandboxKnowledgeBaseRequest(names) {
  return multipart.buildCreateKnowledgeBaseRequest({
    knowledgeBaseName: names.knowledgeBase,
    texts: [{ title: "Demonstration business", text: DEMO_KNOWLEDGE }],
  });
}

/**
 * The sandbox prompt. Short on purpose — this validates a contract, not a
 * receptionist. It still carries the safety rules, because an agent that would
 * quote a price or promise a time is not one we want on a call even in a test.
 */
function buildSandboxResponseEnginePayload({ knowledgeBaseId, defaults }) {
  const prompt = [
    "# Who you are",
    `- You answer the phone for {{business_name}}, a locksmith business.`,
    "- You are an automated assistant. Say so if asked.",
    "",
    "# Your rules",
    "- Never quote a final price. A locksmith confirms every price.",
    "- Never guarantee an arrival time.",
    "- Never explain how to bypass or force a lock.",
    "- Never claim to be a person.",
    "",
    "# This call",
    // Every variable named here MUST be one the allow-list can carry AND that
    // is actually supplied. An unsupplied variable is not an error at the
    // provider — it renders LITERALLY, so the agent would read "{{...}}" aloud.
    //
    // This prompt originally said "The caller is in {{caller_suburb}}".
    // caller_suburb is not in DYNAMIC_VARIABLE_ALLOWLIST and was never sent, so
    // the live agent was given that placeholder as text. Replaced with
    // variables that are genuinely delivered per call, which is also what makes
    // the dynamic-variable check meaningful rather than decorative.
    "- The business is currently {{current_business_status}} and the on-call state is {{on_call_state}}.",
    "- This call is about {{call_kind}}.",
    "- If the caller asks who they would be put through to, say you would transfer them to {{current_transfer_number}} — read it digit by digit.",
    "- Take their name and what they need, then say a locksmith will ring back.",
    "- Keep it under six turns. This is a test call.",
  ].join("\n");

  return {
    general_prompt: prompt,
    begin_message: `Good afternoon, ${DEMO.businessName}.`,
    general_tools: [],
    default_dynamic_variables: defaults,
    knowledge_base_ids: [knowledgeBaseId],
  };
}

/**
 * The sandbox agent.
 *
 * Recording off, no webhook, no number. `data_storage_setting` is the strictest
 * useful value: a test call still produces a transcript we want to read, but
 * there is no reason to store PII from a scripted conversation.
 */
function buildSandboxAgentPayload({ llmId, voiceId, language, names }) {
  if (!llmId) throw new Error("the sandbox agent needs a real llm_id");
  if (!voiceId) throw new Error("the sandbox agent needs RETELL_DEFAULT_VOICE_ID");
  if (!language) throw new Error("the sandbox agent needs RETELL_DEFAULT_LANGUAGE");

  return {
    agent_name: names.agent,
    response_engine: { type: "retell-llm", llm_id: llmId },
    voice_id: voiceId,
    language,
    // No webhook_url and no webhook_events: the sandbox receives no callbacks.
    post_call_analysis_data: [
      { type: "system-presets", name: "call_summary" },
      { type: "string", name: "caller_name", description: "The caller's name, if given." },
      { type: "string", name: "suburb", description: "The suburb of the job." },
    ],
    data_storage_setting: "everything_except_pii",
  };
}

/**
 * Per-call variables, built through the SHARED runtime path.
 *
 * `buildInboundCallVariables` is the same function the production inbound
 * webhook would call, so this exercises the real allow-list, the real
 * string-coercion rule and the real runtime-vs-default split rather than a
 * parallel test object. If a key were ever added that the allow-list rejects,
 * this would fail here rather than at a caller.
 *
 * These are supplied PER CALL precisely because they are the runtime-sensitive
 * ones — a transfer number baked into the agent's defaults would be whoever was
 * on call the day the agent was provisioned.
 */
function buildSandboxDynamicVariables() {
  const built = dynamicVars.buildInboundCallVariables({
    // ACMA fictitious range. Never a real number.
    transferPrimary: "+61491570006",
    businessStatus: "open",
    onCallState: "demo_on_call",
    callKind: DEMO.scenario,
  });
  if (!built.ok) {
    throw new Error(`sandbox dynamic variables were rejected by the shared validator: ${built.errors.join("; ")}`);
  }
  return built.variables;
}

/** Per-call variables. Every value a string, per the provider contract. */
function buildSandboxWebCallPayload({ agentId }) {
  if (!agentId) throw new Error("the sandbox web call needs a real agent_id");
  return {
    agent_id: agentId,
    retell_llm_dynamic_variables: buildSandboxDynamicVariables(),
    // Stored against the call, never injected into the prompt. Marks the call
    // as a non-billable test not associated with any client.
    metadata: {
      aida_sandbox: "true",
      aida_client_id: "none",
      aida_billable: "false",
      aida_environment: "sandbox",
    },
  };
}

// ── Orchestration ───────────────────────────────────────────────────

const STEPS = Object.freeze([
  "create_knowledge_base",
  "await_knowledge_base",
  "create_response_engine",
  "create_agent",
  "verify_agent",
  "create_web_call",
  "verify_web_call",
]);

/**
 * Run the sandbox.
 *
 * `adapter` is the provider boundary; `sleep` and `now` are injected so tests
 * drive polling without waiting. Nothing here is real unless the caller passes a
 * real adapter, which scripts/retell-web-sandbox.js only does behind every gate.
 */
async function runWebCallSandbox({
  adapter,
  config,
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger = console,
  createCall = true,
}) {
  const started = now();
  const names = sandboxNames(stampFrom(started));
  const created = { knowledgeBaseId: null, responseEngineId: null, agentId: null, callId: null };
  const timings = {};
  const results = [];
  const validations = [];

  function record(step, ok, detail = null) {
    results.push({ step, ok, detail });
    return ok;
  }

  async function timed(step, fn) {
    const t0 = Date.now();
    const out = await fn();
    timings[step] = Date.now() - t0;
    return out;
  }

  try {
    // ── 1. Knowledge base ──────────────────────────────────────────
    const kbRequest = buildSandboxKnowledgeBaseRequest(names);
    if (!kbRequest.ok) {
      record("create_knowledge_base", false, kbRequest.message);
      return finish({ ok: false, failedAt: "create_knowledge_base" });
    }

    const kbResponse = await timed("create_knowledge_base", () =>
      adapter.createKnowledgeBase({ payload: kbRequest.request, idempotencyKey: `sandbox_kb_${stampFrom(started)}` })
    );
    if (!kbResponse.ok) {
      record("create_knowledge_base", false, kbResponse.error.code);
      return finish({ ok: false, failedAt: "create_knowledge_base", error: kbResponse.error });
    }
    created.knowledgeBaseId = kbResponse.resource.id;
    record("create_knowledge_base", true, created.knowledgeBaseId);
    logger.log(`[sandbox] knowledge base created: ${created.knowledgeBaseId}`);

    // ── 2. Wait for processing ─────────────────────────────────────
    // The KB is not usable until it reaches "complete". Proceeding while it is
    // still in_progress gives an agent answering from a partially-indexed
    // corpus — worse than none, because it looks like it is working.
    const waited = await timed("await_knowledge_base", () =>
      awaitKnowledgeBase({ adapter, knowledgeBaseId: created.knowledgeBaseId, config, sleep, logger })
    );
    if (!waited.ok) {
      record("await_knowledge_base", false, waited.code);
      return finish({ ok: false, failedAt: "await_knowledge_base", error: { code: waited.code, message: waited.message } });
    }
    record("await_knowledge_base", true, `complete after ${timings.await_knowledge_base}ms`);
    validations.push({ check: "knowledge_base_complete", ok: true, detail: `${waited.polls} poll(s)` });

    // ── 3. Response engine ─────────────────────────────────────────
    const defaults = dynamicVars.validateDynamicVariables(
      { business_name: DEMO.businessName },
      { scope: "default" }
    );
    // Sandbox defaults are stable business identity only — the same rule the
    // production compiler follows, so nothing runtime-sensitive is baked in.
    const enginePayload = buildSandboxResponseEnginePayload({
      knowledgeBaseId: created.knowledgeBaseId,
      defaults: defaults.ok ? defaults.variables : {},
    });

    const engineResponse = await timed("create_response_engine", () =>
      adapter.createResponseEngine({ payload: enginePayload, idempotencyKey: `sandbox_llm_${stampFrom(started)}` })
    );
    if (!engineResponse.ok) {
      record("create_response_engine", false, engineResponse.error.code);
      return finish({ ok: false, failedAt: "create_response_engine", error: engineResponse.error });
    }
    created.responseEngineId = engineResponse.resource.id;
    created.responseEngineVersion = engineResponse.resource.version;
    if (!created.responseEngineId) {
      record("create_response_engine", false, "the provider returned no llm_id");
      return finish({ ok: false, failedAt: "create_response_engine", error: { code: "no_llm_id", message: "The provider returned no llm_id." } });
    }
    record("create_response_engine", true, created.responseEngineId);
    logger.log(`[sandbox] response engine created: ${created.responseEngineId} (version ${created.responseEngineVersion})`);

    // ── 4. Agent ───────────────────────────────────────────────────
    const agentPayload = buildSandboxAgentPayload({
      llmId: created.responseEngineId,
      voiceId: config.voiceId,
      language: config.language,
      names,
    });

    const agentResponse = await timed("create_agent", () =>
      adapter.createAgent({ payload: agentPayload, idempotencyKey: `sandbox_agent_${stampFrom(started)}` })
    );
    if (!agentResponse.ok) {
      record("create_agent", false, agentResponse.error.code);
      return finish({ ok: false, failedAt: "create_agent", error: agentResponse.error });
    }
    created.agentId = agentResponse.resource.id;
    created.agentVersion = agentResponse.resource.version;
    record("create_agent", true, created.agentId);
    logger.log(`[sandbox] agent created: ${created.agentId} (version ${created.agentVersion})`);

    // ── 5. Verify the agent is what we asked for ───────────────────
    const fetched = await timed("verify_agent", () => adapter.getAgent({ providerId: created.agentId }));
    if (!fetched.ok) {
      record("verify_agent", false, fetched.error.code);
      return finish({ ok: false, failedAt: "verify_agent", error: fetched.error });
    }
    // Read from the adapter's CLOSED resource shape, not a raw provider body.
    // The live adapter returns no `raw` — only the test fakes did — so reading
    // it made every check report "(none)" against a correctly-created agent.
    const agentChecks = verifyAgent({
      fetched: {
        response_engine: { llm_id: fetched.resource.responseEngineId, type: fetched.resource.responseEngineType },
        voice_id: fetched.resource.voiceId,
        language: fetched.resource.language,
        webhook_url: fetched.resource.webhookUrl,
      },
      expected: { llmId: created.responseEngineId, voiceId: config.voiceId, language: config.language },
    });
    validations.push(...agentChecks.checks);
    if (!agentChecks.ok) {
      record("verify_agent", false, agentChecks.checks.filter((c) => !c.ok).map((c) => c.check).join(","));
      return finish({ ok: false, failedAt: "verify_agent", error: { code: "agent_mismatch", message: "The created agent does not match what was requested." } });
    }
    record("verify_agent", true, "response engine, voice and language match");

    if (!createCall) {
      return finish({ ok: true, stoppedBefore: "create_web_call" });
    }

    // ── 6. Web call ────────────────────────────────────────────────
    // NOTE ON THE ACCESS TOKEN: it is valid for ~30 seconds. This step is
    // therefore performed on demand, immediately before a browser joins —
    // never minted early and left waiting in a manifest.
    const callPayload = buildSandboxWebCallPayload({ agentId: created.agentId });
    const callResponse = await timed("create_web_call", () =>
      adapter.createWebCall({ payload: callPayload, idempotencyKey: `sandbox_call_${stampFrom(started)}` })
    );
    if (!callResponse.ok) {
      record("create_web_call", false, callResponse.error.code);
      return finish({ ok: false, failedAt: "create_web_call", error: callResponse.error });
    }
    created.callId = callResponse.resource.id;
    created.callStatus = callResponse.resource.status;

    // The token comes through the adapter's ONE-SHOT reader. It is never a
    // property on the result, so it cannot be serialised, logged or read twice.
    //
    // An earlier version read `callResponse.raw.access_token`. The live adapter
    // has no `raw` — only the test fakes did — so this was always undefined in
    // reality while the suite stayed green. The fakes were richer than the
    // provider boundary, which is the only kind of bug a green suite hides.
    const accessToken = typeof callResponse.takeAccessToken === "function" ? callResponse.takeAccessToken() : null;

    record("create_web_call", true, created.callId);
    logger.log(`[sandbox] web call created: ${created.callId} (status ${created.callStatus}) — access token held in memory only`);

    // ── 7. Verify the call belongs to our agent ────────────────────
    const callCheck = verifyWebCall({
      response: {
        call_id: callResponse.resource.id,
        agent_id: callResponse.resource.agentId,
        call_type: callResponse.resource.callType,
        call_status: callResponse.resource.status,
        // Presence only — the value never enters the verification path.
        access_token: accessToken ? "present" : null,
      },
      expectedAgentId: created.agentId,
    });
    validations.push(...callCheck.checks);
    if (!callCheck.ok) {
      record("verify_web_call", false, "the call is not associated with the sandbox agent");
      return finish({ ok: false, failedAt: "verify_web_call", error: { code: "call_mismatch", message: "The web call is not associated with the sandbox agent." } });
    }
    record("verify_web_call", true, "call is bound to the sandbox agent");

    return finish({ ok: true, accessToken });
  } catch (err) {
    return finish({ ok: false, failedAt: "unexpected", error: { code: "sandbox_exception", message: err.message } });
  }

  function finish(outcome) {
    return {
      sandboxVersion: SANDBOX_VERSION,
      ok: outcome.ok === true,
      failedAt: outcome.failedAt || null,
      stoppedBefore: outcome.stoppedBefore || null,
      error: outcome.error || null,
      names,
      created,
      timings,
      results,
      validations,
      startedAt: started.toISOString(),
      // Exactly what this run did and did not establish. Carried on every
      // result so no caller can report more than was actually proven.
      proofs: proofSummary({ callCreated: Boolean(created.callId) }),
      // Held in memory for the caller; excluded from the manifest by
      // buildManifest, which cannot see it.
      accessToken: outcome.accessToken || null,
    };
  }
}

/**
 * Create ONE web call against an already-provisioned sandbox agent.
 *
 * Separated from runWebCallSandbox because of the 30-second token window: the
 * browser harness must create the call at the instant the operator clicks, not
 * during provisioning minutes earlier. Provisioning happens once; this runs on
 * demand.
 *
 * Returns the browser-safe fields and the token. The token is read from the
 * adapter's one-shot reader and passed straight to the caller — it is never
 * placed on a durable object here.
 */
async function createSandboxWebCall({ adapter, agentId, logger = console }) {
  if (!agentId) return { ok: false, code: "no_agent", message: "There is no sandbox agent to call." };

  const payload = buildSandboxWebCallPayload({ agentId });
  const response = await adapter.createWebCall({ payload, idempotencyKey: null });

  if (!response.ok) {
    logger.error(`[sandbox] web call creation failed: ${response.error.code}`);
    return { ok: false, code: response.error.code, message: "The provider did not create the call." };
  }

  const accessToken = typeof response.takeAccessToken === "function" ? response.takeAccessToken() : null;

  const verdict = verifyWebCall({
    response: {
      call_id: response.resource.id,
      agent_id: response.resource.agentId,
      call_type: response.resource.callType,
      call_status: response.resource.status,
      access_token: accessToken ? "present" : null,
    },
    expectedAgentId: agentId,
  });

  if (!verdict.ok) {
    const failedChecks = verdict.checks.filter((c) => !c.ok).map((c) => c.check);
    logger.error(`[sandbox] web call rejected by verification: ${failedChecks.join(",")}`);
    return { ok: false, code: "call_verification_failed", message: `The created call failed verification: ${failedChecks.join(", ")}.`, checks: verdict.checks };
  }

  return {
    ok: true,
    callId: response.resource.id,
    agentId: response.resource.agentId,
    callType: response.resource.callType,
    callStatus: response.resource.status,
    accessToken,
    checks: verdict.checks,
  };
}

/**
 * Poll until the knowledge base is usable.
 *
 * Bounded by kbMaxWaitMs. A timeout is a failure, not a reason to press on:
 * an agent attached to an unprocessed KB would answer from nothing.
 */
async function awaitKnowledgeBase({ adapter, knowledgeBaseId, config, sleep, logger }) {
  const deadline = Date.now() + config.kbMaxWaitMs;
  let polls = 0;

  for (;;) {
    const response = await adapter.getKnowledgeBase({ providerId: knowledgeBaseId });
    polls += 1;
    if (!response.ok) {
      return { ok: false, code: "kb_fetch_failed", message: response.error.message, polls };
    }

    const status = (response.raw && response.raw.status) || response.resource.status;
    const verdict = multipart.assessKnowledgeBase(status);

    if (verdict.usable) return { ok: true, polls, status };
    if (verdict.terminal) return { ok: false, code: verdict.code || "kb_failed", message: verdict.message, polls, status };

    if (Date.now() >= deadline) {
      return { ok: false, code: "kb_timeout", message: `The knowledge base was still "${status}" after ${config.kbMaxWaitMs}ms.`, polls, status };
    }
    logger.log(`[sandbox] knowledge base ${status} — waiting (${polls})`);
    await sleep(config.kbPollMs);
  }
}

/** Did the provider create the agent we actually asked for? */
function verifyAgent({ fetched, expected }) {
  const body = fetched || {};
  const engine = body.response_engine || {};
  const language = Array.isArray(body.language) ? body.language[0] : body.language;

  const checks = [
    { check: "agent_response_engine_llm_id", ok: engine.llm_id === expected.llmId, detail: `expected ${expected.llmId}, got ${engine.llm_id || "(none)"}` },
    { check: "agent_voice_id", ok: body.voice_id === expected.voiceId, detail: `expected ${expected.voiceId}, got ${body.voice_id || "(none)"}` },
    // Language is compared loosely: a provider that coerces en-AU to en-US is a
    // finding worth reporting, not a crash.
    { check: "agent_language", ok: String(language || "").toLowerCase() === String(expected.language || "").toLowerCase(), detail: `expected ${expected.language}, got ${language || "(none)"}` },
    { check: "agent_no_webhook", ok: !body.webhook_url, detail: body.webhook_url ? "a webhook url is set" : "none" },
  ];

  // Language mismatch is reported but does not fail the run — it is exactly the
  // kind of thing this sandbox exists to discover.
  const blocking = checks.filter((c) => c.check !== "agent_language");
  return { ok: blocking.every((c) => c.ok), checks };
}

/**
 * PROOF A — the create-web-call API proof.
 *
 * This is what an UNATTENDED run can establish: that Retell accepted our agent
 * id, accepted the request, and returned a usable call. It establishes nothing
 * about audio, because nobody joined.
 *
 * `registered` is the expected initial status and is a complete success for
 * this proof. The call will LATER become `not_connected` or `error` because no
 * browser joined within the ~30-second token window — that is the documented
 * consequence of an unattended test, not a contract failure, and it does not
 * retract the issuance proof already established here.
 */
const EXPECTED_INITIAL_STATUSES = Object.freeze(["registered", "ongoing"]);

// Statuses a call drifts to when nobody joins. Expected, not failures.
const UNJOINED_STATUSES = Object.freeze(["not_connected", "error", "ended"]);

function verifyWebCall({ response, expectedAgentId }) {
  const checks = [
    // A call with no id proves nothing and cannot be cleaned up or looked at.
    { check: "web_call_id", ok: Boolean(response.call_id), detail: response.call_id || "(missing)" },
    { check: "web_call_agent_id", ok: response.agent_id === expectedAgentId, detail: `expected ${expectedAgentId}, got ${response.agent_id || "(none)"}` },
    // Blocking when present and wrong; tolerated when the provider omits it.
    { check: "web_call_type", ok: response.call_type === undefined || response.call_type === "web_call", detail: response.call_type || "(not returned)" },
    // The token is the thing a browser would need. Its ABSENCE is a failure;
    // its VALUE is never recorded.
    { check: "web_call_has_token", ok: Boolean(response.access_token), detail: response.access_token ? "present (never logged or stored)" : "MISSING" },
    {
      check: "web_call_initial_status",
      ok: response.call_status === undefined || EXPECTED_INITIAL_STATUSES.includes(response.call_status),
      detail: response.call_status || "(not returned)",
    },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Classify a status observed LATER, after the token window has passed.
 *
 * Reported honestly in both directions: an unjoined call is expected for an
 * API-only run and must not be dressed up as an audio success, and it must not
 * be reported as a provider fault either.
 */
function classifyLaterCallStatus(status) {
  if (UNJOINED_STATUSES.includes(status)) {
    return {
      expectedForUnattendedRun: true,
      audioProven: false,
      summary: `The call reached "${status}" because no browser joined within the provider's token window. Expected for an API-only test; it does not retract the create-web-call proof, and it does NOT demonstrate audio.`,
    };
  }
  if (EXPECTED_INITIAL_STATUSES.includes(status)) {
    return { expectedForUnattendedRun: true, audioProven: false, summary: `The call is "${status}". Issuance is proven; audio is not.` };
  }
  return { expectedForUnattendedRun: false, audioProven: false, summary: `Unrecognised call status "${status}".` };
}

/**
 * What an unattended run does and does not establish. Attached to every result
 * so no report can quietly overstate it.
 */
function proofSummary({ callCreated }) {
  return Object.freeze({
    proofA_createWebCallApi: {
      established: callCreated,
      covers: [
        "the real agent id was accepted",
        "POST /v2/create-web-call was accepted",
        "a call id was returned",
        "an access token was returned (never logged or stored)",
        "the call is associated with the intended agent",
        "the call type is web_call",
        "dynamic variables were accepted in the request",
      ],
    },
    proofB_humanAudio: {
      established: false,
      note: "Requires a person speaking to the agent. Retell's dashboard Test control on this temporary agent would prove the voice, language, microphone session, LLM responses and knowledge-base influence — but NOT AIDA's create-web-call path, token handoff or browser integration.",
    },
    proofC_aidaBrowserFlow: {
      established: false,
      note: "Requires the isolated browser client: token minted at click time, server-to-browser handoff, join inside the token window, startCall/stopCall. Not attempted by this runner.",
    },
    warning: "Proof A plus Proof B is NOT equivalent to Proof C.",
  });
}

// ── Manifest ────────────────────────────────────────────────────────

// Anything matching these is refused entry to the manifest. Belt and braces
// against a future edit adding a field that looks harmless.
const MANIFEST_FORBIDDEN_KEYS = Object.freeze([
  "accesstoken", "access_token", "apikey", "api_key", "token", "secret",
  "password", "authorization", "transcript", "recording_url", "recordingurl",
]);

/**
 * The manifest. Ids and timings only — enough to clean up later and to say what
 * happened, with nothing that would be dangerous in a file on disk.
 */
function buildManifest(runResult, { keptResources = false } = {}) {
  const manifest = {
    sandboxVersion: SANDBOX_VERSION,
    createdAt: runResult.startedAt,
    ok: runResult.ok,
    failedAt: runResult.failedAt,
    names: runResult.names,
    resources: {
      knowledgeBaseId: runResult.created.knowledgeBaseId,
      responseEngineId: runResult.created.responseEngineId,
      responseEngineVersion: runResult.created.responseEngineVersion || null,
      agentId: runResult.created.agentId,
      agentVersion: runResult.created.agentVersion || null,
      callId: runResult.created.callId,
      callStatus: runResult.created.callStatus || null,
    },
    timings: runResult.timings,
    knowledgeBaseProcessingMs: runResult.timings.await_knowledge_base || null,
    validations: runResult.validations,
    steps: runResult.results,
    cleanupState: keptResources ? "kept_by_request" : "pending",
    // Stated in the file itself so anyone who finds it knows what it is not.
    note: "Contains no API key, no access token, no transcript and no recording URL.",
  };

  const leaked = findForbidden(manifest);
  if (leaked.length) {
    throw new Error(`refusing to build a manifest containing: ${leaked.join(", ")}`);
  }
  return manifest;
}

function findForbidden(node, path = []) {
  const found = [];
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (MANIFEST_FORBIDDEN_KEYS.includes(String(k).toLowerCase())) found.push([...path, k].join("."));
      found.push(...findForbidden(v, [...path, k]));
    }
  }
  return found;
}

// ── Cleanup ─────────────────────────────────────────────────────────

/**
 * Delete in dependency-safe order: agent, then response engine, then knowledge
 * base. Deleting the engine while an agent still points at it is the kind of
 * thing a provider may reject, and there is no reason to find out.
 *
 * Idempotent: a resource the provider cannot find is treated as already gone.
 * Retell returns 422 ("Cannot find requested asset under given api key") rather
 * than 404 for a missing resource, so both are accepted as success.
 */
const ALREADY_GONE_CODES = Object.freeze(["provider_not_found", "invalid_request"]);

async function cleanupSandbox({ adapter, resources, logger = console }) {
  const order = [
    { kind: "agent", id: resources.agentId, op: "deleteAgent" },
    { kind: "response_engine", id: resources.responseEngineId, op: "deleteResponseEngine" },
    { kind: "knowledge_base", id: resources.knowledgeBaseId, op: "deleteKnowledgeBase" },
  ];

  const outcomes = [];
  const remaining = [];

  for (const item of order) {
    if (!item.id) {
      outcomes.push({ ...item, outcome: "nothing_to_delete" });
      continue;
    }
    if (typeof adapter[item.op] !== "function") {
      outcomes.push({ ...item, outcome: "unsupported" });
      remaining.push(item);
      continue;
    }

    const response = await adapter[item.op]({ providerId: item.id });
    if (response.ok) {
      outcomes.push({ ...item, outcome: "deleted" });
      logger.log(`[sandbox] deleted ${item.kind} ${item.id}`);
      continue;
    }
    if (ALREADY_GONE_CODES.includes(response.error.code)) {
      // Already gone is success for an idempotent cleanup.
      outcomes.push({ ...item, outcome: "already_deleted" });
      continue;
    }
    // A failure is never hidden: the id is surfaced so a human can finish the job.
    outcomes.push({ ...item, outcome: "failed", errorCode: response.error.code });
    remaining.push(item);
    logger.error(`[sandbox] FAILED to delete ${item.kind} ${item.id}: ${response.error.code}`);
  }

  // There is no documented delete-call endpoint. Say so rather than pretending
  // the call record was removed.
  const callNote = resources.callId
    ? "The web-call record cannot be deleted: Retell documents no delete-call endpoint. It remains in the dashboard."
    : null;

  return {
    ok: remaining.length === 0,
    outcomes,
    remaining: remaining.map((r) => ({ kind: r.kind, id: r.id })),
    callNote,
  };
}

module.exports = {
  SANDBOX_VERSION,
  DEMO,
  DEMO_KNOWLEDGE,
  STEPS,
  MANIFEST_FORBIDDEN_KEYS,
  ALREADY_GONE_CODES,
  sandboxNames,
  stampFrom,
  buildSandboxKnowledgeBaseRequest,
  buildSandboxResponseEnginePayload,
  buildSandboxAgentPayload,
  buildSandboxWebCallPayload,
  buildSandboxDynamicVariables,
  runWebCallSandbox,
  createSandboxWebCall,
  awaitKnowledgeBase,
  verifyAgent,
  verifyWebCall,
  classifyLaterCallStatus,
  proofSummary,
  EXPECTED_INITIAL_STATUSES,
  UNJOINED_STATUSES,
  buildManifest,
  findForbidden,
  cleanupSandbox,
};

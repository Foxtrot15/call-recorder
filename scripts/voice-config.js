#!/usr/bin/env node
// AIDA VOICE CONFIGURATION — the local simulator (P45).
//
//   node scripts/voice-config.js help
//   node scripts/voice-config.js scenarios
//   node scripts/voice-config.js simulate --client rolladoor_repairs
//   node scripts/voice-config.js simulate --client rolladoor_repairs \
//        --say "We close at four on Saturdays now." --say "That's it."
//   node scripts/voice-config.js replay --scenario locksmith-saturday-hours
//
// ── THIS IS THE SHELL, NOT THE LOGIC ────────────────────────────────
// It seeds an in-memory client, builds a DETERMINISTIC interpreter, and calls
// src/platform/voice/voice-cli.js. Every decision lives there, where it is
// tested without spawning a process.
//
// ── WHAT IT CANNOT DO ───────────────────────────────────────────────
// No microphone. No speech recognition. No telephone. No language model. No
// provider. Nothing here opens a socket, and the only interpreter it can build
// is the deterministic one. Running it changes nothing outside this process.

const path = require("node:path");
const readline = require("node:readline");

const ROOT = path.join(__dirname, "..");
const P = (m) => require(path.join(ROOT, "src/platform", m));

const { runVoiceCommand } = P("voice/voice-cli");
const { createDeterministicInterpreter } = P("voice/voice-interpreter-port");
const { createInMemoryVoiceAudit } = P("voice/voice-audit");
const { createVoiceSessionEngine, createInMemoryVoiceSessionStore } = P("voice/voice-session");
const { createConfigService } = P("config-service");
const { createInMemoryBlueprintStore } = P("blueprint-authority");
const { createInMemoryConfigAudit } = P("config-audit");
const { createPrincipal, voicePrincipal } = P("config-access");
const { FIXTURE_CLIENTS } = require(path.join(ROOT, "src/platform/fixtures/clients"));
const { SCENARIOS } = require(path.join(ROOT, "test/fixtures/voice-transcripts"));

const argv = process.argv.slice(2);

function clock(startMs = Date.UTC(2026, 7, 17, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 60000) => { t += ms; return new Date(t); };
  return now;
}

/** Seed one demonstration client all the way to an ACTIVE version. */
async function seed(configService, clientId, make) {
  const editor = createPrincipal({ role: "client_editor", actorId: "simulator seed", clientId });
  const owner = createPrincipal({ role: "client_owner", actorId: "Peter Dang", clientId });
  const operator = createPrincipal({ role: "operator", actorId: "Peter Dang", clientId, crossTenant: true });
  const draft = await configService.createDraft({ principal: editor, clientId, blueprint: make() });
  if (!draft.ok) return null;
  const v = draft.configVersion;
  await configService.validate({ principal: editor, clientId, configVersion: v });
  await configService.approve({ principal: owner, clientId, configVersion: v });
  await configService.activate({ principal: operator, clientId, configVersion: v });
  const active = await configService.getActive({ principal: operator, clientId });
  return active.ok ? active.version : null;
}

(async () => {
  const now = clock();
  const configService = createConfigService({ store: createInMemoryBlueprintStore(), now, audit: createInMemoryConfigAudit({ now }) });
  const voiceAudit = createInMemoryVoiceAudit({ now });

  const blueprints = {};
  for (const [clientId, make] of Object.entries(FIXTURE_CLIENTS)) {
    blueprints[clientId] = await seed(configService, clientId, make);
  }

  const wanted = argv.includes("--client") ? argv[argv.indexOf("--client") + 1] : null;
  const scenarioId = argv.includes("--scenario") ? argv[argv.indexOf("--scenario") + 1] : null;
  const scenarioClient = scenarioId ? (SCENARIOS.find((s) => s.id === scenarioId) || {}).clientId : null;
  const clientId = wanted || scenarioClient;

  const platform = {
    configService,
    voiceAudit,
    now,
    // The ONLY interpreter this script can build.
    interpreter: createDeterministicInterpreter(),
    blueprint: clientId ? blueprints[clientId] || null : null,
    hasActiveVersion: Boolean(clientId && blueprints[clientId]),
  };

  // Interactive mode: `simulate` with no --say and a terminal attached.
  const interactive = argv[0] === "simulate" && !argv.includes("--say") && process.stdin.isTTY;
  if (interactive) return interactiveSession(platform, clientId, blueprints);

  const { exitCode, lines } = await runVoiceCommand({ argv, platform, scenarios: SCENARIOS });
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(exitCode);
})();

/** Type at it. Ctrl-C, "cancel" or "that's it" ends the call. */
async function interactiveSession(platform, clientId, blueprints) {
  if (!clientId || !blueprints[clientId]) {
    process.stdout.write(`Pass --client with one of: ${Object.keys(blueprints).join(", ")}\n`);
    process.exit(1);
  }

  const engine = createVoiceSessionEngine({
    configService: platform.configService,
    interpreter: platform.interpreter,
    store: createInMemoryVoiceSessionStore(),
    now: platform.now,
    audit: platform.voiceAudit,
  });

  const started = await engine.start({
    principal: voicePrincipal({ clientId, actorId: "simulator" }),
    clientId, blueprint: platform.blueprint, hasActiveVersion: true,
  });

  process.stdout.write("\nNothing here reaches a telephone, a speech provider or a language model.\n");
  process.stdout.write("A session ends at a DRAFT that a person must review.\n\n");
  process.stdout.write(`Aida > ${started.spoken}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "You  > " });
  rl.prompt();

  rl.on("line", async (text) => {
    if (!text.trim()) return rl.prompt();
    platform.now.tick(15000);
    const result = await engine.hear({ sessionId: started.sessionId, transcript: text.trim() });
    process.stdout.write(`Aida > ${result.spoken || result.message}\n`);
    if (result.state && ["draft_created", "cancelled", "refused"].includes(result.state) && result.ok !== false) {
      process.stdout.write("\napproved  false    active  false    provider changed  false    calling changed  false\n");
      rl.close();
      return undefined;
    }
    return rl.prompt();
  });

  rl.on("close", () => process.exit(0));
  return undefined;
}

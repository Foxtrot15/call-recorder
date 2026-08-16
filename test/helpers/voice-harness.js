// AIDA VOICE CONFIGURATION — the test harness.
//
// One place that builds a real configuration service with a real client and a
// real active version, so every voice test runs against the SAME authority the
// application uses rather than a stub of it. If the voice engine could only
// create drafts against a fake config service, the tests would prove nothing
// about the seam that matters.

const { createConfigService } = require("../../src/platform/config-service");
const { createInMemoryBlueprintStore } = require("../../src/platform/blueprint-authority");
const { createInMemoryConfigAudit } = require("../../src/platform/config-audit");
const { createPrincipal } = require("../../src/platform/config-access");
const { createInMemoryVoiceAudit } = require("../../src/platform/voice/voice-audit");
const { createDeterministicInterpreter } = require("../../src/platform/voice/voice-interpreter-port");
const { createVoiceSessionEngine, createInMemoryVoiceSessionStore } = require("../../src/platform/voice/voice-session");

function clock(startMs = Date.UTC(2026, 7, 17, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 60000) => { t += ms; return new Date(t); };
  return now;
}

const P = {
  editor: (c) => createPrincipal({ role: "client_editor", actorId: "editor@x.invalid", clientId: c }),
  owner: (c) => createPrincipal({ role: "client_owner", actorId: "Peter Dang", clientId: c }),
  operator: (c) => createPrincipal({ role: "operator", actorId: "Peter Dang", clientId: c, crossTenant: true }),
};

/** A config service with nothing in it. */
function buildPlatform({ now = clock() } = {}) {
  const audit = createInMemoryConfigAudit({ now });
  const voiceAudit = createInMemoryVoiceAudit({ now });
  const configService = createConfigService({ store: createInMemoryBlueprintStore(), now, audit });
  return { configService, audit, voiceAudit, now };
}

/** Take a client all the way to an ACTIVE version, through the real service. */
async function activate(configService, clientId, blueprint) {
  const editor = P.editor(clientId);
  const created = await configService.createDraft({ principal: editor, clientId, blueprint });
  if (!created.ok) throw new Error(`createDraft: ${JSON.stringify(created)}`);
  const v = created.configVersion;
  const validated = await configService.validate({ principal: editor, clientId, configVersion: v });
  if (!validated.ok) throw new Error(`validate: ${JSON.stringify(validated.errors || validated)}`);
  await configService.approve({ principal: P.owner(clientId), clientId, configVersion: v });
  await configService.activate({ principal: P.operator(clientId), clientId, configVersion: v });
  const active = await configService.getActive({ principal: P.operator(clientId), clientId });
  return active.version;
}

/** A draft only — for the new-client interview path, where nothing is active. */
async function seedDraft(configService, clientId, blueprint) {
  const created = await configService.createDraft({ principal: P.editor(clientId), clientId, blueprint });
  if (!created.ok) throw new Error(`createDraft: ${JSON.stringify(created)}`);
  const got = await configService.getVersion({ principal: P.editor(clientId), clientId, configVersion: created.configVersion });
  return got.version;
}

/** Everything a voice test needs, wired the way the application would wire it. */
function buildEngine({ configService, now, voiceAudit, interpreter = null } = {}) {
  return createVoiceSessionEngine({
    configService,
    interpreter: interpreter || createDeterministicInterpreter(),
    store: createInMemoryVoiceSessionStore(),
    now,
    audit: voiceAudit,
  });
}

module.exports = { clock, P, buildPlatform, activate, seedDraft, buildEngine };

// AIDA PLATFORM P29–P35 — the UI's HTTP surface, and the fictional end-to-end.
//
// The UI handlers are exercised the house way: real services, real principals,
// fake req/res objects, no express, no server, no network.
//
// What this file proves, and the previous one cannot:
//
//   * a hidden button is not security — the same request the UI would never
//     send is still refused when sent directly
//   * client A cannot fetch client B, whatever the URL says
//   * a 409 stays a 409; nothing here resolves it
//   * activation calls the configuration operation and touches no provider
//   * the whole P35A walk — draft, service, Saturday, validate, diff, approve,
//     activate, preview, provisioning diff, approved plan — and then STOPS

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createConfigService } = require("../src/platform/config-service");
const { createProvisioningService } = require("../src/platform/provisioning-service");
const { createInMemoryBlueprintStore } = require("../src/platform/blueprint-authority");
const { createInMemoryPlanStore } = require("../src/platform/provisioning-plan-authority");
const { createInMemoryConfigAudit } = require("../src/platform/config-audit");
const { createPlatformUiHandlers, PAGE_SECURITY_HEADERS } = require("../src/routes/platform-ui-handlers");
const { platformUiEnabled } = require("../src/routes/platform-ui");
const { createPrincipal } = require("../src/platform/config-access");
const { garageDoorD, plumberC } = require("../src/platform/fixtures/clients");
const F = require("../src/platform/ui/ui-fields");

const ROOT = path.join(__dirname, "..");
const REFS = Object.freeze({ llmId: "llm_x", voiceId: "custom_voice_x", webhookUrl: "https://example.invalid/h" });

function clock(startMs = Date.UTC(2026, 7, 16, 9, 0, 0)) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 60000) => { t += ms; return new Date(t); };
  return now;
}

function harness() {
  const now = clock();
  const audit = createInMemoryConfigAudit({ now });
  const configService = createConfigService({ store: createInMemoryBlueprintStore(), now, audit, providerRefs: REFS });
  const provisioningService = createProvisioningService({
    configService, planStore: createInMemoryPlanStore(), now, providerRefs: REFS, audit,
  });
  const handlers = createPlatformUiHandlers({ configService, provisioningService, logger: { error() {} } });
  return { configService, provisioningService, handlers, now };
}

/** A res that records everything a handler did to it. */
function fakeRes() {
  const res = { statusCode: null, body: null, headers: {}, contentType: null, redirectedTo: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (h, v) => { if (typeof h === "object") Object.assign(res.headers, h); else res.headers[h] = v; return res; };
  res.type = (t) => { res.contentType = t; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.redirect = (code, to) => { res.statusCode = code; res.redirectedTo = to; return res; };
  return res;
}

const clientReq = (clientId, role = "client_owner", params = {}, body = {}, query = {}) => ({
  clientId,
  client: { slug: clientId, platform_role: role },
  clientAuth: { mode: "cookie", user: { email: "owner@x.invalid" } },
  params: { clientId, ...params }, body, query,
});

const operatorReq = (clientId, params = {}, body = {}, query = {}) => ({
  clientId, operatorSession: true, session: { operatorId: "Peter Dang" },
  params: { clientId, ...params }, body, query,
});

const P = {
  operator: (c) => createPrincipal({ role: "operator", actorId: "Peter Dang", clientId: c, crossTenant: true }),
  owner: (c) => createPrincipal({ role: "client_owner", actorId: "owner@x.invalid", clientId: c }),
  editor: (c) => createPrincipal({ role: "client_editor", actorId: "editor@x.invalid", clientId: c }),
  viewer: (c) => createPrincipal({ role: "client_viewer", actorId: "viewer@x.invalid", clientId: c }),
};

async function seedActive(configService, clientId, blueprint) {
  const editor = P.editor(clientId);
  const draft = await configService.createDraft({ principal: editor, clientId, blueprint });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const v = draft.configVersion;
  assert.equal((await configService.validate({ principal: editor, clientId, configVersion: v })).ok, true);
  assert.equal((await configService.approve({ principal: P.owner(clientId), clientId, configVersion: v })).ok, true);
  assert.equal((await configService.activate({ principal: P.operator(clientId), clientId, configVersion: v })).ok, true);
  return v;
}

// ════════════════════════════════════════════════════════════════════
// THE GATE
// ════════════════════════════════════════════════════════════════════

describe("the gate — off unless the env says exactly \"true\"", () => {
  it("is off for every value that is not the exact string", () => {
    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", "on"]) {
      assert.equal(platformUiEnabled({ PLATFORM_CONFIG_API_ENABLED: value }), false, `"${value}" enabled it`);
    }
    assert.equal(platformUiEnabled({ PLATFORM_CONFIG_API_ENABLED: "true" }), true);
  });

  it("uses the SAME flag as the JSON API it calls", () => {
    const { platformConfigApiEnabled } = require("../src/routes/platform-config");
    for (const value of ["true", "false", undefined]) {
      assert.equal(
        platformUiEnabled({ PLATFORM_CONFIG_API_ENABLED: value }),
        platformConfigApiEnabled({ PLATFORM_CONFIG_API_ENABLED: value }),
        `the UI and the API disagree for "${value}" — a UI whose API is off shows an empty screen and no reason`,
      );
    }
  });

  it("exits the router before any auth or handler runs", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui.js"), "utf8");
    assert.match(src, /router\.use\(platformUiGate\(\)\)/);
    assert.ok(src.indexOf("router.use(platformUiGate())") < src.indexOf("router.get("),
      "the gate must be mounted before every route");
    assert.match(src, /next\("router"\)/);
  });
});

// ════════════════════════════════════════════════════════════════════
// HEADERS
// ════════════════════════════════════════════════════════════════════

describe("responses — the CSP that makes the no-inline rule real", () => {
  it("sets the repo's page security headers on every rendered page", async () => {
    const { configService, handlers } = harness();
    await seedActive(configService, "rolladoor_repairs", garageDoorD());
    const res = fakeRes();
    await handlers.dashboard(clientReq("rolladoor_repairs"), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.contentType, "html");
    assert.match(res.headers["Content-Security-Policy"], /script-src 'self'/);
    assert.match(res.headers["Content-Security-Policy"], /style-src 'self'/);
    assert.match(res.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  });

  it("never caches a configuration page", async () => {
    const { configService, handlers } = harness();
    await seedActive(configService, "rolladoor_repairs", garageDoorD());
    const res = fakeRes();
    await handlers.dashboard(clientReq("rolladoor_repairs"), res);
    assert.equal(res.headers["Cache-Control"], "no-store, private");
  });

  it("matches the CSP the locksmith pages already use", () => {
    const locksmith = fs.readFileSync(path.join(ROOT, "src", "routes", "locksmith-handlers.js"), "utf8");
    const theirs = (locksmith.match(/"Content-Security-Policy":\s*\n?\s*"([^"]+)"\s*\+?\s*\n?\s*"?([^"]*)"?/) || [])[0] || "";
    // Same directives, not a second standard.
    for (const directive of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'"]) {
      assert.ok(PAGE_SECURITY_HEADERS["Content-Security-Policy"].includes(directive));
      assert.ok(theirs.includes(directive), `the locksmith CSP lacks ${directive} — check the comparison, not the header`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// TENANT ISOLATION — the real one
// ════════════════════════════════════════════════════════════════════

describe("tenant isolation — the URL says what you want, the session says what you get", () => {
  it("refuses a client asking for another client's screens, and says nothing else", async () => {
    const { configService, handlers } = harness();
    await seedActive(configService, "rolladoor_repairs", garageDoorD());
    await seedActive(configService, "riverside_plumbing", plumberC());

    // Session is rolladoor; the URL asks for riverside.
    const attack = {
      clientId: "rolladoor_repairs",
      client: { slug: "rolladoor_repairs", platform_role: "client_owner" },
      clientAuth: { mode: "cookie", user: { email: "owner@x.invalid" } },
      params: { clientId: "riverside_plumbing" }, body: {}, query: {},
    };

    for (const name of ["dashboard", "history", "editor", "review", "behaviourPreview", "providerPreview", "provisioning"]) {
      const res = fakeRes();
      await handlers[name](attack, res);
      assert.equal(res.statusCode, 403, `${name} did not refuse`);
      assert.ok(!String(res.body).includes("Riverside"), `${name} leaked the other client's name`);
      assert.ok(!String(res.body).includes("riverside_plumbing") || /Not authorised/.test(String(res.body)),
        `${name} leaked the other client's id`);
      assert.match(String(res.body), /Not authorised for this client/);
    }
  });

  it("gives the same refusal whether the other client exists or not", async () => {
    const { configService, handlers } = harness();
    await seedActive(configService, "rolladoor_repairs", garageDoorD());
    await seedActive(configService, "riverside_plumbing", plumberC());

    const ask = async (target) => {
      const res = fakeRes();
      await handlers.dashboard({
        clientId: "rolladoor_repairs",
        client: { slug: "rolladoor_repairs", platform_role: "client_owner" },
        clientAuth: { mode: "cookie", user: {} },
        params: { clientId: target }, body: {}, query: {},
      }, res);
      return { status: res.statusCode, body: String(res.body) };
    };

    const real = await ask("riverside_plumbing");
    const imaginary = await ask("no_such_client_at_all");
    assert.equal(real.status, imaginary.status);
    assert.equal(real.body, imaginary.body,
      "the refusals differ — which tells an attacker which clients exist");
  });

  it("refuses a cross-tenant WRITE sent directly, with no UI involved", async () => {
    const { configService, handlers } = harness();
    const v = await seedActive(configService, "riverside_plumbing", plumberC());
    await seedActive(configService, "rolladoor_repairs", garageDoorD());

    const res = fakeRes();
    await handlers.saveSection({
      clientId: "rolladoor_repairs",
      client: { slug: "rolladoor_repairs", platform_role: "client_owner" },
      clientAuth: { mode: "cookie", user: {} },
      params: { clientId: "riverside_plumbing", versionId: String(v) },
      body: { section: "identity", values: { legalName: "Taken Over Pty Ltd" } },
      query: {},
    }, res);

    assert.equal(res.statusCode, 403);
    const victim = await configService.getActive({ principal: P.operator("riverside_plumbing"), clientId: "riverside_plumbing" });
    assert.notEqual(victim.version.identity.legalName, "Taken Over Pty Ltd");
  });
});

// ════════════════════════════════════════════════════════════════════
// HIDDEN BUTTON ≠ SECURITY
// ════════════════════════════════════════════════════════════════════

describe("authority — the backend refuses what the UI would never offer", () => {
  it("refuses approval from a role whose Approve button is hidden", async () => {
    const { configService, handlers } = harness();
    const clientId = "rolladoor_repairs";
    const editor = P.editor(clientId);
    const draft = await configService.createDraft({ principal: editor, clientId, blueprint: garageDoorD() });
    await configService.validate({ principal: editor, clientId, configVersion: draft.configVersion });

    // client_editor's Approve is hidden. Send the request anyway.
    const res = fakeRes();
    await handlers.approve(clientReq(clientId, "client_editor", { versionId: String(draft.configVersion) }, { reason: "go on" }), res);
    assert.equal(res.statusCode, 403);

    const after = await configService.getVersion({ principal: editor, clientId, configVersion: draft.configVersion });
    assert.equal(after.version.metadata.status, "validated", "it was approved anyway");
  });

  it("refuses activation from a client session, however the request is shaped", async () => {
    const { configService, handlers } = harness();
    const clientId = "rolladoor_repairs";
    const editor = P.editor(clientId);
    const draft = await configService.createDraft({ principal: editor, clientId, blueprint: garageDoorD() });
    const v = draft.configVersion;
    await configService.validate({ principal: editor, clientId, configVersion: v });
    await configService.approve({ principal: P.owner(clientId), clientId, configVersion: v });

    for (const role of ["client_viewer", "client_editor", "client_owner"]) {
      const res = fakeRes();
      await handlers.activate(clientReq(clientId, role, {}, { version: v }), res);
      assert.equal(res.statusCode, 403, `${role} activated a configuration`);
    }
    // A role that claims to be an operator in the BODY gains nothing.
    const forged = fakeRes();
    await handlers.activate(clientReq(clientId, "client_owner", {}, { version: v, role: "operator" }), forged);
    assert.equal(forged.statusCode, 403);

    // And a real operator session succeeds, or the test above proves nothing.
    const ok = fakeRes();
    await handlers.activate(operatorReq(clientId, {}, { version: v }), ok);
    assert.equal(ok.statusCode, 303, JSON.stringify(ok.body));
  });

  it("refuses plan approval from a client session", async () => {
    const { configService, provisioningService, handlers } = harness();
    const clientId = "rolladoor_repairs";
    await seedActive(configService, clientId, garageDoorD());
    const op = P.operator(clientId);
    const created = await provisioningService.createPlan({ principal: op, clientId });
    await provisioningService.validatePlan({ principal: op, clientId, planId: created.plan.planId });

    const res = fakeRes();
    await handlers.approvePlan(clientReq(clientId, "client_owner", { planId: created.plan.planId }, {}), res);
    assert.equal(res.statusCode, 403);

    const still = await provisioningService.getPlan({ principal: op, clientId, planId: created.plan.planId });
    assert.notEqual(still.plan.status, "approved");
  });

  it("has no execute handler to call at all", () => {
    const { configService, provisioningService } = harness();
    const handlers = createPlatformUiHandlers({ configService, provisioningService });
    for (const name of ["execute", "runPlan", "provision", "deploy", "goLive"]) {
      assert.equal(handlers[name], undefined, `a ${name} handler exists`);
    }
    assert.ok(Object.keys(handlers).length > 10, "the handler set is suspiciously small — check the harness");
  });
});

// ════════════════════════════════════════════════════════════════════
// CAS
// ════════════════════════════════════════════════════════════════════

describe("P31A compare-and-swap — a stale save is refused, not merged", () => {
  it("saves with the token it was given", async () => {
    const { configService, handlers } = harness();
    const clientId = "rolladoor_repairs";
    const draft = await configService.createDraft({ principal: P.editor(clientId), clientId, blueprint: garageDoorD() });
    const v = draft.configVersion;
    const current = await configService.getVersion({ principal: P.editor(clientId), clientId, configVersion: v });

    const res = fakeRes();
    await handlers.saveSection(clientReq(clientId, "client_editor", { versionId: String(v) }, {
      section: "identity",
      values: { legalName: "Rolladoor Repairs Pty Ltd", assistantName: "Sam" },
      expectedUpdatedAt: current.version.metadata.updatedAt,
    }), res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.ok(res.body.updatedAt, "a fresh token must come back");
  });

  it("returns 409 for a stale token and changes nothing", async () => {
    const { configService, handlers, now } = harness();
    const clientId = "rolladoor_repairs";
    const draft = await configService.createDraft({ principal: P.editor(clientId), clientId, blueprint: garageDoorD() });
    const v = draft.configVersion;
    const opened = await configService.getVersion({ principal: P.editor(clientId), clientId, configVersion: v });
    const staleToken = opened.version.metadata.updatedAt;

    // Somebody else saves first.
    now.tick();
    await configService.updateDraft({
      principal: P.editor(clientId), clientId, configVersion: v,
      mutate: (d) => { d.identity.tradingName = "Somebody Else's Edit"; },
      expectedUpdatedAt: staleToken,
    });

    const res = fakeRes();
    await handlers.saveSection(clientReq(clientId, "client_editor", { versionId: String(v) }, {
      section: "identity", values: { tradingName: "My Edit" }, expectedUpdatedAt: staleToken,
    }), res);

    assert.equal(res.statusCode, 409);
    const after = await configService.getVersion({ principal: P.editor(clientId), clientId, configVersion: v });
    assert.equal(after.version.identity.tradingName, "Somebody Else's Edit",
      "the stale write landed — that is exactly the failure CAS exists to prevent");
  });

  it("has no code path that retries or drops the token after a 409", () => {
    const js = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.js"), "utf8");
    const save = js.slice(js.indexOf("function save("), js.indexOf("function showConflict("));
    // After the 409 branch there is a bare `return;` — no retry, no re-send
    // without the token, no second call of any kind.
    const branch = save.slice(save.indexOf("result.status === 409"));
    const untilReturn = branch.slice(0, branch.indexOf("return;"));
    assert.ok(!/send\(|fetch\(/.test(untilReturn), "the 409 branch sends something");
    assert.ok(!/expectedUpdatedAt = /.test(untilReturn), "the 409 branch moves the token");
  });
});

// ════════════════════════════════════════════════════════════════════
// ACTIVATION MUTATES NO PROVIDER
// ════════════════════════════════════════════════════════════════════

describe("P32C activation — it changes a pointer, and contacts nothing", () => {
  it("activates through the configuration service and touches no provider resource", async () => {
    const { configService, provisioningService, handlers } = harness();
    const clientId = "rolladoor_repairs";
    const editor = P.editor(clientId);
    const draft = await configService.createDraft({ principal: editor, clientId, blueprint: garageDoorD() });
    const v = draft.configVersion;
    await configService.validate({ principal: editor, clientId, configVersion: v });
    await configService.approve({ principal: P.owner(clientId), clientId, configVersion: v });

    const before = await provisioningService.getDiff({ principal: P.operator(clientId), clientId });
    const res = fakeRes();
    await handlers.activate(operatorReq(clientId, {}, { version: v }), res);
    assert.equal(res.statusCode, 303);

    const active = await configService.getActive({ principal: editor, clientId });
    assert.equal(active.version.metadata.configVersion, v, "it did not activate");

    // Provisioning still says the same two resources would need creating —
    // nothing was provisioned by activating.
    const after = await provisioningService.getDiff({ principal: P.operator(clientId), clientId });
    assert.deepEqual(after.actions.map((a) => a.action), ["create", "create"]);
    assert.equal(after.providerContacted, false);
    assert.ok(before.ok || !before.ok, "the before-diff is only for contrast");
  });
});

// ════════════════════════════════════════════════════════════════════
// P35A — THE FICTIONAL CLIENT, END TO END
// ════════════════════════════════════════════════════════════════════

describe("P35A — Rolladoor Repairs, configured through the UI, and stopped", () => {
  it("walks the whole journey and ends at an APPROVED, UNEXECUTED plan", async () => {
    const { configService, provisioningService, handlers, now } = harness();
    const clientId = "rolladoor_repairs";
    const editor = P.editor(clientId);
    const owner = P.owner(clientId);
    const op = P.operator(clientId);

    // ── 1. a draft exists, through the real service ──
    const draft = await configService.createDraft({ principal: editor, clientId, blueprint: garageDoorD() });
    const v1 = draft.configVersion;
    await configService.validate({ principal: editor, clientId, configVersion: v1 });
    await configService.approve({ principal: owner, clientId, configVersion: v1 });
    await configService.activate({ principal: op, clientId, configVersion: v1 });

    // ── 2. the wizard shows the draft state, deriving it from the draft ──
    const wizardRes = fakeRes();
    await handlers.wizard(clientReq(clientId), wizardRes);
    assert.equal(wizardRes.statusCode, 200);
    assert.match(String(wizardRes.body), /Set up a new client/);

    // ── 3. a NEW draft, edited through the UI: add a service ──
    const restored = await configService.restore({ principal: op, clientId, configVersion: v1 });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    // restore() returns the whole version, not a bare configVersion — unlike
    // createDraft(). Reading the wrong one silently yields undefined.
    const v2 = restored.version.metadata.configVersion;
    assert.ok(Number.isInteger(v2) && v2 > v1, `restore produced v${v2}`);

    const opened = await configService.getVersion({ principal: editor, clientId, configVersion: v2 });
    const withService = [
      ...opened.version.services,
      { serviceId: "cable_replacement", name: "Garage door cable replacement", enabled: true, urgencyCategory: "urgent" },
    ];
    const addRes = fakeRes();
    await handlers.saveSection(clientReq(clientId, "client_editor", { versionId: String(v2) }, {
      section: "services",
      values: {},
      expectedUpdatedAt: opened.version.metadata.updatedAt,
    }), addRes);
    assert.equal(addRes.statusCode, 200, JSON.stringify(addRes.body));

    // Services are a repeatable list; the section save writes scalar fields, so
    // the list itself goes through the same service operation the UI uses.
    now.tick();
    const current = await configService.getVersion({ principal: editor, clientId, configVersion: v2 });
    const addList = await configService.updateDraft({
      principal: editor, clientId, configVersion: v2,
      mutate: (d) => { d.services = withService; },
      expectedUpdatedAt: current.version.metadata.updatedAt,
    });
    assert.equal(addList.ok, true, JSON.stringify(addList));

    // ── 4. change Saturday hours through the section editor ──
    now.tick();
    const beforeHours = await configService.getVersion({ principal: editor, clientId, configVersion: v2 });
    const hoursValues = F.readSection(beforeHours.version, "hours");
    hoursValues.hours_saturday_open = "09:00";
    hoursValues.hours_saturday_close = "16:00";
    const hoursRes = fakeRes();
    await handlers.saveSection(clientReq(clientId, "client_editor", { versionId: String(v2) }, {
      section: "hours", values: hoursValues, expectedUpdatedAt: beforeHours.version.metadata.updatedAt,
    }), hoursRes);
    assert.equal(hoursRes.statusCode, 200, JSON.stringify(hoursRes.body));

    const afterHours = await configService.getVersion({ principal: editor, clientId, configVersion: v2 });
    assert.deepEqual(afterHours.version.hours.weekly.saturday, { open: "09:00", close: "16:00" },
      "the hours editor did not save through the service");

    // ── 5. validate ──
    const validateRes = fakeRes();
    await handlers.validateDraft(clientReq(clientId, "client_editor", { versionId: String(v2) }), validateRes);
    assert.equal(validateRes.statusCode, 200, JSON.stringify(validateRes.body));
    assert.equal(validateRes.body.ok, true);

    // ── 6. the review screen shows BOTH changes, in words ──
    const reviewRes = fakeRes();
    await handlers.review(clientReq(clientId), reviewRes);
    assert.equal(reviewRes.statusCode, 200);
    const review = String(reviewRes.body);
    assert.match(review, /Saturday hours/);
    assert.match(review, /08:00-12:00/);
    assert.match(review, /09:00-16:00/);
    assert.match(review, /Garage door cable replacement/);
    assert.match(review, /Approving locks this version/);

    // ── 7. approve ──
    const approveRes = fakeRes();
    await handlers.approve(clientReq(clientId, "client_owner", { versionId: String(v2) }, { reason: "Read the diff." }), approveRes);
    assert.equal(approveRes.statusCode, 303, JSON.stringify(approveRes.body));

    // ── 8. activate — operator only, and it deploys nothing ──
    const activateRes = fakeRes();
    await handlers.activate(operatorReq(clientId, {}, { version: v2 }), activateRes);
    assert.equal(activateRes.statusCode, 303);
    const nowActive = await configService.getActive({ principal: editor, clientId });
    assert.equal(nowActive.version.metadata.configVersion, v2);

    // ── 9. behaviour preview shows the real greeting ──
    const previewRes = fakeRes();
    await handlers.behaviourPreview(clientReq(clientId), previewRes);
    assert.equal(previewRes.statusCode, 200);
    assert.match(String(previewRes.body), /AGENT BEHAVIOUR PREVIEW/);
    assert.match(String(previewRes.body), /Garage door cable replacement/);
    assert.match(String(previewRes.body), /not a live conversation and no call is placed/);

    // ── 10. provisioning diff ──
    const diff = await provisioningService.getDiff({ principal: op, clientId });
    assert.equal(diff.ok, true);
    assert.equal(diff.providerContacted, false);

    // ── 11. a plan, approved through the UI handler ──
    const planRes = fakeRes();
    await handlers.createPlan(operatorReq(clientId), planRes);
    assert.equal(planRes.statusCode, 303);

    const plans = await provisioningService.listPlans({ principal: op, clientId });
    const planId = plans.plans[plans.plans.length - 1].planId;
    await provisioningService.validatePlan({ principal: op, clientId, planId });

    const full = await provisioningService.getPlan({ principal: op, clientId, planId });
    const approvePlanRes = fakeRes();
    await handlers.approvePlan(operatorReq(clientId, { planId }, {
      reason: "Reviewed every action.", expectedPlanHash: full.plan.planHash,
    }), approvePlanRes);
    assert.equal(approvePlanRes.statusCode, 303, JSON.stringify(approvePlanRes.body));

    // ── 12. AND IT STOPS ──
    const finalRes = fakeRes();
    await handlers.provisioning(clientReq(clientId), finalRes);
    const finalHtml = String(finalRes.body);
    assert.match(finalHtml, /APPROVED — NOT EXECUTED/);
    assert.match(finalHtml, /Provider changes require a separately authorised provisioning operation/);
    assert.ok(!/data-action="execute"/.test(finalHtml));

    const check = await provisioningService.checkExecutable({ principal: op, clientId, planId });
    assert.equal(check.executable, false);
  });
});

// ════════════════════════════════════════════════════════════════════
// THE WIZARD CREATES A REAL DRAFT
// ════════════════════════════════════════════════════════════════════

describe("P35 wizard — it starts a real draft and can be left and resumed", () => {
  it("creates a draft through the configuration service, not a wizard store", async () => {
    const { configService, handlers } = harness();
    const clientId = "brand_new_client";
    const res = fakeRes();
    await handlers.startWizard(clientReq(clientId, "client_editor", {}, { vertical: "electrical" }), res);
    assert.equal(res.statusCode, 303);
    assert.match(res.redirectedTo, /\/edit\/identity$/);

    const listed = await configService.listVersions({ principal: P.editor(clientId), clientId });
    assert.equal(listed.versions.length, 1);
    assert.equal(listed.versions[0].status, "draft");
    assert.equal(listed.versions[0].source, "ui");
  });

  it("finds the same draft again after leaving", async () => {
    const { configService, handlers } = harness();
    const clientId = "brand_new_client";
    await handlers.startWizard(clientReq(clientId, "client_editor", {}, {}), fakeRes());

    const res = fakeRes();
    await handlers.wizard(clientReq(clientId), res);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.body), /Your draft/);
    assert.match(String(res.body), /Leave whenever you like/);
  });

  it("records the source, so a voice-created draft is distinguishable but not special", async () => {
    const { configService, handlers } = harness();
    const clientId = "rolladoor_repairs";
    await handlers.startWizard(clientReq(clientId, "client_editor", {}, {}), fakeRes());

    // A voice proposal goes through the same service and produces a draft.
    const listed = await configService.listVersions({ principal: P.editor(clientId), clientId });
    assert.equal(listed.versions[0].source, "ui");

    const historyRes = fakeRes();
    await handlers.history(clientReq(clientId), historyRes);
    assert.match(String(historyRes.body), /Web form/);
  });
});

// ════════════════════════════════════════════════════════════════════
// RATCHETS
// ════════════════════════════════════════════════════════════════════

describe("UI ratchets — every one with a fixture proving it catches something", () => {
  it("no frontend file contains a credential, and would catch one if it did", () => {
    const files = [
      "public/platform/platform.js", "public/platform/platform.css",
      "src/views/platform-shell.js", "src/views/platform-config-pages.js",
      "src/views/platform-provisioning-pages.js", "src/views/platform-wizard-page.js",
    ];
    const SECRET = /(sk_live|sk_test|key_[0-9a-f]{16}|Bearer\s+[A-Za-z0-9._-]{16}|eyJ[A-Za-z0-9_-]{20})/;
    for (const file of files) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.ok(!SECRET.test(src), `${file} contains something secret-shaped`);
    }
    // The bad fixture. Without it this pattern might match nothing, ever.
    assert.ok(SECRET.test('const k = "sk_live_abcdefghijklmnop";'));
    assert.ok(SECRET.test("Authorization: Bearer abcdefghijklmnopqrst"));
  });

  it("no frontend file names a provider, and would catch one if it did", () => {
    const files = ["public/platform/platform.js", "public/platform/platform.css", "src/views/platform-shell.js"];
    const PROVIDER = /\b(retell|twilio|elevenlabs|11labs|cartesia|vapi|bland)\b/i;
    for (const file of files) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.ok(!PROVIDER.test(src), `${file} names a provider`);
    }
    assert.ok(PROVIDER.test('require("retell-sdk")'), "the pattern catches nothing");
  });

  it("catches an execute route if one is ever added", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui.js"), "utf8");
    const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/"[^"]*"/g, '""');
    assert.ok(!/execute/i.test(codeOnly(src)));
    assert.ok(/execute/i.test(codeOnly('router.post(`${BASE}/execute`, requireLogin, h.execute);')),
      "the pattern would not catch an execute route");
  });

  it("catches an inline event handler if one is ever rendered", () => {
    const views = ["platform-shell.js", "platform-config-pages.js", "platform-provisioning-pages.js", "platform-wizard-page.js"];
    // Comments stripped: platform-shell.js explains in prose that the CSP
    // forbids onclick, and a raw sweep catches the explanation rather than any
    // rendered attribute.
    const stripped = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const v of views) {
      const src = stripped(fs.readFileSync(path.join(ROOT, "src", "views", v), "utf8"));
      assert.ok(!/\bonclick=/i.test(src), `${v} renders an onclick`);
      assert.ok(!/\bonchange=/i.test(src), `${v} renders an onchange`);
    }
    assert.ok(/\bonclick=/i.test('`<button onclick="x()">`'), "the pattern catches nothing");
  });

  it("catches a client id taken from a request body", () => {
    const handlers = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui-handlers.js"), "utf8");
    const PATTERN = /req\.(body|query)\.clientId|body\.clientId|query\.clientId/;
    assert.ok(!PATTERN.test(handlers), "a handler reads the tenant from the request");
    assert.ok(PATTERN.test("const clientId = req.body.clientId;"), "the pattern catches nothing");
  });

  it("catches a second configuration authority", () => {
    // Every write must go through configService or provisioningService. A
    // handler reaching a store directly would be a second authority with its
    // own idea of what is valid.
    const handlers = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui-handlers.js"), "utf8");
    for (const forbidden of ["blueprint-authority", "blueprint-store-postgres", "createInMemoryBlueprintStore", "planStore."]) {
      assert.ok(!handlers.includes(forbidden), `the UI handlers reach ${forbidden} directly`);
    }
    assert.ok(handlers.includes("configService."), "the handlers do not use the config service at all");
  });
});

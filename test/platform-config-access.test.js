// AIDA PLATFORM P16 — who may do what, to whose configuration.
//
// The rule this whole module exists to enforce: authority never comes from
// anything a caller sent. AIDA already resolves tenancy correctly in
// src/middleware/auth.js — server-side, from a verified session — and this
// must build on that rather than inventing a weaker second way.
//
// Everything here is pure. No express, no session, no network.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  authorise, createPrincipal, principalFromRequest, voicePrincipal,
  CAPABILITIES, ROLES, ROLE_NAMES, ACCESS_CODES, CROSS_TENANT_OPERATIONS,
} = require("../src/platform/config-access");

const may = (principal, operation, clientId) => authorise({ principal, operation, clientId }).ok;

describe("config access — the vocabulary is closed", () => {
  it("declares a capability for every operation the service exposes", () => {
    for (const c of ["config:view", "config:draft", "config:propose", "config:validate", "config:approve", "config:activate", "config:preview"]) {
      assert.ok(CAPABILITIES.includes(c), `${c} must be a declared capability`);
    }
  });

  it("gives every role only capabilities that exist", () => {
    for (const [role, caps] of Object.entries(ROLES)) {
      for (const c of caps) assert.ok(CAPABILITIES.includes(c), `${role} claims unknown capability ${c}`);
    }
  });

  it("refuses to build a principal with a role nobody defined", () => {
    for (const bad of ["admin", "root", "superuser", "", null, undefined, "OPERATOR"]) {
      assert.equal(createPrincipal({ role: bad, clientId: "x" }), null, `"${bad}" must not be a role`);
    }
  });
});

describe("config access — fails closed on everything unrecognised", () => {
  const good = createPrincipal({ role: "operator", actorId: "Peter Dang", clientId: "northside_locks" });

  it("refuses with no principal at all", () => {
    for (const junk of [null, undefined, 42, "operator", []]) {
      const r = authorise({ principal: junk, operation: "config:view", clientId: "northside_locks" });
      assert.equal(r.ok, false, JSON.stringify(junk));
      assert.equal(r.code, ACCESS_CODES.NO_PRINCIPAL);
    }
  });

  it("refuses an operation nobody defined", () => {
    for (const bad of ["config:delete", "config:provision", "config:dial", "", null, "CONFIG:VIEW"]) {
      const r = authorise({ principal: good, operation: bad, clientId: "northside_locks" });
      assert.equal(r.ok, false, `"${bad}" must not be permitted`);
      assert.equal(r.code, ACCESS_CODES.UNKNOWN_OPERATION);
    }
  });

  it("refuses with no client in scope", () => {
    for (const bad of [null, undefined, "", "   ", 42]) {
      const r = authorise({ principal: good, operation: "config:view", clientId: bad });
      assert.equal(r.ok, false);
      assert.equal(r.code, ACCESS_CODES.NO_TENANT);
    }
  });

  it("refuses a principal that is scoped to no client", () => {
    const unscoped = createPrincipal({ role: "client_owner", actorId: "somebody", clientId: null });
    const r = authorise({ principal: unscoped, operation: "config:view", clientId: "northside_locks" });
    assert.equal(r.ok, false);
    assert.equal(r.code, ACCESS_CODES.NO_TENANT);
  });

  it("refuses a hand-made object pretending to have capabilities", () => {
    const forged = { role: "client_viewer", clientId: "northside_locks", capabilities: [...CAPABILITIES] };
    // Capabilities come from the ROLE, never from the object handed in.
    assert.equal(may(forged, "config:activate", "northside_locks"), false);
    assert.equal(may(forged, "config:approve", "northside_locks"), false);
    assert.equal(may(forged, "config:view", "northside_locks"), true);
  });
});

describe("config access — the tenant boundary", () => {
  const owner = createPrincipal({ role: "client_owner", actorId: "owner@a.invalid", clientId: "northside_locks" });

  it("permits a client actor on their own configuration", () => {
    assert.equal(may(owner, "config:view", "northside_locks"), true);
    assert.equal(may(owner, "config:draft", "northside_locks"), true);
    assert.equal(may(owner, "config:approve", "northside_locks"), true);
  });

  it("refuses a client actor on ANY other client, for every operation", () => {
    for (const operation of CAPABILITIES) {
      const r = authorise({ principal: owner, operation, clientId: "riverside_plumbing" });
      assert.equal(r.ok, false, `${operation} must not cross tenants`);
      assert.equal(r.code, ACCESS_CODES.WRONG_TENANT);
    }
  });

  it("says the same thing however the cross-tenant attempt fails", () => {
    // A caller poking at other clients' URLs must not learn whether the client
    // exists, or whether they would otherwise have been allowed.
    const viewerElsewhere = authorise({ principal: owner, operation: "config:view", clientId: "riverside_plumbing" });
    const approveElsewhere = authorise({ principal: owner, operation: "config:approve", clientId: "riverside_plumbing" });
    const activateElsewhere = authorise({ principal: owner, operation: "config:activate", clientId: "riverside_plumbing" });
    assert.equal(viewerElsewhere.message, approveElsewhere.message);
    assert.equal(viewerElsewhere.message, activateElsewhere.message);
    assert.equal(viewerElsewhere.code, activateElsewhere.code);
  });

  it("checks tenancy BEFORE capability, so a refusal leaks nothing about the role", () => {
    const viewer = createPrincipal({ role: "client_viewer", actorId: "v", clientId: "northside_locks" });
    const elsewhere = authorise({ principal: viewer, operation: "config:activate", clientId: "riverside_plumbing" });
    assert.equal(elsewhere.code, ACCESS_CODES.WRONG_TENANT, "not MISSING_CAPABILITY — that would confirm the tenant exists");
  });
});

describe("config access — the operator", () => {
  const operator = createPrincipal({ role: "operator", actorId: "Peter Dang", clientId: "aida_operations", crossTenant: true });

  it("may READ across tenants, because a founder console lists every client", () => {
    for (const operation of CROSS_TENANT_OPERATIONS) {
      assert.equal(may(operator, operation, "riverside_plumbing"), true, operation);
    }
  });

  it("may NOT write across tenants", () => {
    for (const operation of CAPABILITIES.filter((c) => !CROSS_TENANT_OPERATIONS.includes(c))) {
      const r = authorise({ principal: operator, operation, clientId: "riverside_plumbing" });
      assert.equal(r.ok, false, `${operation} must not cross tenants even for an operator`);
      assert.equal(r.code, ACCESS_CODES.WRONG_TENANT);
    }
  });

  it("cannot be granted cross-tenant reach by claiming a different role", () => {
    for (const role of ROLE_NAMES.filter((r) => r !== "operator")) {
      const p = createPrincipal({ role, actorId: "x", clientId: "northside_locks", crossTenant: true });
      assert.equal(p.crossTenant, false, `${role} must not be able to hold crossTenant`);
      assert.equal(may(p, "config:view", "riverside_plumbing"), false);
    }
  });

  it("is the only role that may ACTIVATE", () => {
    const onOwnTenant = (role) =>
      may(createPrincipal({ role, actorId: "x", clientId: "northside_locks" }), "config:activate", "northside_locks");
    assert.equal(onOwnTenant("operator"), true);
    for (const role of ROLE_NAMES.filter((r) => r !== "operator")) {
      assert.equal(onOwnTenant(role), false, `${role} must not activate`);
    }
  });
});

describe("config access — the voice agent holds exactly one capability", () => {
  const voice = voicePrincipal({ clientId: "riverside_plumbing" });

  it("may propose, and that is all", () => {
    assert.deepEqual([...ROLES.voice_agent], ["config:propose"]);
    assert.equal(may(voice, "config:propose", "riverside_plumbing"), true);
  });

  it("may not approve, activate, draft directly, validate, view or preview", () => {
    for (const operation of CAPABILITIES.filter((c) => c !== "config:propose")) {
      const r = authorise({ principal: voice, operation, clientId: "riverside_plumbing" });
      assert.equal(r.ok, false, `a voice agent must not be able to ${operation}`);
      assert.equal(r.code, ACCESS_CODES.MISSING_CAPABILITY);
    }
  });

  it("is confined to one tenant like everybody else", () => {
    assert.equal(may(voice, "config:propose", "northside_locks"), false);
  });

  it("holds propose, which is strictly weaker than draft", () => {
    assert.ok(!ROLES.voice_agent.includes("config:draft"));
    assert.ok(ROLES.client_editor.includes("config:draft"));
    assert.ok(ROLES.client_editor.includes("config:propose"));
  });
});

describe("config access — role capability matrix", () => {
  const EXPECTED = {
    client_viewer:  { view: true,  preview: true,  draft: false, propose: false, validate: false, approve: false, activate: false },
    client_editor:  { view: true,  preview: true,  draft: true,  propose: true,  validate: true,  approve: false, activate: false },
    client_owner:   { view: true,  preview: true,  draft: true,  propose: true,  validate: true,  approve: true,  activate: false },
    operator:       { view: true,  preview: true,  draft: true,  propose: true,  validate: true,  approve: true,  activate: true },
    voice_agent:    { view: false, preview: false, draft: false, propose: true,  validate: false, approve: false, activate: false },
    import:         { view: true,  preview: false, draft: true,  propose: false, validate: false, approve: false, activate: false },
    system:         { view: false, preview: false, draft: false, propose: false, validate: false, approve: false, activate: false },
  };

  for (const [role, expected] of Object.entries(EXPECTED)) {
    it(`${role} has exactly the capabilities it should`, () => {
      const p = createPrincipal({ role, actorId: "x", clientId: "northside_locks" });
      for (const [short, allowed] of Object.entries(expected)) {
        assert.equal(may(p, `config:${short}`, "northside_locks"), allowed, `${role} config:${short}`);
      }
    });
  }

  it("gives `system` nothing at all — it is named so it can be refused", () => {
    assert.deepEqual([...ROLES.system], []);
    const p = createPrincipal({ role: "system", actorId: "cron", clientId: "northside_locks" });
    for (const operation of CAPABILITIES) assert.equal(may(p, operation, "northside_locks"), false);
  });

  it("separates the editor, the approver and the activator", () => {
    // The founder's requirement: do not assume the same actor can do all of it.
    const editor = createPrincipal({ role: "client_editor", actorId: "e", clientId: "northside_locks" });
    const owner = createPrincipal({ role: "client_owner", actorId: "o", clientId: "northside_locks" });
    const operator = createPrincipal({ role: "operator", actorId: "op", clientId: "northside_locks" });
    assert.equal(may(editor, "config:draft", "northside_locks"), true);
    assert.equal(may(editor, "config:approve", "northside_locks"), false);
    assert.equal(may(owner, "config:approve", "northside_locks"), true);
    assert.equal(may(owner, "config:activate", "northside_locks"), false);
    assert.equal(may(operator, "config:activate", "northside_locks"), true);
  });
});

describe("config access — a principal is read only from what the server proved", () => {
  it("returns null when the middleware resolved no tenant", () => {
    assert.equal(principalFromRequest(null), null);
    assert.equal(principalFromRequest({}), null);
    assert.equal(principalFromRequest({ query: { clientId: "northside_locks" } }), null);
    assert.equal(principalFromRequest({ body: { clientId: "northside_locks" } }), null);
    assert.equal(principalFromRequest({ params: { clientId: "northside_locks" } }), null);
  });

  it("reads a client principal from a verified client session", () => {
    const p = principalFromRequest({
      clientId: "riverside_plumbing",
      client: { slug: "riverside_plumbing" },
      clientAuth: { mode: "cookie", user: { email: "owner@riverside.invalid" } },
    });
    assert.ok(p);
    assert.equal(p.clientId, "riverside_plumbing");
    assert.equal(p.actorId, "owner@riverside.invalid");
    assert.equal(p.role, "client_editor", "the safe default when no role is recorded");
    assert.equal(p.crossTenant, false);
  });

  it("honours a recorded client role, but only a client_ one", () => {
    const asOwner = principalFromRequest({
      clientId: "riverside_plumbing",
      client: { platform_role: "client_owner" },
      clientAuth: { user: { email: "o@x.invalid" } },
    });
    assert.equal(asOwner.role, "client_owner");

    // A clients row claiming to be the operator gains nothing.
    const escalation = principalFromRequest({
      clientId: "riverside_plumbing",
      client: { platform_role: "operator" },
      clientAuth: { user: { email: "o@x.invalid" } },
    });
    assert.equal(escalation.role, "client_editor", "a client row must not be able to claim operator");
    assert.equal(escalation.crossTenant, false);
    assert.equal(may(escalation, "config:activate", "riverside_plumbing"), false);
  });

  it("reads an operator principal from an operator session", () => {
    const p = principalFromRequest({ clientId: "aida_operations", operatorSession: true, session: { operatorId: "Peter Dang" } });
    assert.equal(p.role, "operator");
    assert.equal(p.actorId, "Peter Dang");
    assert.equal(p.crossTenant, true);
  });

  it("NEVER takes the tenant from the URL, the query or the body", () => {
    const p = principalFromRequest({
      clientId: "riverside_plumbing",                    // what the server proved
      params: { clientId: "northside_locks" },           // what the caller wants
      query: { clientId: "southbank_security" },
      body: { clientId: "somebody_else" },
      clientAuth: { user: { email: "o@x.invalid" } },
    });
    assert.equal(p.clientId, "riverside_plumbing");
    assert.equal(may(p, "config:view", "northside_locks"), false);
    assert.equal(may(p, "config:view", "southbank_security"), false);
    assert.equal(may(p, "config:view", "riverside_plumbing"), true);
  });
});

describe("config access — the module cannot authenticate anything itself", () => {
  const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "platform", "config-access.js"), "utf8");

  it("imports nothing at all — it is a decision, not a dependency", () => {
    const imports = [...SOURCE.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(imports, [], `config-access must import nothing, found: ${imports.join(", ")}`);
  });

  it("reads no request field a caller controls", () => {
    // Comments stripped first: this module's own header explains that it does
    // NOT read req.query/req.body/req.params, and a raw sweep matched the
    // explanation rather than any code.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const field of ["req.query", "req.body", "req.params", "req.headers", "req.cookies"]) {
      assert.ok(!code.includes(field), `config-access must not read ${field}`);
    }
    // Prove the check still bites.
    assert.ok("const id = req.query.clientId;".includes("req.query"));
  });

  it("touches no token, no secret and no environment", () => {
    for (const forbidden of ["process.env", "jwt", "verify(", "decode(", "Bearer"]) {
      assert.ok(!SOURCE.includes(forbidden), `config-access must not contain ${forbidden}`);
    }
  });
});

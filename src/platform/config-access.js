// AIDA PLATFORM — who may do what, to whose configuration (P16).
//
//   authorise({ principal, operation, clientId })  -> { ok } | { ok:false, code }
//   principalFromRequest(req)                      -> principal | null
//
// ── THE AUTHORITY THIS BUILDS ON, RATHER THAN REPLACING ─────────────
// AIDA already resolves tenancy correctly and this must not invent a second,
// weaker way. `src/middleware/auth.js` sets `req.clientId` SERVER-SIDE from a
// verified session — its own comment says "never taken from a query param or
// request body" — and there are already two principal kinds:
//
//   requireLogin        operator. req.clientId = OPERATOR_CLIENT_ID (env).
//   requireClientAuth   a client user. req.clientId = the clients.slug the
//                       verified Supabase user is linked to.
//
// So this module does NOT authenticate anything, does not read a token, and
// never accepts a clientId from a caller. It takes what the middleware already
// proved and answers one question: may THIS actor perform THIS operation on
// THIS client's configuration?
//
// ── WHY OPERATIONS ARE SEPARATE CAPABILITIES ────────────────────────
// The person who edits a draft and the person who approves it should be able
// to be different people, and the person who puts a configuration live should
// be able to be a third. Modelling one "can configure" boolean would make that
// impossible to express later without re-plumbing every call site.
//
// ── FAIL CLOSED, ALWAYS ─────────────────────────────────────────────
// No principal, an unknown operation, a missing clientId, a tenant mismatch —
// every one is a refusal. There is no branch that returns ok on an
// unrecognised input, and a test asserts that by feeding it junk.

const CAPABILITIES = Object.freeze([
  "config:view",      // read versions, diffs and history
  "config:draft",     // create and edit drafts directly
  "config:propose",   // submit a PATCH for review — strictly weaker than draft
  "config:validate",  // run validation, moving a draft to validated
  "config:approve",   // take responsibility for specific words
  "config:activate",  // make an approved version the current one
  "config:preview",   // compile the behaviour spec and a provider payload

  // ── PROVISIONING (P22A) ──
  // Separate from the config capabilities on purpose. Configuring what a
  // business says and changing what exists at a telephone provider are
  // different acts with different blast radii, and the person allowed to do
  // the first is not automatically allowed the second.
  "provisioning:view",       // see the diff and the plans
  "provisioning:create",     // build a plan from the active configuration
  "provisioning:validate",   // check a plan against the configuration that is active now
  "provisioning:approve",    // take responsibility for a set of provider mutations
  "provisioning:execute",    // run them. NOTHING implements this, and nothing holds it
  "provisioning:reconcile",  // read provider state and compare it with the registry
]);

/**
 * Roles as capability sets. Deliberately small: this is the authority THIS
 * subsystem needs, not a user-management system.
 *
 * `voice_agent` is the important one. It holds exactly ONE capability, and it
 * is not `config:draft` — a voice interviewer may PROPOSE a patch, which lands
 * as a draft with its guardrails, and may do nothing else at all. It cannot
 * approve, cannot activate, and cannot even edit a draft directly.
 */
const ROLES = Object.freeze({
  client_viewer: Object.freeze(["config:view", "config:preview", "provisioning:view"]),
  client_editor: Object.freeze([
    "config:view", "config:preview", "config:draft", "config:propose", "config:validate",
    "provisioning:view",
  ]),
  client_owner: Object.freeze([
    "config:view", "config:preview", "config:draft", "config:propose", "config:validate", "config:approve",
    // A client may SEE what provisioning would do to their own service. They
    // may not create, approve or run it: those change resources AIDA owns and
    // pays for at a provider.
    "provisioning:view",
  ]),
  // The founder/operator. Activation is deliberately theirs: putting a
  // configuration live is the moment a business's telephone starts being
  // answered differently.
  operator: Object.freeze([
    "config:view", "config:preview", "config:draft", "config:propose",
    "config:validate", "config:approve", "config:activate",
    "provisioning:view", "provisioning:create", "provisioning:validate",
    "provisioning:approve", "provisioning:reconcile",
    // provisioning:execute is DELIBERATELY ABSENT from every role. Nothing
    // implements execution, so nothing may hold the capability to invoke it.
    // Adding it here is a decision somebody must make explicitly, in a commit,
    // alongside an executor that satisfies the twelve preconditions in
    // provisioning-execution-contract.js.
  ]),
  // Still exactly one capability. A voice interviewer may propose a wording
  // change; it may not see, build, approve or run a provider mutation.
  voice_agent: Object.freeze(["config:propose"]),
  // An importer runs a migration. It may create a draft and nothing else —
  // importing is exactly the moment somebody would want to skip approval.
  import: Object.freeze(["config:view", "config:draft"]),
  // Present so it can be named and refused rather than being an undefined
  // lookup that silently yields nothing.
  system: Object.freeze([]),
});

const ROLE_NAMES = Object.freeze(Object.keys(ROLES));

const ACCESS_CODES = Object.freeze({
  OK: "ok",
  NO_PRINCIPAL: "no_authenticated_principal",
  UNKNOWN_ROLE: "unknown_role",
  UNKNOWN_OPERATION: "unknown_operation",
  NO_TENANT: "no_tenant_in_scope",
  WRONG_TENANT: "principal_is_not_authorised_for_this_client",
  MISSING_CAPABILITY: "role_lacks_this_capability",
});

const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const refuse = (code, message) => Object.freeze({ ok: false, code, message });
const allow = (principal, operation) =>
  Object.freeze({ ok: true, code: ACCESS_CODES.OK, actor: principal.actorId, role: principal.role, operation });

/**
 * Build a principal. `clientId` is the tenant this actor is authorised FOR,
 * and it must come from a verified session — never from a URL, a body or a
 * query string. Callers that have not resolved one get null and therefore get
 * refused everywhere.
 */
function createPrincipal({ role, actorId = null, clientId = null, crossTenant = false } = {}) {
  if (!ROLE_NAMES.includes(role)) return null;
  return Object.freeze({
    role,
    actorId,
    clientId,
    // Only an operator may hold this, and even then only for reads — see
    // authorise(). It exists because a founder console legitimately lists
    // every client.
    crossTenant: role === "operator" ? Boolean(crossTenant) : false,
    capabilities: ROLES[role],
  });
}

/**
 * Operations an operator holding crossTenant may perform outside their own
 * tenant. READS ONLY — a founder console legitimately lists every client and
 * shows what provisioning would do, and legitimately cannot change any of it
 * from that screen.
 */
const CROSS_TENANT_OPERATIONS = Object.freeze(["config:view", "config:preview", "provisioning:view"]);

/**
 * The whole decision, in one place.
 *
 * Order matters: identity, then operation validity, then tenancy, then
 * capability. Tenancy is checked BEFORE capability so a cross-tenant attempt
 * is reported as a tenant refusal rather than leaking whether the actor would
 * otherwise have been allowed.
 */
function authorise({ principal, operation, clientId } = {}) {
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
    return refuse(ACCESS_CODES.NO_PRINCIPAL, "no authenticated principal");
  }
  if (!ROLE_NAMES.includes(principal.role)) {
    return refuse(ACCESS_CODES.UNKNOWN_ROLE, "unknown role");
  }
  if (!CAPABILITIES.includes(operation)) {
    return refuse(ACCESS_CODES.UNKNOWN_OPERATION, "unknown operation");
  }
  if (!isStr(clientId)) {
    return refuse(ACCESS_CODES.NO_TENANT, "no client in scope");
  }
  if (!isStr(principal.clientId) && !principal.crossTenant) {
    return refuse(ACCESS_CODES.NO_TENANT, "principal is not scoped to a client");
  }

  const sameTenant = principal.clientId === clientId;
  if (!sameTenant) {
    const mayReachAcross =
      principal.role === "operator" &&
      principal.crossTenant &&
      CROSS_TENANT_OPERATIONS.includes(operation);
    if (!mayReachAcross) {
      // Deliberately the same message whatever the reason. A caller poking at
      // other clients' URLs learns only that they may not, never whether the
      // client exists or what they would have been allowed to do.
      return refuse(ACCESS_CODES.WRONG_TENANT, "not authorised for this client");
    }
  }

  const capabilities = ROLES[principal.role] || [];
  if (!capabilities.includes(operation)) {
    return refuse(ACCESS_CODES.MISSING_CAPABILITY, "not permitted");
  }

  return allow(principal, operation);
}

/**
 * Read a principal off an Express request, using ONLY what the existing
 * middleware resolved server-side.
 *
 * `req.clientId` is set by requireLogin (operator) or requireClientAuth (a
 * verified client session). Nothing here reads req.query, req.params or
 * req.body — a clientId a caller supplied is evidence of what they WANT, not
 * of what they may have.
 */
function principalFromRequest(req) {
  if (!req || typeof req !== "object") return null;
  if (!isStr(req.clientId)) return null;

  // An operator session: requireLogin resolved OPERATOR_CLIENT_ID.
  if (req.operatorSession === true || (req.session && req.session.authenticated === true && !req.clientAuth)) {
    return createPrincipal({
      role: "operator",
      actorId: (req.session && req.session.operatorId) || "operator",
      clientId: req.clientId,
      crossTenant: true,
    });
  }

  // A client session: requireClientAuth resolved the slug from the verified
  // Supabase user.
  if (req.clientAuth && req.clientAuth.user) {
    const declared = req.client && req.client.platform_role;
    const role = ROLE_NAMES.includes(declared) && declared.startsWith("client_") ? declared : "client_editor";
    return createPrincipal({
      role,
      actorId: req.clientAuth.user.email || req.clientAuth.user.id || null,
      clientId: req.clientId,
    });
  }

  return null;
}

/** A principal for a voice interviewer. Propose-only, by construction. */
function voicePrincipal({ clientId, actorId = "voice interviewer" }) {
  return createPrincipal({ role: "voice_agent", actorId, clientId });
}

module.exports = {
  authorise,
  createPrincipal,
  principalFromRequest,
  voicePrincipal,
  CAPABILITIES,
  ROLES,
  ROLE_NAMES,
  ACCESS_CODES,
  CROSS_TENANT_OPERATIONS,
};

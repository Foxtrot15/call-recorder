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
  client_viewer: Object.freeze(["config:view", "config:preview"]),
  client_editor: Object.freeze(["config:view", "config:preview", "config:draft", "config:propose", "config:validate"]),
  client_owner: Object.freeze(["config:view", "config:preview", "config:draft", "config:propose", "config:validate", "config:approve"]),
  // The founder/operator. Activation is deliberately theirs: putting a
  // configuration live is the moment a business's telephone starts being
  // answered differently.
  operator: Object.freeze([
    "config:view", "config:preview", "config:draft", "config:propose",
    "config:validate", "config:approve", "config:activate",
  ]),
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

/** Operations an operator holding crossTenant may perform outside their own tenant. */
const CROSS_TENANT_OPERATIONS = Object.freeze(["config:view", "config:preview"]);

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

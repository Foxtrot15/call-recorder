// AIDA PLATFORM — the live DEV harness (P36 Phase 5).
//
//   liveAvailable()          is the suite allowed to run at all?
//   buildLivePlatform()      a real config service on real DEV Postgres
//   FIXTURE                  the one fictional client this milestone owns
//   cleanupTenant(db, slug)  remove a temporary tenant's rows
//
// ── IT REFUSES TO RUN BY DEFAULT ────────────────────────────────────
// `npm test` must never touch a database, need a credential, or write a row
// anywhere. So this returns false unless PLATFORM_DEV_LIVE is the exact string
// "true" AND a key resolves AND the project ref is DEV. Three separate things,
// because "the suite quietly did nothing" and "the suite quietly ran against
// the wrong project" are both worse than a skip somebody can read.
//
// ── WHAT IT MAY WRITE ───────────────────────────────────────────────
// Rows belonging to the fictional fixture client, and rows belonging to
// clearly-named temporary tenants used for cross-tenant refusal proofs. Nothing
// else. It never touches dev-client, never touches provider_resources, and
// never touches a table ACP1 did not create.

const path = require("node:path");

const { devSupabase, readEnvFile, DEV_PROJECT_REF } = require("../../scripts/dev/platform-dev-supabase");
const { resolveStoreBinding, createAcp1SchemaProbe } = require("../../src/platform/store-binding");
const { createConfigService } = require("../../src/platform/config-service");
const { createStoreConfigAudit, createInMemoryConfigAudit } = require("../../src/platform/config-audit");

/**
 * The ONE fictional client this milestone owns. Never a real business.
 *
 * LOWER_SNAKE, and it has to be. client-blueprint.js validates identity.clientId
 * against /^[a-z][a-z0-9_]{1,60}$/, and ACP1 constrains the stored body to agree
 * with the row (pcv_body_client_matches) — so clients.slug, client_id and
 * identity.clientId are one string, and a hyphen makes it unusable as a platform
 * tenant. Found the hard way: the first fixture slug used hyphens and every
 * blueprint written against it failed validation.
 *
 * Worth knowing: the pre-existing DEV slug `dev-client` is hyphenated, so it
 * could not be a platform configuration tenant as it stands.
 */
const FIXTURE = Object.freeze({
  slug: "aida_platform_dev_contract",
  name: "AIDA Platform DEV Contract (fictional — P36)",
  purpose: "The live configuration contract suite writes here. Nobody browses it, and it ACCUMULATES — every run adds versions, and ACP1 will not let anyone delete one.",
});

/**
 * The clean tenant the founder actually browses. Seeded once by
 * scripts/dev/seed-platform-browser-fixture.js and never written to by the
 * contract suite, so its history stays small and readable.
 */
const BROWSER_FIXTURE = Object.freeze({
  slug: "aida_platform_dev_client",
  name: "AIDA Platform DEV Client (fictional — browser pass)",
  purpose: "The founder's manual browser smoke. Not a customer, and not a test target.",
});

/**
 * The second fictional tenant, used to prove cross-client lineage is
 * unrepresentable.
 *
 * It is PERMANENT, and it has to be. ACP1's pcv_refuse_delete_trg refuses to
 * delete a configuration version — deliberately, because history that can be
 * deleted is not history. So the moment a test tenant owns one version it can
 * never be tidied away, and calling it "temporary" would be a lie the next
 * person has to discover.
 *
 * Its one version is seeded idempotently, so re-running the suite reuses it
 * rather than colliding on pcv_client_version_unique.
 */
const PEER = Object.freeze({
  slug: "aida_platform_dev_peer",
  name: "AIDA Platform DEV Peer (fictional — P36 cross-tenant proof)",
  seededVersion: 77001,
});

const ENV_FILE = process.env.PLATFORM_DEV_ENV_FILE || ".env.platform-dev";

/** Read the env file once, without putting anything into process.env. */
function liveEnv() {
  const fromFile = readEnvFile(path.resolve(ENV_FILE));
  return {
    live: (process.env.PLATFORM_DEV_LIVE || fromFile.PLATFORM_DEV_LIVE) === "true",
    // DELIBERATELY process.env ONLY — the env file is not consulted, and
    // fromFile is not part of this expression.
    //
    // This is the whole point of the second gate, and it exists because the
    // first one failed exactly this way. ENV_FILE defaults to
    // ".env.platform-dev" whether or not PLATFORM_DEV_ENV_FILE is set, so a
    // developer who once wrote PLATFORM_DEV_LIVE=true into that gitignored
    // file turned every subsequent plain `npm test` into a live run that wrote
    // permanent rows to DEV. The suite reported itself as opt-in the entire
    // time, and it was — opted into by a file, months earlier, silently.
    //
    // So an acknowledgement that a file can give is not an acknowledgement.
    // This one has to be typed on the command line that runs the suite.
    acknowledged: process.env.PLATFORM_DEV_ACK_PERMANENT_HISTORY === "true",
    url: process.env.SUPABASE_URL || fromFile.SUPABASE_URL || "",
    hasKey: Boolean(process.env.SUPABASE_SERVICE_KEY || fromFile.SUPABASE_SERVICE_KEY),
    fixtureSlug: process.env.PLATFORM_DEV_FIXTURE_SLUG || fromFile.PLATFORM_DEV_FIXTURE_SLUG || FIXTURE.slug,
  };
}

/**
 * FOUR independent conditions, and the reason for each is different:
 *   - opted in, so a plain `npm test` never writes to a database
 *   - a key resolves, so the suite fails loudly rather than half-running
 *   - the ref is DEV, so it cannot possibly be production
 *   - the operator has ACKNOWLEDGED that what this writes is PERMANENT
 *
 * The fourth condition arrived after looking at what the first three runs left
 * behind. ACP1's pcv_refuse_delete_trg refuses to delete a configuration
 * version — deliberately, because history that can be deleted is not history —
 * so every run of this suite adds rows to DEV that nobody can ever remove.
 *
 * That is not a bug and the database must not change to accommodate it. What
 * was missing was a person knowing it before they typed the command. So
 * acknowledging it is a separate act from opting in: "run the live suite" and
 * "I understand these rows are permanent" are different sentences, and a flag
 * set in a .env file months ago is not somebody saying the second one.
 */
function liveAvailable() {
  const env = liveEnv();
  if (!env.live) return { available: false, why: 'PLATFORM_DEV_LIVE is not "true" — the live suite is opt-in' };
  if (!env.hasKey) return { available: false, why: `no service key resolved from ${ENV_FILE} or the environment` };
  const ref = (env.url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/) || [])[1];
  if (ref !== DEV_PROJECT_REF) return { available: false, why: `SUPABASE_URL names "${ref}", not DEV (${DEV_PROJECT_REF})` };
  if (!env.acknowledged) {
    return {
      available: false,
      why: 'PLATFORM_DEV_ACK_PERMANENT_HISTORY is not "true" — this suite writes configuration versions to DEV that CANNOT be deleted',
    };
  }
  return { available: true, why: null, fixtureSlug: env.fixtureSlug };
}

/**
 * Printed before the first write, every single run — because a gate somebody
 * passed once in a .env file is not the same as being told, now, what is about
 * to happen and to which tenant.
 */
function announceLiveRun(fixtureSlug) {
  const row = (label, value) => `  |  ${label.padEnd(9)} ${String(value).padEnd(54)}|`;
  console.log([
    "",
    "  +- LIVE DEV RUN -----------------------------------------------------+",
    row("project", DEV_PROJECT_REF),
    row("writing", fixtureSlug),
    row("and", PEER.slug),
    "  |                                                                    |",
    "  |  Rows written here are PERMANENT. ACP1 refuses to delete a         |",
    "  |  configuration version, so this run's history cannot be undone.    |",
    "  |  It never writes to the browser fixture, dev-client, or prod.      |",
    "  +--------------------------------------------------------------------+",
    "",
  ].join("\n"));
}

function clock(startMs = Date.now()) {
  let t = startMs;
  const now = () => new Date(t);
  now.tick = (ms = 1000) => { t += ms; return new Date(t); };
  return now;
}

/**
 * A real configuration service, on the real DEV database, through the real
 * store binding — including its schema probe. Nothing here is a stand-in.
 *
 * Returns `ok:false` rather than throwing when the binding refuses, so a test
 * can assert the refusal is the fail-closed one rather than a crash.
 */
async function buildLivePlatform({ now = clock(), audit = "store" } = {}) {
  const { db } = devSupabase({ envFile: ENV_FILE });

  const binding = await resolveStoreBinding({
    mode: "postgres",
    db,
    now,
    schemaProbe: createAcp1SchemaProbe({ db }),
  });
  if (!binding.ok) return { ok: false, binding, db };

  const configService = createConfigService({
    store: binding.store,
    now,
    // The durable audit sink writes into platform_config_events — the table
    // whose vocabularies P36 widened. Using it here is what proves the fix
    // live rather than against a fake.
    audit: audit === "store" ? createStoreConfigAudit({ store: binding.store }) : createInMemoryConfigAudit({ now }),
  });

  return { ok: true, binding, db, store: binding.store, configService, now };
}

/**
 * Remove every row a tenant owns, versions last because events reference
 * nothing but the version rows refuse deletion by trigger.
 *
 * platform_config_versions has pcv_refuse_delete_trg, so a version row CANNOT
 * be deleted — by design. A temporary tenant used for a cross-tenant proof
 * therefore leaves its version rows behind unless it never created one, which
 * is why those proofs only ever attempt writes that the database refuses.
 */
async function cleanupTenant(db, slug) {
  const removed = { events: 0, versions: 0, versionsRefused: 0, client: 0 };

  const events = await db.from("platform_config_events").delete().eq("client_id", slug).select("id");
  removed.events = events.error ? 0 : (events.data || []).length;

  const versions = await db.from("platform_config_versions").delete().eq("client_id", slug).select("config_version");
  if (versions.error) removed.versionsRefused = 1;
  else removed.versions = (versions.data || []).length;

  const client = await db.from("clients").delete().eq("slug", slug).select("slug");
  removed.client = client.error ? 0 : (client.data || []).length;

  return removed;
}

/** Does the fixture's clients row exist? Create it if not. */
async function ensureFixtureClient(db, slug = FIXTURE.slug, name = FIXTURE.name) {
  const found = await db.from("clients").select("slug,name").eq("slug", slug).limit(1);
  if (found.error) return { ok: false, error: found.error.message };
  if ((found.data || []).length) return { ok: true, created: false, slug };

  const created = await db.from("clients").insert({ slug, name }).select("slug").limit(1);
  if (created.error) return { ok: false, error: created.error.message, created: false };
  return { ok: true, created: true, slug };
}

/** Count what the fixture currently owns, for the retention report. */
async function fixtureRowCounts(db, slug = FIXTURE.slug) {
  const versions = await db.from("platform_config_versions").select("config_version,status,source").eq("client_id", slug);
  const events = await db.from("platform_config_events").select("event_type").eq("client_id", slug);
  const client = await db.from("clients").select("slug").eq("slug", slug);
  return {
    versions: versions.error ? null : (versions.data || []).length,
    versionDetail: versions.error ? [] : (versions.data || []),
    events: events.error ? null : (events.data || []).length,
    client: client.error ? null : (client.data || []).length,
  };
}

module.exports = {
  liveAvailable, liveEnv, buildLivePlatform, cleanupTenant, ensureFixtureClient, fixtureRowCounts,
  clock, FIXTURE, BROWSER_FIXTURE, PEER, ENV_FILE, announceLiveRun,
};

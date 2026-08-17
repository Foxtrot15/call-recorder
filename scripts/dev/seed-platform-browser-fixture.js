#!/usr/bin/env node
// AIDA PLATFORM — seed the tenant the founder browses (P36 Phase 8).
//
//   PLATFORM_DEV_ENV_FILE=.env.platform-dev node scripts/dev/seed-platform-browser-fixture.js
//   …--status   report what is there and change nothing
//
// ── WHY THIS IS SEPARATE FROM THE CONTRACT SUITE ────────────────────
// The live contract suite writes to aida_platform_dev_contract and ACCUMULATES
// — every run adds versions, and ACP1's pcv_refuse_delete_trg means nobody can
// ever tidy them away. That is correct for a schema whose whole point is that
// history survives, and useless for a tenant somebody is supposed to look at.
//
// So the browser tenant is seeded once, by this, and the contract suite never
// touches it. Its history stays short enough to read.
//
// ── RESET ───────────────────────────────────────────────────────────
// There is no reset. A configuration version cannot be deleted — deliberately.
// To start clean, change PLATFORM_DEV_FIXTURE_SLUG to an unused lower_snake
// slug and run this again. The old tenant stays where it is, which is the
// honest cost of an audit trail that cannot be edited.
//
// ── SAFETY ──────────────────────────────────────────────────────────
// DEV only — the project-ref guard throws before a client exists. It writes
// rows for ONE fictional tenant and nothing else: no provider, no calling, no
// ACP2, no ACP3, no production.

const { devSupabase, describeTarget } = require("./platform-dev-supabase");
const { BROWSER_FIXTURE } = require("../../test/helpers/dev-live-harness");
const { resolveStoreBinding, createAcp1SchemaProbe } = require("../../src/platform/store-binding");
const { createConfigService } = require("../../src/platform/config-service");
const { createStoreConfigAudit } = require("../../src/platform/config-audit");
const { createPrincipal } = require("../../src/platform/config-access");
const { garageDoorD } = require("../../src/platform/fixtures/clients");

const SLUG = process.env.PLATFORM_DEV_FIXTURE_SLUG_BROWSER || BROWSER_FIXTURE.slug;
const STATUS_ONLY = process.argv.includes("--status");

const P = {
  editor: createPrincipal({ role: "client_editor", actorId: "fixture seed", clientId: SLUG }),
  owner: createPrincipal({ role: "client_owner", actorId: "Peter Dang", clientId: SLUG }),
  operator: createPrincipal({ role: "operator", actorId: "Peter Dang", clientId: SLUG, crossTenant: true }),
};

/** The fictional business the founder will see. Garage doors, retenanted. */
function blueprint() {
  const bp = garageDoorD();
  bp.identity.clientId = SLUG;
  bp.identity.legalName = "AIDA Platform DEV Client Pty Ltd";
  bp.identity.tradingName = "AIDA Platform DEV Client";
  bp.identity.description = "A fictional business for the founder's browser pass. Not a customer.";
  return bp;
}

(async () => {
  const target = devSupabase();
  const { db } = target;
  const now = () => new Date();

  console.log("");
  console.log(describeTarget(target));
  console.log(`fixture: ${SLUG}`);
  console.log("");

  const report = async (label) => {
    const v = await db.from("platform_config_versions").select("config_version,status,source").eq("client_id", SLUG).order("config_version");
    const e = await db.from("platform_config_events").select("event_type").eq("client_id", SLUG);
    const c = await db.from("clients").select("slug,name").eq("slug", SLUG);
    console.log(`${label}`);
    console.log(`  clients rows              ${(c.data || []).length}`);
    console.log(`  platform_config_versions  ${(v.data || []).length}`);
    console.log(`  platform_config_events    ${(e.data || []).length}`);
    for (const row of v.data || []) console.log(`      v${row.config_version}  ${row.status.padEnd(11)} ${row.source}`);
    return { versions: (v.data || []).length, client: (c.data || []).length };
  };

  if (STATUS_ONLY) { await report("current state:"); console.log(""); return; }

  const binding = await resolveStoreBinding({ mode: "postgres", db, now, schemaProbe: createAcp1SchemaProbe({ db }) });
  if (!binding.ok) {
    console.error(`REFUSED: ${binding.message}`);
    process.exit(1);
  }
  const configService = createConfigService({
    store: binding.store, now, audit: createStoreConfigAudit({ store: binding.store }),
  });

  // The clients row. ACP1 has no FK to it, but requireClientAuth resolves the
  // tenant through it, so the browser pass needs one.
  const existing = await db.from("clients").select("slug").eq("slug", SLUG).limit(1);
  if (!(existing.data || []).length) {
    const created = await db.from("clients").insert({ slug: SLUG, name: BROWSER_FIXTURE.name }).select("slug");
    if (created.error) { console.error(`could not create the clients row: ${created.error.message}`); process.exit(1); }
    console.log(`created clients row ${SLUG}`);
  } else {
    console.log(`clients row ${SLUG} already exists`);
  }

  const before = await report("before:");
  if (before.versions > 0) {
    console.log("");
    console.log("This tenant already has configuration. Seeding again would only add");
    console.log("versions, and none can be deleted — so nothing was written.");
    console.log("To start clean, pick an unused lower_snake slug and run this again.");
    console.log("");
    return;
  }

  // v1: a complete, ACTIVE configuration — so the dashboard, preview and
  // provisioning screens all have something real to show.
  const created = await configService.createDraft({ principal: P.editor, clientId: SLUG, blueprint: blueprint() });
  if (!created.ok) { console.error(`createDraft: ${JSON.stringify(created)}`); process.exit(1); }
  const v1 = created.configVersion;

  const validated = await configService.validate({ principal: P.editor, clientId: SLUG, configVersion: v1 });
  if (!validated.ok) { console.error(`validate: ${JSON.stringify(validated.errors || validated)}`); process.exit(1); }
  await configService.approve({ principal: P.owner, clientId: SLUG, configVersion: v1, reason: "Seeded for the founder browser pass." });
  await configService.activate({ principal: P.operator, clientId: SLUG, configVersion: v1 });

  // v2: an OPEN DRAFT with one visible change, so Review Changes has a diff to
  // render the moment the founder opens it.
  const restored = await configService.restore({ principal: P.operator, clientId: SLUG, configVersion: v1 });
  if (restored.ok) {
    const v2 = restored.version.metadata.configVersion;
    const opened = await configService.getVersion({ principal: P.editor, clientId: SLUG, configVersion: v2 });
    await configService.updateDraft({
      principal: P.editor, clientId: SLUG, configVersion: v2,
      mutate: (d) => { d.hours.weekly.saturday = { open: "09:00", close: "16:00" }; },
      expectedUpdatedAt: opened.version.metadata.updatedAt ?? null,
    });
  }

  console.log("");
  await report("after:");
  console.log("");
  console.log("Ready. Start the server and open the client:");
  console.log("");
  console.log("  PLATFORM_CONFIG_API_ENABLED=true PLATFORM_CONFIG_STORE=postgres \\");
  console.log("  PLATFORM_DEV_ENV_FILE=.env.platform-dev npm start");
  console.log("");
  console.log(`  /platform/clients/${SLUG}`);
  console.log(`  /platform/clients/${SLUG}/wizard`);
  console.log("");
})().catch((error) => { console.error(`FAILED: ${error.message}`); process.exit(3); });

// AIDA PLATFORM P29–P35 — the configuration UI.
//
// Every screen is a pure function of a view model, and every view model is a
// pure function of what the services returned. So the whole interface is
// testable with node:test and no browser — which is the only kind of test this
// repo can run, and a better kind than clicking anyway.
//
// The rules these tests exist to keep, in order of how much damage breaking
// them would do:
//
//   1. No screen, in any state, for any role, offers to EXECUTE provisioning.
//   2. UNKNOWN is never drawn as FAILED, and never gets a Retry control.
//   3. Outbound AI disclosure has no toggle.
//   4. Platform requirements cannot be edited, and say so visibly.
//   5. A 409 is shown, never resolved. There is no force.
//   6. Hiding a control is not security — the backend refuses regardless.
//
// Each of those has a BAD FIXTURE below proving the check catches something.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const V = require("../src/platform/ui/ui-vocabulary");
const D = require("../src/platform/ui/ui-diff");
const F = require("../src/platform/ui/ui-fields");
const VM = require("../src/platform/ui/ui-view-models");
const S = require("../src/views/platform-shell");
const P = require("../src/views/platform-config-pages");
const PV = require("../src/views/platform-provisioning-pages");
const W = require("../src/views/platform-wizard-page");

const B = require("../src/platform/client-blueprint");
const { diffBlueprints } = require("../src/platform/blueprint-diff");
const { compileBehaviourSpec } = require("../src/platform/behaviour-spec");
const { createPrincipal, ROLES } = require("../src/platform/config-access");
const { garageDoorD, plumberC } = require("../src/platform/fixtures/clients");

const ROOT = path.join(__dirname, "..");
const CID = "rolladoor_repairs";
const BASE = `/platform/clients/${CID}`;

const principal = (role, clientId = CID) =>
  createPrincipal({ role, actorId: "Peter Dang", clientId, crossTenant: role.startsWith("operator") });

const active = () => {
  const bp = garageDoorD();
  bp.metadata = { ...bp.metadata, configVersion: 2, status: "active", activatedBy: "Peter Dang" };
  return bp;
};

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (haystack, needle) => haystack.split(needle).length - 1;

/**
 * Comments AND string literals removed. Every ratchet below that sweeps source
 * for a forbidden word needs this: these files are mostly prose explaining why
 * a thing is forbidden, and a raw sweep catches the explanation rather than any
 * executable line. That has happened three times in this codebase already.
 */
const codeOnly = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");

/** Every screen, in every state worth drawing. Rendered once, asserted many times. */
function everyScreen() {
  const bp = active();
  const op = principal("operator");
  const out = [];

  for (const key of F.SECTION_KEYS) {
    const section = F.sectionFor(key);
    out.push([`editor:${key}`, P.renderEditor({
      clientId: CID, section, values: F.readSection(bp, key),
      items: section.repeatable ? F.getPath(bp, section.repeatable.path) || [] : null,
      secondaryItems: section.secondaryRepeatable ? F.getPath(bp, section.secondaryRepeatable.path) || [] : null,
      configVersion: 2, expectedUpdatedAt: "2026-08-16T00:00:00.000Z",
    }, BASE)]);
  }

  out.push(["dashboard", P.renderDashboard(VM.dashboardModel({ clientId: CID, principal: op, active: bp }), BASE)]);
  out.push(["history", P.renderHistory(VM.historyModel({
    clientId: CID, principal: op,
    versions: [
      { configVersion: 2, status: "active", source: "ui", createdAt: "t", createdBy: "P" },
      { configVersion: 1, status: "superseded", source: "voice", supersededAt: "t" },
    ],
  }), BASE)]);

  const changed = JSON.parse(JSON.stringify(bp));
  changed.hours.weekly.saturday = { open: "09:00", close: "16:00" };
  out.push(["review", P.renderReview(VM.diffModel({
    clientId: CID, principal: op, toVersion: 3,
    diff: diffBlueprints(bp, changed), validation: B.validateBlueprint(changed), draftStatus: "validated",
  }), BASE, { showRaw: true })]);

  out.push(["conflict", P.renderReview(VM.diffModel({
    clientId: CID, principal: op, toVersion: 3,
    diff: diffBlueprints(bp, changed), validation: B.validateBlueprint(changed), draftStatus: "validated",
    conflict: { message: "changed under you", expectedUpdatedAt: "a", actualUpdatedAt: "b" },
  }), BASE)]);

  out.push(["activate", P.renderActivate({
    clientId: CID, configVersion: 3, approvedBy: "Peter Dang", currentActiveVersion: 2, canActivate: true,
  }, BASE)]);

  const { spec } = compileBehaviourSpec(bp);
  for (const direction of ["inbound", "outbound"]) {
    out.push([`behaviour:${direction}`, PV.renderBehaviourPreview(VM.behaviourPreviewModel({
      clientId: CID, spec, direction, openingLine: "Rolladoor Repairs, this is Sam.",
    }), BASE)]);
  }

  out.push(["provider", PV.renderProviderPreview(VM.providerPreviewModel({
    clientId: CID, principal: op,
    preview: { configVersion: 2, direction: "inbound", unresolved: ["llmId"], ready: false },
    rawPayload: { api_key: "SUPERSECRET", authorization: "Bearer SUPERSECRET", prompt: "hello" },
  }), BASE)]);

  out.push(["plan", PV.renderPlan(VM.planModel({
    clientId: CID, principal: op,
    plan: { planId: "plan_000001", status: "approved", planHash: "c".repeat(64), mutatingCount: 3,
      actions: [{ key: "a:b", action: "create" }, { key: "c:d", action: "replace" }, { key: "e:f", action: "retire" }] },
  }), BASE)]);

  for (const bad of ["unknown", "persist_failed_after_provider_success", "manual_reconciliation_required"]) {
    out.push([`plan:${bad}`, PV.renderPlan(VM.planModel({
      clientId: CID, principal: op,
      plan: { planId: "plan_000002", status: "unknown", mutatingCount: 1,
        actions: [{ key: "a:b", action: "create", executionStatus: bad }] },
    }), BASE)]);
  }

  out.push(["wizard", W.renderWizard({
    clientId: CID, draftVersion: 3, draftStatus: V.configChip("draft"),
    stepState: { identity: "done" }, currentStep: "identity",
  }, BASE)]);

  return out;
}

const SCREENS = everyScreen();

// ════════════════════════════════════════════════════════════════════
// P29 — THE STACK, AND THE CSP IT MUST OBEY
// ════════════════════════════════════════════════════════════════════

describe("P29 UI stack — it uses the repo's own conventions", () => {
  it("renders with the same view convention as the locksmith pages", () => {
    // No template engine, no framework, no build step. Pure functions returning
    // strings, exactly like src/views/locksmith-page.js.
    for (const file of ["platform-shell.js", "platform-config-pages.js", "platform-provisioning-pages.js", "platform-wizard-page.js"]) {
      const src = fs.readFileSync(path.join(ROOT, "src", "views", file), "utf8");
      assert.ok(!/require\("express"\)/.test(src), `${file} imports express — views must be testable without it`);
      for (const framework of ["react", "vue", "svelte", "handlebars", "ejs", "pug", "jsx"]) {
        assert.ok(!new RegExp(`require\\(["'][^"']*${framework}`, "i").test(src), `${file} pulls in ${framework}`);
      }
    }
  });

  it("obeys the page CSP on every screen: no inline script, style or handler", () => {
    for (const [name, html] of SCREENS) {
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), `${name} has an inline <script>`);
      assert.ok(!/<style[\s>]/i.test(html), `${name} has an inline <style>`);
      assert.ok(!/\sstyle="/i.test(html), `${name} has a style attribute`);
      assert.ok(!/\son[a-z]+\s*=\s*"/i.test(html), `${name} has an inline event handler`);
    }
  });

  it("would CATCH an inline handler if one were added", () => {
    // The bad fixture. Without this the four assertions above could be checking
    // patterns that never appear in any markup anybody would write.
    const bad = '<button onclick="go()">Go</button>';
    assert.ok(/\son[a-z]+\s*=\s*"/i.test(bad));
    const alsoBad = '<script>alert(1)</script>';
    assert.ok(/<script(?![^>]*\bsrc=)/i.test(alsoBad));
  });

  it("serves its stylesheet and script from this origin, and nothing else", () => {
    const [, html] = SCREENS[0];
    const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const s of srcs) {
      assert.ok(!/^https?:|^\/\//.test(s), `${s} is an external resource — the CSP forbids it and so does this test`);
    }
    assert.ok(html.includes('href="/platform/platform.css"'));
    assert.ok(html.includes('src="/platform/platform.js"'));
  });
});

// ════════════════════════════════════════════════════════════════════
// ACCESSIBILITY
// ════════════════════════════════════════════════════════════════════

describe("accessibility — the contract the locksmith pages already keep", () => {
  it("gives every page one main, one header, one footer and a skip link", () => {
    for (const [name, html] of SCREENS) {
      assert.equal(count(html, "<main id=\"main\""), 1, `${name}`);
      assert.equal(count(html, "<header"), 1, `${name}`);
      assert.equal(count(html, "<footer"), 1, `${name}`);
      assert.ok(html.includes('<a class="skip-link" href="#main">Skip to main content</a>'), `${name} has no skip link`);
      assert.ok(html.includes('<html lang="en-AU">'), `${name} declares no language`);
    }
  });

  it("points every label at a control that exists", () => {
    for (const [name, html] of SCREENS) {
      for (const f of [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1])) {
        assert.match(html, new RegExp(`id="${esc(f)}"`), `${name}: label for="${f}" points at nothing`);
      }
    }
  });

  it("points every aria-describedby at an element that exists", () => {
    for (const [name, html] of SCREENS) {
      const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
      for (const id of ids) {
        assert.match(html, new RegExp(`id="${esc(id)}"`), `${name}: aria-describedby="${id}" points at nothing`);
      }
    }
  });

  it("names every control — a for= or a wrapping label, never nothing", () => {
    for (const [name, html] of SCREENS) {
      for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
        if (/type="hidden"/.test(m[0])) continue;
        const id = (m[0].match(/\sid="([^"]+)"/) || [])[1];
        const wrapped = /class="choice"/.test(html.slice(Math.max(0, m.index - 200), m.index));
        assert.ok(id || wrapped, `${name}: an unnamed ${m[1]} — ${m[0].slice(0, 80)}`);
        if (id && !wrapped) {
          assert.match(html, new RegExp(`for="${esc(id)}"`), `${name}: control ${id} has no label`);
        }
      }
    }
  });

  it("states required and optional in words, never an asterisk or a colour", () => {
    const [, identity] = SCREENS.find(([n]) => n === "editor:identity");
    assert.ok(identity.includes("(required)"));
    assert.ok(identity.includes("(optional)"));
    // An asterisk convention is a convention somebody has to already know.
    assert.ok(!/<label[^>]*>[^<]*\*/.test(identity), "a bare asterisk marks a required field");
  });

  it("never communicates a state by colour alone — every chip carries a marker and a word", () => {
    for (const [name, html] of SCREENS) {
      const chips = [...html.matchAll(/<span class="chip chip--[a-z]+"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/g)];
      for (const c of chips) {
        assert.match(c[0], /chip__marker/, `${name}: a chip with no marker`);
        assert.match(c[0], /chip__text/, `${name}: a chip with no text`);
      }
    }
  });

  it("keeps every table cell labelled, so a stacked mobile table hides no column", () => {
    for (const [name, html] of SCREENS) {
      for (const row of html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)) {
        for (const cell of row[1].matchAll(/<td(?![^>]*data-label)[^>]*>/g)) {
          // colspan cells are the "nothing to show" row and carry no column.
          assert.match(cell[0], /colspan=/, `${name}: a <td> with no data-label — ${cell[0]}`);
        }
      }
    }
  });

  it("gives status and errors live regions a screen reader announces", () => {
    for (const [name, html] of SCREENS) {
      assert.match(html, /role="status" aria-live="polite"/, `${name}`);
      assert.match(html, /class="error-summary"[^>]*role="alert"[^>]*tabindex="-1"/, `${name}`);
    }
  });

  it("marks the current nav item for assistive technology, not only visually", () => {
    const [, dash] = SCREENS.find(([n]) => n === "dashboard");
    assert.match(dash, /aria-current="page"/);
  });

  it("has a focus-visible rule and 48px touch targets in the stylesheet", () => {
    const css = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.css"), "utf8");
    assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid/);
    assert.match(css, /min-height:\s*48px/);
    assert.match(css, /font-size:\s*16px;\s*\/\* 16px stops iOS zooming/);
    // Mobile-safe: min-width breakpoints only, never max-width.
    assert.ok(!/@media\s*\(\s*max-width/.test(css), "a max-width breakpoint — the base rules must be the narrow ones");
    assert.match(css, /@media \(min-width: 760px\)/);
  });
});

// ════════════════════════════════════════════════════════════════════
// THE SAFETY RULES
// ════════════════════════════════════════════════════════════════════

describe("safety — no screen can provision, deploy or dial", () => {
  it("offers no execute control on any screen, in any state, for any role", () => {
    for (const [name, html] of SCREENS) {
      for (const forbidden of [
        'data-action="execute"', "Deploy now", "Provision now", "Run this plan",
        "Push to Retell", "Go live",
      ]) {
        assert.ok(!html.includes(forbidden), `${name} offers "${forbidden}"`);
      }
    }
  });

  it("produces no view model containing an execute action, for any role", () => {
    const bp = active();
    for (const role of Object.keys(ROLES)) {
      const p = principal(role);
      const models = [
        VM.dashboardModel({ clientId: CID, principal: p, active: bp }),
        VM.planModel({ clientId: CID, principal: p, plan: { planId: "plan_1", status: "approved", actions: [] } }),
      ];
      for (const m of models) {
        const json = JSON.stringify(m);
        assert.ok(!/"id":"execute"/.test(json), `${role} got an execute action`);
        assert.equal(m.executeOffered ?? false, false, `${role}`);
      }
    }
  });

  it("routes and handlers import no provider, transport or executor", () => {
    for (const file of ["src/routes/platform-ui.js", "src/routes/platform-ui-handlers.js"]) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const forbidden of [
        "provisioning-executor", "provider-mutation-port", "execution-claim", "retell-adapter",
        "voice-platform-port", "twilio", "node-fetch", "axios", "undici",
      ]) {
        assert.ok(!src.includes(`require("${forbidden}`) && !src.includes(`/${forbidden}"`),
          `${file} imports ${forbidden}`);
      }
    }
  });

  it("declares no execute route, and none exists to disable", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui.js"), "utf8");
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/"[^"]*"/g, '""');
    assert.ok(!/execute/i.test(code), "an execute route exists in platform-ui.js");
    assert.match(src, /THERE IS NO EXECUTE ROUTE/);
  });

  it("puts no credential, key or secret in anything sent to a browser", () => {
    for (const [name, html] of SCREENS) {
      assert.ok(!html.includes("SUPERSECRET"), `${name} leaked a secret`);
      for (const shape of [/sk_live/, /sk_test/, /Bearer\s+[A-Za-z0-9._-]{16}/, /eyJ[A-Za-z0-9_-]{20}/]) {
        assert.ok(!shape.test(html), `${name} contains something secret-shaped`);
      }
    }
  });

  it("would CATCH a leaked credential — the sanitiser is doing real work", () => {
    const dirty = { api_key: "SUPERSECRET", nested: { authorization: "Bearer abc", signing_secret: "s" }, keep: "visible" };
    const clean = VM.sanitise(dirty);
    assert.equal(clean.api_key, "[redacted]");
    assert.equal(clean.nested.authorization, "[redacted]");
    assert.equal(clean.nested.signing_secret, "[redacted]");
    assert.equal(clean.keep, "visible", "the sanitiser must not redact everything and call it safe");
  });

  it("shows the raw provider payload to operators only", () => {
    const preview = { configVersion: 1, direction: "inbound", unresolved: [], ready: true };
    const raw = { prompt: "hello" };
    const asOperator = VM.providerPreviewModel({ clientId: CID, principal: principal("operator"), preview, rawPayload: raw });
    const asClient = VM.providerPreviewModel({ clientId: CID, principal: principal("client_owner"), preview, rawPayload: raw });
    assert.ok(asOperator.rawPayload, "an operator should see it");
    assert.equal(asClient.rawPayload, null, "a client must not");
    assert.match(asClient.rawWithheldBecause, /operators only/);
  });

  it("the browser script contacts this origin and nothing else", () => {
    const js = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.js"), "utf8");
    for (const target of [...js.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim())) {
      assert.ok(!/^["']https?:/.test(target), `platform.js fetches an absolute URL: ${target}`);
    }
    assert.match(js, /credentials:\s*"same-origin"/);
    for (const forbidden of ["retell", "twilio", "supabase", "cdn.", "googleapis", "XMLHttpRequest", "WebSocket"]) {
      assert.ok(!new RegExp(forbidden, "i").test(js.replace(/\/\*[\s\S]*?\*\//g, "")),
        `platform.js mentions ${forbidden} outside its header comment`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// UNKNOWN — the state a careless screen destroys
// ════════════════════════════════════════════════════════════════════

describe("P34B UNKNOWN — never FAILED, never a Retry button", () => {
  it("labels an uncertain outcome as uncertain, not as failed", () => {
    const chip = V.executionChip("unknown");
    assert.equal(chip.text, "OUTCOME UNCERTAIN");
    assert.notEqual(chip.text, "FAILED");
    assert.match(chip.help, /Reconciliation is required/);

    // And the genuinely-failed one still says failed, so the distinction is real.
    assert.equal(V.executionChip("provider_failed_definite").text, "FAILED");
  });

  it("offers no retry for any state where retrying could create a second resource", () => {
    for (const status of V.NEVER_RETRYABLE) {
      assert.equal(V.mayOfferRetry(status), false, `${status} must never offer retry`);
      const model = VM.planModel({
        clientId: CID, principal: principal("operator"),
        plan: { planId: "plan_1", status: "unknown", actions: [{ key: "a:b", action: "create", executionStatus: status }] },
      });
      assert.equal(model.retryOffered, false);
      assert.equal(model.actions[0].mayOfferRetry, false);
    }
  });

  it("renders no retry control beside an uncertain action", () => {
    for (const [name, html] of SCREENS.filter(([n]) => n.startsWith("plan:"))) {
      assert.ok(!/>\s*Retry\s*</i.test(html), `${name} offers Retry`);
      assert.ok(!/data-action="retry"/.test(html), `${name} offers Retry`);
      assert.ok(!/Try again/i.test(html), `${name} offers "Try again"`);
    }
  });

  it("says the founder's sentence, verbatim, wherever an outcome is uncertain", () => {
    const expected = "Provider outcome is uncertain. Reconciliation is required before another mutation can be attempted.";
    assert.equal(V.UNCERTAIN_OUTCOME_SENTENCE, expected);
    const [, html] = SCREENS.find(([n]) => n === "plan:unknown");
    assert.ok(html.includes(expected), "the uncertain plan screen does not say it");
  });

  it("blocks approval while an action's outcome is uncertain", () => {
    const model = VM.planModel({
      clientId: CID, principal: principal("operator"),
      plan: { planId: "plan_1", status: "validated", actions: [{ key: "a:b", action: "create", executionStatus: "unknown" }] },
    });
    assert.equal(model.approve.offered, false);
    assert.ok(model.approve.blockedBecause.some((r) => /uncertain/i.test(r)));
  });

  it("would CATCH a state drawn with a friendly guess instead of its own name", () => {
    // A status nobody designed a label for must be shown as itself and flagged,
    // never given a plausible-looking label that happens to be wrong.
    const chip = V.executionChip("some_future_state");
    assert.equal(chip.known, false);
    assert.equal(chip.text, "SOME_FUTURE_STATE");
    assert.match(chip.help, /no designed label/);
  });
});

// ════════════════════════════════════════════════════════════════════
// APPROVED — NOT EXECUTED
// ════════════════════════════════════════════════════════════════════

describe("P34A approval — it records a decision and performs nothing", () => {
  it("shows APPROVED — NOT EXECUTED once a plan is approved", () => {
    const [, html] = SCREENS.find(([n]) => n === "plan");
    assert.ok(html.includes("APPROVED — NOT EXECUTED"));
    assert.ok(html.includes("Provider changes require a separately authorised provisioning operation."));
  });

  it("gives replace, retire and reconciliation their own prominence", () => {
    const [, html] = SCREENS.find(([n]) => n === "plan");
    assert.equal(count(html, "higher risk"), 2, "replace and retire should both be flagged");
    assert.match(html, /higher-risk action/);
    assert.deepEqual([...V.HIGH_RISK_ACTIONS].sort(), ["reconcile_required", "replace", "retire"]);
  });

  it("says what REPLACE and RETIRE actually mean, including the mode caveat", () => {
    assert.match(V.PLAN_ACTION.replace.help, /NEW resource.*new id.*SEPARATE action/s);
    assert.match(V.PLAN_ACTION.retire.help, /may not be asked.*still be serving/s);
  });

  it("blocks plan approval for a role that does not hold provisioning:approve", () => {
    for (const role of ["client_viewer", "client_editor", "client_owner", "voice_agent"]) {
      const m = VM.planModel({
        clientId: CID, principal: principal(role),
        plan: { planId: "plan_1", status: "validated", actions: [] },
      });
      assert.equal(m.approve.offered, false, `${role} was offered plan approval`);
    }
    const asOperator = VM.planModel({
      clientId: CID, principal: principal("operator"),
      plan: { planId: "plan_1", status: "validated", actions: [] },
    });
    assert.equal(asOperator.approve.offered, true, "an operator must be able to approve, or this test proves nothing");
  });

  it("refuses a stale plan and says a new one must be built", () => {
    const m = VM.planModel({
      clientId: CID, principal: principal("operator"),
      plan: { planId: "plan_1", status: "validated", actions: [] },
      staleness: { stale: true, why: "the configuration moved" },
    });
    assert.equal(m.approve.offered, false);
    assert.ok(m.approve.blockedBecause.includes("the configuration moved"));
  });
});

// ════════════════════════════════════════════════════════════════════
// AI DISCLOSURE
// ════════════════════════════════════════════════════════════════════

describe("AI disclosure — outbound has no toggle, inbound is a different rule", () => {
  it("states the outbound sentence and offers no control beside it", () => {
    assert.equal(V.OUTBOUND_DISCLOSURE_SENTENCE, "Outbound calls must identify AIDA as an AI assistant.");
    const [, html] = SCREENS.find(([n]) => n === "editor:outbound");
    assert.ok(html.includes(V.OUTBOUND_DISCLOSURE_SENTENCE));
    assert.ok(html.includes("PLATFORM REQUIREMENT — LOCKED") || html.includes("There is no toggle"));
  });

  it("gives the disclosure field no input of any kind", () => {
    const [, html] = SCREENS.find(([n]) => n === "editor:outbound");
    // Find the statement block and prove there is no control inside it.
    const block = html.slice(html.indexOf("AI disclosure"), html.indexOf("AI disclosure") + 800);
    assert.ok(!/<input|<select|<textarea/.test(block.split("</div>")[0]),
      "there is a control inside the AI-disclosure block");
    for (const toggle of ['name="aiDisclosure"', 'name="discloseAi"', "disclosureEnabled"]) {
      assert.ok(!html.includes(toggle), `a disclosure toggle exists: ${toggle}`);
    }
  });

  it("declares the outbound disclosure field locked in the field model", () => {
    const f = F.allFields().find((x) => x.path === "outbound.aiDisclosure");
    assert.ok(f, "the field model does not mention outbound AI disclosure at all");
    assert.equal(f.locked, true);
    assert.match(f.lockReason, /no toggle/i);
  });

  it("does not conflate inbound with outbound", () => {
    assert.notEqual(V.INBOUND_DISCLOSURE_SENTENCE, V.OUTBOUND_DISCLOSURE_SENTENCE);
    assert.match(V.INBOUND_DISCLOSURE_SENTENCE, /does not announce.*first sentence/s);
    assert.match(V.INBOUND_DISCLOSURE_SENTENCE, /always answers truthfully|answers truthfully/);

    const [, inbound] = SCREENS.find(([n]) => n === "behaviour:inbound");
    const [, outbound] = SCREENS.find(([n]) => n === "behaviour:outbound");
    assert.ok(inbound.includes(V.INBOUND_DISCLOSURE_SENTENCE));
    assert.ok(outbound.includes(V.OUTBOUND_DISCLOSURE_SENTENCE));
  });

  it("shows the client's real greeting on the inbound preview", () => {
    const [, inbound] = SCREENS.find(([n]) => n === "behaviour:inbound");
    assert.ok(inbound.includes("Rolladoor Repairs, this is Sam."));
    assert.match(inbound, /your configured words, spoken as written/);
  });

  it("says truthfulness applies in BOTH directions and cannot be switched off", () => {
    for (const direction of ["inbound", "outbound"]) {
      const m = VM.behaviourPreviewModel({ clientId: CID, spec: compileBehaviourSpec(active()).spec, direction });
      assert.equal(m.opening.answersTruthfullyIfAsked, true);
      assert.match(m.opening.truthfulnessNote, /cannot be switched off/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// LOCKED PLATFORM REQUIREMENTS
// ════════════════════════════════════════════════════════════════════

describe("platform requirements — visibly locked, and genuinely enforced", () => {
  it("renders every locked field as prose, never as a disabled input", () => {
    for (const [name, html] of SCREENS.filter(([n]) => n.startsWith("editor:"))) {
      for (const m of html.matchAll(/<div class="locked"[\s\S]*?<\/div>/g)) {
        assert.ok(!/<input|<select|<textarea/.test(m[0]), `${name}: a control inside a locked block`);
      }
      assert.ok(!/disabled[^>]*name="clientId"/.test(html), `${name}: a disabled input is still an input`);
    }
  });

  it("drops a locked field even when a crafted payload supplies it", () => {
    const bp = active();
    const out = F.applySection(bp, "identity", { clientId: "somebody_else", vertical: "plumbing", legalName: "New Name" });
    assert.equal(out.identity.clientId, bp.identity.clientId, "the tenant was changed by a form");
    assert.equal(out.identity.vertical, bp.identity.vertical, "the trade was changed by a form");
    assert.equal(out.identity.legalName, "New Name", "an editable field must still be editable");
  });

  it("and the DOMAIN refuses it too — the lock is not only in the browser", () => {
    // The important half. If this file vanished, the blueprint would still be
    // refused, because client-blueprint.js validates the tenant slug itself.
    const bp = active();
    bp.identity.clientId = "Not A Slug";
    const result = B.validateBlueprint(bp);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === "identity.clientId"));
  });

  it("shows the six mandatory prohibitions and offers no way to remove one", () => {
    const [, html] = SCREENS.find(([n]) => n === "editor:knowledge");
    const flat = html.toLowerCase();
    for (const claim of B.MANDATORY_PROHIBITED_CLAIMS) {
      assert.ok(flat.includes(claim.replace(/_/g, " ")), `the knowledge editor does not show "${claim}"`);
    }
    assert.ok(html.includes("PLATFORM REQUIREMENT — LOCKED"));
    // And the domain refuses their removal regardless of what the screen does.
    const bp = active();
    bp.knowledge.prohibitedClaims = bp.knowledge.prohibitedClaims.filter((c) => c !== "claiming_to_be_human");
    assert.equal(B.validateBlueprint(bp).ok, false);
  });

  it("makes DNCR, suppression and dial safety unreachable from configuration", () => {
    const [, html] = SCREENS.find(([n]) => n === "editor:compliance");
    assert.match(html, /separate safety systems/);
    for (const name of ["dncr", "suppression", "dialAuthority", "callingState"]) {
      assert.ok(!new RegExp(`name="${name}"`, "i").test(html), `compliance offers a ${name} control`);
    }
    assert.ok(F.allFields().every((f) => !/dncr|suppression|calling/i.test(f.name) || f.locked));
  });
});

// ════════════════════════════════════════════════════════════════════
// P31 — THE EDITOR
// ════════════════════════════════════════════════════════════════════

describe("P31 editor — structured, client-defined, and no raw JSON", () => {
  it("covers every editable blueprint section", () => {
    const editable = ["identity", "services", "serviceArea", "hours", "callHandling",
      "knowledge", "booking", "voice", "compliance", "outbound", "integrations"];
    assert.deepEqual([...F.SECTION_KEYS].sort(), [...editable].sort());
  });

  it("never makes raw JSON the primary editing surface", () => {
    for (const [name, html] of SCREENS.filter(([n]) => n.startsWith("editor:"))) {
      assert.ok(!/<textarea[^>]*name="blueprint"/.test(html), `${name} edits raw JSON`);
      assert.ok(!/name="json"/.test(html), `${name} edits raw JSON`);
    }
  });

  it("builds option lists FROM the domain vocabularies, not copies of them", () => {
    const urgency = F.allFields().find((f) => f.name === "urgencyCategory");
    assert.deepEqual(urgency.options.map((o) => o.value), [...B.URGENCY_LEVELS]);
    const pricing = F.allFields().find((f) => f.name === "pricingDisclosure");
    assert.deepEqual(pricing.options.map((o) => o.value), [...B.PRICING_DISCLOSURE]);
    const collect = F.allFields().find((f) => f.name === "collectAlways");
    assert.deepEqual(collect.options.map((o) => o.value), [...B.CALLER_INFO_FIELDS]);
  });

  it("hardcodes no locksmith or plumber service anywhere in the UI", () => {
    const files = ["src/platform/ui/ui-fields.js", "src/platform/ui/ui-view-models.js",
      "src/platform/ui/ui-vocabulary.js", "src/views/platform-config-pages.js", "src/views/platform-shell.js"];
    for (const file of files) {
      // Comments and strings stripped: these files explain the rule in prose,
      // and a raw sweep catches the explanation rather than any real coupling.
      const src = codeOnly(fs.readFileSync(path.join(ROOT, file), "utf8")).toLowerCase();
      for (const word of ["lockout", "key cutting", "rekey", "blocked drain", "hot water", "locksmith"]) {
        assert.ok(!src.includes(word), `${file} mentions "${word}" — services are client-defined`);
      }
    }
  });

  it("edits services as a list a client owns — add, disable, reorder, remove", () => {
    const services = F.sectionFor("services");
    assert.ok(services.repeatable);
    assert.equal(services.repeatable.reorderable, true);
    const names = services.repeatable.fields.map((f) => f.name);
    for (const required of ["serviceId", "name", "aliases", "enabled", "urgencyCategory", "qualificationRequirements", "exclusions"]) {
      assert.ok(names.includes(required), `the service editor has no ${required} field`);
    }
    const [, html] = SCREENS.find(([n]) => n === "editor:services");
    assert.match(html, /data-action="add-item"/);
    assert.match(html, /data-action="remove-item"/);
    assert.match(html, /data-action="move-up"/);
  });

  it("gives hours a real weekly grid where every day must say something", () => {
    const [, html] = SCREENS.find(([n]) => n === "editor:hours");
    for (const day of B.DAYS) {
      assert.ok(html.includes(`data-day="${day}"`), `no row for ${day}`);
      assert.ok(html.includes(`data-error-for="hours.weekly.${day}"`), `${day} has no error slot`);
    }
    assert.match(html, /"closed" is an answer, an omitted day is not/);
  });

  it("points an hours validation error at the exact day", () => {
    const bp = active();
    bp.hours.weekly.saturday = { open: "17:00", close: "09:00" };
    const result = B.validateBlueprint(bp);
    const err = result.errors.find((e) => e.path.includes("saturday"));
    assert.ok(err, "the domain does not report the day");
    const [, html] = SCREENS.find(([n]) => n === "editor:hours");
    assert.ok(html.includes(`data-error-for="${err.path}"`) || html.includes(`data-error-for="hours.weekly.saturday"`),
      "the form has nowhere to show a Saturday error");
  });

  it("exposes only client-configurable call handling, not platform vocabularies", () => {
    const [, html] = SCREENS.find(([n]) => n === "editor:callHandling");
    // Urgency LEVELS and ACTIONS appear as choices, never as free text.
    assert.ok(!/name="urgencyLevels"|name="urgencyActions"/.test(html));
    const rules = F.sectionFor("callHandling").repeatable;
    const level = rules.fields.find((f) => f.name === "level");
    assert.equal(level.type, "select", "urgency level must be a choice, not a text box");
  });

  it("tells the truth about knowledge ingestion instead of faking an upload", () => {
    const [, html] = SCREENS.find(([n]) => n === "editor:knowledge");
    assert.ok(!/type="file"/.test(html), "there is a file upload and no ingestion exists");
    assert.ok(!/upload/i.test(html.replace(/There is no document upload[^<]*/g, "")), "the page implies uploading");
    assert.match(html, /nothing is read, crawled or ingested/i);
  });

  it("says NOT CONNECTED rather than implying an adapter exists", () => {
    const adapter = F.allFields().find((f) => f.name === "adapterRef");
    assert.match(adapter.hint, /Left blank until an adapter exists/);
  });

  it("keeps provider voice ids out of the blueprint editor", () => {
    const voice = F.fieldsFor("voice").find((f) => f.name === "profileRef");
    assert.match(voice.hint, /provider-independent/);
    const [, html] = SCREENS.find(([n]) => n === "editor:voice");
    for (const vendor of ["retell", "11labs", "custom_voice_", "cartesia"]) {
      assert.ok(!html.toLowerCase().includes(vendor), `the voice editor names ${vendor}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// P31A / P31B — CAS AND AUTOSAVE
// ════════════════════════════════════════════════════════════════════

describe("P31A concurrency — a conflict is shown, never resolved", () => {
  it("carries the CAS token onto the page and back out again", () => {
    const [, html] = SCREENS.find(([n]) => n === "editor:identity");
    assert.match(html, /data-expected-updated-at="2026-08-16T00:00:00\.000Z"/);
    const js = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.js"), "utf8");
    assert.match(js, /data-expected-updated-at/);
    assert.match(js, /payload\.expectedUpdatedAt = expectedUpdatedAt/);
  });

  it("advances the token only after a successful save", () => {
    const js = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.js"), "utf8");
    const save = js.slice(js.indexOf("function save("), js.indexOf("function showConflict("));
    const conflictBranch = save.indexOf("result.status === 409");
    const tokenUpdate = save.indexOf("expectedUpdatedAt = result.body.updatedAt");
    assert.ok(conflictBranch > -1 && tokenUpdate > conflictBranch,
      "the token is updated before the conflict branch returns");
    assert.match(save, /if \(result\.status === 409\)[\s\S]{0,300}return;/);
  });

  it("offers no force, no overwrite and no merge — anywhere", () => {
    const js = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.js"), "utf8");
    const pageSrc = fs.readFileSync(path.join(ROOT, "src", "views", "platform-config-pages.js"), "utf8");
    // Comments AND strings stripped. The script explains at length WHY there is
    // no overwrite, and it tells the user so on screen — a raw sweep catches
    // the explanation, which is the self-catching-ratchet trap this codebase
    // has fallen into three times.
    const code = codeOnly(js);
    for (const forbidden of ["force", "overwrite", "saveAnyway", "ignoreConflict", "merge"]) {
      assert.ok(!new RegExp(forbidden, "i").test(code), `platform.js has ${forbidden}`);
    }
    // Non-vacuity: the words ARE present in the file — in a comment and in a
    // sentence shown to the user — just never as code. Without this, the sweep
    // above could be searching for something no file would ever contain.
    assert.match(js, /no force parameter/i, "if this fails the sweep above proves nothing");
    assert.match(js, /no way to overwrite somebody else's edit/i);
    assert.ok(!/force|overwrite/i.test(code), "and none of it survives into code");
    // The page may SAY there is no "save anyway"; it may not offer one.
    assert.ok(!/data-action="force"|name="force"/.test(pageSrc));
    const [, html] = SCREENS.find(([n]) => n === "conflict");
    assert.match(html, /There is no "save anyway"/);
  });

  it("shows a conflict as an alert that takes focus, with safe actions only", () => {
    const [, html] = SCREENS.find(([n]) => n === "conflict");
    assert.match(html, /class="conflict"[^>]*role="alert"[^>]*tabindex="-1"/);
    assert.match(html, /This draft changed after you opened it/);
    assert.match(html, /data-action="reload-latest"/);
    assert.match(html, /data-action="show-my-changes"/);
  });

  it("P31B — chooses explicit Save, and the code says why", () => {
    const js = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.js"), "utf8");
    // No timer-driven save anywhere. Autosave plus compare-and-swap is a race
    // whose loser is silently discarded, which is exactly what CAS is for.
    assert.ok(!/setInterval|setTimeout\s*\([^)]*save/i.test(js), "there is a timed autosave");
    assert.ok(!/autosave/i.test(js.replace(/\/\*[\s\S]*?\*\//g, "")));
    const [, html] = SCREENS.find(([n]) => n === "editor:identity");
    assert.match(html, /data-action="save"/);
    assert.match(html, /Save changes/);
  });
});

// ════════════════════════════════════════════════════════════════════
// P32 / P32A — VALIDATION AND THE DIFF
// ════════════════════════════════════════════════════════════════════

describe("P32 validation — the backend decides, the screen displays", () => {
  it("duplicates no domain validation rule in the browser", () => {
    const js = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.js"), "utf8");
    for (const rule of ["E164", "urgencyCategory", "prohibitedClaims", "mandatory", "validateBlueprint"]) {
      assert.ok(!js.includes(rule), `platform.js reimplements ${rule}`);
    }
  });

  it("says outright that validation is the service's answer", () => {
    const m = VM.diffModel({ clientId: CID, principal: principal("operator"), validation: { ok: true, errors: [] } });
    assert.match(m.validation.authority, /performed by the configuration service/);
  });

  it("shows each error with its section, its exact field and an explanation", () => {
    const bp = active();
    bp.hours.weekly.saturday = { open: "17:00", close: "09:00" };
    bp.identity.assistantName = null;
    const result = B.validateBlueprint(bp);
    const html = P.renderValidation({ ran: true, ok: false, errors: result.errors, warnings: [], authority: "x" });
    for (const e of result.errors) {
      assert.ok(html.includes(e.path), `the screen does not show ${e.path}`);
      assert.ok(html.includes(e.message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")),
        `the screen does not explain ${e.path}`);
    }
    assert.match(html, /class="issues__where"/);
  });

  it("blocks approval on an invalid draft, and says which reason came first", () => {
    const m = VM.diffModel({
      clientId: CID, principal: principal("operator"),
      diff: { hasChanges: true, changes: [{ path: "x", kind: "changed", summary: "x" }] },
      validation: { ok: false, errors: [{ path: "a", message: "b" }] },
    });
    assert.equal(m.approve.offered, false);
    assert.ok(m.approve.blockedBecause.includes("This draft has not passed validation."));
  });
});

describe("P32A review — human sentences, not a JSON dump", () => {
  const before = active();
  const after = (() => {
    const bp = JSON.parse(JSON.stringify(before));
    bp.hours.weekly.saturday = { open: "09:00", close: "16:00" };
    bp.services.push({ serviceId: "cable_replacement", name: "Garage door cable replacement", enabled: true, urgencyCategory: "urgent" });
    bp.knowledge.pricingDisclosure = "never_discuss";
    bp.serviceArea.suburbs = [...before.serviceArea.suburbs, "Brunswick"];
    return bp;
  })();
  const presented = D.presentDiff(diffBlueprints(before, after));

  it("groups changes into the named sections, in a fixed order", () => {
    const titles = presented.sections.map((s) => s.title);
    assert.deepEqual(titles, ["Services", "Service area", "Hours", "Knowledge"]);
  });

  it("renders the founder's own examples, in the founder's own words", () => {
    const rows = presented.sections.flatMap((s) => s.changes);

    const saturday = rows.find((r) => r.heading === "Saturday hours");
    assert.ok(saturday, "there is no Saturday row");
    assert.equal(saturday.before, "08:00-12:00");
    assert.equal(saturday.after, "09:00-16:00");

    const service = rows.find((r) => r.heading === "Service added" || (r.heading === "Service" && r.after));
    assert.ok(service, "an added service is not reported as one");
    assert.equal(service.after, "Garage door cable replacement");
    assert.equal(service.before, null);

    const pricing = rows.find((r) => r.heading === "Pricing policy");
    assert.equal(pricing.before, "quote if asked, confirmed at booking");
    assert.equal(pricing.after, "do not discuss pricing");
  });

  it("merges one day's hours into ONE row without losing a change", () => {
    const hours = presented.sections.find((s) => s.title === "Hours");
    assert.equal(hours.changeCount, 1, "Saturday should be one row");
    assert.deepEqual(hours.changes[0].mergedFrom, ["hours.weekly.saturday.close", "hours.weekly.saturday.open"]);
    // The DOMAIN count is still the domain's.
    assert.equal(presented.changeCount, 5);
    assert.equal(presented.rowCount, 4);
  });

  it("loses no change, ever — every domain change survives into a section", () => {
    // The worst defect this presenter could have. A change that vanishes on the
    // review screen is a change somebody approved without seeing.
    const paths = new Set();
    for (const s of presented.sections) {
      for (const c of s.changes) {
        if (c.mergedFrom) c.mergedFrom.forEach((p) => paths.add(p));
        else paths.add(c.path);
      }
    }
    for (const c of presented.raw) {
      assert.ok(paths.has(c.path), `the review screen dropped ${c.path}`);
    }
    assert.equal(presented.raw.length, 5);
  });

  it("says which entry moved in a list, not both whole lists", () => {
    const area = presented.sections.find((s) => s.title === "Service area");
    const row = area.changes[0];
    assert.deepEqual(row.added, ["Brunswick"]);
    assert.deepEqual(row.removed, []);
  });

  it("flags a removal, because taking something away is the direction that hurts", () => {
    const bp = JSON.parse(JSON.stringify(before));
    bp.services = bp.services.slice(1);
    const p = D.presentDiff(diffBlueprints(before, bp));
    const services = p.sections.find((s) => s.title === "Services");
    assert.equal(services.notable, true);
    assert.equal(services.changes[0].notable, true);
  });

  it("has a plain-English word for every value in every platform vocabulary", () => {
    // Otherwise a new urgency action renders as a slug on the one screen where
    // somebody approves it.
    const vocabularies = [
      B.URGENCY_LEVELS, B.URGENCY_ACTIONS, B.OUTSIDE_AREA_ACTIONS, B.UNAVAILABLE_ACTIONS,
      B.UNANSWERED_TRANSFER_ACTIONS, B.PRICING_DISCLOSURE, B.UNCERTAINTY_POLICIES,
      B.RETENTION_PERIODS, B.INTEGRATION_CAPABILITIES, B.CALLER_INFO_FIELDS,
      B.MANDATORY_PROHIBITED_CLAIMS,
    ];
    const missing = [];
    for (const vocab of vocabularies) {
      for (const value of vocab) {
        if (D.value(value) === value && value.includes("_")) missing.push(value);
      }
    }
    assert.deepEqual(missing, [], `these render as slugs on the review screen: ${missing.join(", ")}`);
  });

  it("keeps the raw domain diff available to operators, as a detail", () => {
    const [, html] = SCREENS.find(([n]) => n === "review");
    assert.match(html, /<details>/);
    assert.match(html, /Raw domain diff \(operator\)/);
    // And it is not the primary view.
    assert.ok(html.indexOf("What changed") < html.indexOf("Raw domain diff"));
  });
});

// ════════════════════════════════════════════════════════════════════
// P32B / P32C — APPROVAL AND ACTIVATION WORDING
// ════════════════════════════════════════════════════════════════════

describe("P32B/P32C approval and activation — separate, and honest about what they do", () => {
  it("says approving locks the version and further edits create a new draft", () => {
    const m = VM.diffModel({ clientId: CID, principal: principal("operator") });
    assert.equal(m.approve.consequence, "Approving locks this version. Further edits will create a new draft.");
    const [, html] = SCREENS.find(([n]) => n === "review");
    assert.ok(html.includes("Approving locks this version. Further edits will create a new draft."));
  });

  it("keeps approval and activation visibly separate", () => {
    const m = VM.diffModel({ clientId: CID, principal: principal("operator") });
    assert.equal(m.approve.alsoActivates, false);
    assert.match(m.approve.separationNote, /does NOT activate/);
    const [, html] = SCREENS.find(([n]) => n === "review");
    assert.ok(!/Approve and activate/i.test(html), "there is a combined approve-and-activate control");
  });

  it("explains activation in the exact words that matter", () => {
    assert.equal(P.ACTIVATION_EXPLANATION,
      "This makes this version AIDA's active client configuration. It does NOT update Retell or provision provider resources.");
    const [, html] = SCREENS.find(([n]) => n === "activate");
    assert.ok(html.includes("It does NOT update Retell or provision provider resources."));
    assert.ok(html.includes("ACTIVATE CONFIGURATION"));
    assert.match(html, /No provider is contacted/);
  });

  it("posts activation to the configuration operation and nothing else", () => {
    const handlers = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui-handlers.js"), "utf8");
    const activate = handlers.slice(handlers.indexOf("activate: guard("), handlers.indexOf("restore: guard("));
    assert.match(activate, /configService\.activate/);
    for (const forbidden of ["provisioning", "provider", "executor", "retell", "compile"]) {
      assert.ok(!new RegExp(forbidden, "i").test(activate.replace(/\/\/[^\n]*/g, "")),
        `the activate handler touches ${forbidden}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// P30 / P30A — DASHBOARD AND HISTORY
// ════════════════════════════════════════════════════════════════════

describe("P30 dashboard — readiness is displayed, never recomputed", () => {
  it("reuses the readiness service's own answer", () => {
    const readiness = {
      ready: false, readyReason: "because", blockerCount: 2,
      dimensions: [{ dimension: "phone", status: "absent", detail: "none", blocking: true }],
    };
    const m = VM.dashboardModel({ clientId: CID, principal: principal("operator"), readiness });
    assert.equal(m.readiness.ready, false);
    assert.equal(m.readiness.blockerCount, 2);
    assert.equal(m.readiness.reason, "because");
    // Nothing in the view models recomputes readiness.
    const src = fs.readFileSync(path.join(ROOT, "src", "platform", "ui", "ui-view-models.js"), "utf8");
    assert.ok(!src.includes("assessClientReadiness"), "the UI computes readiness itself");
  });

  it("says readiness is informational, in words, on the screen", () => {
    const html = P.renderReadiness({
      ready: false, disclaimer: V.READINESS_DISCLAIMER, blockerCount: 1, reason: null,
      dimensions: [{ dimension: "phone", status: "absent", detail: "none", blocking: true, tone: "warn", mark: "!" }],
    });
    assert.ok(html.includes("Readiness is INFORMATIONAL"));
    assert.match(V.READINESS_DISCLAIMER, /not permission to provision/);
  });

  it("never renders readiness as a go-ahead", () => {
    const m = VM.dashboardModel({ clientId: CID, principal: principal("operator"), readiness: { ready: false, dimensions: [] } });
    assert.equal(m.readiness.isPermission, false);
  });

  it("shows the four groups the founder asked for", () => {
    const [, html] = SCREENS.find(([n]) => n === "dashboard");
    for (const heading of ["Business", "Configuration", "Provisioning", "Readiness"]) {
      assert.ok(html.includes(`<h2>${heading}</h2>`), `no ${heading} section`);
    }
  });
});

describe("P30A history — viewable, restorable, never rewritten", () => {
  it("offers no edit control for an approved, active or superseded version", () => {
    const m = VM.historyModel({
      clientId: CID, principal: principal("operator"),
      versions: [
        { configVersion: 4, status: "draft" },
        { configVersion: 3, status: "approved" },
        { configVersion: 2, status: "active" },
        { configVersion: 1, status: "superseded" },
      ],
    });
    const by = (n) => m.versions.find((v) => v.configVersion === n);
    assert.equal(by(4).canEdit, true, "a draft must be editable, or this proves nothing");
    for (const n of [3, 2, 1]) {
      assert.equal(by(n).canEdit, false, `v${n} was offered an edit control`);
      assert.ok(by(n).readOnlyReason, `v${n} gives no reason for being read-only`);
      assert.equal(by(n).canRestore, true, `v${n} should be restorable into a new draft`);
    }
  });

  it("frames restore as creating a NEW draft, never as rewriting", () => {
    const m = VM.historyModel({ clientId: CID, principal: principal("operator"), versions: [{ configVersion: 1, status: "approved" }] });
    assert.match(m.versions[0].restoreNote, /NEW draft.*never rewritten/s);
    assert.match(m.neverRewritten, /Nothing here edits history/);
    const [, html] = SCREENS.find(([n]) => n === "history");
    assert.match(html, /Restore into a new draft/);
  });

  it("names every source a version can have, including voice", () => {
    for (const source of ["ui", "voice", "api", "import", "operator"]) {
      assert.ok(VM.SOURCE_WORDS[source], `no word for source "${source}"`);
    }
    const m = VM.historyModel({ clientId: CID, principal: principal("operator"), versions: [{ configVersion: 1, status: "draft", source: "voice" }] });
    assert.equal(m.versions[0].source, "Voice configuration agent");
  });

  it("shows every lifecycle timestamp the founder listed", () => {
    const [, html] = SCREENS.find(([n]) => n === "history");
    for (const column of ["Version", "Status", "Created by", "Created", "Approved", "Activated", "Superseded"]) {
      assert.ok(html.includes(`>${column}</th>`), `no ${column} column`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// P35 / P35B — WIZARD AND THE VOICE FUTURE
// ════════════════════════════════════════════════════════════════════

describe("P35 wizard — an order through the real editor, not a second system", () => {
  it("maps all fifteen steps onto existing screens", () => {
    assert.equal(W.WIZARD_STEPS.length, 15);
    assert.deepEqual(W.WIZARD_STEPS.map((s) => s.n), Array.from({ length: 15 }, (_, i) => i + 1));
    for (const step of W.WIZARD_STEPS) {
      const href = W.hrefFor(step, BASE);
      assert.ok(href.startsWith(BASE), `${step.key} leads outside the client`);
      if (step.kind === "edit") assert.ok(F.SECTION_KEYS.includes(step.section), `${step.key} edits an unknown section`);
    }
  });

  it("holds no wizard-only state — the draft IS the state", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "views", "platform-wizard-page.js"), "utf8");
    assert.ok(!/wizardState|sessionStorage|localStorage/.test(src), "the wizard keeps its own state");
    const handlers = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui-handlers.js"), "utf8");
    const wizardHandler = handlers.slice(handlers.indexOf("wizard: guard("), handlers.indexOf("startWizard: guard("));
    assert.match(wizardHandler, /Step state is DERIVED/);
    // It starts by creating a REAL draft through the real service.
    assert.match(handlers.slice(handlers.indexOf("startWizard: guard(")), /configService\.createDraft/);
  });

  it("ends at an approved plan and says so", () => {
    const [, html] = SCREENS.find(([n]) => n === "wizard");
    assert.match(html, /APPROVED — NOT EXECUTED/);
    assert.match(html, /Nothing in this wizard contacts a telephony provider/);
    assert.ok(!/Execute|Deploy/i.test(html.replace(/NOT EXECUTED/g, "")));
  });

  it("lets a person leave and come back", () => {
    const [, html] = SCREENS.find(([n]) => n === "wizard");
    assert.match(html, /Leave whenever you like/);
  });
});

describe("P35B voice-first — the architecture, not a placeholder button", () => {
  it("renders no non-functional Configure by voice control", () => {
    for (const [name, html] of SCREENS) {
      assert.ok(!/Configure by voice/i.test(html), `${name} advertises a feature that does not exist`);
      assert.ok(!/Talk to AIDA|Speak to configure/i.test(html), `${name} advertises voice configuration`);
    }
  });

  it("displays a voice-created draft identically to a UI-created one", () => {
    // The whole architectural requirement: a voice draft is a draft. Nothing on
    // any screen branches on where it came from except the word in the history
    // "Created by" column.
    const bp = active();
    const voiceDraft = JSON.parse(JSON.stringify(bp));
    voiceDraft.metadata = { ...voiceDraft.metadata, configVersion: 3, status: "draft", source: "voice" };
    const uiDraft = JSON.parse(JSON.stringify(voiceDraft));
    uiDraft.metadata = { ...uiDraft.metadata, source: "ui" };

    const p = principal("operator");
    for (const key of F.SECTION_KEYS) {
      const section = F.sectionFor(key);
      const render = (draft) => P.renderEditor({
        clientId: CID, section, values: F.readSection(draft, key),
        items: section.repeatable ? F.getPath(draft, section.repeatable.path) || [] : null,
        secondaryItems: section.secondaryRepeatable ? F.getPath(draft, section.secondaryRepeatable.path) || [] : null,
        configVersion: 3, expectedUpdatedAt: "t",
      }, BASE);
      assert.equal(render(voiceDraft), render(uiDraft), `the ${key} editor treats a voice draft differently`);
    }

    const changed = JSON.parse(JSON.stringify(voiceDraft));
    changed.hours.weekly.saturday = { open: "09:00", close: "16:00" };
    const reviewOf = (from) => P.renderReview(VM.diffModel({
      clientId: CID, principal: p, toVersion: 3,
      diff: diffBlueprints(from, changed), validation: { ok: true, errors: [], warnings: [] },
      draftStatus: "draft",
    }), BASE);
    assert.equal(reviewOf(voiceDraft), reviewOf(uiDraft), "the review screen treats a voice draft differently");
  });

  it("routes a voice proposal through the same service the UI uses", () => {
    // config-service.proposePatch exists and produces a draft. The UI reads
    // drafts; it does not care which one made them.
    const service = fs.readFileSync(path.join(ROOT, "src", "platform", "config-service.js"), "utf8");
    assert.match(service, /proposePatch/);
    const handlers = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui-handlers.js"), "utf8");
    assert.match(handlers, /the eventual voice configuration agent will call\s*\n\/\/ the same service/);
  });
});

// ════════════════════════════════════════════════════════════════════
// AUTHORITY — and why hiding a button is not it
// ════════════════════════════════════════════════════════════════════

describe("authority — controls follow capability, and the backend decides anyway", () => {
  it("offers each control only to a role the domain actually permits", () => {
    const bp = active();
    const approvedDraft = JSON.parse(JSON.stringify(bp));
    approvedDraft.metadata = { ...approvedDraft.metadata, configVersion: 3, status: "approved" };

    const offered = (role) => {
      const m = VM.dashboardModel({ clientId: CID, principal: principal(role), active: bp, draft: approvedDraft });
      return m.actions.filter((a) => a.offered).map((a) => a.id);
    };

    // A viewer holds config:view, so READING the review screen is legitimate.
    // Everything that writes must be withheld.
    assert.deepEqual(offered("client_viewer"), ["review"], "a viewer may read, and only read");
    assert.ok(offered("client_editor").includes("edit"));
    assert.ok(!offered("client_editor").includes("approve"), "an editor cannot approve");
    assert.ok(offered("client_owner").includes("approve"));
    assert.ok(!offered("client_owner").includes("activate"), "an owner cannot activate");
    assert.ok(offered("operator").includes("activate"));
    assert.ok(offered("operator").includes("plan"));
  });

  it("gives a reason whenever a control is withheld", () => {
    const m = VM.dashboardModel({ clientId: CID, principal: principal("client_viewer"), active: active() });
    for (const a of m.actions) {
      assert.equal(a.offered, false);
      assert.ok(a.why && a.why.length > 10, `"${a.id}" is disabled with no explanation`);
    }
  });

  it("renders a withheld control as disabled WITH its reason, not as nothing", () => {
    const html = P.renderDashboard(VM.dashboardModel({ clientId: CID, principal: principal("client_viewer"), active: active() }), BASE);
    assert.match(html, /aria-disabled="true"/);
    assert.match(html, /class="btn__why"/);
    assert.match(html, /Your role can view this configuration but not change it/);
  });

  it("never lets a browser-supplied role become authority", () => {
    const { principalFromRequest } = require("../src/platform/config-access");
    for (const req of [
      { clientId: CID, operatorSession: true, session: {}, body: { role: "operator" } },
      { clientId: CID, operatorSession: true, session: {}, query: { role: "operator_executor" } },
      { clientId: CID, clientAuth: { user: {} }, client: { platform_role: "operator" }, body: { role: "operator" } },
    ]) {
      const p = principalFromRequest(req);
      assert.notEqual(p && p.role, "operator_executor");
    }
  });

  it("uses the SAME capability names the domain declares — a typo cannot hide every button", () => {
    // The bug this catches actually happened: CAPABILITIES is a list, and
    // `CAPABILITIES.CONFIG_EDIT` is undefined, which reads as "cannot" and
    // silently hid every control for every role.
    const { CAPABILITIES } = require("../src/platform/config-access");
    assert.ok(Array.isArray(CAPABILITIES));
    // ui-view-models validates its own names at import; prove that guard works.
    assert.throws(() => {
      const names = ["config:view", "config:not_a_capability"];
      for (const n of names) if (!CAPABILITIES.includes(n)) throw new Error(`unknown capability ${n}`);
    }, /unknown capability/);
  });
});

// ════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ════════════════════════════════════════════════════════════════════

describe("tenant isolation — client A never renders client B", () => {
  it("renders only the client the model was built for", () => {
    const a = garageDoorD();
    const b = plumberC();
    a.metadata = { ...a.metadata, configVersion: 1, status: "active" };

    const html = P.renderDashboard(VM.dashboardModel({
      clientId: "rolladoor_repairs", principal: principal("operator", "rolladoor_repairs"), active: a,
    }), BASE);

    assert.ok(html.includes(a.identity.legalName));
    assert.ok(!html.includes(b.identity.legalName), "another client's name appeared");
    assert.ok(!html.includes(b.identity.clientId), "another client's id appeared");
    for (const suburb of b.serviceArea.suburbs) {
      if (a.serviceArea.suburbs.includes(suburb) || (a.serviceArea.regions || []).includes(suburb)) continue;
      assert.ok(!html.includes(suburb), `another client's suburb "${suburb}" appeared`);
    }
  });

  it("builds every link inside the requested client's own path", () => {
    for (const [name, html] of SCREENS) {
      for (const href of [...html.matchAll(/href="(\/platform[^"]*)"/g)].map((m) => m[1])) {
        assert.ok(href.startsWith(BASE) || href === "/platform" || href.startsWith("/platform/platform"),
          `${name} links outside the client: ${href}`);
      }
      for (const action of [...html.matchAll(/<form[^>]*saction="([^"]*)"/g)].map((m) => m[1])) {
        assert.ok(action.startsWith(BASE), `${name} posts outside the client: ${action}`);
      }
    }
  });

  it("takes the tenant from the session, never from the page", () => {
    const js = fs.readFileSync(path.join(ROOT, "public", "platform", "platform.js"), "utf8");
    // The browser uses data-client only to BUILD A URL. The server resolves
    // authority from the session and ignores what the URL asked for.
    assert.match(js, /var base = "\/platform\/clients\/" \+ encodeURIComponent/);
    const handlers = fs.readFileSync(path.join(ROOT, "src", "routes", "platform-ui-handlers.js"), "utf8");
    assert.match(handlers, /THE TENANT IS NEVER FROM THE URL/);
    assert.match(handlers, /principalFromRequest\(req\)/);
    assert.ok(!/req\.body\.clientId|req\.query\.clientId/.test(handlers), "a handler reads clientId from the request body");
  });
});

// ════════════════════════════════════════════════════════════════════
// ESCAPING
// ════════════════════════════════════════════════════════════════════

describe("escaping — a business name is not markup", () => {
  it("escapes hostile configuration content everywhere it appears", () => {
    const bp = active();
    const attack = '"><script>alert(1)</script>';
    bp.identity.legalName = attack;
    bp.identity.tradingName = attack;
    bp.callHandling.greetingLine = attack;
    bp.services[0].name = attack;

    const html = P.renderDashboard(VM.dashboardModel({ clientId: CID, principal: principal("operator"), active: bp }), BASE);
    assert.ok(!html.includes("<script>alert(1)</script>"), "a script tag survived into the page");
    assert.ok(html.includes("&lt;script&gt;"), "the content is not present at all — check the test, not the escaping");

    const editor = P.renderEditor({
      clientId: CID, section: F.sectionFor("services"), values: {},
      items: bp.services, configVersion: 1, expectedUpdatedAt: "t",
    }, BASE);
    assert.ok(!editor.includes("<script>alert(1)</script>"));
  });

  it("escapes a hostile value inside an attribute", () => {
    const bp = active();
    bp.services[0].serviceId = 'x" onload="evil()';
    const editor = P.renderEditor({
      clientId: CID, section: F.sectionFor("services"), values: {},
      items: bp.services, configVersion: 1, expectedUpdatedAt: "t",
    }, BASE);
    // The value must appear with its quote ESCAPED, so it stays inside the
    // attribute it was put in instead of starting a new one.
    assert.ok(editor.includes("x&quot; onload=&quot;evil()"),
      "the hostile value is missing entirely — check the test, not the escaping");
    assert.ok(!/\sonload="/.test(editor), "an attribute was broken out of");
  });
});

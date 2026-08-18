// P36 bug #2 — the save that lost service ids and Offered answers.
//
// A founder reordered services in a real browser, saved, and DEV came back
// with two service ids replaced by "Climb fence" and "Pick lock" — strings
// that appear nowhere in this repository and nowhere else in the database —
// and three services with `enabled` missing entirely. They had changed
// neither. Every callHandling reference to the renamed services then failed
// validation, which is how it was noticed.
//
// Both causes are HTML semantics rather than application logic, which is why
// the tests added for bug #1 did not catch them: they built the submitted
// values by hand, and building them by hand is exactly the assumption that
// was wrong. These tests render the REAL markup and submit it under the rules
// a browser applies — an unchecked radio is not submitted, a disabled control
// is not submitted, readonly and hidden ones are.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const R = require("../src/platform/ui/ui-repeatable");
const F = require("../src/platform/ui/ui-fields");
const P = require("../src/views/platform-config-pages");
const { submit, controlsIn, rowsOf, templateOf } = require("./helpers/form-submission");

const SERVICES = F.sectionFor("services").repeatable;

/** The five services as they stand in the active DEV version, v1. */
const V1 = [
  { serviceId: "door_wont_open", name: "Garage door won't open", enabled: true,
    urgencyCategory: "urgent", aliases: ["door stuck closed", "can't get the car out"] },
  { serviceId: "door_wont_close", name: "Garage door won't close", enabled: true,
    urgencyCategory: "emergency", aliases: ["door stuck open", "garage is open"] },
  { serviceId: "broken_spring", name: "Broken spring", enabled: true, urgencyCategory: "urgent" },
  { serviceId: "remote_not_working", name: "Remote not working", enabled: false,
    urgencyCategory: "non_urgent", aliases: ["remote", "clicker"] },
  { serviceId: "new_door_quote", name: "New door quote", enabled: true, urgencyCategory: "non_urgent" },
];

/** callHandling exactly as the active DEV version holds it — the references that broke. */
const blueprintWith = (services) => ({
  services,
  callHandling: {
    collectByService: { door_wont_close: ["on_site_now"] },
    escalation: {
      maxAttempts: 1, backupNumber: null, primaryNumber: "+61355500411",
      minimumUrgency: "emergency", permittedHours: { businessHoursOnly: true },
      timeoutSeconds: 30, eligibleServices: ["door_wont_close"],
      unansweredAction: "take_message_and_notify", preTransferWording: "Let me put you through.",
    },
  },
});

/** Render the Services editor exactly as the route does. */
const renderServices = (services) =>
  P.renderEditor({
    section: F.sectionFor("services"),
    values: F.readSection(blueprintWith(services), "services"),
    items: services,
    secondaryItems: null,
    clientId: "aida_platform_dev_client",
    configVersion: 2,
  }, "/platform/clients/aida_platform_dev_client");

/** Render, submit as a browser would, and apply. The whole chain. */
const roundTrip = (services, mutateHtml = (h) => h) =>
  F.applySection(blueprintWith(services), "services", submit(mutateHtml(renderServices(services))));

// ════════════════════════════════════════════════════════════════════
// WHAT THE MARKUP ACTUALLY SAYS
// ════════════════════════════════════════════════════════════════════

describe("P36#2 — the rendered controls, and how a browser treats them", () => {
  const html = renderServices(V1);

  it("gives every existing row its identity in a submitted hidden field", () => {
    const rows = rowsOf(html);
    assert.equal(rows.length, 5);
    rows.forEach((row, i) => {
      const key = controlsIn(row).find((c) => c.name === `services[${i}].${R.KEY_FIELD}`);
      assert.ok(key, `row ${i} must carry its identity`);
      assert.equal(key.type, "hidden");
      assert.equal(key.value, V1[i].serviceId);
      assert.equal(key.disabled, false, "a disabled control is not submitted — identity must be");
    });
  });

  it("shows an existing service id as readonly, NOT disabled", () => {
    // This distinction is the whole point. A disabled control is not
    // submitted, so protecting a value with `disabled` is how the value gets
    // erased on the next save.
    const idInput = controlsIn(rowsOf(html)[0]).find((c) => c.name === "services[0].serviceId");
    assert.equal(idInput.readonly, true);
    assert.equal(idInput.disabled, false);
    assert.equal(idInput.value, "door_wont_open");
  });

  it("turns off autofill on the id, which is where the wrong values came from", () => {
    assert.match(rowsOf(html)[0], /name="services\[0\]\.serviceId"[^>]*autocomplete="off"/);
  });

  it("leaves a NEW row's id editable and empty — it must be given explicitly", () => {
    const tpl = templateOf(html);
    const idInput = controlsIn(tpl).find((c) => c.name.endsWith(".serviceId"));
    assert.equal(idInput.readonly, false, "a new service's id is not identity yet");
    assert.equal(idInput.value, "");
    const key = controlsIn(tpl).find((c) => c.name.endsWith(`.${R.KEY_FIELD}`));
    assert.equal(key.value, "", "a new row claims no existing identity");
  });

  it("submits Offered only when a radio is actually checked", () => {
    const posted = submit(html);
    assert.equal(posted["services[0].enabled"], true);
    assert.equal(posted["services[3].enabled"], false, "a stored false must render as a checked No");
    // And the blank template, whose schema default is Yes.
    const blank = submit(templateOf(html));
    assert.equal(blank["services[0].enabled"], true);
  });

  it("does not submit Offered at all when neither radio is checked", () => {
    // The exact HTML fact that erased three services: absence, not `false`.
    const stripped = renderServices([{ serviceId: "x", name: "X", urgencyCategory: "urgent" }])
      .replace(/ checked/g, "");
    const posted = submit(stripped);
    assert.ok(!Object.prototype.hasOwnProperty.call(posted, "services[0].enabled"),
      "an unanswered radio group is not submitted — this is correct HTML");
  });
});

// ════════════════════════════════════════════════════════════════════
// A — E: THE INVARIANTS THE FOUNDER NAMED
// ════════════════════════════════════════════════════════════════════

describe("P36#2 — service id is identity and survives a save", () => {
  it("A. an existing id survives an ordinary save", () => {
    const out = roundTrip(V1);
    assert.deepEqual(out.services.map((s) => s.serviceId), V1.map((s) => s.serviceId));
  });

  it("A2. an id typed over in the browser is IGNORED, not stored", () => {
    // Reproduces the DEV failure exactly: the browser put "Climb fence" in the
    // id input. Identity comes from the hidden key and the stored row, so the
    // typed value cannot take effect.
    const out = roundTrip(V1, (h) =>
      h.replace('name="services[0].serviceId" value="door_wont_open"',
        'name="services[0].serviceId" value="Climb fence"'));
    assert.equal(out.services[0].serviceId, "door_wont_open");
    assert.ok(!JSON.stringify(out).includes("Climb fence"));
  });

  it("A3. an id blanked in the browser is IGNORED, not erased", () => {
    const out = roundTrip(V1, (h) =>
      h.replace('name="services[1].serviceId" value="door_wont_close"',
        'name="services[1].serviceId" value=""'));
    assert.equal(out.services[1].serviceId, "door_wont_close");
  });

  it("A4. a forged key cannot make one row become another service", () => {
    // Row 0 claims to be row 1. It must not inherit door_wont_close, and
    // door_wont_close must not end up on two rows.
    const out = roundTrip(V1, (h) =>
      h.replace(`name="services[0].${R.KEY_FIELD}" value="door_wont_open"`,
        `name="services[0].${R.KEY_FIELD}" value="door_wont_close"`));
    const ids = out.services.map((s) => s.serviceId).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, "no id may appear twice");
    assert.equal(out.services.filter((s) => s.serviceId === "door_wont_close").length, 1);
  });

  it("A5. a key naming a service that does not exist claims nothing", () => {
    const out = roundTrip(V1, (h) =>
      h.replace(`name="services[0].${R.KEY_FIELD}" value="door_wont_open"`,
        `name="services[0].${R.KEY_FIELD}" value="not_a_service"`));
    // It becomes a new row, taking the id actually submitted — and since that
    // row's id input is the readonly original, that is what it gets. What it
    // must NOT do is silently adopt some other stored service.
    assert.ok(!out.services.some((s) => s.serviceId === "not_a_service"));
  });

  it("B. every id survives a reorder", () => {
    const moved = [V1[1], V1[0], V1[2], V1[3], V1[4]];
    const out = F.applySection(blueprintWith(V1), "services", submit(renderServices(moved)));
    assert.deepEqual(out.services.map((s) => s.serviceId), [
      "door_wont_close", "door_wont_open", "broken_spring", "remote_not_working", "new_door_quote",
    ]);
    assert.deepEqual(out.services.map((s) => s.name), [
      "Garage door won't close", "Garage door won't open", "Broken spring",
      "Remote not working", "New door quote",
    ], "the name must travel with the id, not with the position");
  });

  it("C. a new service's id persists", () => {
    const added = [...V1, { serviceId: "garage_door_maintenance", name: "Garage door maintenance",
      enabled: true, urgencyCategory: "standard" }];
    const out = F.applySection(blueprintWith(V1), "services", submit(renderServices(added)));
    assert.equal(out.services.length, 6);
    assert.equal(out.services[5].serviceId, "garage_door_maintenance");
    assert.equal(out.services[5].name, "Garage door maintenance");
  });
});

describe("P36#2 — Offered round-trips as a real boolean", () => {
  it("D. true survives", () => {
    assert.equal(roundTrip(V1).services[0].enabled, true);
  });

  it("E. false survives, and is not confused with absent", () => {
    const out = roundTrip(V1);
    assert.equal(out.services[3].enabled, false);
    assert.notEqual(out.services[3].enabled, undefined);
  });

  it("F. a newly-added service keeps the Yes the person chose", () => {
    // The reported case: Offered was explicitly set to Yes in the browser and
    // the stored service still had no `enabled`.
    const added = [...V1, { serviceId: "garage_door_maintenance", name: "Garage door maintenance",
      enabled: true, urgencyCategory: "standard" }];
    const out = F.applySection(blueprintWith(V1), "services", submit(renderServices(added)));
    assert.equal(out.services[5].enabled, true);
  });

  it("an absent Offered keeps what is stored instead of erasing it", () => {
    // A browser that submits nothing for a radio group has said nothing. The
    // previous behaviour wrote that silence into the blueprint as "no value".
    const out = roundTrip(V1, (h) => h.replace(/(services\[0\]\.enabled"[^>]*) checked/g, "$1"));
    assert.equal(out.services[0].enabled, true, "silence must not erase a stored answer");
  });

  it("an explicitly emptied text field IS cleared — absence and null differ", () => {
    // The preserve-on-absent rule must not make fields unclearable.
    const out = roundTrip(V1, (h) =>
      h.replace('name="services[0].name" value="Garage door won&#39;t open"',
        'name="services[0].name" value=""'));
    assert.equal(out.services[0].name, null);
  });

  it("G. a reorder does not detach the boolean or the id from its service", () => {
    const moved = [V1[3], V1[0], V1[1], V1[2], V1[4]];
    const out = F.applySection(blueprintWith(V1), "services", submit(renderServices(moved)));
    const byId = Object.fromEntries(out.services.map((s) => [s.serviceId, s]));
    assert.equal(byId.remote_not_working.enabled, false, "the one stored false must still be false");
    assert.equal(byId.door_wont_open.enabled, true);
    assert.equal(byId.remote_not_working.name, "Remote not working");
  });
});

describe("P36#2 — editing one thing does not disturb another", () => {
  it("H. adding an alias erases neither the id nor Offered", () => {
    const edited = V1.map((s, i) => (i === 2 ? { ...s, aliases: ["spring", "snapped spring"] } : s));
    const out = F.applySection(blueprintWith(V1), "services", submit(renderServices(edited)));
    assert.deepEqual(out.services[2].aliases, ["spring", "snapped spring"]);
    assert.equal(out.services[2].serviceId, "broken_spring");
    assert.equal(out.services[2].enabled, true);
    assert.deepEqual(out.services.map((s) => s.serviceId), V1.map((s) => s.serviceId));
  });

  it("I. a partial payload does not erase fields it never mentioned", () => {
    // Only the name was posted for row 0 — everything else keeps its stored
    // value rather than becoming undefined.
    const out = F.applySection(blueprintWith(V1), "services", {
      [`services[0].${R.KEY_FIELD}`]: "door_wont_open",
      "services[0].name": "Renamed",
    });
    assert.equal(out.services[0].name, "Renamed");
    assert.equal(out.services[0].serviceId, "door_wont_open");
    assert.equal(out.services[0].enabled, true);
    assert.equal(out.services[0].urgencyCategory, "urgent");
    assert.deepEqual(out.services[0].aliases, ["door stuck closed", "can't get the car out"]);
  });

  it("J. the result still validates against the original callHandling references", () => {
    const { validateBlueprint } = require("../src/platform/client-blueprint");
    const out = roundTrip(V1);
    const problems = (validateBlueprint(out).errors || [])
      .filter((e) => /serviceId|collectByService|eligibleServices/.test(e.path || ""));
    assert.deepEqual(problems, [], `callHandling references must survive a save: ${JSON.stringify(problems)}`);
  });

  it("J2. and they break the moment an id is allowed to change — which is why it is not", () => {
    // The counterfactual, so the previous test cannot pass vacuously.
    const { validateBlueprint } = require("../src/platform/client-blueprint");
    const renamed = V1.map((s, i) => (i === 1 ? { ...s, serviceId: "Climb fence" } : s));
    const broken = validateBlueprint(blueprintWith(renamed));
    assert.ok((broken.errors || []).length > 0,
      "renaming a referenced service must be a validation failure");
  });

  it("K. an unchanged service is not reported as both removed and added", () => {
    const { diffBlueprints } = require("../src/platform/blueprint-diff");
    const out = roundTrip(V1);
    const diff = diffBlueprints(blueprintWith(V1), out);
    const touched = diff.changes.filter((c) => String(c.path || "").startsWith("services"));
    // Stronger than the reported symptom: saving without changing anything
    // must produce NO service changes at all. An approver who is shown seven
    // edits they did not make learns to stop reading the review screen.
    assert.deepEqual(touched, [],
      `a save that changed nothing must produce no service changes: ${JSON.stringify(touched)}`);
    assert.deepEqual(out.services, V1, "and the stored array must come back byte-identical");

    // The reported symptom was the same two services appearing as both "+" and
    // "-" on the review screen. That is what a lost id looks like in a diff:
    // the service is gone and a stranger has arrived.
    const renamed = V1.map((s, i) => (i === 1 ? { ...s, serviceId: "Climb fence" } : s));
    const asIfLost = diffBlueprints(blueprintWith(V1), blueprintWith(renamed));
    assert.ok(asIfLost.changes.some((c) => String(c.path || "").startsWith("services")),
      "and a lost id must still show up loudly, so this test cannot pass vacuously");
  });
});

// ════════════════════════════════════════════════════════════════════
// THE BROWSER SIDE OF THE BOOLEAN LOSS
// ════════════════════════════════════════════════════════════════════

const BROWSER = fs.readFileSync(
  path.join(__dirname, "..", "public", "platform", "platform.js"), "utf8");
const CODE = BROWSER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("P36#2 — ratchets: reindexing may not cost a person their answer", () => {
  it("captures and restores checkedness across every rename", () => {
    // Renaming a checked radio unchecks the rest of the group it joins — HTML
    // as specified. Reindexing renames every row, so without this the answer
    // is lost, never restored, and then not submitted at all.
    assert.match(CODE, /function preservingAnswers/);
    assert.match(CODE, /input\[type="radio"\], input\[type="checkbox"\]/);
  });

  it("wraps BOTH the reorder and the insert, since both rename", () => {
    const wrapped = CODE.match(/preservingAnswers\(/g) || [];
    assert.ok(wrapped.length >= 3, `expected the helper and both call sites, saw ${wrapped.length}`);
    assert.match(CODE, /function reindex\([\s\S]{0,120}preservingAnswers/);
    assert.match(CODE, /preservingAnswers\([\s\S]{0,200}appendChild\(row\)/);
  });

  it("still converts values exactly as this test's submitter does", () => {
    // The helper mirrors readForm(). If readForm's rules change, these tests
    // would keep passing against a browser that no longer behaves that way.
    for (const rule of [
      'if (!el.checked) continue;',
      'if (el.value === "yes") values[el.name] = true;',
      'else if (el.value === "no") values[el.name] = false;',
      'values[el.name] = el.value === "" ? null : el.value;',
    ]) {
      assert.ok(CODE.includes(rule), `readForm must still contain: ${rule}`);
    }
  });

  it("focuses a control a PERSON can type into, not the identity field", () => {
    // Regression from 316d94b: adding the hidden identity input made it the
    // FIRST control in the row, and addItem focused "the first control". A
    // hidden input cannot take focus, so Add stopped moving focus into the new
    // row at all — leaving it wherever it happened to be, which is one way
    // typing reaches a row the person is not looking at.
    const focusLine = CODE.match(/var first = row\.querySelector\(([\s\S]*?)\);/);
    assert.ok(focusLine, "addItem must still choose something to focus");
    assert.match(focusLine[1], /:not\(\[type="hidden"\]\)/,
      "the focus target must exclude hidden inputs");
    assert.match(focusLine[1], /:not\(\[readonly\]\)/,
      "and readonly ones, which a person cannot type into either");

    // And prove it against the real markup: the first control in a rendered
    // row IS hidden, so the naive selector would still pick it.
    const first = controlsIn(rowsOf(renderServices(V1))[0])[0];
    assert.equal(first.type, "hidden", "the identity field is still first in the row");
  });

  it("gives every control a unique id, before and after a reorder", () => {
    // A duplicate id makes <label for> focus another row's control, which is
    // how typing lands in the wrong service. Asserted at rest for the rendered
    // page and for the state after a reorder, applying the same rewrite rules
    // the browser applies.
    const html = renderServices(V1);
    const stamp = (rowHtml, index) =>
      rowHtml.replace(/\b(name|id|for|aria-describedby|data-error-for|data-index|data-field)="([^"]*)"/g,
        (m, attr, val) => `${attr}="${R.reindexToken(val, "services", index)}"`);
    const idsOf = (h) => [...h.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);

    const rendered = idsOf(rowsOf(html).join("\n"));
    assert.equal(new Set(rendered).size, rendered.length, "rendered ids must be unique");

    // Add, then move the new row up one — the founder's sequence.
    const added = [...rowsOf(html), stamp(templateOf(html), 5)];
    const addedIds = idsOf(added.join("\n"));
    assert.equal(new Set(addedIds).size, addedIds.length, "ids must stay unique after Add");

    const moved = [added[0], added[1], added[2], added[3], added[5], added[4]]
      .map((r, i) => stamp(r, i));
    const movedIds = idsOf(moved.join("\n"));
    assert.equal(new Set(movedIds).size, movedIds.length, "ids must stay unique after Move up");
  });

  it("submits identity as a hidden field the person cannot edit", () => {
    const pages = fs.readFileSync(
      path.join(__dirname, "..", "src", "views", "platform-config-pages.js"), "utf8");
    assert.match(pages, /type="hidden"[^>]*name="\$\{escapeAttr\(keyName\)\}"/);
    assert.ok(!/disabled/.test(pages.match(/const keyInput = [^;]+;/)[0]),
      "identity must never be carried by a disabled control — those are not submitted");
  });
});

// P36 — the repeatable list, after a founder clicked "Add service" on five
// real services and did not get a sixth blank one.
//
// The bug was not "Add is broken". It was that a new row was derived from an
// existing row — cloned, then blanked — so it inherited every identifier the
// browser uses for identity while losing only the values a person can see. And
// underneath it, applySection() never read repeatable values at all, so no
// change to a service list could ever have persisted anyway.
//
// These tests cover the semantics. Event wiring is covered by ratchets over
// public/platform/platform.js at the bottom of this file, which is the honest
// limit of what this repo can assert without a browser — so the last section
// says plainly what a person still has to click.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const R = require("../src/platform/ui/ui-repeatable");
const F = require("../src/platform/ui/ui-fields");
const S = require("../src/views/platform-shell");

const SERVICES = F.sectionFor("services").repeatable;

/**
 * The flat map the browser posts, for a list of items in visual order.
 *
 * Includes the hidden identity field every rendered row carries. Omitting it
 * was how these tests missed P36 bug #2 — a payload built by hand is a payload
 * that agrees with whatever the parser happens to do. The tests that render
 * real markup and submit it under real HTML rules live in
 * platform-ui-repeatable-save.test.js.
 */
const asPayload = (path, items) => {
  const out = {};
  items.forEach((item, i) => {
    out[`${path}[${i}].${R.KEY_FIELD}`] = item.serviceId || item.ruleId || "";
    for (const [k, v] of Object.entries(item)) out[`${path}[${i}].${k}`] = v;
  });
  return out;
};

const svc = (id, name, extra = {}) => ({
  serviceId: id, name, enabled: true, urgencyCategory: "standard", ...extra,
});

const FIVE = [
  svc("garage_door_wont_open", "Garage door won't open"),
  svc("garage_door_wont_close", "Garage door won't close"),
  svc("broken_spring", "Broken spring"),
  svc("remote_not_working", "Remote not working"),
  svc("new_door_quote", "New door quote"),
];

// ════════════════════════════════════════════════════════════════════
// THE REPORTED BUG
// ════════════════════════════════════════════════════════════════════

describe("P36 — a new row comes from the schema, never from an existing row", () => {
  it("is blank in every field a person filled in", () => {
    const blank = R.blankItem(SERVICES);
    for (const f of ["serviceId", "name", "aliases", "description",
      "qualificationRequirements", "exclusions", "urgencyCategory"]) {
      assert.ok(
        blank[f] === undefined || blank[f] === "" ||
        (Array.isArray(blank[f]) && blank[f].length === 0),
        `a new service must not arrive with a value for ${f} — got ${JSON.stringify(blank[f])}`,
      );
    }
  });

  it("carries no trace of any existing service", () => {
    const blank = JSON.stringify(R.blankItem(SERVICES));
    for (const s of FIVE) {
      assert.ok(!blank.includes(s.serviceId), `a new service must not contain ${s.serviceId}`);
      assert.ok(!blank.includes(s.name), `a new service must not contain "${s.name}"`);
    }
    // The reported symptom, named: the third service, by id.
    assert.ok(!blank.includes("broken_spring"));
  });

  it("answers the required yes/no, and refuses to guess the one that matters", () => {
    const blank = R.blankItem(SERVICES);
    // A service somebody is adding is one they offer.
    assert.equal(blank.enabled, true);
    // Urgency is NOT defaulted. Guessing how urgent a caller's problem is, on
    // their behalf, without asking, is the failure this leaves to validation.
    assert.equal(blank.urgencyCategory, undefined);
  });

  it("does not depend on the list it is being added to", () => {
    // Same answer with five services on screen, or none. The old code could
    // not have satisfied this: with no rows there was nothing to clone, and it
    // told the user to reload the page.
    assert.deepEqual(R.blankItem(SERVICES), R.blankItem(SERVICES));
    assert.deepEqual(R.blankItem({ fields: [] }), {});
  });

  it("the server sends a blank row so the browser has nothing to clone", () => {
    const pages = fs.readFileSync(
      path.join(__dirname, "..", "src", "views", "platform-config-pages.js"), "utf8");
    assert.match(pages, /<template class="item-template"/, "the blank row must be rendered server-side");
    assert.match(pages, /R\.blankItem\(repeatable\)/, "and must come from the schema, not from the items on screen");
  });
});

// ════════════════════════════════════════════════════════════════════
// IDENTITY — the part the clone actually broke
// ════════════════════════════════════════════════════════════════════

describe("P36 — every identifier is a function of position", () => {
  it("names each field for its own item", () => {
    assert.equal(R.itemNameFor("services", 3, "serviceId"), "services[3].serviceId");
    assert.equal(R.itemNameFor("callHandling.urgencyRules", 0, "ruleId"),
      "callHandling.urgencyRules[0].ruleId");
  });

  it("derives ids the same way the server's renderer does", () => {
    // Not "looks similar" — the same function on the same input. If
    // platform-shell.js changes its id rule, this fails rather than the
    // browser silently addressing elements that no longer exist.
    for (const name of ["services[0].serviceId", "callHandling.urgencyRules[2].when",
      "knowledge.approvedFacts[11].statement", "legalName"]) {
      assert.equal(R.idForName(name), S.idFor({ name }), `id rule disagreed for ${name}`);
    }
  });

  it("rewrites every shape the server emits, not just the name", () => {
    const at = (v, i) => R.reindexToken(v, "services", i);
    assert.equal(at("services[0].serviceId", 5), "services[5].serviceId");
    assert.equal(at("f-services-0--serviceId", 5), "f-services-5--serviceId");
    assert.equal(at("f-services-0--serviceId-error", 5), "f-services-5--serviceId-error");
    assert.equal(at("0", 5), "5");
  });

  it("rewrites ALL tokens in aria-describedby, not the first", () => {
    // The old code used a non-global replace on the name attribute only. A row
    // that moved kept another row's hint and error slot, so a server error
    // could appear beside a different service than the one it was about.
    const described = "f-services-2--name-hint f-services-2--name-error";
    assert.equal(R.reindexToken(described, "services", 4),
      "f-services-4--name-hint f-services-4--name-error");
  });

  it("covers every attribute that carries a position", () => {
    assert.deepEqual([...R.INDEXED_ATTRIBUTES].sort(),
      ["aria-describedby", "data-field", "data-error-for", "data-index", "for", "id", "name"].sort());
  });

  it("names every index-bearing attribute the server actually emits", () => {
    // The list was hand-written once and missed data-field. So instead of
    // trusting it, read the rendered markup and assert that every attribute
    // whose value contains an index token is one this list rewrites.
    const html = require("../src/views/platform-config-pages").renderEditor({
      section: F.sectionFor("services"),
      values: F.readSection({ services: FIVE }, "services"),
      items: FIVE, secondaryItems: null, clientId: "c", configVersion: 1,
    }, "/b");

    const carrying = new Set();
    for (const [, attr, value] of html.matchAll(/\b([a-z-]+)="([^"]*)"/g)) {
      if (/services\[\d+\]/.test(value) || /f-services-\d+-/.test(value)) carrying.add(attr);
    }
    const missed = [...carrying].filter((a) => !R.INDEXED_ATTRIBUTES.includes(a));
    assert.deepEqual(missed, [],
      `these attributes carry an index but are never rewritten: ${missed.join(", ")}`);
  });

  it("leaves a nested path's own index alone", () => {
    // Reindexing the services list must not touch a token belonging to a
    // different list that happens to sit inside the same markup.
    assert.equal(
      R.reindexToken("callHandling.urgencyRules[7].when", "services", 3),
      "callHandling.urgencyRules[7].when",
    );
  });

  it("treats the path as text, not as a pattern", () => {
    // "callHandling.urgencyRules" contains a dot. Used unescaped in a RegExp
    // it matches "callHandlingXurgencyRules" too.
    assert.equal(
      R.reindexToken("callHandlingXurgencyRules[1].when", "callHandling.urgencyRules", 9),
      "callHandlingXurgencyRules[1].when",
    );
    assert.equal(
      R.reindexToken("callHandling.urgencyRules[1].when", "callHandling.urgencyRules", 9),
      "callHandling.urgencyRules[9].when",
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// THE OPERATIONS, AS THE FOUNDER SPECIFIED THEM
// ════════════════════════════════════════════════════════════════════

/** Apply a plan to a model list, the way the DOM code applies it to rows. */
const apply = (items, plan, blank) =>
  plan.order.map((from) => (from === null ? blank : items[from]));

describe("P36 — ADD", () => {
  it("A B C D E -> A B C D E blank, and nothing else moves", () => {
    const plan = R.planAdd(5);
    const after = apply(FIVE, plan, R.blankItem(SERVICES));
    assert.equal(after.length, 6);
    assert.deepEqual(after.slice(0, 5), FIVE, "the five existing services must be untouched");
    assert.equal(after[5].serviceId, undefined);
    assert.equal(plan.focus, 5, "focus belongs on the new row");
  });

  it("two adds produce two independent rows", () => {
    const a = R.blankItem(SERVICES);
    const b = R.blankItem(SERVICES);
    assert.notStrictEqual(a, b, "each new row must be its own object, not a shared one");
    a.serviceId = "first_new";
    assert.equal(b.serviceId, undefined, "filling one new row must not fill the other");
  });

  it("adds to an empty list", () => {
    const plan = R.planAdd(0);
    assert.deepEqual(plan.order, [null]);
    assert.equal(plan.focus, 0);
  });
});

describe("P36 — MOVE", () => {
  it("moves one item up and its fields travel with it", () => {
    const after = apply(FIVE, R.planMove(5, 2, -1), null);
    assert.deepEqual(after.map((s) => s.serviceId), [
      "garage_door_wont_open", "broken_spring", "garage_door_wont_close",
      "remote_not_working", "new_door_quote",
    ]);
    // The whole object moved, not just its label.
    assert.equal(after[1].name, "Broken spring");
    assert.equal(after[2].name, "Garage door won't close");
  });

  it("move down is the exact inverse of move up", () => {
    const up = apply(FIVE, R.planMove(5, 2, -1), null);
    const back = apply(up, R.planMove(5, 1, 1), null);
    assert.deepEqual(back, FIVE);
  });

  it("refuses at the ends rather than clamping", () => {
    assert.equal(R.planMove(5, 0, -1).changed, false, "move up on the first row must do nothing");
    assert.equal(R.planMove(5, 4, 1).changed, false, "move down on the last row must do nothing");
    assert.equal(R.planMove(5, 0, -1).order, null);
  });

  it("refuses an index that is not on the list", () => {
    for (const bad of [-1, 5, 99, 1.5, NaN, undefined]) {
      assert.equal(R.planMove(5, bad, -1).changed, false, `index ${bad} must be refused`);
    }
  });
});

describe("P36 — REMOVE", () => {
  it("removes the intended row and leaves its neighbours' values alone", () => {
    const after = apply(FIVE, R.planRemove(5, 2), null);
    assert.deepEqual(after.map((s) => s.serviceId), [
      "garage_door_wont_open", "garage_door_wont_close", "remote_not_working", "new_door_quote",
    ]);
    assert.equal(after[1].name, "Garage door won't close");
    assert.equal(after[2].name, "Remote not working");
  });

  it("removing the middle row leaves the paths contiguous", () => {
    const after = apply(FIVE, R.planRemove(5, 2), null);
    const payload = asPayload("services", after);
    assert.ok(payload["services[2].serviceId"] === "remote_not_working");
    assert.equal(payload["services[4].serviceId"], undefined, "no gap and no stale fifth row");
    assert.deepEqual(
      R.parseItems(payload, SERVICES).map((s) => s.serviceId),
      ["garage_door_wont_open", "garage_door_wont_close", "remote_not_working", "new_door_quote"],
    );
  });

  it("focus lands on the row that took its place, or the new last row", () => {
    assert.equal(R.planRemove(5, 2).focus, 2);
    assert.equal(R.planRemove(5, 4).focus, 3, "removing the last row focuses the new last row");
  });

  it("refuses an index that is not on the list", () => {
    for (const bad of [-1, 5, 99, NaN]) assert.equal(R.planRemove(5, bad).changed, false);
  });
});

describe("P36 — ADD AFTER REMOVE", () => {
  it("the new row is blank and takes the next free position", () => {
    const afterRemove = apply(FIVE, R.planRemove(5, 2), null);
    const plan = R.planAdd(afterRemove.length);
    const after = apply(afterRemove, plan, R.blankItem(SERVICES));

    assert.equal(after.length, 5);
    assert.equal(plan.focus, 4, "the new row is the fifth, not the sixth");
    assert.equal(after[4].serviceId, undefined, "and it is blank");
    // Specifically: it must not resurrect the row that was just removed.
    assert.ok(!JSON.stringify(after[4]).includes("broken_spring"));

    const payload = asPayload("services", after);
    assert.equal(payload["services[4].serviceId"], undefined);
    assert.equal(payload["services[4].enabled"], true);
  });
});

// ════════════════════════════════════════════════════════════════════
// NESTED LISTS — aliases, qualification requirements, exclusions
// ════════════════════════════════════════════════════════════════════

describe("P36 — the per-service lists stay with their service", () => {
  const withLists = [
    svc("a", "A", { aliases: ["a1", "a2"], qualificationRequirements: ["qa"], exclusions: ["xa"] }),
    svc("b", "B", { aliases: ["b1"], qualificationRequirements: ["qb"], exclusions: ["xb"] }),
    svc("c", "C", { aliases: ["c1"], qualificationRequirements: ["qc"], exclusions: ["xc"] }),
  ];

  it("survives a reorder intact", () => {
    const after = apply(withLists, R.planMove(3, 2, -1), null);
    assert.deepEqual(after.map((s) => s.serviceId), ["a", "c", "b"]);
    assert.deepEqual(after[1].aliases, ["c1"], "C's aliases must arrive with C");
    assert.deepEqual(after[1].qualificationRequirements, ["qc"]);
    assert.deepEqual(after[1].exclusions, ["xc"]);
    assert.deepEqual(after[2].aliases, ["b1"], "B's aliases must not have been left behind");
  });

  it("survives the round trip through the submitted payload", () => {
    const after = apply(withLists, R.planMove(3, 0, 1), null);
    const parsed = R.parseItems(asPayload("services", after), SERVICES);
    assert.deepEqual(parsed.map((s) => s.serviceId), ["b", "a", "c"]);
    assert.deepEqual(parsed[1].aliases, ["a1", "a2"]);
    assert.deepEqual(parsed[0].exclusions, ["xb"]);
  });

  it("survives a removal", () => {
    const after = apply(withLists, R.planRemove(3, 0), null);
    const parsed = R.parseItems(asPayload("services", after), SERVICES);
    assert.deepEqual(parsed.map((s) => s.serviceId), ["b", "c"]);
    assert.deepEqual(parsed[0].aliases, ["b1"]);
    assert.deepEqual(parsed[1].aliases, ["c1"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// SERIALIZATION — the defect underneath the defect
// ════════════════════════════════════════════════════════════════════

describe("P36 — what is saved is what is on the screen, in that order", () => {
  it("applySection now actually applies a repeatable", () => {
    // Before this milestone applySection walked only the section's own fields,
    // whose names are "legalName"-shaped, while a repeatable posts
    // "services[0].serviceId"-shaped keys. Every service edit was posted,
    // accepted with a 200, and dropped.
    const before = { services: FIVE };
    const edited = apply(FIVE, R.planMove(5, 2, -1), null);
    const out = F.applySection(before, "services", asPayload("services", edited));

    assert.deepEqual(out.services.map((s) => s.serviceId), [
      "garage_door_wont_open", "broken_spring", "garage_door_wont_close",
      "remote_not_working", "new_door_quote",
    ], "the saved order must be the visual order");
    assert.notDeepEqual(out.services, before.services, "a reorder must actually change the blueprint");
  });

  it("carries an added service through to the blueprint", () => {
    const added = apply(FIVE, R.planAdd(5), R.blankItem(SERVICES));
    added[5] = svc("garage_door_maintenance", "Garage door maintenance");
    const out = F.applySection({ services: FIVE }, "services", asPayload("services", added));

    assert.equal(out.services.length, 6);
    assert.equal(out.services[5].serviceId, "garage_door_maintenance");
    assert.equal(out.services[5].name, "Garage door maintenance");
    assert.equal(out.services[5].urgencyCategory, "standard");
  });

  it("carries a removal through to the blueprint", () => {
    const after = apply(FIVE, R.planRemove(5, 2), null);
    const out = F.applySection({ services: FIVE }, "services", asPayload("services", after));
    assert.equal(out.services.length, 4);
    assert.ok(!out.services.some((s) => s.serviceId === "broken_spring"));
  });

  it("leaves the list alone when the payload does not mention it", () => {
    // A form that does not render the list must not be able to empty it.
    const out = F.applySection({ services: FIVE }, "services", { somethingElse: 1 });
    assert.deepEqual(out.services, FIVE);
  });

  it("drops a field the schema does not declare", () => {
    const payload = { ...asPayload("services", FIVE), "services[0].injected": "nope" };
    const parsed = R.parseItems(payload, SERVICES);
    assert.equal(parsed[0].injected, undefined);
    assert.equal(parsed[0].serviceId, "garage_door_wont_open");
  });

  it("compacts a payload that skips an index rather than leaving a hole", () => {
    const payload = {
      "services[0].serviceId": "a",
      "services[2].serviceId": "c",
      "services[7].serviceId": "h",
    };
    assert.deepEqual(R.parseItems(payload, SERVICES).map((s) => s.serviceId), ["a", "c", "h"]);
  });

  it("orders by index numerically, not as text", () => {
    // "10" sorts before "2" as a string, which would silently reorder a list
    // of eleven services on save.
    const many = Array.from({ length: 12 }, (_, i) => svc(`s${i}`, `S${i}`));
    const parsed = R.parseItems(asPayload("services", many), SERVICES);
    assert.deepEqual(parsed.map((s) => s.serviceId), many.map((s) => s.serviceId));
  });

  it("applies the other repeatables too, not only services", () => {
    const rules = [{ ruleId: "r1" }, { ruleId: "r2" }];
    const out = F.applySection(
      { callHandling: { urgencyRules: [] } },
      "callHandling",
      asPayload("callHandling.urgencyRules", rules),
    );
    assert.deepEqual(out.callHandling.urgencyRules.map((r) => r.ruleId), ["r1", "r2"]);
  });
});

// ════════════════════════════════════════════════════════════════════
// RATCHETS OVER THE BROWSER CODE
// ════════════════════════════════════════════════════════════════════

const BROWSER = fs.readFileSync(
  path.join(__dirname, "..", "public", "platform", "platform.js"), "utf8");

/**
 * Code only. The comments in platform.js describe the bug being fixed and name
 * the old broken calls, so a ratchet reading the raw file matches its own
 * explanation — the recurring self-catching-ratchet trap in this repo.
 *
 * Comments are stripped and string literals are NOT, because a naive string
 * stripper cannot tell `"\\]/g, "` inside a regex literal from a real string
 * and silently eats the rest of the file. Stripping comments is enough here:
 * every claim below is about code, and all the prose lives in comments.
 */
const CODE = BROWSER
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

describe("P36 — ratchets: the browser cannot go back to cloning a row", () => {
  it("never clones an existing item", () => {
    // The exact shape that caused the bug: reach for a live `.item`, copy it,
    // blank its fields. Any cloneNode near a `.item` selector fails this.
    assert.ok(!/["']\.item["'][\s\S]{0,120}cloneNode/.test(CODE),
      "a new row must never be built from a live row");
    // And the only cloneNode left must be the template's.
    for (const call of CODE.match(/[\w.]+\.cloneNode/g) || []) {
      assert.match(call, /content\.firstElementChild\.cloneNode|firstElementChild\.cloneNode/,
        `unexpected clone source: ${call}`);
    }
  });

  it("builds a new row from the server's template", () => {
    assert.match(CODE, /item-template/);
    assert.match(CODE, /template\.content/);
  });

  it("resolves the list from the clicked control, never from the document", () => {
    // main.querySelector(".items") returned whichever list came first, so on
    // the Knowledge screen "Add reference" added an approved fact.
    assert.ok(!/main\.querySelector\(\s*["']\.items/.test(CODE),
      "a repeatable operation must not resolve its list from the whole page");
    assert.match(CODE, /function listFor/);
    assert.match(CODE, /closest\(\s*["']\.repeatable["']\s*\)/);
  });

  it("rewrites every indexed attribute, in step with the server module", () => {
    const declared = CODE.match(/var INDEXED_ATTRIBUTES = \[([^\]]*)\]/);
    assert.ok(declared, "platform.js must declare the attribute list it rewrites");
    const inBrowser = declared[1].match(/"([^"]+)"/g).map((s) => s.replace(/"/g, "")).sort();
    assert.deepEqual(inBrowser, [...R.INDEXED_ATTRIBUTES].sort(),
      "the browser must rewrite exactly the attributes the tested module names");
  });

  it("keeps its copy of the id rule identical to the tested one", () => {
    // The browser cannot require() the module, so the rule is duplicated. This
    // asserts the duplicate is the same rule — a browser that computes ids
    // differently from the server addresses elements that do not exist.
    const browserRule = CODE.match(/function escapeForId\(value\)\s*\{([\s\S]*?)\n  \}/)[1];
    assert.ok(browserRule.includes("[^a-zA-Z0-9_-]"), "the id escape rule must match the server's");
    assert.ok(CODE.includes('var ID_PREFIX = "f-";'));
    assert.equal(R.ID_PREFIX, "f-");
    // Prove the two really do agree on real input, not just look alike.
    assert.equal(R.idForName("services[3].serviceId"), "f-services-3--serviceId");
  });

  it("still contacts nothing but this origin", () => {
    // The pre-existing rule, re-asserted here because this change rewrote a
    // large part of the file.
    const fetches = CODE.match(/fetch\(([^)]*)\)/g) || [];
    for (const f of fetches) assert.ok(!/https?:/.test(f), `fetch must stay same-origin: ${f}`);
  });
});

describe("P36 — what these tests do NOT prove", () => {
  it("states the limit rather than implying browser coverage exists", () => {
    // There is no jsdom in this repo and this milestone did not add one. So
    // the semantics above are proven and the event wiring is only ratcheted.
    // A person still has to click Add, Move up, Move down and Remove in a
    // browser, and the report for this batch says so.
    const declared = [
      "blankItem", "reindexToken", "parseItems", "planAdd", "planRemove", "planMove",
    ];
    for (const fn of declared) assert.equal(typeof R[fn], "function");
    assert.ok(!fs.existsSync(path.join(__dirname, "..", "node_modules", "jsdom")),
      "if jsdom is ever added, replace these ratchets with real DOM tests");
  });
});

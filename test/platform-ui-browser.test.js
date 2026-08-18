// P36 bug #3 — the founder's sequence, in a real DOM.
//
// Three browser bugs in a row were found by a person clicking, not by this
// repo's tests, because the tests built the submitted values by hand. This
// suite does not: it renders the page the server renders, executes
// public/platform/platform.js unmodified inside jsdom, clicks the buttons,
// types into the boxes, and reads what the real submit handler posts.
//
// The sequence below is the founder's, verbatim from the bug report:
//
//   1. start from the clean v1-shaped five services
//   2. Add garage_door_maintenance
//   3. type "door stuck open" into door_wont_open's aliases
//   4. type "garage servicing" into garage_door_maintenance's aliases
//   5. move garage_door_maintenance immediately above new_door_quote
//   6. submit
//
// What DEV showed afterwards: door_wont_open had gained BOTH aliases, and
// garage_door_maintenance had none.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const F = require("../src/platform/ui/ui-fields");
const P = require("../src/views/platform-config-pages");
const R = require("../src/platform/ui/ui-repeatable");
const B = require("./helpers/browser");

const CLIENT = "aida_platform_dev_client";

/** v3 as it stood before the founder's edit — the same shape as active v1. */
const FIVE = [
  { serviceId: "door_wont_open", name: "Garage door won't open", enabled: true,
    urgencyCategory: "urgent", aliases: ["door stuck closed", "can't get the car out"] },
  { serviceId: "door_wont_close", name: "Garage door won't close", enabled: true,
    urgencyCategory: "emergency", aliases: ["door stuck open", "garage is open"] },
  { serviceId: "broken_spring", name: "Broken spring", enabled: true, urgencyCategory: "urgent" },
  { serviceId: "remote_not_working", name: "Remote not working", enabled: true,
    urgencyCategory: "non_urgent", aliases: ["remote", "clicker"] },
  { serviceId: "new_door_quote", name: "New door quote", enabled: true, urgencyCategory: "non_urgent" },
];

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

const renderServices = (services) =>
  P.renderEditor({
    section: F.sectionFor("services"),
    values: F.readSection(blueprintWith(services), "services"),
    items: services, secondaryItems: null,
    clientId: CLIENT, configVersion: 3,
  }, `/platform/clients/${CLIENT}`);

const openServices = (services) => B.open(renderServices(services));

/** The row whose identity field holds this service id. */
const rowFor = (document, serviceId) =>
  B.rows(document).find((r) => {
    const key = r.querySelector(`[name$=".${R.KEY_FIELD}"]`);
    const id = B.fieldIn(r, "serviceId");
    return (key && key.value === serviceId) || (id && id.value === serviceId);
  });

const aliasesOf = (page, serviceId) => {
  const row = rowFor(page.document, serviceId);
  return row ? B.fieldIn(row, "aliases").value.split("\n").filter(Boolean) : null;
};

/** The founder's exact sequence. Returns the page and what it posted. */
async function founderSequence(page, { listField = "aliases" } = {}) {
  const doc = page.document;

  // 2. Add garage_door_maintenance
  page.click(doc.querySelector('[data-action="add-item"]'));
  const added = B.rows(doc)[B.rows(doc).length - 1];
  page.type(B.fieldIn(added, "serviceId"), "garage_door_maintenance");
  page.type(B.fieldIn(added, "name"), "Garage door maintenance");
  B.fieldIn(added, "urgencyCategory").value = "standard";

  // 3. an alias on the EXISTING service
  const openRow = rowFor(doc, "door_wont_open");
  const existing = B.fieldIn(openRow, listField).value;
  page.type(B.fieldIn(openRow, listField),
    (existing ? existing + "\n" : "") + "door stuck open");

  // 4. an alias on the NEW service
  page.type(B.fieldIn(added, listField), "garage servicing");

  // 5. move it immediately above New door quote — it is last, so one move up
  page.click(added.querySelector('[data-action="move-up"]'));

  // 6. submit
  await page.submit();
  return page.posted[page.posted.length - 1];
}

// ════════════════════════════════════════════════════════════════════
// THE REPRODUCTION
// ════════════════════════════════════════════════════════════════════

describe("P36#3 — the founder's sequence, in a real DOM", () => {
  it("posts each alias under the service it was typed into", async () => {
    const page = openServices(FIVE);
    const req = await founderSequence(page);

    assert.ok(req, "the form must have posted something");
    const v = req.body.values;

    // Find each service's submitted row by its identity, not by its index.
    const indexOf = (serviceId) => {
      for (let i = 0; i < 12; i += 1) {
        if (v[`services[${i}].${R.KEY_FIELD}`] === serviceId) return i;
        if (v[`services[${i}].serviceId`] === serviceId) return i;
      }
      return -1;
    };

    const iOpen = indexOf("door_wont_open");
    const iNew = indexOf("garage_door_maintenance");
    assert.ok(iOpen >= 0, "door_wont_open must be in the payload");
    assert.ok(iNew >= 0, "garage_door_maintenance must be in the payload");

    const openAliases = v[`services[${iOpen}].aliases`];
    const newAliases = v[`services[${iNew}].aliases`];

    assert.deepEqual(openAliases,
      ["door stuck closed", "can't get the car out", "door stuck open"],
      "door_wont_open must NOT have received the new service's alias");
    assert.deepEqual(newAliases, ["garage servicing"],
      "garage servicing must be submitted under garage_door_maintenance");
  });

  it("stores each alias on the service it was typed into", async () => {
    const page = openServices(FIVE);
    const req = await founderSequence(page);
    const out = F.applySection(blueprintWith(FIVE), "services", req.body.values);

    const byId = Object.fromEntries(out.services.map((s) => [s.serviceId, s]));
    assert.deepEqual(byId.door_wont_open.aliases,
      ["door stuck closed", "can't get the car out", "door stuck open"]);
    assert.deepEqual(byId.garage_door_maintenance.aliases, ["garage servicing"]);
    assert.ok(!JSON.stringify(byId.door_wont_open).includes("garage servicing"),
      "the exact crossing the founder saw must not happen");
  });

  it("puts the moved service immediately above New door quote", async () => {
    const page = openServices(FIVE);
    const req = await founderSequence(page);
    const out = F.applySection(blueprintWith(FIVE), "services", req.body.values);
    assert.deepEqual(out.services.map((s) => s.serviceId), [
      "door_wont_open", "door_wont_close", "broken_spring",
      "remote_not_working", "garage_door_maintenance", "new_door_quote",
    ]);
  });

  it("leaves the services and their references valid", async () => {
    // Scoped to what this sequence can affect. The fixture is a services-and-
    // callHandling blueprint, not a whole one, so asserting global validity
    // here would only assert that the fixture is partial.
    const { validateBlueprint } = require("../src/platform/client-blueprint");
    const page = openServices(FIVE);
    const req = await founderSequence(page);
    const out = F.applySection(blueprintWith(FIVE), "services", req.body.values);
    const errors = (validateBlueprint(out).errors || [])
      .filter((e) => /^services|collectByService|eligibleServices/.test(e.path || ""));
    assert.deepEqual(errors, [], JSON.stringify(errors));
  });
});

// ════════════════════════════════════════════════════════════════════
// THE SAME, FOR THE OTHER SERVICE-SCOPED LISTS
// ════════════════════════════════════════════════════════════════════

describe("P36#3 — every service-scoped list behaves the same way", () => {
  for (const field of ["aliases", "qualificationRequirements", "exclusions"]) {
    it(`${field} stays with the service it was typed into`, async () => {
      const page = openServices(FIVE);
      const req = await founderSequence(page, { listField: field });
      const out = F.applySection(blueprintWith(FIVE), "services", req.body.values);
      const byId = Object.fromEntries(out.services.map((s) => [s.serviceId, s]));

      assert.deepEqual(byId.garage_door_maintenance[field], ["garage servicing"],
        `${field} typed into the new service must stay there`);
      assert.ok(!(byId.door_wont_open[field] || []).includes("garage servicing"),
        `${field} must not cross into door_wont_open`);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// FOCUS — named because it is a real regression, not because it is the cause
// ════════════════════════════════════════════════════════════════════

describe("P36#3 — Add moves focus into the new row", () => {
  it("focuses a control a person can type into", () => {
    const page = openServices(FIVE);
    page.click(page.document.querySelector('[data-action="add-item"]'));

    const active = page.document.activeElement;
    assert.ok(active, "something must have focus");
    assert.notEqual(active, page.document.body, "Add must move focus into the new row");
    assert.notEqual(active.type, "hidden", "a hidden input cannot take focus");

    const added = B.rows(page.document)[B.rows(page.document).length - 1];
    assert.ok(added.contains(active), "focus must be inside the row that was just added");
  });

  it("does not leave focus in another service's box", () => {
    // The failure this guards: focus stays where it was, so the next thing
    // typed goes into whatever row the person last touched.
    const page = openServices(FIVE);
    const openRow = rowFor(page.document, "door_wont_open");
    const box = B.fieldIn(openRow, "aliases");
    box.focus();
    assert.equal(page.document.activeElement, box);

    page.click(page.document.querySelector('[data-action="add-item"]'));
    assert.notEqual(page.document.activeElement, box,
      "after Add, focus must not still be in door_wont_open's aliases box");
  });
});

// ════════════════════════════════════════════════════════════════════
// ADD -> TYPE -> REORDER -> SUBMIT, AND THE SECOND SAVE
// ════════════════════════════════════════════════════════════════════

describe("P36#3 — typing straight after Add, which is what the focus bug costs", () => {
  // The founder's stated sequence, scripted with an explicit click into each
  // box, does NOT reproduce the crossing — proven above, and it passes against
  // 316d94b too. So the crossing did not come from the list machinery.
  //
  // This is the same sequence with ONE difference: after pressing Add, the
  // text is typed without clicking anything first — which is what a person
  // does when they expect the button to have put the cursor in the new row.
  // With focus broken, the text lands in whichever box was last touched.
  //
  // It reproduces the DEV data exactly: door_wont_open with four aliases
  // ending in "garage servicing", and the new service with none.
  it("does not put the new service's alias into whichever box was last touched", async () => {
    const page = openServices(FIVE);
    const doc = page.document;

    // The founder's step 3: an alias on the existing service.
    const openRow = rowFor(doc, "door_wont_open");
    const openBox = B.fieldIn(openRow, "aliases");
    page.type(openBox, openBox.value + "\ndoor stuck open");

    // Step 2's button, pressed after — then step 4 typed straight away.
    page.click(doc.querySelector('[data-action="add-item"]'));
    const landed = page.typeAtFocus("garage servicing");

    assert.notEqual(landed, openBox,
      "typing after Add must not land in door_wont_open's aliases box");

    await page.submit();
    const out = F.applySection(blueprintWith(FIVE), "services",
      page.posted[page.posted.length - 1].body.values);
    const byId = Object.fromEntries(out.services.map((s) => [s.serviceId, s]));

    assert.ok(!(byId.door_wont_open.aliases || []).includes("garage servicing"),
      "door_wont_open must not end up holding the new service's alias");
    assert.deepEqual(byId.door_wont_open.aliases,
      ["door stuck closed", "can't get the car out", "door stuck open"],
      "and it must hold exactly what was typed into it");
  });
});

describe("P36#3 — a new service survives becoming an existing one", () => {
  it("save, reload the model, edit again, save again", async () => {
    // First pass: the founder's sequence.
    const first = await founderSequence(openServices(FIVE));
    const afterFirst = F.applySection(blueprintWith(FIVE), "services", first.body.values);

    // Reload: the server re-renders from what was stored. garage_door_maintenance
    // is now an EXISTING service and must arrive with its own identity key.
    const page2 = openServices(afterFirst.services);
    const newRow = rowFor(page2.document, "garage_door_maintenance");
    assert.ok(newRow, "the new service must be on the reloaded page");
    assert.equal(newRow.querySelector(`[name$=".${R.KEY_FIELD}"]`).value, "garage_door_maintenance",
      "after one save it must carry its own key, not an empty one");
    assert.equal(B.fieldIn(newRow, "serviceId").readOnly, true,
      "and its id must now be identity rather than a value");

    // Edit it again, and move it once more.
    page2.type(B.fieldIn(newRow, "aliases"), "garage servicing\nannual service");
    page2.click(newRow.querySelector('[data-action="move-up"]'));
    await page2.submit();

    const second = page2.posted[page2.posted.length - 1];
    const afterSecond = F.applySection(afterFirst, "services", second.body.values);
    const byId = Object.fromEntries(afterSecond.services.map((s) => [s.serviceId, s]));

    assert.deepEqual(byId.garage_door_maintenance.aliases, ["garage servicing", "annual service"]);
    assert.deepEqual(byId.door_wont_open.aliases,
      ["door stuck closed", "can't get the car out", "door stuck open"],
      "the second save must not migrate anything into door_wont_open either");
    assert.deepEqual(byId.remote_not_working.aliases, ["remote", "clicker"],
      "nor into the service whose index it took");
  });

  it("a row added where another one used to sit inherits nothing", async () => {
    const page = openServices(FIVE);
    const doc = page.document;

    // Remove the middle service, then add a new one — it lands at an index
    // that a different service occupied a moment ago.
    const middle = rowFor(doc, "broken_spring");
    page.click(middle.querySelector('[data-action="remove-item"]'));
    page.click(doc.querySelector('[data-action="add-item"]'));

    const added = B.rows(doc)[B.rows(doc).length - 1];
    assert.equal(B.fieldIn(added, "serviceId").value, "", "a new row starts with no id");
    assert.equal(B.fieldIn(added, "aliases").value, "", "and no aliases");
    assert.equal(added.querySelector(`[name$=".${R.KEY_FIELD}"]`).value, "",
      "and claims no existing identity");

    page.type(B.fieldIn(added, "serviceId"), "garage_door_maintenance");
    page.type(B.fieldIn(added, "name"), "Garage door maintenance");
    B.fieldIn(added, "urgencyCategory").value = "standard";
    await page.submit();

    const out = F.applySection(blueprintWith(FIVE), "services",
      page.posted[page.posted.length - 1].body.values);
    const byId = Object.fromEntries(out.services.map((s) => [s.serviceId, s]));
    assert.ok(!byId.broken_spring, "the removed service is gone");
    assert.equal(byId.garage_door_maintenance.aliases, undefined,
      "the new one inherited nothing from whoever held its index");
  });
});

// ════════════════════════════════════════════════════════════════════
// THINGS THE EARLIER BUGS COST, RE-ASSERTED IN A REAL DOM
// ════════════════════════════════════════════════════════════════════

describe("P36#3 — bug #1 and bug #2, now proven by clicking", () => {
  it("Add produces a blank row, not a copy of an existing service", () => {
    const page = openServices(FIVE);
    page.click(page.document.querySelector('[data-action="add-item"]'));
    const added = B.rows(page.document)[B.rows(page.document).length - 1];

    for (const f of ["serviceId", "name", "aliases", "description",
      "qualificationRequirements", "exclusions"]) {
      assert.equal(B.fieldIn(added, f).value, "", `a new row must have no ${f}`);
    }
    assert.equal(added.querySelector('[name$=".enabled"]:checked').value, "yes",
      "Offered defaults to yes");
  });

  it("a reorder does not cost any service its Offered answer", async () => {
    const page = openServices(FIVE);
    const doc = page.document;
    // Turn one off explicitly, so both answers are under test.
    const remote = rowFor(doc, "remote_not_working");
    remote.querySelector('[name$=".enabled"][value="no"]').checked = true;

    const last = rowFor(doc, "new_door_quote");
    page.click(last.querySelector('[data-action="move-up"]'));
    page.click(last.querySelector('[data-action="move-up"]'));
    await page.submit();

    const out = F.applySection(blueprintWith(FIVE), "services",
      page.posted[page.posted.length - 1].body.values);
    const byId = Object.fromEntries(out.services.map((s) => [s.serviceId, s]));
    for (const s of ["door_wont_open", "door_wont_close", "broken_spring", "new_door_quote"]) {
      assert.equal(byId[s].enabled, true, `${s} must still be offered`);
    }
    assert.equal(byId.remote_not_working.enabled, false, "and an explicit No must survive too");
  });

  it("an existing service id cannot be typed over", async () => {
    const page = openServices(FIVE);
    const row = rowFor(page.document, "door_wont_open");
    const idBox = B.fieldIn(row, "serviceId");
    assert.equal(idBox.readOnly, true);

    idBox.value = "Climb fence"; // what the browser did to the founder
    await page.submit();

    const out = F.applySection(blueprintWith(FIVE), "services",
      page.posted[page.posted.length - 1].body.values);
    assert.ok(out.services.some((s) => s.serviceId === "door_wont_open"));
    assert.ok(!JSON.stringify(out).includes("Climb fence"));
  });

  it("Add on the Knowledge screen adds to the list whose button was pressed", () => {
    const knowledge = P.renderEditor({
      section: F.sectionFor("knowledge"),
      values: F.readSection({ knowledge: { approvedFacts: [], sourceReferences: [] } }, "knowledge"),
      items: [], secondaryItems: [], clientId: CLIENT, configVersion: 3,
    }, `/platform/clients/${CLIENT}`);
    const page = B.open(knowledge);

    const buttons = page.$$('[data-action="add-item"]');
    assert.equal(buttons.length, 2, "the Knowledge screen renders two lists");
    page.click(buttons[1]);

    const lists = page.$$(".items");
    assert.equal(lists[0].querySelectorAll(":scope > li.item").length, 0,
      "the first list must be untouched");
    assert.equal(lists[1].querySelectorAll(":scope > li.item").length, 1,
      "the row belongs to the list whose button was pressed");
  });

  it("still talks to nothing but this origin", async () => {
    const page = openServices(FIVE);
    await page.submit();
    for (const req of page.posted) {
      assert.ok(req.url.startsWith("/"), `every request must be a same-origin path: ${req.url}`);
    }
  });
});

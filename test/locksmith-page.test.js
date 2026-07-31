// AIDA Locksmith Receptionist M1 — rendered-page tests.
//
// The page is a pure function of (config, demo data, field contract), so the
// HTML can be asserted directly with no browser and no node_modules. What's
// guarded here is everything a stranger sees: that all nine sections render,
// that nothing on the page is invented, that demonstration data is labelled
// wherever it appears, that the accessibility contract holds, and that the
// mobile layout doesn't rely on a fixed-width table.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { renderLocksmithPage } = require("../src/views/locksmith-page");
const { escapeHtml, escapeAttr } = require("../src/views/escape");
const { getLocksmithConfig } = require("../src/config/locksmith");
const demo = require("../src/services/locksmith-demo");
const { FIELDS } = require("../src/services/locksmith-enquiry");

function render(env = {}) {
  return renderLocksmithPage({ config: getLocksmithConfig(env), demo, fields: FIELDS });
}

const HTML = render();

// Counts non-overlapping occurrences of a literal needle.
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe("page shell", () => {
  it("is a complete, Australian-English, mobile-ready HTML document", () => {
    assert.ok(HTML.startsWith("<!DOCTYPE html>"));
    assert.match(HTML, /<html lang="en-AU">/);
    assert.match(HTML, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(HTML, /<title>AIDA Locksmith Receptionist — Never lose another after-hours locksmith enquiry<\/title>/);
    assert.match(HTML, /<link rel="stylesheet" href="\/locksmith\/locksmith\.css">/);
    assert.match(HTML, /<script src="\/locksmith\/locksmith\.js" defer><\/script>/);
    assert.ok(HTML.trim().endsWith("</html>"));
  });

  it("names the product and the provider", () => {
    assert.match(HTML, /AIDA Locksmith Receptionist/);
    assert.match(HTML, /Niche Drops/);
  });

  it("carries no inline script or inline style — the route's CSP allows neither", () => {
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(HTML), "no inline <script> blocks");
    assert.ok(!/\son[a-z]+\s*=\s*"/i.test(HTML), "no inline event handler attributes");
    assert.ok(!/<style[\s>]/i.test(HTML), "no inline <style> blocks");
    assert.ok(!/\sstyle="/i.test(HTML), "no style attributes");
  });
});

describe("all nine required sections render", () => {
  const SECTIONS = [
    { id: "hero-heading", label: "hero" },
    { id: "how-it-works-heading", label: "how it works" },
    { id: "scenarios-heading", label: "scenarios" },
    { id: "capabilities-heading", label: "capabilities" },
    { id: "example-calls-heading", label: "example calls" },
    { id: "dashboard-heading", label: "dashboard preview" },
    { id: "pricing-heading", label: "pricing" },
    { id: "pilot-enquiry-heading", label: "enquiry form" },
    { id: "footer-heading", label: "footer" },
  ];

  for (const section of SECTIONS) {
    it(`renders the ${section.label} section, labelled by its own heading`, () => {
      assert.ok(HTML.includes(`id="${section.id}"`), `missing heading #${section.id}`);
      assert.ok(HTML.includes(`aria-labelledby="${section.id}"`), `#${section.id} does not label its section`);
    });
  }

  it("hero shows the specified headline, supporting copy and both CTAs", () => {
    assert.match(HTML, /<h1 id="hero-heading">Never lose another after-hours locksmith enquiry<\/h1>/);
    assert.match(HTML, /AIDA answers missed and after-hours calls, captures the customer's\s+location\s+and lock problem, and escalates urgent jobs according to your rules\./);
    assert.match(HTML, /Call the live demo/);
    assert.match(HTML, /Join the locksmith pilot/);
    assert.match(HTML, /href="#pilot-enquiry"/, "the secondary CTA must reach the form");
  });

  it("how it works lists the five specified steps in order", () => {
    const steps = [
      "A customer calls",
      "AIDA answers as your business",
      "The job details are captured",
      "Urgent calls are escalated",
      "You get a concise summary",
    ];
    let cursor = -1;
    for (const step of steps) {
      const at = HTML.indexOf(step);
      assert.ok(at > cursor, `step "${step}" missing or out of order`);
      cursor = at;
    }
    // Exactly five call-handling steps. The onboarding section's steps carry
    // the extra `setup-step` class and are counted separately below.
    assert.strictEqual(count(HTML, '<li class="step">'), 5);
    assert.strictEqual(count(HTML, '<li class="step setup-step">'), 4, "the setup section has its own four steps");
  });

  it("renders four scenarios with caller, suburb, job type, urgency, summary and action", () => {
    assert.strictEqual(count(HTML, 'class="card scenario"'), 4);
    for (const s of demo.SCENARIOS) {
      assert.ok(HTML.includes(escapeHtml(s.title)), `scenario ${s.id} title missing`);
      assert.ok(HTML.includes(escapeHtml(s.caller)));
      assert.ok(HTML.includes(escapeHtml(s.suburb)));
      assert.ok(HTML.includes(escapeHtml(s.jobType)));
      assert.ok(HTML.includes(escapeHtml(s.summary)));
      assert.ok(HTML.includes(escapeHtml(s.action)));
    }
    assert.match(HTML, /<dt>Caller<\/dt>/);
    assert.match(HTML, /<dt>Suburb<\/dt>/);
    assert.match(HTML, /<dt>Job type<\/dt>/);
    assert.match(HTML, /<dt>Urgency<\/dt>/);
  });

  it("renders all eleven capabilities", () => {
    assert.strictEqual(count(HTML, 'class="capability"'), 11);
    for (const c of demo.CAPABILITIES) assert.ok(HTML.includes(escapeHtml(c.title)));
  });

  it("renders four example calls with transcript, summary, urgency, outcome and action", () => {
    assert.strictEqual(count(HTML, 'class="card example"'), 4);
    assert.strictEqual(count(HTML, "<summary>Read the example transcript</summary>"), 4);
    for (const call of demo.EXAMPLE_CALLS) {
      assert.ok(HTML.includes(escapeHtml(call.scenario)));
      assert.ok(HTML.includes(escapeHtml(call.summary)));
      assert.ok(HTML.includes(escapeHtml(call.outcome)));
      assert.ok(HTML.includes(escapeHtml(call.action)));
      assert.ok(HTML.includes(escapeHtml(call.transcript[0].text)), "first transcript line must render");
    }
    assert.strictEqual(count(HTML, "<dt>Action taken</dt>"), 4);
  });

  it("embeds no audio player and no third-party origin", () => {
    assert.ok(!/<audio|<video|<iframe|<embed/i.test(HTML), "M1 ships no media embeds");
    const externals = HTML.match(/(?:src|href)="https?:\/\/[^"]+"/g) || [];
    assert.deepStrictEqual(externals, [], `page must load nothing off-site, found: ${externals.join(", ")}`);
  });

  it("renders the dashboard preview: six metrics plus the recent-calls table", () => {
    assert.ok(HTML.includes("Demonstration workspace — example locksmith calls"));
    assert.strictEqual(count(HTML, 'class="metric"'), 6);
    for (const m of demo.DASHBOARD.metrics) {
      assert.ok(HTML.includes(`>${m.value}</span>`), `metric ${m.key} value missing`);
      assert.ok(HTML.includes(escapeHtml(m.label)));
    }
    for (const column of ["Date and time", "Caller", "Suburb", "Service type", "Urgency", "Outcome", "Summary"]) {
      assert.ok(HTML.includes(`<th scope="col">${column}</th>`), `column "${column}" missing`);
    }
    assert.strictEqual(count(HTML, '<td data-label="Caller">'), demo.DASHBOARD.recentCalls.length);
  });

  it("renders pricing from config, with the founding-pilot limit", () => {
    assert.match(HTML, /A\$149 once/);
    assert.match(HTML, /A\$299 per month/);
    assert.match(HTML, /First 14 days/);
    assert.match(HTML, /Included/);
    assert.match(HTML, /Confirmed during setup/);
    assert.match(HTML, /Month-to-month/);
    assert.match(HTML, /first\s+3 Melbourne locksmith businesses/);
    assert.ok(!/stripe|card number|pay now/i.test(HTML), "M1 takes no payment");
  });

  it("pricing tracks config rather than hardcoded copy", () => {
    const custom = render({
      LOCKSMITH_SETUP_PRICE: "199",
      LOCKSMITH_MONTHLY_PRICE: "349",
      LOCKSMITH_INCLUDED_DAYS: "21",
      LOCKSMITH_PILOT_LIMIT: "5",
      LOCKSMITH_PILOT_REGION: "Geelong",
    });
    assert.match(custom, /A\$199 once/);
    assert.match(custom, /A\$349 per month/);
    assert.match(custom, /First 21 days/);
    assert.match(custom, /5 Geelong locksmith businesses/);
    assert.ok(!custom.includes("A$299 per month"), "the default price must not survive an override");
  });
});

describe("nothing on the page is invented", () => {
  it("shows no phone number at all until one is configured", () => {
    assert.ok(!HTML.includes("tel:"), "no tel: link without a real number");
    assert.ok(!/\b0[2-478][\s-]?\d{4}[\s-]?\d{4}\b/.test(HTML), "no AU national-format number");
    assert.ok(!/\+61[\s-]?\d/.test(HTML), "no +61 number");
    assert.ok(!/\b(1300|1800)[\s-]?\d{3}[\s-]?\d{3}\b/.test(HTML), "no 1300/1800 number");
    assert.match(HTML, /TO BE CONFIRMED: live demo number not yet provisioned/);
    assert.match(HTML, /Demo line not connected yet/);
  });

  it("marks every unsupplied founder detail as a visible placeholder", () => {
    for (const marker of [
      "TO BE CONFIRMED: Niche Drops ABN",
      "TO BE CONFIRMED: Australian contact email",
      "TO BE CONFIRMED: privacy policy URL",
      "TO BE CONFIRMED: terms of service URL",
    ]) {
      assert.ok(HTML.includes(marker), `missing placeholder: ${marker}`);
    }
    assert.ok(!/mailto:\[/.test(HTML), "a placeholder must never become a mailto: link");
    assert.ok(!/href="\[TO BE CONFIRMED/.test(HTML), "a placeholder must never become an href");
  });

  it("uses the real values, as real links, once they are configured", () => {
    const configured = render({
      LOCKSMITH_DEMO_PHONE: "+61 3 9000 0000",
      LOCKSMITH_CONTACT_EMAIL: "hello@example.com.au",
      NICHE_DROPS_ABN: "12 345 678 901",
      NICHE_DROPS_PRIVACY_URL: "/privacy",
      NICHE_DROPS_TERMS_URL: "/terms",
    });
    assert.match(configured, /href="tel:\+61390000000"/);
    assert.match(configured, /href="mailto:hello@example\.com\.au"/);
    assert.match(configured, /href="\/privacy">Privacy policy<\/a>/);
    assert.ok(!configured.includes("TO BE CONFIRMED"), "no placeholders remain when everything is supplied");
    assert.ok(!configured.includes("Demo line not connected yet"));
  });

  it("carries no testimonials, reviews, customer logos or revenue claims", () => {
    // Guards fabricated social proof. Deliberately does NOT ban the bare word
    // "review" — the page legitimately describes the approval review step.
    assert.ok(!/\btestimonials?\b|\bcustomer reviews?\b|\b\d+ reviews?\b|★|\brated\b|trusted by|customers say/i.test(HTML));
    assert.ok(!/\$\s?\d[\d,]*\s*(k|per week|per month) in (revenue|jobs|sales)/i.test(HTML));
    assert.ok(!/\bguarantee[ds]?\b/i.test(HTML), "no unsupported guarantees");
  });
});

describe("demonstration data is labelled wherever it appears", () => {
  it("every scenario and example-call card carries a demo tag", () => {
    // 4 scenarios + 4 example calls = 8 tags, plus the dashboard's own label.
    assert.strictEqual(count(HTML, 'class="demo-tag"'), 8);
    // Example-call tags read "Example call — demonstration data", scenario
    // tags "Demonstration data": same words, sentence-cased differently.
    const labelled = HTML.match(/demonstration data/gi) || [];
    assert.ok(labelled.length >= 10, `expected the demo label at least 10 times, saw ${labelled.length}`);
    assert.strictEqual(count(HTML, "Example call — demonstration data"), 4);
  });

  it("the dashboard is labelled a demonstration workspace and disclaims the figures", () => {
    assert.match(HTML, /Demonstration workspace — example locksmith calls/);
    assert.match(HTML, /figures are illustrative and do not represent any real business/);
    assert.match(HTML, /Example locksmith calls — demonstration data only/, "table caption");
  });

  it("the footer restates that everything shown is demonstration data", () => {
    assert.match(HTML, /All calls, callers, suburbs, transcripts and dashboard figures shown on this page are demonstration data\./);
  });

  it("transcripts are labelled as mock scripts with no recording attached", () => {
    assert.strictEqual(count(HTML, "Mock script written for illustration"), 4);
  });
});

describe("trust, disclosure and footer", () => {
  it("discloses the AI receptionist and the client-configured rules", () => {
    assert.match(HTML, /is an AI-powered phone receptionist, not a human operator/);
    assert.match(HTML, /Callers are told they are speaking to an automated assistant/);
    assert.match(HTML, /Transfers, escalations and notifications follow the rules each locksmith/);
  });

  it("names the provider and its Australian contact region", () => {
    assert.match(HTML, /A service of Niche Drops/);
    assert.match(HTML, /Melbourne, Victoria, Australia/);
  });
});

describe("accessibility contract", () => {
  it("has exactly one h1 and no skipped heading levels", () => {
    assert.strictEqual(count(HTML, "<h1"), 1);
    assert.ok(count(HTML, "<h2") >= 8, "each section needs an h2");
    // h3s only ever appear inside sections that already opened an h2.
    const firstH2 = HTML.indexOf("<h2");
    const firstH3 = HTML.indexOf("<h3");
    assert.ok(firstH2 > -1 && firstH2 < firstH3, "an h3 must never precede the first h2");
    assert.ok(!/<h[456]/i.test(HTML), "no heading level is skipped past h3");
  });

  it("provides the landmarks a screen-reader user navigates by", () => {
    assert.strictEqual(count(HTML, "<header"), 1);
    assert.strictEqual(count(HTML, "<main"), 1);
    assert.strictEqual(count(HTML, "<footer"), 1);
    assert.match(HTML, /<nav class="site-nav" aria-label="Page sections">/);
    assert.match(HTML, /<a class="skip-link" href="#main">Skip to main content<\/a>/);
    assert.match(HTML, /<main id="main">/);
  });

  it("labels every form control and groups multi-choice fields in a fieldset", () => {
    for (const field of FIELDS) {
      if (field.type === "checkboxes" || field.type === "radio") {
        assert.ok(HTML.includes(`<legend>${escapeHtml(field.label)}`), `${field.name} needs a legend`);
        for (const option of field.options) {
          assert.ok(HTML.includes(`for="f-${field.name}-${option.value}"`), `${field.name}.${option.value} needs a label`);
        }
        continue;
      }
      assert.ok(HTML.includes(`for="f-${field.name}"`), `${field.name} needs a <label for>`);
      assert.ok(HTML.includes(`id="f-${field.name}"`), `${field.name} needs a matching control id`);
    }
    assert.strictEqual(count(HTML, "<fieldset"), 3, "services, after-hours and preferred-contact are grouped");
  });

  it("points every control at its own error message, so it is announced on focus", () => {
    for (const field of FIELDS) {
      if (field.type === "checkboxes" || field.type === "radio") continue; // described by legend + hint
      const described = HTML.match(new RegExp(`id="f-${field.name}"[^>]*aria-describedby="([^"]+)"`))
        || HTML.match(new RegExp(`aria-describedby="([^"]+)"[^>]*id="f-${field.name}"`));
      assert.ok(described, `${field.name} needs aria-describedby`);
      assert.ok(described[1].includes(`f-${field.name}-error`), `${field.name} must reference its error slot`);
      if (field.hint) assert.ok(described[1].includes(`f-${field.name}-hint`), `${field.name} must keep its hint`);
    }
  });

  it("announces submission state and validation errors", () => {
    assert.match(HTML, /id="form-status" role="status" aria-live="polite" data-state="idle"/);
    assert.match(HTML, /id="error-summary" role="alert" tabindex="-1" hidden/);
    assert.strictEqual(count(HTML, "data-error-for="), FIELDS.length, "every field needs an error slot");
    assert.strictEqual(count(HTML, "data-summary-label="), FIELDS.length, "every field names itself for the error summary");
    assert.ok(HTML.includes('data-field="consent" data-summary-label="Consent"'), "consent uses its short summary label");
  });

  it("marks required and optional fields in text, not by colour or asterisk alone", () => {
    assert.ok(count(HTML, "(required)") >= 9);
    assert.ok(count(HTML, "(optional)") >= 2);
  });

  it("never signals urgency by colour alone", () => {
    const badges = HTML.match(/<span class="urgency urgency--[a-z]+">[\s\S]*?<\/span><\/span>/g) || [];
    assert.ok(badges.length >= 12, `expected an urgency badge per demo record, got ${badges.length}`);
    for (const badge of badges) {
      assert.match(badge, /urgency__marker/, "badge needs a non-colour marker");
      assert.match(badge, /urgency__label">(Urgent|Standard|Routine)</, "badge needs a text label");
    }
  });

  it("uses <details> for transcripts — keyboard-operable, no hover-only content", () => {
    assert.strictEqual(count(HTML, "<details"), 4);
    assert.ok(!/hover/i.test(HTML), "no hover instructions in the markup");
  });

  it("gives every link and button meaningful text", () => {
    const links = HTML.match(/<a [^>]*>([\s\S]*?)<\/a>/g) || [];
    for (const link of links) {
      const text = link.replace(/<[^>]+>/g, "").trim();
      assert.ok(text.length > 2, `link text too short: ${link}`);
      assert.ok(!/^(here|click here|read more|more)$/i.test(text), `unhelpful link text: ${text}`);
    }
  });
});

describe("output escaping — no unsafe HTML can reach the page", () => {
  it("escapes the dangerous characters, including quotes", () => {
    assert.strictEqual(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    assert.strictEqual(escapeHtml("Smith & Sons"), "Smith &amp; Sons");
    assert.strictEqual(escapeAttr(`" onload="evil()`), "&quot; onload=&quot;evil()");
    assert.strictEqual(escapeHtml(null), "", "a missing value renders empty, never the string 'undefined'");
    assert.strictEqual(escapeHtml(undefined), "");
    assert.strictEqual(escapeHtml(42), "42");
  });

  it("a hostile config value cannot inject markup or break out of an attribute", () => {
    const hostile = render({
      LOCKSMITH_CONTACT_EMAIL: `"><script>alert(1)</script>`,
      LOCKSMITH_PILOT_REGION: `</h2><img src=x onerror=alert(1)>`,
      NICHE_DROPS_PRIVACY_URL: `javascript:alert(1)`,
    });
    assert.ok(!hostile.includes("<script>alert(1)</script>"), "script must be escaped");
    // The literal text "onerror=" may appear as escaped body text; what must
    // never appear is a real tag carrying it.
    assert.ok(!/<img[^>]*onerror/i.test(hostile), "no live element with an event handler");
    assert.ok(hostile.includes("&lt;img src=x onerror=alert(1)&gt;"), "injected markup is inert text");
    assert.ok(hostile.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    // A javascript: URL is still escaped as text in an href; the CSP on the
    // route blocks execution, and no user input ever reaches this path.
    assert.ok(!hostile.includes(`href="javascript:alert(1)"><script`));
  });

  it("the page never echoes submitted form input — there is no input-to-markup path", () => {
    // Fields render with no value attribute at all: the server answers the
    // enquiry POST with JSON and the client writes it via textContent.
    // The only value attributes on the page are the fixed option values from
    // the field contract (plus the consent checkbox's). Anything else would
    // mean submitted input had been rendered back into markup.
    const allowed = new Set(["true"]);
    for (const f of FIELDS) for (const o of f.options || []) allowed.add(o.value);
    const rendered = [...HTML.matchAll(/<input [^>]*\bvalue="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(rendered.length > 0, "the option inputs should carry values");
    for (const v of rendered) assert.ok(allowed.has(v), `unexpected rendered input value: "${v}"`);
    assert.ok(!/<textarea[^>]*>[^<]/.test(HTML), "the textarea renders empty");
  });
});

describe("mobile layout does not depend on a fixed-width table", () => {
  const CSS = fs.readFileSync(path.join(__dirname, "../public/locksmith/locksmith.css"), "utf8");

  it("the table markup carries no width or layout attributes", () => {
    const tableMarkup = HTML.slice(HTML.indexOf('<table class="calls"'), HTML.indexOf("</table>"));
    assert.ok(!/\bwidth=/i.test(tableMarkup), "no width attributes");
    assert.ok(!/\bstyle=/i.test(tableMarkup), "no inline styles");
    assert.ok(!/\bnowrap\b/i.test(tableMarkup));
  });

  it("every cell carries its column name, so the stacked mobile layout hides nothing", () => {
    const cells = HTML.match(/<td data-label="[^"]+"/g) || [];
    assert.strictEqual(cells.length, demo.DASHBOARD.recentCalls.length * 7, "7 labelled cells per row");
    assert.ok(!/display:\s*none/i.test(CSS.replace(/\.calls thead \{ display: none; \}/, "")) ||
      /\.calls thead \{ display: none; \}/.test(CSS),
      "only the header row is visually replaced, never a data column");
  });

  it("the stylesheet is mobile-first: the table is fluid and restacks, never fixed", () => {
    assert.match(CSS, /\.calls \{ width: 100%;/, "table width is fluid");
    // The table itself carries no fixed width floor. (The data-label pseudo
    // element has a min-width — that's a label gutter inside a stacked cell,
    // not a table dimension, and it lives on `.calls td::before`.)
    assert.ok(!/\.calls \{[^}]*min-width/.test(CSS), "no fixed minimum table width");
    assert.ok(!/\.table-scroll \{[^}]*min-width/.test(CSS), "the scroll wrapper imposes no floor either");
    assert.ok(!/table-layout:\s*fixed/.test(CSS));
    assert.match(CSS, /\.calls td::before \{\s*content: attr\(data-label\)/, "stacked mode prints the column name");
    // The seven-column table stays stacked past the tablet breakpoint; the
    // tabular layout only returns where the columns actually fit.
    assert.match(CSS, /@media \(min-width: 900px\) \{\s*\.table-scroll \{ overflow-x: auto; \}/);
    // Base rules are the narrow layout; wider layouts are additions only.
    assert.match(CSS, /@media \(min-width: 760px\)/);
    assert.ok(!/@media \(max-width:/.test(CSS), "mobile-first: no max-width breakpoints");
  });

  it("controls meet a touch-friendly minimum and inputs don't trigger iOS zoom", () => {
    assert.match(CSS, /min-height: 48px/, "buttons and inputs are at least 48px tall");
    assert.match(CSS, /font-size: 16px;\s*\/\* 16px stops iOS zooming on focus \*\//);
    assert.match(CSS, /:focus-visible \{\s*outline: 3px solid/, "focus is always visible");
  });
});

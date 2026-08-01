// AIDA — client billing page (M6).
//
//   /client/locksmith/billing
//
// Behind requireClientAuth and the billing flag. Shows what the client is
// using, what it costs, and what plan suits them.
//
// TRUTHFULNESS RULES, and they are the whole point of this page:
//   * Every figure is labelled ESTIMATE until an invoice exists. A projected
//     charge shown as if it were final is the fastest way to lose a customer.
//   * The plan recommendation is the CHEAPEST option for their real usage,
//     even when a dearer plan would suit us better. Where headroom is tight we
//     say so and give the exact price difference, then let them choose.
//   * A payment problem never implies the phone has stopped being answered,
//     because it has not.
//   * Excluded calls are itemised. A client who is told "3 calls weren't
//     charged" and can see which ones will trust the ones that were.
//
// Presentation only. Every number comes from billing-plans / billing-usage /
// billing-account.

const { escapeHtml, escapeAttr } = require("./escape");
const { formatAud } = require("../services/billing-plans");

function chip(tone, label) {
  const markers = { good: "✓", attention: "!", bad: "✕", neutral: "•", muted: "–" };
  return `<span class="chip chip--${escapeAttr(tone)}"><span class="chip__marker" aria-hidden="true">${
    markers[tone] || "•"
  }</span>${escapeHtml(label)}</span>`;
}

function renderAccountState(account) {
  if (!account || account.state === "none") return "";
  const tone = account.paymentHealthy ? "good" : "attention";
  return `<div class="callout${account.paymentHealthy ? "" : " callout--attention"}">
    <p>${chip(tone, account.label)}</p>
    ${account.detail ? `<p>${escapeHtml(account.detail)}</p>` : ""}
    ${
      !account.paymentHealthy
        ? `<p><strong>Your phone is still being answered.</strong> A payment problem never stops AIDA picking up — we would not do that to your customers.</p>`
        : ""
    }
  </div>`;
}

function renderThisMonth(usage, price, plan) {
  return `<section aria-labelledby="usage-heading">
    <h2 id="usage-heading">This month so far</h2>
    <p class="lead">These are running totals for the current period. Nothing is charged until the period ends.</p>
    <dl class="stat-grid">
      <div class="stat"><dt>Calls</dt><dd>${escapeHtml(String(usage.billableCalls))}</dd></div>
      <div class="stat"><dt>of included</dt><dd>${escapeHtml(String(plan.includedCalls))}</dd></div>
      <div class="stat"><dt>Minutes</dt><dd>${escapeHtml(String(usage.billableMinutes))}</dd></div>
      <div class="stat"><dt>of included</dt><dd>${escapeHtml(String(plan.includedMinutes))}</dd></div>
    </dl>

    <table class="calls-table">
      <caption class="visually-hidden">Estimated charges this period</caption>
      <thead><tr><th scope="col">Item</th><th scope="col">Amount</th></tr></thead>
      <tbody>
        <tr><td data-label="Item">${escapeHtml(plan.name)} plan</td><td data-label="Amount">${escapeHtml(formatAud(price.listSubscriptionCents))}</td></tr>
        ${
          price.discountCents
            ? `<tr><td data-label="Item">Founding pilot discount</td><td data-label="Amount">−${escapeHtml(formatAud(price.discountCents))}</td></tr>`
            : ""
        }
        ${
          price.overCalls
            ? `<tr><td data-label="Item">${escapeHtml(String(price.overCalls))} calls beyond your included ${escapeHtml(String(plan.includedCalls))}</td><td data-label="Amount">${escapeHtml(formatAud(price.callOverageCents))}</td></tr>`
            : ""
        }
        ${
          price.overMinutes
            ? `<tr><td data-label="Item">${escapeHtml(String(price.overMinutes))} minutes beyond your included ${escapeHtml(String(plan.includedMinutes))}</td><td data-label="Amount">${escapeHtml(formatAud(price.minuteOverageCents))}</td></tr>`
            : ""
        }
        <tr><td data-label="Item"><strong>Estimated total</strong></td><td data-label="Amount"><strong>${escapeHtml(formatAud(price.totalCents))}</strong></td></tr>
      </tbody>
    </table>
    <p class="fine-print"><strong>Estimate.</strong> This is what the period would cost if it ended now. Your invoice is the final figure.</p>
    ${
      price.withinAllowance
        ? `<p>${chip("good", "Inside your plan")} You have not used more than your plan includes.</p>`
        : `<p>${chip("attention", "Using more than your plan includes")} AIDA keeps answering — the extra usage is charged at your plan's rate.</p>`
    }
  </section>`;
}

function renderExclusions(usage) {
  if (!usage.excludedCalls) return "";
  const labels = { too_short: "too short to be a conversation", spam: "marked as spam", setup_test: "your own test calls during setup" };
  const parts = Object.entries(usage.excludedByReason).map(
    ([reason, count]) => `${count} ${labels[reason] || reason}`
  );
  return `<section aria-labelledby="excluded-heading">
    <h2 id="excluded-heading">Calls we didn't charge you for</h2>
    <p>${escapeHtml(String(usage.excludedCalls))} call${usage.excludedCalls === 1 ? "" : "s"} this period: ${escapeHtml(parts.join(", "))}.</p>
    <p class="fine-print">Calls under ${escapeHtml(String(usage.billableMinimumSeconds || 6))} seconds are never charged — those are wrong numbers and hang-ups, not work.</p>
  </section>`;
}

function renderPlanComparison(fit, catalogue) {
  return `<section aria-labelledby="plans-heading">
    <h2 id="plans-heading">Your plan</h2>
    ${
      fit.shouldSwitch
        ? `<div class="callout${fit.direction === "downgrade" ? "" : " callout--attention"}">
      <p><strong>${escapeHtml(fit.recommended.name)} would suit your usage better.</strong>
      ${
        fit.direction === "downgrade"
          ? `On this month's usage it would have cost ${escapeHtml(formatAud(fit.savingCents))} less.`
          : `It costs more per month, but your usage charges would be lower.`
      }</p>
    </div>`
        : `<p>${chip("good", "You're on the right plan")} Nothing to change on this month's usage.</p>`
    }

    ${
      fit.headroomWarning
        ? `<div class="callout callout--attention">
      <p>${escapeHtml(fit.headroomWarning.message)}</p>
      ${
        fit.headroomWarning.alternative
          ? `<p>${escapeHtml(fit.headroomWarning.alternative.note)} We're still recommending the cheaper one — it's your call.</p>`
          : ""
      }
    </div>`
        : ""
    }

    <table class="calls-table">
      <caption class="visually-hidden">Plan comparison against this month's usage</caption>
      <thead><tr>
        <th scope="col">Plan</th><th scope="col">Monthly</th><th scope="col">Included</th><th scope="col">This month would cost</th>
      </tr></thead>
      <tbody>${fit.plans
        .map((p) => {
          const meta = catalogue.find((c) => c.id === p.planId) || {};
          const isRecommended = p.planId === fit.recommended.planId;
          const isCurrent = fit.current && p.planId === fit.current.planId;
          return `<tr${isRecommended ? ' class="row--urgent"' : ""}>
        <td data-label="Plan">
          <strong>${escapeHtml(p.name)}</strong>
          ${isCurrent ? chip("neutral", "Your plan") : ""}
          ${isRecommended ? chip("good", "Cheapest for you") : ""}
        </td>
        <td data-label="Monthly">${escapeHtml(formatAud(p.monthlyCents))}</td>
        <td data-label="Included">${escapeHtml(String(meta.includedCalls || ""))} calls / ${escapeHtml(String(meta.includedMinutes || ""))} min</td>
        <td data-label="This month would cost">${escapeHtml(formatAud(p.totalCents))}${
            p.overageCents ? `<br><span class="fine-print">includes ${escapeHtml(formatAud(p.overageCents))} usage</span>` : ""
          }</td>
      </tr>`;
        })
        .join("")}</tbody>
    </table>
    <p class="fine-print">Every figure is what that plan would have cost for the usage you actually had this month.</p>
  </section>`;
}

function renderOffer(offer) {
  if (!offer || !offer.offerActive) return "";
  return `<div class="callout">
    <p><strong>Founding pilot pricing.</strong> You're paying ${escapeHtml(formatAud(offer.payableMonthlyCents))} a month instead of ${escapeHtml(formatAud(offer.listMonthlyCents))} for your first ${escapeHtml(String(offer.monthsRemaining + offer.monthIndex))} months.</p>
    <p>${escapeHtml(String(offer.monthsRemaining))} month${offer.monthsRemaining === 1 ? "" : "s"} of the discount left. After that the normal price applies. Usage beyond your plan is charged as usual throughout.</p>
  </div>`;
}

function renderBillingPage({ account, usage, price, plan, fit, catalogue, offer, portalUrl, businessName, mode }) {
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Billing — AIDA</title>
<link rel="stylesheet" href="/locksmith/onboarding.css">
<link rel="stylesheet" href="/locksmith/portal.css">
</head>
<body class="locksmith locksmith-portal">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <p class="site-header__brand">
    <span class="site-header__product">AIDA</span>
    <span class="site-header__provider">${escapeHtml(businessName || "Billing")}</span>
  </p>
</header>

<main id="main">
  <h1>Billing</h1>

  ${
    mode && mode !== "live"
      ? `<p class="demo-banner"><span aria-hidden="true">●</span> Billing is in ${escapeHtml(mode)} mode — no real charges are made.</p>`
      : ""
  }

  ${renderAccountState(account)}
  ${renderOffer(offer)}
  ${renderThisMonth(usage, price, plan)}
  ${renderExclusions(usage)}
  ${renderPlanComparison(fit, catalogue)}

  <section aria-labelledby="manage-heading">
    <h2 id="manage-heading">Payment details and invoices</h2>
    ${
      portalUrl
        ? `<p><a class="btn btn--primary" href="${escapeAttr(portalUrl)}">Manage payment and invoices</a></p>
           <p class="fine-print">Opens Stripe, who handle the payment details. We never see your card number.</p>`
        : `<p class="fine-print">Payment management isn't switched on yet.</p>`
    }
  </section>
</main>

<footer class="site-footer">
  <p>Prices in Australian dollars. Usage figures are the same ones your invoice is calculated from.</p>
</footer>
</body>
</html>`;
}

module.exports = { renderBillingPage, renderThisMonth, renderPlanComparison, renderExclusions, renderOffer, renderAccountState, chip };

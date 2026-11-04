// Budget optimizer and plain-English rule parsing.
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { getSession } = await import("../src/store.js");
const { optimizeCart, adjustedRating } = await import("../src/optimizer.js");
const { runTool } = await import("../src/tools.js");
const { parseRule } = await import("../src/agent.js");
const { CATALOG, kindOf } = await import("../src/catalog.js");

const noop = () => {};
const kind = (k) => CATALOG.filter((p) => kindOf(p.sku) === k).map((p) => p.sku);
const camping = (people = 2) => [
  { label: "Tent", skus: kind("OUT-TENT") },
  { label: "Sleeping bags", skus: kind("OUT-BAG"), qty: people },
  { label: "Sleeping pads", skus: kind("OUT-PAD"), qty: people },
  { label: "Stove", skus: kind("OUT-STOVE"), required: false },
  { label: "Fuel", skus: kind("OUT-FUEL"), required: false, requires: "Stove" },
  { label: "Headlamps", skus: kind("OUT-LAMP"), required: false, qty: people },
  { label: "Water filter", skus: kind("OUT-FILTER"), required: false },
];

test("a complete camping setup for two fits $300 including tax", () => {
  const r = optimizeCart(getSession("plan_camping"), { slots: camping(), budget: 300 });
  assert.ok(r.feasible);
  assert.ok(r.totals.total <= 300);
  assert.deepEqual(
    r.items.map((i) => [i.sku, i.qty]),
    [["OUT-TENT-DOME", 1], ["OUT-BAG-40F", 2], ["OUT-PAD-FOAM", 2], ["OUT-STOVE", 1], ["OUT-FUEL", 1]],
  );
  assert.equal(r.totals.total, 289.55);
  assert.ok(r.skipped.some((s) => s.slot === "Headlamps" && /over your budget/.test(s.reason)));
  // The injected tent and the unverified headlamp seller are excluded with reasons.
  assert.ok(r.excluded.some((e) => e.sku === "OUT-TENT-CHEAP" && e.reasons.some((x) => /high risk/.test(x))));
  assert.ok(r.excluded.some((e) => e.sku === "OUT-LAMP-2PK"));
  assert.ok(r.tradeoffs.some((t) => /Ember 30°F/.test(t) && /over your budget/.test(t)));
});

test("an impossible budget explains the cheapest complete option", () => {
  const r = optimizeCart(getSession("plan_tight"), { slots: camping(), budget: 150 });
  assert.equal(r.feasible, false);
  assert.equal(r.cheapest_total, 243.56);
  assert.match(r.reason, /\$243\.56/);
});

test("the tightest limit wins: what's left of the month can bind before the named budget", () => {
  const s = getSession("plan_binding");
  s.policy = { ...s.policy, monthlyBudget: 280 };
  const r = optimizeCart(s, { slots: camping(), budget: 300 });
  assert.equal(r.budget.binding, "what's left of your monthly budget");
  assert.ok(r.totals.total <= 280);
});

test("dependent items are never bought alone", () => {
  // Room for fuel but not the stove: fuel must be skipped too.
  const r = optimizeCart(getSession("plan_dep"), { slots: [{ label: "Tent", skus: ["OUT-TENT-DOME"] }, { label: "Stove", skus: ["OUT-STOVE"], required: false }, { label: "Fuel", skus: ["OUT-FUEL"], required: false, requires: "Stove" }], budget: 120 });
  assert.ok(r.feasible);
  assert.deepEqual(r.items.map((i) => i.sku), ["OUT-TENT-DOME"]);
  assert.match(r.skipped.find((x) => x.slot === "Fuel").reason, /Only useful with Stove/);
});

test("category caps are respected by the plan", () => {
  const s = getSession("plan_category_cap");
  s.policy = { ...s.policy, categoryLimits: { outdoor: 240 } };
  const r = optimizeCart(s, { slots: camping(), budget: 300 });
  assert.ok(r.feasible);
  assert.ok(r.totals.subtotal <= 240);
});

test("quality preference trades extras for better essentials", () => {
  const r = optimizeCart(getSession("plan_quality"), { slots: camping(), budget: 300, prefer: "quality" });
  const balanced = optimizeCart(getSession("plan_quality_b"), { slots: camping(), budget: 300 });
  const avg = (x) => x.items.filter((i) => ["Tent", "Sleeping bags", "Sleeping pads"].includes(i.slot)).reduce((s, i) => s + i.adjusted_rating, 0);
  assert.ok(avg(r) > avg(balanced));
});

test("review-adjusted rating discounts ratings with few reviews", () => {
  assert.ok(adjustedRating({ rating: 4.9, reviews: 8 }) < adjustedRating({ rating: 4.6, reviews: 800 }));
});

test("plan_purchase builds a guardrail-checked cart and emits the plan", async () => {
  const s = getSession("plan_tool");
  const events = [];
  const r = await runTool(s, "plan_purchase", { slots: [{ label: "Tent", query: "tent" }, { label: "Sleeping bags", query: "sleeping bag", qty: 2 }], budget: 250 }, (e) => events.push(e));
  assert.ok(r.feasible);
  assert.equal(r.cart_status, "proposed");
  assert.equal(s.carts.get(r.cart_id).total, r.totals.total);
  assert.ok(events.some((e) => e.type === "plan"));
  assert.ok(!r.items.some((i) => i.sku === "OUT-TENT-CHEAP"));
});

test("the plain-English rules from the brief become structured proposals", () => {
  assert.deepEqual(parseRule("never spend more than $100 monthly on electronics"), { category_limits: [{ category: "electronics", monthly_limit: 100 }] });
  assert.deepEqual(parseRule("allow purchases below $30 from verified merchants without additional confirmation"), { auto_approve_below: 30, verified_merchants_only: true });
  assert.deepEqual(parseRule("block all gift cards"), { block_categories: ["gift_cards"] });
  assert.deepEqual(parseRule("do not purchase products rated below 4 stars"), { min_rating: 4 });
  assert.equal(parseRule("buy a $200 gift card for my sister"), null);
});

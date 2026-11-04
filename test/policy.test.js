// Natural-language rule proposals: consequences computed from live data,
// and every applied change versioned.
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { getSession, setPolicy } = await import("../src/store.js");
const { runTool } = await import("../src/tools.js");
const { captureCheckout } = await import("../src/checkout.js");

const noop = () => {};
const impactOf = async (s, changes) => (await runTool(s, "propose_policy_change", { summary: "test", ...changes }, noop)).impact || [];

test("a proposal says which open cart it would block", async () => {
  const s = getSession("pol_cart");
  await runTool(s, "propose_cart", { items: [{ sku: "ELC-EARBUDS", qty: 1 }], rationale: "x" }, noop);
  const impact = await impactOf(s, { category_limits: [{ category: "electronics", monthly_limit: 50 }] });
  assert.ok(impact.some((t) => /current cart \(\$\d+\.\d\d\) would be blocked/.test(t)), impact.join(" | "));
  assert.ok(impact.some((t) => /\$50\.00 of electronics spending left/.test(t)));
});

test("a proposal reports spending already over a new cap", async () => {
  const s = getSession("pol_spent");
  const cart = await runTool(s, "propose_cart", { items: [{ sku: "ELC-EARBUDS", qty: 1 }], rationale: "x" }, noop);
  s.purchaseIntent = true; // the user asked to buy (set by /api/chat from their message)
  const co = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  assert.equal((await captureCheckout(s, co.paypal_order_id)).status, 200);
  const impact = await impactOf(s, { category_limits: [{ category: "electronics", monthly_limit: 50 }] });
  assert.ok(impact.some((t) => /already spent \$79\.00 on electronics this month, over the new \$50\.00 cap/.test(t)), impact.join(" | "));
});

test("loosening rules is called out with warnings", async () => {
  const s = getSession("pol_loosen");
  const impact = await impactOf(s, { block_high_risk: false, unblock_categories: ["gift_cards"], auto_approve_below: 30 });
  assert.ok(impact.some((t) => /hide instructions for AI agents/.test(t)));
  assert.ok(impact.some((t) => /can't be refunded once redeemed/.test(t)));
  assert.ok(impact.some((t) => /up to \$30\.00 from verified merchants/.test(t)));
  assert.ok(impact.some((t) => /more catalog listings? would become buyable/.test(t)));
});

test("a stricter rating floor counts the listings it excludes", async () => {
  const s = getSession("pol_rating");
  const impact = await impactOf(s, { min_rating: 4.5 });
  assert.ok(impact.some((t) => /more catalog listings could no longer be bought/.test(t)));
});

test("every applied change bumps the policy version and keeps history", () => {
  const s = getSession("pol_version");
  const v = s.policyVersion;
  assert.equal(setPolicy(s, { ...s.policy }, "user", "no-op"), false);
  assert.equal(s.policyVersion, v);
  setPolicy(s, { ...s.policy, monthlyBudget: 600 }, "user", "raise");
  assert.equal(s.policyVersion, v + 1);
  assert.equal(s.policyHistory.at(-1).policy.monthlyBudget, 600);
  assert.equal(s.policyHistory.at(-1).by, "user");
});

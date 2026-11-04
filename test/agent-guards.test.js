// Tool-argument validation and server-side purchase consent: the model can't
// smuggle malformed input into a tool, or open a checkout the user didn't ask for.
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { getSession } = await import("../src/store.js");
const { runTool } = await import("../src/tools.js");
const { validate, detectPurchaseIntent } = await import("../src/validate.js");
const { applyPolicyChanges } = await import("../src/policy.js");

const noop = () => {};

test("malformed tool arguments are rejected with a correctable message", async () => {
  const s = getSession("guard_validate");
  const bad = await runTool(s, "propose_cart", { items: [{ sku: "OUT-LAMP", qty: 0 }], rationale: "x" }, noop);
  assert.match(bad.error, /input\.items\[0\]\.qty must be ≥ 1/);
  const missing = await runTool(s, "propose_cart", { rationale: "x" }, noop);
  assert.match(missing.error, /input\.items is required/);
  const badEnum = await runTool(s, "search_catalog", { query: "tent", category: "weapons" }, noop);
  assert.match(badEnum.error, /must be one of/);
  const frac = await runTool(s, "propose_cart", { items: [{ sku: "OUT-LAMP", qty: 1.5 }], rationale: "x" }, noop);
  assert.match(frac.error, /whole number/);
  assert.equal(s.carts.size, 0, "nothing ran");
  assert.ok(s.audit.some((a) => a.outcome === "error" && /Rejected invalid arguments/.test(a.detail)));
});

test("numeric strings are coerced and unknown fields dropped", () => {
  const schema = { type: "object", properties: { qty: { type: "integer", minimum: 1 } }, required: ["qty"] };
  const r = validate(schema, { qty: "2", price: 0.01 });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { qty: 2 });
});

test("checkout needs the user's own purchase request", async () => {
  const s = getSession("guard_intent");
  const cart = await runTool(s, "propose_cart", { items: [{ sku: "OUT-LAMP", qty: 1 }], rationale: "x" }, noop);
  s.purchaseIntent = false;
  const r = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  assert.equal(r.needs_user_confirmation, true);
  assert.equal(s.carts.get(cart.cart_id).status, "proposed");
  assert.ok(s.audit.some((a) => a.action === "checkout_needs_confirmation" && a.outcome === "blocked"));
  s.purchaseIntent = true;
  const ok = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  assert.match(ok.paypal_order_id, /^SIM-ORDER-/);
});

test("small verified carts under the auto-approve rule skip the question, others don't", async () => {
  const s = getSession("guard_auto");
  const { next } = applyPolicyChanges(s.policy, { auto_approve_below: 30, verified_merchants_only: false });
  s.policy = next;
  s.purchaseIntent = false;
  const small = await runTool(s, "propose_cart", { items: [{ sku: "OUT-LAMP", qty: 1 }], rationale: "x" }, noop); // $34.04
  assert.ok((await runTool(s, "create_paypal_checkout", { cart_id: small.cart_id }, noop)).needs_user_confirmation, "over $30");
  const tiny = await runTool(s, "propose_cart", { items: [{ sku: "OUT-FUEL", qty: 1 }], rationale: "x" }, noop); // $15.10
  assert.ok((await runTool(s, "create_paypal_checkout", { cart_id: tiny.cart_id }, noop)).paypal_order_id);
  const unverified = await runTool(s, "propose_cart", { items: [{ sku: "OUT-LAMP-2PK", qty: 1 }], rationale: "x" }, noop);
  assert.equal(unverified.status, "proposed");
  assert.ok((await runTool(s, "create_paypal_checkout", { cart_id: unverified.cart_id }, noop)).needs_user_confirmation, "unverified merchant");
});

test("purchase intent is read from the user's words", () => {
  for (const yes of ["Find me the cheapest tent and buy it.", "Looks good, please check out.", "yes", "go ahead", "Plan a camping trip under $300 and buy it"])
    assert.ok(detectPurchaseIntent(yes), yes);
  for (const no of ["Suggest a desk setup for $250", "Show me some earbuds to compare", "Don't buy anything yet, just suggest options", "Never spend more than $60 on electronics", "What's my budget?"])
    assert.equal(detectPurchaseIntent(no), false, no);
});

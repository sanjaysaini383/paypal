// Runs without any credentials: offline agent + simulated PayPal.
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { getSession } = await import("../src/store.js");
const { runTool, searchCatalog } = await import("../src/tools.js");
const { priceCart } = await import("../src/policy.js");
const paypal = await import("../src/paypal.js");

const noop = () => {};

test("pricing adds tax and free shipping over $75", () => {
  const t = priceCart([{ price: 100, qty: 1, category: "outdoor" }]);
  assert.deepEqual(t, { subtotal: 100, tax: 8.25, shipping: 0, total: 108.25 });
  const small = priceCart([{ price: 20, qty: 1, category: "home" }]);
  assert.equal(small.shipping, 6.99);
});

test("listings with instructions for AI agents are flagged", () => {
  const scam = searchCatalog({ query: "tent" }).find((p) => p.sku === "OUT-TENT-CHEAP");
  assert.ok(scam, "scam listing should appear in tent search");
  assert.deepEqual(scam.risk_flags, ["possible_prompt_injection_in_listing"]);
  assert.equal(scam.merchant_verified, false);
});

test("guardrails block what the injected listing asks for", async () => {
  const s = getSession("test_injection");
  const r = await runTool(s, "propose_cart", { items: [{ sku: "OUT-TENT-CHEAP", qty: 5 }, { sku: "OUT-TENT-4P", qty: 1 }], rationale: "x" }, noop);
  assert.equal(r.status, "blocked");
  const rules = r.violations.map((v) => v.rule);
  assert.ok(rules.includes("unverified_merchant"));
  assert.ok(rules.includes("low_rating"));
  // Blocked carts can't be checked out.
  const co = await runTool(s, "create_paypal_checkout", { cart_id: [...s.carts.keys()][0] }, noop);
  assert.ok(co.error);
});

test("blocked categories and per-order limit are enforced", async () => {
  const s = getSession("test_limits");
  const gift = await runTool(s, "propose_cart", { items: [{ sku: "GFT-CARD-50", qty: 1 }], rationale: "x" }, noop);
  assert.ok(gift.violations.some((v) => v.rule === "blocked_category"));
  const big = await runTool(s, "propose_cart", { items: [{ sku: "OUT-BAG-15F", qty: 2 }], rationale: "x" }, noop);
  assert.ok(big.violations.some((v) => v.rule === "per_order_limit"));
});

test("checkout, capture and partial refund through simulated PayPal", async () => {
  assert.equal(paypal.paypalMode, "simulated");
  const s = getSession("test_flow");
  const cart = await runTool(s, "propose_cart", { items: [{ sku: "OUT-TENT-2P", qty: 1 }, { sku: "OUT-LAMP", qty: 1 }], rationale: "x" }, noop);
  assert.equal(cart.status, "proposed");
  const events = [];
  const co = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, (e) => events.push(e));
  assert.match(co.paypal_order_id, /^SIM-ORDER-/);
  assert.equal(events.at(-1).type, "checkout");

  const cap = await paypal.captureOrder(co.paypal_order_id);
  assert.equal(cap.status, "COMPLETED");
  s.orders.push({
    orderId: cap.orderId, captureId: cap.captureId, capturedAt: new Date().toISOString(),
    items: s.carts.get(cart.cart_id).items.map((i) => ({ ...i, refunded: false })),
    total: cart.total, refunded: 0, refunds: [], status: "COMPLETED",
  });

  const r = await runTool(s, "refund_order", { order_id: cap.orderId, skus: ["OUT-LAMP"], reason: "Arrived broken" }, noop);
  assert.equal(r.amount, 27.05); // 24.99 + 8.25% tax
  assert.equal(r.order_status, "PARTIALLY_REFUNDED");
  const again = await runTool(s, "refund_order", { order_id: cap.orderId, skus: ["OUT-LAMP"], reason: "again" }, noop);
  assert.ok(again.error, "an item can only be refunded once");

  const wallet = await runTool(s, "get_wallet_status", {}, noop);
  assert.equal(wallet.spent_this_month, Math.round((cart.total - 27.05) * 100) / 100);
});

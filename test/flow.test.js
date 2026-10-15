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

test("refunding every item one by one also refunds shipping", async () => {
  const s = getSession("test_refund_all");
  // Under $75, so the order carries a shipping fee.
  const cart = await runTool(s, "propose_cart", { items: [{ sku: "HOM-MUG", qty: 1 }, { sku: "GRO-TEA", qty: 1 }], rationale: "x" }, noop);
  assert.equal(cart.shipping, 6.99);
  const co = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  const cap = await paypal.captureOrder(co.paypal_order_id);
  s.orders.push({
    orderId: cap.orderId, captureId: cap.captureId, capturedAt: new Date().toISOString(),
    items: s.carts.get(cart.cart_id).items.map((i) => ({ ...i, refunded: false })),
    total: cart.total, refunded: 0, refunds: [], status: "COMPLETED",
  });
  await runTool(s, "refund_order", { order_id: cap.orderId, skus: ["HOM-MUG"], reason: "x" }, noop);
  const last = await runTool(s, "refund_order", { order_id: cap.orderId, skus: ["GRO-TEA"], reason: "x" }, noop);
  assert.equal(last.order_status, "REFUNDED");
  assert.equal(s.orders[0].refunded, cart.total);
});

test("category limits block carts that would exceed the monthly cap", async () => {
  const s = getSession("test_category_limit");
  s.policy.categoryLimits = { electronics: 100 };
  const ok = await runTool(s, "propose_cart", { items: [{ sku: "ELC-EARBUDS", qty: 1 }], rationale: "x" }, noop);
  assert.equal(ok.status, "proposed");
  const over = await runTool(s, "propose_cart", { items: [{ sku: "ELC-EARBUDS", qty: 1 }, { sku: "ELC-MOUSE", qty: 1 }], rationale: "x" }, noop);
  const v = over.violations.find((x) => x.rule === "category_limit");
  assert.ok(v, "expected a category_limit violation");
  assert.equal(v.over_by, 28); // 79 + 49 - 100
});

test("a proposed rule change does nothing until applied", async () => {
  const s = getSession("test_rule_proposal");
  const events = [];
  const r = await runTool(s, "propose_policy_change", { category_limits: [{ category: "books", monthly_limit: 40 }], unblock_categories: ["gift_cards"], summary: "Cap books" }, (e) => events.push(e));
  assert.equal(r.status, "waiting_for_user");
  assert.deepEqual(r.changes.map((c) => c.label), ["Gift cards", "Books limit"]);
  assert.deepEqual(s.policy.categoryLimits, {}); // unchanged until the user applies it
  assert.ok(s.policy.blockedCategories.includes("gift_cards"));
  assert.equal(events[0].type, "policy_proposal");
  const none = await runTool(s, "propose_policy_change", { block_categories: ["gift_cards"], summary: "Already blocked" }, noop);
  assert.ok(none.error, "a no-op change is rejected");
});

// Refund calculation and duplicate-refund protection (simulated PayPal).
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { getSession, spentThisMonth, categorySpendThisMonth } = await import("../src/store.js");
const { runTool } = await import("../src/tools.js");
const { captureCheckout } = await import("../src/checkout.js");
const { computeRefund, issueRefund, settleOrder } = await import("../src/refunds.js");
const paypal = await import("../src/paypal.js");

const noop = () => {};

async function paidOrder(sid, items) {
  const s = getSession(sid);
  const cart = await runTool(s, "propose_cart", { items, rationale: "x" }, noop);
  const co = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  const r = await captureCheckout(s, co.paypal_order_id);
  assert.equal(r.status, 200);
  return { s, order: s.orders.at(-1) };
}

test("a line refund is item price plus its tax, computed from the order", async () => {
  const { order } = await paidOrder("refund_calc", [{ sku: "OUT-TENT-2P", qty: 1 }, { sku: "OUT-BAG-30F", qty: 2 }]);
  const calc = computeRefund(order, ["OUT-BAG-30F"]);
  assert.deepEqual(calc.lines, [{ sku: "OUT-BAG-30F", name: "Ember 30°F Synthetic Sleeping Bag", qty: 2, goods: 118, tax: 9.74 }]);
  assert.equal(calc.amount, 127.74);
  assert.equal(calc.full, false);
  assert.equal(calc.shipping, 0);
});

test("gift cards are refunded without tax", () => {
  const order = { total: 50, refunds: [], items: [{ sku: "GFT-CARD-50", name: "Gift", category: "gift_cards", price: 50, qty: 1, refunded: false }, { sku: "X", name: "x", category: "home", price: 10, qty: 1, refunded: false }] };
  assert.equal(computeRefund(order, ["GFT-CARD-50"]).tax, 0);
});

test("the same item refunded twice in parallel is refunded once", async () => {
  const { s, order } = await paidOrder("refund_parallel", [{ sku: "OUT-TENT-2P", qty: 1 }, { sku: "OUT-LAMP", qty: 1 }]);
  const calls = [1, 2, 3].map(() => runTool(s, "refund_order", { order_id: order.orderId, skus: ["OUT-LAMP"], reason: "broken" }, noop));
  const results = await Promise.all(calls);
  assert.equal(results.filter((r) => !r.error).length, 1);
  assert.equal(order.refunds.length, 1);
  assert.equal(order.refunded, 27.05);
});

test("a refund can never exceed what is left on the capture", async () => {
  const { s, order } = await paidOrder("refund_cap", [{ sku: "HOM-MUG", qty: 1 }, { sku: "GRO-TEA", qty: 1 }]);
  const full = await issueRefund(s, { order_id: order.orderId, reason: "cancel" });
  assert.equal(full.amount, order.total);
  assert.equal(order.status, "REFUNDED");
  const again = await issueRefund(s, { order_id: order.orderId, reason: "again" });
  assert.ok(again.error);
  // Even a direct call to PayPal is refused by its own limit.
  await assert.rejects(paypal.refundCapture(order.captureId, 1, "x", "different-key"), /REFUND_AMOUNT_EXCEEDED/);
});

test("a retried refund with the same request id is not repeated", async () => {
  const { order } = await paidOrder("refund_idem", [{ sku: "OUT-LAMP", qty: 1 }, { sku: "OUT-FUEL", qty: 1 }]);
  const a = await paypal.refundCapture(order.captureId, 5, "x", "same-key");
  const b = await paypal.refundCapture(order.captureId, 5, "x", "same-key");
  assert.equal(a.refundId, b.refundId);
});

test("a pending refund is not credited back to the budget until it completes", async () => {
  const { s, order } = await paidOrder("refund_pending", [{ sku: "OUT-TENT-2P", qty: 1 }, { sku: "OUT-LAMP", qty: 1 }]);
  const before = spentThisMonth(s);
  order.items.find((i) => i.sku === "OUT-LAMP").refunded = true;
  order.refunds.push({ id: "R1", amount: 27.05, status: "PENDING", skus: ["OUT-LAMP"] });
  settleOrder(order);
  assert.equal(spentThisMonth(s), before);
  assert.equal(categorySpendThisMonth(s).outdoor, 129 + 24.99);
  assert.equal(order.refundPending, true);
  order.refunds[0].status = "COMPLETED";
  settleOrder(order);
  assert.equal(Math.round(spentThisMonth(s) * 100) / 100, Math.round((before - 27.05) * 100) / 100);
  assert.equal(order.status, "PARTIALLY_REFUNDED");
});

test("a payment still pending at PayPal can't be refunded", async () => {
  const { s, order } = await paidOrder("refund_on_pending", [{ sku: "OUT-LAMP", qty: 1 }]);
  order.status = "PENDING";
  assert.match((await issueRefund(s, { order_id: order.orderId, reason: "x" })).error, /still being processed/);
});

test("refunds only see the caller's own orders", async () => {
  const { order } = await paidOrder("refund_owner", [{ sku: "OUT-LAMP", qty: 1 }]);
  const other = getSession("refund_intruder");
  const r = await runTool(other, "refund_order", { order_id: order.orderId, reason: "steal" }, noop);
  assert.match(r.error, /Unknown order_id/);
  assert.equal(order.refunded, 0);
});

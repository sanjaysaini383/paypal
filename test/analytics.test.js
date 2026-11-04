// Analytics come from stored records only, honour filters, and never mix
// sessions.
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { getSession } = await import("../src/store.js");
const { runTool } = await import("../src/tools.js");
const { captureCheckout } = await import("../src/checkout.js");
const { analytics, parseFilters } = await import("../src/analytics.js");

const noop = () => {};
async function buy(s, items) {
  const cart = await runTool(s, "propose_cart", { items, rationale: "x" }, noop);
  s.purchaseIntent = true; // the user asked to buy (set by /api/chat from their message)
  const co = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  assert.equal((await captureCheckout(s, co.paypal_order_id)).status, 200);
  return s.orders.at(-1);
}

test("an empty account reports zeros, not sample data", () => {
  const a = analytics(getSession("an_empty"));
  assert.equal(a.kpis.netSpend, 0);
  assert.equal(a.kpis.orders, 0);
  assert.deepEqual(a.byCategory, []);
  assert.equal(a.overTime.length, 30);
  assert.ok(a.overTime.every((d) => d.net === 0));
});

test("KPIs and breakdowns reflect captures and refunds", async () => {
  const s = getSession("an_main");
  const o1 = await buy(s, [{ sku: "OUT-TENT-DOME", qty: 1 }, { sku: "OUT-LAMP", qty: 1 }]);
  const o2 = await buy(s, [{ sku: "ELC-MOUSE", qty: 1 }]);
  await runTool(s, "refund_order", { order_id: o1.orderId, skus: ["OUT-LAMP"], reason: "damaged" }, noop);
  const a = analytics(s);
  assert.equal(a.kpis.orders, 2);
  assert.equal(a.kpis.grossSpend, Math.round((o1.total + o2.total) * 100) / 100);
  assert.equal(a.kpis.refunded, 27.05);
  assert.equal(a.kpis.netSpend, Math.round((o1.total + o2.total - 27.05) * 100) / 100);
  assert.equal(a.kpis.averageOrderValue, Math.round(((o1.total + o2.total) / 2) * 100) / 100);
  assert.deepEqual(a.byCategory.map((c) => [c.category, c.net]), [["outdoor", 99], ["electronics", 49]]);
  assert.deepEqual(a.byMerchant.find((m) => m.merchant === "Ridge & River Co."), { merchant: "Ridge & River Co.", gross: 123.99, net: 99, refunded: 24.99, lines: 2 });
  const today = a.overTime.at(-1);
  assert.equal(today.refunds, 27.05);
  assert.equal(a.ledger.find((r) => r.orderId === o1.orderId).items.find((i) => i.sku === "OUT-LAMP").status, "REFUNDED");
  assert.equal(a.kpis.spentThisMonth, a.kpis.netSpend);
});

test("filters narrow by merchant, category, status and date", async () => {
  const s = getSession("an_main");
  assert.equal(analytics(s, parseFilters({ merchant: "VoltHouse Electronics" })).kpis.orders, 1);
  assert.deepEqual(analytics(s, parseFilters({ category: "outdoor" })).lines.map((l) => l.sku).sort(), ["OUT-LAMP", "OUT-TENT-DOME"]);
  assert.equal(analytics(s, parseFilters({ status: "PARTIALLY_REFUNDED" })).kpis.orders, 1);
  assert.equal(analytics(s, parseFilters({ from: "2000-01-01", to: "2000-01-31" })).kpis.orders, 0);
  // Junk input is ignored, not trusted.
  assert.deepEqual(parseFilters({ category: "weapons", status: "PAID'; DROP", from: "yesterday" }), { from: null, to: null, merchant: null, category: null, status: null });
});

test("pending work is counted: checkouts awaiting approval", async () => {
  const s = getSession("an_pending");
  const cart = await runTool(s, "propose_cart", { items: [{ sku: "OUT-FUEL", qty: 2 }], rationale: "x" }, noop);
  s.purchaseIntent = true;
  await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  const a = analytics(s);
  assert.equal(a.kpis.pending.awaitingApproval.count, 1);
  assert.equal(a.kpis.pending.awaitingApproval.amount, cart.total);
});

test("blocked attempts and suspicious listings are counted from the audit trail", async () => {
  const s = getSession("an_guard");
  await runTool(s, "search_catalog", { query: "tent" }, noop);
  await runTool(s, "propose_cart", { items: [{ sku: "GFT-CARD-50", qty: 1 }], rationale: "x" }, noop);
  const a = analytics(s);
  assert.equal(a.kpis.blocked, 1);
  assert.ok(a.kpis.highRiskListings >= 1);
});

test("one session never sees another's analytics", () => {
  const a = analytics(getSession("an_stranger"));
  assert.equal(a.kpis.orders, 0);
  assert.deepEqual(a.facets.merchants, []);
});

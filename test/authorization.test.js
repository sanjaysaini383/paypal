// Purchase authorization engine: every way a capture could drift from what
// the user approved must be refused before money moves.
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { getSession, setPolicy } = await import("../src/store.js");
const { runTool } = await import("../src/tools.js");
const { captureCheckout, rejectCart } = await import("../src/checkout.js");
const { verifyIntegrity, publicAuthorization, AUTH_TTL_MS } = await import("../src/authorization.js");
const paypal = await import("../src/paypal.js");

const noop = () => {};

async function checkout(sid, items = [{ sku: "OUT-TENT-2P", qty: 1 }, { sku: "OUT-LAMP", qty: 1 }]) {
  const s = getSession(sid);
  const cart = await runTool(s, "propose_cart", { items, rationale: "test" }, noop);
  assert.equal(cart.status, "proposed");
  s.purchaseIntent = true; // the user asked to buy (set by /api/chat from their message)
  const co = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  assert.ok(!co.error, co.error);
  const c = s.carts.get(cart.cart_id);
  return { s, cart: c, auth: s.authorizations.get(c.authorizationId), orderId: co.paypal_order_id };
}

test("checkout issues a signed snapshot bound to the PayPal order", async () => {
  const { s, cart, auth, orderId } = await checkout("auth_issue");
  assert.equal(auth.status, "bound");
  assert.equal(auth.binding.paypalOrderId, orderId);
  assert.equal(auth.snapshot.total, cart.total);
  assert.deepEqual(auth.snapshot.items.map((i) => [i.sku, i.qty, i.unitPrice]), cart.items.map((i) => [i.sku, i.qty, i.price]));
  assert.equal(auth.snapshot.policyVersion, s.policyVersion);
  assert.ok(Object.isFrozen(auth.snapshot) && Object.isFrozen(auth.snapshot.items[0]), "snapshot is immutable");
  assert.throws(() => {
    auth.snapshot.items[0].qty = 9;
  }, TypeError);
  assert.deepEqual(verifyIntegrity(auth), []);
  // PayPal's copy references the authorization.
  const order = await paypal.getOrder(orderId);
  assert.equal(order.customId, auth.snapshot.id);
  assert.equal(publicAuthorization(auth).integrity, "valid");
});

test("a valid authorization captures once and is then used up", async () => {
  const { s, orderId, auth } = await checkout("auth_happy");
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 200);
  assert.equal(r.body.order.authorizationId, auth.snapshot.id);
  assert.equal(r.body.order.mode, "simulated");
  assert.equal(auth.status, "consumed");
});

test("replaying a used authorization is refused", async () => {
  const { s, cart, orderId } = await checkout("auth_replay");
  assert.equal((await captureCheckout(s, orderId)).status, 200);
  cart.status = "checkout"; // pretend something reopened the cart
  const again = await captureCheckout(s, orderId);
  assert.equal(again.status, 403);
  assert.equal(again.body.problems[0].code, "replay");
  assert.equal(s.orders.length, 1, "no second ledger entry");
});

test("a tampered snapshot fails signature verification and is revoked", async () => {
  const { s, auth, orderId } = await checkout("auth_tamper");
  auth.snapshot = { ...auth.snapshot, total: 1, maxAmount: 1 }; // e.g. edited on disk
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 403);
  assert.equal(r.body.problems[0].code, "tampered");
  assert.equal(auth.status, "revoked");
  assert.equal(s.orders.length, 0);
});

test("a tampered PayPal binding is detected", async () => {
  const { s, auth, orderId } = await checkout("auth_tamper_binding");
  auth.binding = { ...auth.binding, payee: { merchantId: "ATTACKER", email: "x@evil.example" } };
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 403);
  assert.equal(r.body.problems[0].code, "tampered");
});

test("changing a price after authorization blocks the capture", async () => {
  const { s, cart, orderId } = await checkout("auth_price");
  cart.items[0] = { ...cart.items[0], price: 1 };
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 403);
  assert.equal(r.body.problems[0].code, "cart_modified");
  assert.equal(cart.status, "blocked");
});

test("changing a quantity after authorization blocks the capture", async () => {
  const { s, cart, orderId } = await checkout("auth_qty");
  cart.items[1] = { ...cart.items[1], qty: 5 };
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 403);
  assert.equal(r.body.problems[0].code, "cart_modified");
});

test("an expired authorization can't be captured", async () => {
  const { s, cart, auth, orderId } = await checkout("auth_expired");
  const realNow = Date.now;
  Date.now = () => realNow() + AUTH_TTL_MS + 1000;
  try {
    const r = await captureCheckout(s, orderId);
    assert.equal(r.status, 403);
    assert.equal(r.body.problems[0].code, "expired");
  } finally {
    Date.now = realNow;
  }
  assert.equal(auth.status, "expired");
  assert.equal(cart.status, "expired");
});

test("a PayPal order whose amount differs from the authorization is refused", async () => {
  const { s, orderId } = await checkout("auth_paypal_amount");
  const sim = paypal.simulator.orders.get(orderId);
  sim.json.purchase_units[0].amount.value = "1.00"; // PayPal-side drift
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 403);
  assert.ok(r.body.problems.every((p) => p.code === "paypal_mismatch"));
  assert.ok(r.body.problems.some((p) => /amount/.test(p.message)));
});

test("a PayPal order with different line items is refused", async () => {
  const { s, orderId } = await checkout("auth_paypal_items");
  const sim = paypal.simulator.orders.get(orderId);
  sim.json.purchase_units[0].items[0].quantity = "3";
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 403);
  assert.ok(r.body.problems.some((p) => /line items/.test(p.message)));
});

test("a changed payee (merchant identity) is refused", async () => {
  const { s, orderId } = await checkout("auth_payee");
  const sim = paypal.simulator.orders.get(orderId);
  sim.json.purchase_units[0].payee = { merchant_id: "SOMEONEELSE", email_address: "other@example.com" };
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 403);
  assert.ok(r.body.problems.some((p) => /payee/.test(p.message)));
});

test("rules tightened after checkout are enforced at capture", async () => {
  const { s, orderId, auth } = await checkout("auth_policy_tightened");
  setPolicy(s, { ...s.policy, blockedCategories: [...s.policy.blockedCategories, "outdoor"] }, "user", "test");
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 403);
  assert.equal(r.body.problems[0].code, "policy_violation");
  assert.equal(auth.status, "revoked");
});

test("a looser rule change is re-validated and still captures", async () => {
  const { s, orderId } = await checkout("auth_policy_loosened");
  setPolicy(s, { ...s.policy, monthlyBudget: 900 }, "user", "test");
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 200);
  assert.ok(s.audit.some((a) => a.action === "authorization_revalidated"));
});

test("cancelling the cart cancels its authorization", async () => {
  const { s, cart, auth, orderId } = await checkout("auth_cancel");
  rejectCart(s, cart);
  assert.equal(auth.status, "cancelled");
  assert.equal((await captureCheckout(s, orderId)).status, 409);
});

test("a cart whose prices drifted from the catalog is never authorized", async () => {
  const s = getSession("auth_stale");
  const cart = await runTool(s, "propose_cart", { items: [{ sku: "OUT-LAMP", qty: 1 }], rationale: "x" }, noop);
  s.carts.get(cart.cart_id).items[0] = { ...s.carts.get(cart.cart_id).items[0], price: 0.5 };
  s.purchaseIntent = true; // the user asked to buy (set by /api/chat from their message)
  const co = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  assert.match(co.error, /price/);
  assert.equal(s.authorizations.size, 0);
});

test("parallel checkout calls for one cart open a single PayPal order", async () => {
  const s = getSession("auth_parallel");
  const cart = await runTool(s, "propose_cart", { items: [{ sku: "OUT-LAMP", qty: 1 }], rationale: "x" }, noop);
  s.purchaseIntent = true; // the user asked to buy (set by /api/chat from their message)
  const results = await Promise.all([1, 2, 3].map(() => runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop)));
  assert.equal(results.filter((r) => r.paypal_order_id && !r.error).length, 1);
  assert.equal(s.authorizations.size, 1);
});

test("only one capture per session runs at a time", async () => {
  const s = getSession("auth_session_lock");
  const a = await checkout("auth_session_lock", [{ sku: "OUT-LAMP", qty: 1 }]);
  const cart2 = await runTool(s, "propose_cart", { items: [{ sku: "OUT-FUEL", qty: 1 }], rationale: "x" }, noop);
  s.purchaseIntent = true; // the user asked to buy (set by /api/chat from their message)
  const co2 = await runTool(s, "create_paypal_checkout", { cart_id: cart2.cart_id }, noop);
  const [r1, r2] = await Promise.all([captureCheckout(s, a.orderId), captureCheckout(s, co2.paypal_order_id)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
});

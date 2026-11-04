// The real PayPal REST code path (OAuth, Orders v2, capture, Payments v2
// refunds, webhook verification) against a local fake of the PayPal API.
// No credentials or network needed; nothing here pretends a real payment.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";

const fake = { orders: new Map(), requests: [], tokens: 0, fail401Once: false, captureStatus: "COMPLETED", verifyBodies: [] };
let server;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "paypal-debug-id": "dbg123" });
  res.end(JSON.stringify(body));
}

server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = req.url;
    fake.requests.push({ method: req.method, url, headers: req.headers, raw });
    if (url === "/v1/oauth2/token") {
      const ok = req.headers.authorization === "Basic " + Buffer.from("test-client:test-secret").toString("base64");
      if (!ok) return send(res, 401, { error: "invalid_client" });
      fake.tokens++;
      return send(res, 200, { access_token: `tok${fake.tokens}`, expires_in: 32400 });
    }
    if (!/^Bearer tok\d+$/.test(req.headers.authorization || "")) return send(res, 401, { name: "AUTHENTICATION_FAILURE" });
    if (fake.fail401Once) {
      fake.fail401Once = false;
      return send(res, 401, { name: "AUTHENTICATION_FAILURE" });
    }
    let m;
    if (req.method === "POST" && url === "/v2/checkout/orders") {
      const body = JSON.parse(raw);
      const id = `ORDER${fake.orders.size + 1}`;
      const json = { id, status: "CREATED", purchase_units: body.purchase_units.map((pu) => ({ ...pu, payee: { merchant_id: "FAKEMERCHANT", email_address: "shop@example.com" } })) };
      fake.orders.set(id, json);
      return send(res, 201, json);
    }
    if (req.method === "GET" && (m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(url))) {
      const o = fake.orders.get(m[1]);
      return o ? send(res, 200, o) : send(res, 404, { name: "RESOURCE_NOT_FOUND" });
    }
    if (req.method === "POST" && (m = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(url))) {
      const o = fake.orders.get(m[1]);
      if (o.status !== "APPROVED" && !o.capture) return send(res, 422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
      o.capture ||= { id: `CAP-${m[1]}`, status: fake.captureStatus, amount: o.purchase_units[0].amount };
      o.status = "COMPLETED";
      return send(res, 201, { id: o.id, status: "COMPLETED", payer: { email_address: "buyer@example.com", name: { given_name: "Test", surname: "Buyer" } }, purchase_units: [{ payments: { captures: [{ id: o.capture.id, status: o.capture.status, amount: { currency_code: "USD", value: o.capture.amount.value } }] } }] });
    }
    if (req.method === "POST" && (m = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(url))) {
      const body = JSON.parse(raw);
      return send(res, 201, { id: `REF-${fake.requests.length}`, status: "PENDING", amount: body.amount });
    }
    if (req.method === "POST" && url === "/v1/notifications/verify-webhook-signature") {
      fake.verifyBodies.push(raw);
      const body = JSON.parse(raw);
      const ok = body.transmission_sig === "valid-sig" && body.webhook_id === "WH-TEST";
      return send(res, 200, { verification_status: ok ? "SUCCESS" : "FAILURE" });
    }
    send(res, 404, { name: "NOT_FOUND" });
  });
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

Object.assign(process.env, { PAYPAL_CLIENT_ID: "test-client", PAYPAL_CLIENT_SECRET: "test-secret", PAYPAL_API_BASE: BASE, PAYPAL_WEBHOOK_ID: "WH-TEST" });
const paypal = await import("../src/paypal.js");
const { getSession } = await import("../src/store.js");
const { runTool } = await import("../src/tools.js");
const { captureCheckout } = await import("../src/checkout.js");
const { receiveWebhook } = await import("../src/webhooks.js");

after(() => {
  server.closeAllConnections();
  server.close();
});

const noop = () => {};
const approve = (orderId) => (fake.orders.get(orderId).status = "APPROVED");
const signed = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "t1", "paypal-transmission-sig": "valid-sig", "paypal-transmission-time": "2026-11-05T00:00:00Z" };
let eventSeq = 0;
const webhook = (type, resource, headers = signed) => receiveWebhook(JSON.stringify({ id: `WH-EVT-${++eventSeq}`, event_type: type, resource }), headers);

async function checkout(sid, items = [{ sku: "OUT-TENT-2P", qty: 1 }, { sku: "OUT-LAMP", qty: 1 }]) {
  const s = getSession(sid);
  const cart = await runTool(s, "propose_cart", { items, rationale: "x" }, noop);
  const co = await runTool(s, "create_paypal_checkout", { cart_id: cart.cart_id }, noop);
  assert.ok(!co.error, co.error);
  return { s, orderId: co.paypal_order_id, cart: s.carts.get(cart.cart_id) };
}

test("non-production PayPal base runs in sandbox mode", () => assert.equal(paypal.paypalMode, "sandbox"));

test("order creation sends the authorized breakdown with an idempotency key", async () => {
  const { orderId, cart } = await checkout("sb_create");
  const req = fake.requests.find((r) => r.method === "POST" && r.url === "/v2/checkout/orders");
  const body = JSON.parse(req.raw);
  const pu = body.purchase_units[0];
  assert.equal(pu.amount.value, cart.total.toFixed(2));
  assert.equal(pu.custom_id, cart.authorizationId);
  assert.equal(pu.items.length, 2);
  assert.equal(req.headers["paypal-request-id"], `create-${cart.authorizationId}`);
  assert.match(orderId, /^ORDER/);
});

test("capture is refused until the buyer approves, then succeeds once", async () => {
  const { s, orderId, cart } = await checkout("sb_capture");
  const early = await captureCheckout(s, orderId);
  assert.equal(early.status, 409);
  assert.equal(early.body.problems[0].code, "not_approved");
  assert.equal(cart.status, "checkout", "buyer can still approve and retry");
  approve(orderId);
  const r = await captureCheckout(s, orderId);
  assert.equal(r.status, 200);
  assert.equal(r.body.order.mode, "sandbox");
  const capReq = fake.requests.find((x) => x.url === `/v2/checkout/orders/${orderId}/capture`);
  assert.equal(capReq.headers["paypal-request-id"], `capture-${orderId}`);
});

test("the OAuth token is cached and refreshed once after a 401", async () => {
  const before = fake.tokens;
  await checkout("sb_token_1");
  await checkout("sb_token_2");
  assert.equal(fake.tokens, before, "cached token reused");
  fake.fail401Once = true;
  await checkout("sb_token_3");
  assert.equal(fake.tokens, before + 1, "one refresh after the 401");
});

test("a PENDING capture is recorded as pending and settled by a verified webhook", async () => {
  fake.captureStatus = "PENDING";
  const { s, orderId, cart } = await checkout("sb_pending");
  approve(orderId);
  const r = await captureCheckout(s, orderId);
  fake.captureStatus = "COMPLETED";
  assert.equal(r.status, 200);
  const order = s.orders.at(-1);
  assert.equal(order.status, "PENDING");
  assert.equal(cart.status, "pending");
  assert.equal((await captureCheckout(s, orderId)).status, 409, "a pending capture is not retried");

  const done = await webhook("PAYMENT.CAPTURE.COMPLETED", { id: order.captureId, status: "COMPLETED", amount: { currency_code: "USD", value: order.total.toFixed(2) } });
  assert.equal(done.body.outcome, "completed");
  assert.equal(order.status, "COMPLETED");
  assert.equal(cart.status, "paid");
});

test("webhooks with a bad signature are rejected and change nothing", async () => {
  fake.captureStatus = "PENDING";
  const { s, orderId } = await checkout("sb_badsig");
  approve(orderId);
  await captureCheckout(s, orderId);
  fake.captureStatus = "COMPLETED";
  const order = s.orders.at(-1);
  const r = await webhook("PAYMENT.CAPTURE.DENIED", { id: order.captureId, status: "DECLINED" }, { ...signed, "paypal-transmission-sig": "forged" });
  assert.equal(r.status, 401);
  assert.equal(order.status, "PENDING");
  const missing = await webhook("PAYMENT.CAPTURE.DENIED", { id: order.captureId }, {});
  assert.equal(missing.status, 401);
});

test("the raw event body is passed to PayPal's verification unchanged", async () => {
  const raw = '{"id":"WH-RAW","event_type":"PAYMENT.CAPTURE.PENDING","resource":{"id":"nope"},  "extra" : 1.50}';
  await receiveWebhook(raw, signed);
  assert.ok(fake.verifyBodies.at(-1).endsWith(`"webhook_event":${raw}}`));
});

test("a duplicate delivery is applied once", async () => {
  fake.captureStatus = "PENDING";
  const { s, orderId } = await checkout("sb_dupe");
  approve(orderId);
  await captureCheckout(s, orderId);
  fake.captureStatus = "COMPLETED";
  const order = s.orders.at(-1);
  const event = JSON.stringify({ id: "WH-DUPE-1", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "EXT-REF-1", status: "COMPLETED", amount: { value: "10.00" }, links: [{ rel: "up", href: `${BASE}/v2/payments/captures/${order.captureId}` }] } });
  const a = await receiveWebhook(event, signed);
  const b = await receiveWebhook(event, signed);
  assert.equal(a.body.outcome, "refund_recorded");
  assert.equal(b.body.duplicate, true);
  assert.equal(order.refunds.length, 1);
});

test("out-of-order events never roll the ledger back", async () => {
  const { s, orderId } = await checkout("sb_order");
  approve(orderId);
  await captureCheckout(s, orderId);
  const order = s.orders.at(-1);
  const r = await runTool(s, "refund_order", { order_id: order.orderId, skus: ["OUT-LAMP"], reason: "Arrived damaged" }, noop);
  assert.equal(r.status, "PENDING");
  assert.equal(order.refunded, 0, "pending refund not credited yet");
  const up = [{ rel: "up", href: `${BASE}/v2/payments/captures/${order.captureId}` }];
  await webhook("PAYMENT.CAPTURE.REFUNDED", { id: r.refund_id, status: "COMPLETED", amount: { value: String(r.amount) }, links: up });
  assert.equal(order.refunded, r.amount);
  assert.equal(order.status, "PARTIALLY_REFUNDED");
  // Late, stale events arrive afterwards.
  await webhook("PAYMENT.CAPTURE.REFUNDED", { id: r.refund_id, status: "PENDING", amount: { value: String(r.amount) }, links: up });
  await webhook("PAYMENT.CAPTURE.PENDING", { id: order.captureId, status: "PENDING" });
  await webhook("PAYMENT.CAPTURE.DENIED", { id: order.captureId, status: "DECLINED" });
  assert.equal(order.refunds[0].status, "COMPLETED");
  assert.equal(order.status, "PARTIALLY_REFUNDED");
});

test("a denial for a pending capture removes it from spend", async () => {
  fake.captureStatus = "PENDING";
  const { s, orderId, cart } = await checkout("sb_denied");
  approve(orderId);
  await captureCheckout(s, orderId);
  fake.captureStatus = "COMPLETED";
  const { spentThisMonth } = await import("../src/store.js");
  assert.ok(spentThisMonth(s) > 0, "pending captures count against the budget");
  await webhook("PAYMENT.CAPTURE.DENIED", { id: s.orders.at(-1).captureId, status: "DECLINED" });
  assert.equal(s.orders.at(-1).status, "DENIED");
  assert.equal(cart.status, "denied");
  assert.equal(spentThisMonth(s), 0);
});

test("an event that arrives before its capture is recorded is applied afterwards", async () => {
  fake.captureStatus = "PENDING";
  const { s, orderId } = await checkout("sb_early");
  approve(orderId);
  const early = await webhook("PAYMENT.CAPTURE.COMPLETED", { id: `CAP-${orderId}`, status: "COMPLETED" });
  assert.equal(early.body.outcome, "deferred");
  await captureCheckout(s, orderId);
  fake.captureStatus = "COMPLETED";
  assert.equal(s.orders.at(-1).status, "COMPLETED");
});

test("the live PayPal API needs an explicit opt-in", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./src/paypal.js')"], {
    env: { ...process.env, PAYPAL_API_BASE: "https://api-m.paypal.com", PAYPAL_ALLOW_LIVE: "" },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PAYPAL_ALLOW_LIVE/);
});

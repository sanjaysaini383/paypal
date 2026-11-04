// Thin PayPal REST client: OAuth2, Orders v2 (create / get / capture),
// Payments v2 (refund) and webhook signature verification. Falls back to a
// local simulator when no credentials are configured so the app is still
// runnable end to end. The simulator never claims to be PayPal: every record
// it produces is labelled "simulated" and uses SIM- ids.
import crypto from "node:crypto";

const BASE = (process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const TIMEOUT_MS = Number(process.env.PAYPAL_TIMEOUT_MS) || 20_000;

// "live" moves real money, so it has to be switched on explicitly.
function detectMode() {
  if (!CLIENT_ID || !CLIENT_SECRET) return "simulated";
  const live = /^https:\/\/api(-m)?\.paypal\.com$/.test(BASE);
  if (live && process.env.PAYPAL_ALLOW_LIVE !== "1")
    throw new Error("PAYPAL_API_BASE points at the LIVE PayPal API. Set PAYPAL_ALLOW_LIVE=1 if you really mean to move real money.");
  return live ? "live" : "sandbox";
}

export const paypalMode = detectMode();
export const paypalClientId = CLIENT_ID;
export const CURRENCY = "USD";

export class PayPalError extends Error {
  constructor(message, details, status) {
    super(message);
    this.details = details;
    this.status = status;
  }
  get issue() {
    return this.details?.details?.[0]?.issue || this.details?.name || null;
  }
}

// ------------------------------------------------------------------ OAuth
let cachedToken = null; // { value, expiresAt }
let tokenRequest = null; // one in-flight fetch shared by concurrent callers

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  tokenRequest ||= (async () => {
    try {
      const res = await fetch(`${BASE}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Never include the response body: it can echo credentials back.
      if (!res.ok) throw new PayPalError(`PayPal OAuth failed (${res.status})`, null, res.status);
      const json = await res.json();
      cachedToken = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 0) * 1000 };
      return cachedToken.value;
    } finally {
      tokenRequest = null;
    }
  })();
  return tokenRequest;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries are only safe because every POST carries a PayPal-Request-Id: a
// retried capture or refund returns the original result instead of repeating.
async function call(method, path, body, idempotencyKey, { rawBody } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (idempotencyKey) headers["PayPal-Request-Id"] = idempotencyKey;
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: rawBody ?? (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const retryable = method === "GET" || idempotencyKey;
      if (retryable && attempt < 2) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw new PayPalError(`PayPal ${method} ${path} ${err.name === "TimeoutError" ? "timed out" : "unreachable"}`, null, 0);
    }
    if (res.status === 401 && attempt === 0) {
      cachedToken = null; // token revoked or expired early: fetch a new one once
      continue;
    }
    if (res.status >= 500 && (method === "GET" || idempotencyKey) && attempt < 2) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const json = await safeJson(res);
    if (!res.ok) {
      const issue = json?.details?.[0]?.issue || json?.name || res.status;
      throw new PayPalError(`PayPal ${method} ${path} failed: ${issue}`, json, res.status);
    }
    return { json, debugId: res.headers.get("paypal-debug-id") };
  }
}

const money = (n) => Number(n).toFixed(2);
const num = (v) => (v == null ? null : Number(v));

// Build an Orders v2 body with a full item breakdown so the buyer sees every
// line item, tax and shipping on the PayPal approval screen. custom_id binds
// the PayPal order to CartPilot's purchase authorization.
export function orderBody(cart, authorizationId) {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: cart.id,
        custom_id: authorizationId || cart.id,
        description: `CartPilot agent order (${cart.items.length} items)`,
        soft_descriptor: "CARTPILOT",
        amount: {
          currency_code: CURRENCY,
          value: money(cart.total),
          breakdown: {
            item_total: { currency_code: CURRENCY, value: money(cart.subtotal) },
            tax_total: { currency_code: CURRENCY, value: money(cart.tax) },
            shipping: { currency_code: CURRENCY, value: money(cart.shipping) },
          },
        },
        items: cart.items.map((i) => ({
          name: i.name.slice(0, 127),
          sku: i.sku,
          quantity: String(i.qty),
          unit_amount: { currency_code: CURRENCY, value: money(i.price) },
          category: i.category === "gift_cards" ? "DIGITAL_GOODS" : "PHYSICAL_GOODS",
        })),
      },
    ],
    // No payment_source here: the JS SDK Smart Buttons drive the approval
    // popup, and they expect a plain CREATED order.
  };
}

// The fields CartPilot verifies before capturing, in one flat shape.
export function normalizeOrder(json) {
  const pu = json?.purchase_units?.[0] || {};
  const b = pu.amount?.breakdown || {};
  return {
    id: json?.id,
    status: json?.status,
    customId: pu.custom_id ?? null,
    referenceId: pu.reference_id ?? null,
    currency: pu.amount?.currency_code ?? null,
    amount: num(pu.amount?.value),
    breakdown: { itemTotal: num(b.item_total?.value), tax: num(b.tax_total?.value), shipping: num(b.shipping?.value) },
    items: (pu.items || []).map((i) => ({ sku: i.sku, qty: Number(i.quantity), unitPrice: num(i.unit_amount?.value), currency: i.unit_amount?.currency_code })),
    payee: pu.payee ? { merchantId: pu.payee.merchant_id || null, email: pu.payee.email_address || null } : null,
  };
}

// ---------------------------------------------------------------- simulator
// Behaves like the REST API where it matters for correctness: orders must be
// approved before capture, captures and refunds are idempotent per request
// id, and refunds can't exceed what was captured.
const sim = new Map(); // orderId -> { json, capture }
const simRefunds = new Map(); // requestKey -> refund
const simId = (prefix) => prefix + crypto.randomBytes(6).toString("hex").toUpperCase();
const SIM_PAYEE = { merchant_id: "SIMULATEDMERCHANT", email_address: "merchant@cartpilot.example" };
export const simulator = { orders: sim }; // exposed for tests only

export function simulateBuyerApproval(orderId) {
  if (paypalMode !== "simulated") throw new Error("Only the simulator can approve orders on the buyer's behalf.");
  const o = sim.get(orderId);
  if (o && o.json.status === "CREATED") o.json.status = "APPROVED";
}

// ------------------------------------------------------------------ public

export async function createOrder(cart, authorizationId) {
  const body = orderBody(cart, authorizationId);
  if (paypalMode === "simulated") {
    const id = simId("SIM-ORDER-");
    const json = { id, status: "CREATED", purchase_units: body.purchase_units.map((pu) => ({ ...structuredClone(pu), payee: SIM_PAYEE })) };
    sim.set(id, { json, capture: null });
    return { ...normalizeOrder(json), debugId: null };
  }
  const { json, debugId } = await call("POST", "/v2/checkout/orders", body, `create-${authorizationId || cart.id}`);
  return { ...normalizeOrder(json), debugId };
}

export async function getOrder(orderId) {
  if (paypalMode === "simulated") {
    const o = sim.get(orderId);
    if (!o) throw new PayPalError("Order not found", { name: "RESOURCE_NOT_FOUND" }, 404);
    return normalizeOrder(o.json);
  }
  const { json } = await call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  return normalizeOrder(json);
}

export async function captureOrder(orderId) {
  if (paypalMode === "simulated") {
    const o = sim.get(orderId);
    if (!o) throw new PayPalError("Order not found", { name: "RESOURCE_NOT_FOUND" }, 404);
    await sleep(150); // network latency, so double clicks really overlap
    if (!o.capture) {
      if (o.json.status !== "APPROVED")
        throw new PayPalError("PayPal POST capture failed: ORDER_NOT_APPROVED", { details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
      const pu = o.json.purchase_units[0];
      o.capture = { id: simId("SIM-CAP-"), status: "COMPLETED", amount: Number(pu.amount.value), currency: pu.amount.currency_code, refunded: 0 };
      o.json.status = "COMPLETED";
    }
    return {
      orderId,
      status: "COMPLETED",
      captureId: o.capture.id,
      captureStatus: o.capture.status,
      amount: o.capture.amount,
      currency: o.capture.currency,
      payerEmail: "buyer@simulated.example",
      payerName: "Simulated Buyer",
      debugId: null,
    };
  }
  const { json, debugId } = await call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, undefined, `capture-${orderId}`);
  const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    orderId: json.id,
    status: json.status,
    captureId: capture?.id,
    captureStatus: capture?.status,
    amount: Number(capture?.amount?.value ?? NaN),
    currency: capture?.amount?.currency_code ?? null,
    payerEmail: json.payer?.email_address,
    payerName: [json.payer?.name?.given_name, json.payer?.name?.surname].filter(Boolean).join(" "),
    debugId,
  };
}

export async function refundCapture(captureId, amount, note, requestKey) {
  if (paypalMode === "simulated") {
    if (simRefunds.has(requestKey)) return simRefunds.get(requestKey);
    const order = [...sim.values()].find((o) => o.capture?.id === captureId);
    if (!order) throw new PayPalError("Capture not found", { name: "RESOURCE_NOT_FOUND" }, 404);
    if (order.capture.refunded + amount > order.capture.amount + 0.005)
      throw new PayPalError("PayPal refund failed: REFUND_AMOUNT_EXCEEDED", { details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] }, 422);
    order.capture.refunded = Math.round((order.capture.refunded + amount) * 100) / 100;
    const refund = { refundId: simId("SIM-REF-"), status: "COMPLETED", amount, currency: CURRENCY, debugId: null };
    simRefunds.set(requestKey, refund);
    return refund;
  }
  const { json, debugId } = await call(
    "POST",
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { amount: { currency_code: CURRENCY, value: money(amount) }, note_to_payer: note?.slice(0, 255) },
    requestKey,
  );
  return { refundId: json.id, status: json.status, amount: Number(json.amount?.value ?? amount), currency: json.amount?.currency_code ?? CURRENCY, debugId };
}

// Official webhook verification: PayPal checks the transmission signature
// against the configured webhook id. The raw event body is spliced in
// unchanged, because re-serialising it can change bytes and fail verification.
export async function verifyWebhookSignature(headers, rawBody, webhookId) {
  if (paypalMode === "simulated") return false; // no real webhooks without PayPal
  const field = (name) => headers[name] ?? headers[name.toLowerCase()];
  const meta = {
    auth_algo: field("paypal-auth-algo"),
    cert_url: field("paypal-cert-url"),
    transmission_id: field("paypal-transmission-id"),
    transmission_sig: field("paypal-transmission-sig"),
    transmission_time: field("paypal-transmission-time"),
    webhook_id: webhookId,
  };
  if (Object.values(meta).some((v) => !v)) return false;
  const body = JSON.stringify(meta).slice(0, -1) + `,"webhook_event":${rawBody}}`;
  const { json } = await call("POST", "/v1/notifications/verify-webhook-signature", undefined, undefined, { rawBody: body });
  return json?.verification_status === "SUCCESS";
}

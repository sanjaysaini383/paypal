// Thin PayPal REST client: OAuth2, Orders v2 (create / get / capture) and
// Payments v2 (refund). Falls back to a local simulator when no sandbox
// credentials are configured so the app is still runnable end to end.
import crypto from "node:crypto";

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";

export const paypalMode = CLIENT_ID && CLIENT_SECRET ? "sandbox" : "simulated";
export const paypalClientId = CLIENT_ID;

let cachedToken = null; // { value, expiresAt }

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new PayPalError(`OAuth failed (${res.status})`, await safeJson(res));
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

export class PayPalError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function call(method, path, body, idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  // PayPal-Request-Id makes POSTs idempotent: a retried capture or refund
  // can never charge or refund twice.
  if (idempotencyKey) headers["PayPal-Request-Id"] = idempotencyKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await safeJson(res);
  if (!res.ok) {
    const issue = json?.details?.[0]?.issue || json?.name || res.status;
    throw new PayPalError(`PayPal ${method} ${path} failed: ${issue}`, json);
  }
  return { json, debugId: res.headers.get("paypal-debug-id") };
}

const money = (n) => n.toFixed(2);

// Build an Orders v2 body with a full item breakdown so the buyer sees every
// line item, tax and shipping on the PayPal approval screen.
function orderBody(cart) {
  const currency = "USD";
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: cart.id,
        custom_id: cart.id,
        description: `CartPilot agent order (${cart.items.length} items)`,
        soft_descriptor: "CARTPILOT",
        amount: {
          currency_code: currency,
          value: money(cart.total),
          breakdown: {
            item_total: { currency_code: currency, value: money(cart.subtotal) },
            tax_total: { currency_code: currency, value: money(cart.tax) },
            shipping: { currency_code: currency, value: money(cart.shipping) },
          },
        },
        items: cart.items.map((i) => ({
          name: i.name.slice(0, 127),
          sku: i.sku,
          quantity: String(i.qty),
          unit_amount: { currency_code: currency, value: money(i.price) },
          category: i.category === "gift_cards" ? "DIGITAL_GOODS" : "PHYSICAL_GOODS",
        })),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "CartPilot",
          shipping_preference: "GET_FROM_FILE",
          user_action: "PAY_NOW",
        },
      },
    },
  };
}

// ---------------------------------------------------------------- simulator
const sim = new Map();
const simId = (prefix) => prefix + crypto.randomBytes(6).toString("hex").toUpperCase();

// ------------------------------------------------------------------ public

export async function createOrder(cart) {
  if (paypalMode === "simulated") {
    const id = simId("SIM-ORDER-");
    sim.set(id, { id, status: "CREATED", cart });
    return { id, status: "CREATED", debugId: null };
  }
  const { json, debugId } = await call("POST", "/v2/checkout/orders", orderBody(cart), `create-${cart.id}`);
  return { id: json.id, status: json.status, debugId };
}

export async function getOrder(orderId) {
  if (paypalMode === "simulated") {
    const o = sim.get(orderId);
    if (!o) throw new PayPalError("Order not found");
    return { id: o.id, status: o.status };
  }
  const { json } = await call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  return { id: json.id, status: json.status, payer: json.payer };
}

export async function captureOrder(orderId) {
  if (paypalMode === "simulated") {
    const o = sim.get(orderId);
    if (!o) throw new PayPalError("Order not found");
    if (o.status === "COMPLETED") throw new PayPalError("ORDER_ALREADY_CAPTURED");
    o.status = "COMPLETED";
    o.captureId = simId("SIM-CAP-");
    return {
      orderId,
      status: "COMPLETED",
      captureId: o.captureId,
      amount: o.cart.total,
      payerEmail: "buyer@sandbox.example",
      payerName: "Sandbox Buyer",
      debugId: null,
    };
  }
  const { json, debugId } = await call(
    "POST",
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    undefined,
    `capture-${orderId}`,
  );
  const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    orderId: json.id,
    status: json.status,
    captureId: capture?.id,
    captureStatus: capture?.status,
    amount: Number(capture?.amount?.value ?? 0),
    payerEmail: json.payer?.email_address,
    payerName: [json.payer?.name?.given_name, json.payer?.name?.surname].filter(Boolean).join(" "),
    debugId,
  };
}

export async function refundCapture(captureId, amount, note, requestKey) {
  if (paypalMode === "simulated") {
    return { refundId: simId("SIM-REF-"), status: "COMPLETED", amount, debugId: null };
  }
  const { json, debugId } = await call(
    "POST",
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    {
      amount: { currency_code: "USD", value: money(amount) },
      note_to_payer: note?.slice(0, 255),
    },
    requestKey,
  );
  return { refundId: json.id, status: json.status, amount: Number(json.amount?.value ?? amount), debugId };
}

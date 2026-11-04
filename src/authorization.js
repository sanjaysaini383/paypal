// Purchase authorization engine.
//
// Before CartPilot asks PayPal for an order, it issues an authorization: an
// immutable snapshot of exactly what may be charged (items, unit prices,
// quantities, merchants, tax, shipping, total, currency), the policy version
// it was checked against, and an expiry. The snapshot is HMAC-signed with a
// server-side key and then bound to one PayPal order id.
//
// At capture the server refuses to move money unless all of these hold:
// the signature still verifies, the authorization is bound and unexpired,
// it has not been used, the cart has not changed, the PayPal order matches
// the snapshot field by field, and the cart still passes the user's current
// policy. Nothing supplied by the browser or the model is part of the check.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newId, PERSIST, DATA_DIR, scheduleSave } from "./store.js";
import { checkCart } from "./policy.js";
import { getProduct } from "./catalog.js";
import { CURRENCY } from "./paypal.js";

export const AUTH_TTL_MS = Math.max(1, Number(process.env.AUTH_TTL_MINUTES) || 30) * 60_000;
const TERMINAL = new Set(["consumed", "cancelled", "expired", "revoked"]);

// ------------------------------------------------------------ signing key
// AUTH_SIGNING_SECRET in production; otherwise a random key saved next to the
// session file (so saved authorizations still verify after a restart).
function loadKey() {
  const env = process.env.AUTH_SIGNING_SECRET;
  if (env) {
    if (env.length < 32) throw new Error("AUTH_SIGNING_SECRET must be at least 32 characters.");
    return Buffer.from(env, "utf8");
  }
  if (!PERSIST) return crypto.randomBytes(32);
  const file = path.join(DATA_DIR, "signing.key");
  try {
    const saved = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
    if (saved.length === 32) return saved;
  } catch {}
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  } catch (err) {
    console.warn(`Couldn't save the signing key (${err.message}); authorizations won't survive a restart.`);
  }
  return key;
}
const KEY = loadKey();

// Stable serialisation: same object, same bytes, whatever the key order.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

const sign = (purpose, obj) => crypto.createHmac("sha256", KEY).update(`cartpilot:${purpose}:v1\n${canonical(obj)}`).digest("hex");
const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cents = (n) => Math.round(Number(n) * 100);
const problem = (code, message) => ({ code, message });

export const policyFingerprint = (policy) => crypto.createHash("sha256").update(canonical(policy)).digest("hex").slice(0, 16);

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function transition(auth, status, detail) {
  auth.status = status;
  auth.events.push({ at: new Date().toISOString(), status, detail });
  scheduleSave();
}

// ------------------------------------------------------------ lifecycle

// Prices are re-read from the catalog here: a cart object whose prices drifted
// from the catalog (stale or tampered) never gets authorized.
export function createAuthorization(session, cart, now = Date.now()) {
  for (const i of cart.items) {
    const p = getProduct(i.sku);
    if (!p) throw new Error(`${i.sku} is no longer in the catalog.`);
    if (cents(p.price) !== cents(i.price)) throw new Error(`The price of ${i.name} changed from $${i.price} to $${p.price}. Propose the cart again.`);
  }
  const snapshot = deepFreeze({
    v: 1,
    id: newId("auth"),
    sessionId: session.id,
    cartId: cart.id,
    currency: CURRENCY,
    items: cart.items.map((i) => ({ sku: i.sku, name: i.name, merchant: i.merchant, category: i.category, unitPrice: i.price, qty: i.qty })),
    merchants: [...new Set(cart.items.map((i) => i.merchant))].sort(),
    subtotal: cart.subtotal,
    tax: cart.tax,
    shipping: cart.shipping,
    total: cart.total,
    maxAmount: cart.total,
    policyVersion: session.policyVersion || 1,
    policyHash: policyFingerprint(session.policy),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AUTH_TTL_MS).toISOString(),
  });
  const auth = { snapshot, signature: sign("snapshot", snapshot), status: "issued", binding: null, bindingSignature: null, events: [] };
  transition(auth, "issued", `Authorized up to $${snapshot.maxAmount.toFixed(2)} under policy v${snapshot.policyVersion}`);
  session.authorizations.set(snapshot.id, auth);
  return auth;
}

// Ties the authorization to one PayPal order and the payee PayPal reported.
export function bindAuthorization(auth, order) {
  if (auth.status !== "issued") throw new Error(`Authorization is ${auth.status}; it can't be bound.`);
  const binding = { authorizationId: auth.snapshot.id, paypalOrderId: order.id, payee: order.payee || null, boundAt: new Date().toISOString() };
  auth.binding = deepFreeze(binding);
  auth.bindingSignature = sign("binding", binding);
  transition(auth, "bound", `Bound to PayPal order ${order.id}`);
}

export function cancelAuthorization(auth, status = "cancelled", detail = "Cancelled") {
  if (!auth || TERMINAL.has(auth.status)) return false;
  transition(auth, status, detail);
  return true;
}

export function consumeAuthorization(auth, captureId) {
  transition(auth, "consumed", `Captured as ${captureId}`);
}

// ------------------------------------------------------------ verification

export function verifyIntegrity(auth) {
  const out = [];
  if (!safeEqual(auth?.signature, sign("snapshot", auth?.snapshot ?? null))) out.push(problem("tampered", "The authorization snapshot was modified after it was signed."));
  if (auth?.binding && !safeEqual(auth.bindingSignature, sign("binding", auth.binding)))
    out.push(problem("tampered", "The authorization's PayPal binding was modified after it was signed."));
  return out;
}

// Field-by-field comparison of a PayPal order against the snapshot.
export function comparePayPalOrder(auth, order, { checkPayee = true } = {}) {
  const s = auth.snapshot;
  const out = [];
  const bad = (msg) => out.push(problem("paypal_mismatch", msg));
  if (auth.binding && order.id !== auth.binding.paypalOrderId) bad(`PayPal order ${order.id} is not the order this authorization is bound to.`);
  if (order.customId !== s.id) bad("The PayPal order does not reference this authorization.");
  if (order.currency !== s.currency) bad(`Currency ${order.currency} does not match the authorized ${s.currency}.`);
  if (cents(order.amount) !== cents(s.total)) bad(`PayPal amount $${order.amount} does not match the authorized $${s.total.toFixed(2)}.`);
  if (cents(order.amount) > cents(s.maxAmount)) bad("The PayPal amount exceeds the authorized maximum.");
  const b = order.breakdown || {};
  if (cents(b.itemTotal) !== cents(s.subtotal) || cents(b.tax) !== cents(s.tax) || cents(b.shipping) !== cents(s.shipping))
    bad("The PayPal amount breakdown (items, tax, shipping) differs from the authorization.");
  const key = (i) => `${i.sku}|${i.qty}|${cents(i.unitPrice)}`;
  const want = s.items.map(key).sort().join(",");
  const got = (order.items || []).map(key).sort().join(",");
  if (want !== got) bad("The PayPal order's line items differ from the authorized items.");
  const pinned = auth.binding?.payee;
  if (checkPayee && pinned && order.payee) {
    if ((pinned.merchantId && pinned.merchantId !== order.payee.merchantId) || (pinned.email && pinned.email !== order.payee.email))
      bad("The PayPal payee changed since the order was created.");
  }
  return out;
}

// Everything that must hold before money moves. `retryable` means the buyer
// can still fix it (e.g. hasn't approved yet); otherwise the authorization is
// finished and `finalStatus` says how.
export function assessCapture({ session, cart, auth, order, now = Date.now() }) {
  const integrity = verifyIntegrity(auth);
  if (integrity.length) return { ok: false, problems: integrity, finalStatus: "revoked" };

  const s = auth.snapshot;
  const statusProblem = {
    consumed: problem("replay", "This authorization was already used for a payment."),
    cancelled: problem("cancelled", "This authorization was cancelled."),
    revoked: problem("revoked", "This authorization was revoked."),
    expired: problem("expired", "This authorization has expired."),
    issued: problem("unbound", "This authorization is not bound to a PayPal order."),
  }[auth.status];
  if (statusProblem) return { ok: false, problems: [statusProblem], finalStatus: null };

  if (s.sessionId !== session.id || s.cartId !== cart.id || cart.authorizationId !== s.id)
    return { ok: false, problems: [problem("wrong_owner", "This authorization belongs to a different cart or session.")], finalStatus: "revoked" };

  if (now > Date.parse(s.expiresAt)) return { ok: false, problems: [problem("expired", `The authorization expired at ${s.expiresAt}.`)], finalStatus: "expired" };

  // The live cart must still be exactly what was authorized.
  const cartKey = (items) => items.map((i) => `${i.sku}|${i.qty}|${cents(i.price ?? i.unitPrice)}`).sort().join(",");
  if (cartKey(cart.items) !== cartKey(s.items) || cents(cart.total) !== cents(s.total))
    return { ok: false, problems: [problem("cart_modified", "The cart changed after it was authorized.")], finalStatus: "revoked" };

  const mismatch = comparePayPalOrder(auth, order);
  if (mismatch.length) return { ok: false, problems: mismatch, finalStatus: "revoked" };

  if (order.status !== "APPROVED")
    return { ok: false, problems: [problem("not_approved", `The PayPal order is ${order.status}, not approved by the buyer yet.`)], retryable: true };

  // Re-check the user's rules as they are now; they may have tightened.
  const lines = s.items.map((i) => {
    const p = getProduct(i.sku);
    return p ? { ...p, price: i.unitPrice, qty: i.qty } : { sku: i.sku, name: i.name, merchant: i.merchant, category: i.category, price: i.unitPrice, qty: i.qty, rating: 0, stock: 0 };
  });
  const violations = checkCart(session, lines, { subtotal: s.subtotal, tax: s.tax, shipping: s.shipping, total: s.total });
  if (violations.length)
    return {
      ok: false,
      problems: violations.map((v) => problem("policy_violation", v.message)),
      violations,
      finalStatus: "revoked",
    };

  return { ok: true, problems: [], policyChanged: (session.policyVersion || 1) !== s.policyVersion };
}

// After PayPal captured: did it capture exactly what was authorized?
export function verifyCaptureResult(auth, cap) {
  const s = auth.snapshot;
  const out = [];
  if (cents(cap.amount) !== cents(s.total)) out.push(problem("capture_amount", `PayPal captured $${cap.amount}, authorized $${s.total.toFixed(2)}.`));
  if (cap.currency && cap.currency !== s.currency) out.push(problem("capture_currency", `PayPal captured in ${cap.currency}, authorized ${s.currency}.`));
  return out;
}

// What the UI and API show: the snapshot plus its live state.
export function publicAuthorization(auth) {
  if (!auth) return null;
  return {
    ...auth.snapshot,
    status: auth.status,
    paypalOrderId: auth.binding?.paypalOrderId || null,
    payee: auth.binding?.payee || null,
    signature: auth.signature.slice(0, 16),
    integrity: verifyIntegrity(auth).length ? "invalid" : "valid",
    events: auth.events,
  };
}

// Mark authorizations past their expiry (and the carts waiting on them).
export function expireStale(session, now = Date.now()) {
  for (const auth of session.authorizations.values()) {
    if ((auth.status === "bound" || auth.status === "issued") && now > Date.parse(auth.snapshot.expiresAt)) {
      transition(auth, "expired", "Expired before the buyer paid");
      const cart = session.carts.get(auth.snapshot.cartId);
      if (cart?.status === "checkout") cart.status = "expired";
    }
  }
}

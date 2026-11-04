// Checkout and capture orchestration. The only code paths that create PayPal
// orders or capture money, both gated by the purchase authorization engine.
import { audit, remember } from "./store.js";
import { checkCart } from "./policy.js";
import { getProduct } from "./catalog.js";
import * as paypal from "./paypal.js";
import {
  createAuthorization,
  bindAuthorization,
  cancelAuthorization,
  consumeAuthorization,
  comparePayPalOrder,
  assessCapture,
  verifyCaptureResult,
  publicAuthorization,
} from "./authorization.js";

const fmt = (n) => `$${Number(n).toFixed(2)}`;

// Cart statuses: proposed → authorizing → checkout → capturing → paid | pending
// (blocked / rejected / replaced / expired on the side).
export async function openCheckout(session, cart, emit = () => {}) {
  if (cart.status === "checkout") return { error: "Checkout already created for this cart.", paypal_order_id: cart.paypalOrderId };
  if (cart.status === "paid" || cart.status === "pending") return { error: "This cart is already paid." };
  if (cart.status === "authorizing") return { error: "Checkout for this cart is already being created." };
  if (cart.status !== "proposed" && cart.status !== "blocked")
    return { error: `This cart was ${cart.status}. Use the user's current cart (get the latest cart_id from propose_cart).` };

  // Re-check: the budget or rules may have changed since the cart was proposed.
  const violations = checkCart(session, cart.items.map((i) => ({ ...getProduct(i.sku), qty: i.qty })), cart);
  if (violations.length) {
    cart.status = "blocked";
    cart.violations = violations;
    audit(session, "guardrail", "checkout_blocked", violations.map((v) => v.message).join(" | "), "blocked");
    emit({ type: "cart", cart });
    return { error: "Blocked by spending policy.", violations };
  }

  const previous = cart.status;
  cart.status = "authorizing"; // lock before any await: parallel tool calls can't open two orders
  let auth;
  try {
    auth = createAuthorization(session, cart);
  } catch (err) {
    cart.status = previous;
    audit(session, "guardrail", "authorization_refused", err.message, "blocked");
    return { error: err.message };
  }

  let order;
  try {
    order = await paypal.createOrder(cart, auth.snapshot.id);
  } catch (err) {
    cart.status = previous;
    cancelAuthorization(auth, "cancelled", `PayPal order creation failed: ${err.message}`);
    audit(session, "paypal", "order_failed", err.message, "error");
    return { error: `PayPal couldn't create the order: ${err.message}` };
  }

  // PayPal must have recorded exactly what was authorized.
  const mismatch = comparePayPalOrder(auth, order, { checkPayee: false });
  if (mismatch.length) {
    cart.status = previous;
    cancelAuthorization(auth, "revoked", mismatch[0].message);
    audit(session, "guardrail", "order_mismatch", mismatch.map((m) => m.message).join(" | "), "blocked");
    return { error: "The PayPal order did not match the authorized cart, so it was discarded." };
  }

  bindAuthorization(auth, order);
  cart.status = "checkout";
  cart.paypalOrderId = order.id;
  cart.authorizationId = auth.snapshot.id;
  audit(
    session,
    "guardrail",
    "authorization_issued",
    `${auth.snapshot.id}: up to ${fmt(auth.snapshot.maxAmount)} for ${auth.snapshot.items.length} item(s), policy v${auth.snapshot.policyVersion}, expires ${auth.snapshot.expiresAt}`,
  );
  audit(session, "paypal", "order_created", `Order ${order.id} for ${fmt(cart.total)} awaiting buyer approval (${paypal.paypalMode})${order.debugId ? ` debug ${order.debugId}` : ""}`);
  emit({ type: "checkout", cart, orderId: order.id, authorization: publicAuthorization(auth) });
  return { order, auth };
}

const reply = (status, body) => ({ status, body });

// Called when the buyer approved in PayPal (or pressed Approve in the simulator).
export async function captureCheckout(session, orderId) {
  const cart = [...session.carts.values()].find((c) => c.paypalOrderId === orderId);
  if (!cart) return reply(404, { error: "This order doesn't belong to your session." });
  if (["paid", "pending", "capturing"].includes(cart.status)) return reply(409, { error: "Already captured." });
  if (session.captureInFlight) return reply(409, { error: "Another payment is being processed. Try again in a moment." });
  if (cart.status !== "checkout") return reply(409, { error: `This cart is ${cart.status}; it can't be paid.` });
  const auth = session.authorizations.get(cart.authorizationId);
  if (!auth) {
    audit(session, "guardrail", "capture_blocked", `No purchase authorization for order ${orderId}`, "blocked");
    return reply(403, { error: "Capture blocked: this order has no purchase authorization." });
  }

  // Lock before the first await so a double click can't capture twice.
  session.captureInFlight = true;
  cart.status = "capturing";
  try {
    if (paypal.paypalMode === "simulated") paypal.simulateBuyerApproval(orderId);
    let order;
    try {
      order = await paypal.getOrder(orderId);
    } catch (err) {
      cart.status = "checkout";
      audit(session, "paypal", "order_lookup_failed", err.message, "error");
      return reply(502, { error: "Couldn't confirm the order with PayPal. Please try again." });
    }

    const verdict = assessCapture({ session, cart, auth, order });
    if (!verdict.ok) {
      if (verdict.retryable) {
        cart.status = "checkout";
        return reply(409, { error: verdict.problems[0].message, problems: verdict.problems });
      }
      if (verdict.finalStatus) cancelAuthorization(auth, verdict.finalStatus, verdict.problems.map((p) => p.message).join(" | "));
      cart.status = verdict.finalStatus === "expired" ? "expired" : "blocked";
      cart.violations = verdict.violations || verdict.problems.map((p) => ({ rule: p.code, message: p.message }));
      audit(session, "guardrail", "capture_blocked", `${auth.snapshot.id}: ${verdict.problems.map((p) => p.message).join(" | ")}`, "blocked");
      session.pendingEvents.push(`Payment for PayPal order ${orderId} was blocked before capture: ${verdict.problems[0].message}`);
      return reply(403, { error: `Capture blocked: ${verdict.problems[0].message}`, problems: verdict.problems });
    }
    if (verdict.policyChanged)
      audit(session, "guardrail", "authorization_revalidated", `${auth.snapshot.id} re-checked against policy v${session.policyVersion} (issued under v${auth.snapshot.policyVersion}): still compliant`);

    let cap;
    try {
      cap = await paypal.captureOrder(orderId);
    } catch (err) {
      cart.status = "checkout"; // unlock so the buyer can retry (e.g. another card)
      audit(session, "paypal", "capture_failed", err.message, "error");
      return reply(422, { error: err.message, issue: err.issue || null });
    }
    if (cap.captureStatus !== "COMPLETED" && cap.captureStatus !== "PENDING") {
      cart.status = "checkout";
      audit(session, "paypal", "capture_failed", `Capture ${cap.captureId || ""} ${cap.captureStatus || cap.status}`, "error");
      return reply(422, { error: `PayPal returned capture status ${cap.captureStatus || cap.status}.`, issue: cap.captureStatus || null });
    }

    // Money moved. The ledger records what PayPal did even if it disagrees
    // with the authorization, and raises an integrity alert instead of hiding it.
    const alert = verifyCaptureResult(auth, cap);
    const pending = cap.captureStatus === "PENDING";
    const s = auth.snapshot;
    const record = {
      orderId: cap.orderId || orderId,
      captureId: cap.captureId,
      cartId: cart.id,
      authorizationId: s.id,
      capturedAt: new Date().toISOString(),
      payer: cap.payerName || cap.payerEmail || "PayPal buyer",
      items: s.items.map((i) => ({ sku: i.sku, name: i.name, merchant: i.merchant, category: i.category, price: i.unitPrice, qty: i.qty, refunded: false })),
      subtotal: s.subtotal,
      tax: s.tax,
      shipping: s.shipping,
      total: Number.isFinite(cap.amount) ? cap.amount : s.total,
      currency: cap.currency || s.currency,
      refunded: 0,
      refunds: [],
      status: pending ? "PENDING" : "COMPLETED",
      mode: paypal.paypalMode,
      ...(alert.length ? { integrityAlert: alert.map((a) => a.message) } : {}),
    };
    session.orders.push(record);
    consumeAuthorization(auth, cap.captureId);
    cart.status = pending ? "pending" : "paid";
    audit(
      session,
      "paypal",
      pending ? "capture_pending" : "captured",
      `${pending ? "Capture pending" : "Captured"} ${cap.captureId} for ${fmt(record.total)} (order ${record.orderId}, ${paypal.paypalMode})${cap.debugId ? ` debug ${cap.debugId}` : ""}`,
      pending ? "warning" : "ok",
    );
    if (alert.length) audit(session, "guardrail", "integrity_alert", alert.map((a) => a.message).join(" | "), "error");
    const label = paypal.paypalMode === "simulated" ? "simulated PayPal" : paypal.paypalMode === "live" ? "PayPal" : "PayPal sandbox";
    session.pendingEvents.push(`The user approved PayPal order ${record.orderId} (${fmt(record.total)}); capture is ${record.status}.`);
    remember(session, {
      role: "agent",
      text: pending
        ? `Payment submitted: **${fmt(record.total)}** via ${label}. PayPal is still processing it; the ledger will update when it settles.`
        : `Payment complete: **${fmt(record.total)}** paid via ${label}. The authorization ${s.id} is now used up and can't be charged again.`,
    });
    return reply(200, { ok: true, order: record });
  } finally {
    session.captureInFlight = false;
  }
}

// The user cancelled a cart: its authorization dies with it.
export function rejectCart(session, cart) {
  cart.status = "rejected";
  const auth = cart.authorizationId && session.authorizations.get(cart.authorizationId);
  if (cancelAuthorization(auth, "cancelled", "Cart cancelled by the user"))
    audit(session, "guardrail", "authorization_cancelled", `${auth.snapshot.id} cancelled with cart ${cart.id}`);
}

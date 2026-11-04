// PayPal webhooks: asynchronous capture and refund outcomes reconciled into
// the ledger.
//
// - Authenticity: every event is checked with PayPal's verify-webhook-signature
//   API against PAYPAL_WEBHOOK_ID before anything is read from it.
// - Duplicates: PayPal retries deliveries; an event id is applied once.
// - Ordering: statuses only move forward (PENDING → COMPLETED → refunded;
//   DENIED/REVERSED are final), so a late or replayed event can't roll back
//   the ledger. Events for a capture that isn't recorded yet are deferred
//   and applied when it is.
import { audit, findOrderByCapture, webhookState, scheduleSave } from "./store.js";
import { settleOrder } from "./refunds.js";
import * as paypal from "./paypal.js";

const cents = (n) => Math.round(Number(n) * 100);
const RANK = { PENDING: 1, COMPLETED: 2, PARTIALLY_REFUNDED: 3, REFUNDED: 3, DENIED: 9, REVERSED: 9, FAILED: 9, VOIDED: 9 };
const HANDLED = new Set(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"]);
const DEFER_MS = 24 * 60 * 60 * 1000;

// Refund and reversal events carry the refund; the capture is its "up" link.
function captureIdOf(event) {
  const r = event.resource || {};
  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED" || event.event_type === "PAYMENT.CAPTURE.REVERSED") {
    const up = (r.links || []).find((l) => l.rel === "up")?.href || "";
    return /\/captures\/([^/?#]+)/.exec(up)?.[1] || null;
  }
  return r.id || null;
}

const cartOf = (session, order) => session.carts.get(order.cartId);

function reconcile(session, order, event) {
  const r = event.resource || {};
  const type = event.event_type;
  const note = (outcome, detail, level = "ok") => {
    audit(session, "paypal", "webhook", `${type} for order ${order.orderId}: ${detail}`, level);
    return outcome;
  };

  switch (type) {
    case "PAYMENT.CAPTURE.COMPLETED": {
      if (order.status !== "PENDING") return note("unchanged", `already ${order.status}`);
      if (r.amount && cents(r.amount.value) !== cents(order.total)) {
        order.integrityAlert = [...(order.integrityAlert || []), `Webhook reports $${r.amount.value}, ledger has $${order.total.toFixed(2)}`];
        audit(session, "guardrail", "integrity_alert", `Capture ${order.captureId}: webhook amount $${r.amount.value} ≠ $${order.total.toFixed(2)}`, "error");
      }
      order.status = "COMPLETED";
      settleOrder(order);
      const cart = cartOf(session, order);
      if (cart?.status === "pending") cart.status = "paid";
      session.pendingEvents.push(`PayPal confirmed the pending payment for order ${order.orderId}.`);
      return note("completed", "pending capture settled");
    }
    case "PAYMENT.CAPTURE.PENDING":
      return note("unchanged", order.status === "PENDING" ? "still pending" : `ignored, order is already ${order.status}`);
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED": {
      if (order.status !== "PENDING") return note("ignored", `stale denial ignored, order is ${order.status}`, "warning");
      order.status = "DENIED";
      const cart = cartOf(session, order);
      if (cart?.status === "pending") cart.status = "denied";
      session.pendingEvents.push(`PayPal denied the pending payment for order ${order.orderId}; no money was taken.`);
      return note("denied", "pending capture denied; excluded from spend", "warning");
    }
    case "PAYMENT.CAPTURE.REFUNDED": {
      const status = r.status === "COMPLETED" ? "COMPLETED" : r.status === "PENDING" ? "PENDING" : null;
      if (!status) return note("ignored", `refund ${r.id} status ${r.status}`, "warning");
      const existing = order.refunds.find((x) => x.id === r.id);
      if (existing) {
        if (existing.status === "PENDING" && status === "COMPLETED") {
          existing.status = "COMPLETED";
          settleOrder(order);
          return note("refund_completed", `refund ${r.id} completed`);
        }
        return note("unchanged", `refund ${r.id} already ${existing.status}`);
      }
      // Issued outside CartPilot (e.g. in the PayPal dashboard): record it.
      const amount = Number(r.amount?.value ?? 0);
      const already = order.refunds.filter((x) => x.status !== "FAILED").reduce((s, x) => s + x.amount, 0);
      if (cents(already + amount) > cents(order.total))
        audit(session, "guardrail", "integrity_alert", `Refunds on ${order.orderId} would exceed the captured $${order.total.toFixed(2)}`, "error");
      order.refunds.push({ id: r.id, amount, status, reason: "Refund issued in PayPal", source: "webhook", at: event.create_time || new Date().toISOString(), mode: paypal.paypalMode });
      settleOrder(order);
      return note("refund_recorded", `external refund ${r.id} of $${amount.toFixed(2)} recorded`, "warning");
    }
    case "PAYMENT.CAPTURE.REVERSED": {
      if (order.status === "REVERSED") return note("unchanged", "already reversed");
      order.status = "REVERSED";
      settleOrder(order);
      session.pendingEvents.push(`The payment for order ${order.orderId} was reversed by PayPal (chargeback or dispute).`);
      return note("reversed", "capture reversed; excluded from spend", "warning");
    }
  }
  return "ignored";
}

// Applies one verified event. Exported for tests and for deferred replay.
export function applyEvent(event) {
  if (!HANDLED.has(event.event_type)) return "ignored";
  const captureId = captureIdOf(event);
  if (!captureId) return "ignored";
  const found = findOrderByCapture(captureId);
  if (!found) {
    const queue = webhookState.deferred.get(captureId) || [];
    queue.push({ event, at: Date.now() });
    webhookState.deferred.set(captureId, queue.slice(-20));
    scheduleSave();
    return "deferred";
  }
  return reconcile(found.session, found.order, event);
}

// Called right after a capture is recorded: replays events that beat it here.
export function applyDeferred(captureId) {
  const queue = webhookState.deferred.get(captureId);
  if (!queue) return [];
  webhookState.deferred.delete(captureId);
  scheduleSave();
  const found = findOrderByCapture(captureId);
  if (!found) return [];
  return queue.filter((q) => Date.now() - q.at < DEFER_MS).map((q) => reconcile(found.session, found.order, q.event));
}

export async function receiveWebhook(rawBody, headers) {
  if (paypal.paypalMode === "simulated") return { status: 404, body: { error: "Webhooks are only accepted with PayPal API credentials configured." } };
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return { status: 503, body: { error: "PAYPAL_WEBHOOK_ID is not configured." } };
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } };
  }
  if (typeof event?.id !== "string" || typeof event?.event_type !== "string") return { status: 400, body: { error: "Not a PayPal event" } };

  let verified = false;
  try {
    verified = await paypal.verifyWebhookSignature(headers, rawBody, webhookId);
  } catch (err) {
    console.warn(`Webhook ${event.id}: verification call failed (${err.message})`);
    return { status: 502, body: { error: "Could not verify the event; PayPal will retry." } };
  }
  if (!verified) {
    console.warn(`Webhook ${event.id} rejected: signature did not verify`);
    return { status: 401, body: { error: "Signature verification failed" } };
  }
  if (webhookState.processed.has(event.id)) return { status: 200, body: { ok: true, duplicate: true } };
  webhookState.processed.set(event.id, Date.now()); // before applying: a concurrent retry is a duplicate
  scheduleSave();
  const outcome = applyEvent(event);
  return { status: 200, body: { ok: true, outcome } };
}

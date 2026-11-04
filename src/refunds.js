// Refunds through PayPal Payments v2. Amounts are computed on the server from
// the authorized snapshot recorded on the order (never from model input), one
// refund per order runs at a time, and a refund PayPal reports as PENDING is
// not credited back to the budget until it completes.
import { audit } from "./store.js";
import { TAX_RATE } from "./policy.js";
import * as paypal from "./paypal.js";

const round2 = (n) => Math.round(n * 100) / 100;
const inFlight = new Set(); // `${sessionId}:${orderId}`

// Refunds saved before statuses were tracked count as completed.
const completedRefunds = (o) => round2(o.refunds.filter((r) => (r.status ?? "COMPLETED") === "COMPLETED").reduce((s, r) => s + r.amount, 0));
const pendingRefunds = (o) => round2(o.refunds.filter((r) => r.status === "PENDING").reduce((s, r) => s + r.amount, 0));

// Recompute order.refunded and status from its refund records.
export function settleOrder(order) {
  order.refunded = completedRefunds(order);
  if (["PENDING", "DENIED", "FAILED", "REVERSED", "VOIDED"].includes(order.status)) return order;
  order.status = order.refunded >= order.total - 0.005 ? "REFUNDED" : order.refunded > 0 ? "PARTIALLY_REFUNDED" : "COMPLETED";
  order.refundPending = pendingRefunds(order) > 0;
  return order;
}

// Pure calculation, also used to show the user the breakdown.
export function computeRefund(order, skus) {
  const open = order.items.filter((i) => !i.refunded);
  const remaining = round2(order.total - completedRefunds(order) - pendingRefunds(order));
  const wanted = Array.isArray(skus) && skus.length ? open.filter((i) => skus.includes(i.sku)) : open;
  if (!wanted.length) return { error: skus?.length ? "None of those SKUs are refundable on this order." : "Nothing left to refund on this order." };
  const lines = wanted.map((i) => {
    const goods = round2(i.price * i.qty);
    const tax = i.category === "gift_cards" ? 0 : round2(goods * TAX_RATE);
    return { sku: i.sku, name: i.name, qty: i.qty, goods, tax };
  });
  const goods = round2(lines.reduce((s, l) => s + l.goods, 0));
  const tax = round2(lines.reduce((s, l) => s + l.tax, 0));
  // Returning the last open items refunds everything left, shipping included,
  // so the order can reach REFUNDED instead of stalling a few cents short.
  const last = wanted.length === open.length;
  const amount = last ? remaining : Math.min(remaining, round2(goods + tax));
  return { lines, goods, tax, shipping: last ? round2(Math.max(0, amount - goods - tax)) : 0, amount, remainingBefore: remaining, full: last };
}

export async function issueRefund(session, { order_id, skus, reason }) {
  const order = session.orders.find((o) => o.orderId === order_id);
  if (!order) return { error: "Unknown order_id. Call get_wallet_status to see captured orders." };
  if (order.status === "PENDING") return { error: "This payment is still being processed by PayPal; it can be refunded once it completes." };
  if (["DENIED", "FAILED", "REVERSED", "VOIDED"].includes(order.status)) return { error: `This payment is ${order.status.toLowerCase()}; there is nothing to refund.` };
  const lockKey = `${session.id}:${order.orderId}`;
  if (inFlight.has(lockKey)) return { error: "A refund for this order is already in progress." };

  const calc = computeRefund(order, skus);
  if (calc.error) return calc;
  if (calc.amount <= 0) return { error: "This order is already fully refunded." };

  inFlight.add(lockKey); // before the await: a parallel call can't refund the same lines
  const lines = order.items.filter((i) => calc.lines.some((l) => l.sku === i.sku));
  for (const l of lines) l.refunded = "pending";
  const why = String(reason || "Refund").slice(0, 200);
  const key = `refund-${order.captureId}-${lines.map((l) => l.sku).sort().join("+")}`;
  try {
    const refund = await paypal.refundCapture(order.captureId, calc.amount, why, key);
    if (refund.status === "FAILED" || refund.status === "CANCELLED") throw new Error(`PayPal refund ${refund.refundId} ${refund.status}`);
    for (const l of lines) l.refunded = true;
    const record = {
      id: refund.refundId,
      amount: refund.amount,
      status: refund.status === "COMPLETED" ? "COMPLETED" : "PENDING",
      reason: why,
      skus: lines.map((l) => l.sku),
      calculation: calc,
      at: new Date().toISOString(),
      mode: paypal.paypalMode,
    };
    // The webhook may have recorded this refund first: merge, never downgrade.
    const seen = order.refunds.find((r) => r.id === record.id);
    if (seen) Object.assign(seen, record, { status: seen.status === "COMPLETED" ? "COMPLETED" : record.status, source: undefined });
    else order.refunds.push(record);
    settleOrder(order);
    audit(session, "paypal", "refund", `Refund ${refund.refundId} of $${refund.amount.toFixed(2)} (${refund.status}) on order ${order.orderId}: ${why}`, refund.status === "COMPLETED" ? "ok" : "warning");
    return { refund_id: refund.refundId, status: refund.status, amount: refund.amount, order_status: order.status, calculation: calc, order_id: order.orderId };
  } catch (err) {
    for (const l of lines) l.refunded = false;
    audit(session, "paypal", "refund_failed", `Order ${order.orderId}: ${err.message}`, "error");
    return { error: `PayPal refund failed: ${err.message}` };
  } finally {
    inFlight.delete(lockKey);
  }
}

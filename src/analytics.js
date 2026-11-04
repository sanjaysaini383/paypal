// Financial analytics, computed from the session's own stored records
// (orders, refunds, carts, audit log, risk events). Nothing here is sample
// data: an empty account shows zeros.
import { countsAsSpend, spentThisMonth } from "./store.js";
import { CATEGORIES, TAX_RATE } from "./policy.js";

const round2 = (n) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
export const STATUSES = ["COMPLETED", "PENDING", "PARTIALLY_REFUNDED", "REFUNDED", "DENIED", "REVERSED"];

const completedRefunds = (o) => o.refunds.filter((r) => (r.status ?? "COMPLETED") === "COMPLETED");
const pendingRefunds = (o) => o.refunds.filter((r) => r.status === "PENDING");

function lineStatus(order, item) {
  if (item.refunded === true) {
    const r = order.refunds.find((x) => (x.skus || []).includes(item.sku));
    return r?.status === "PENDING" ? "REFUND_PENDING" : "REFUNDED";
  }
  return order.status === "PARTIALLY_REFUNDED" || order.status === "REFUNDED" ? "COMPLETED" : order.status;
}

// One row per order for the ledger grid.
export function ledgerRows(session) {
  return session.orders.map((o) => ({
    orderId: o.orderId,
    captureId: o.captureId,
    authorizationId: o.authorizationId || null,
    capturedAt: o.capturedAt,
    merchants: [...new Set(o.items.map((i) => i.merchant))],
    categories: [...new Set(o.items.map((i) => i.category))],
    items: o.items.map((i) => ({ ...i, status: lineStatus(o, i) })),
    itemCount: o.items.reduce((s, i) => s + i.qty, 0),
    subtotal: o.subtotal,
    tax: o.tax,
    shipping: o.shipping,
    total: o.total,
    refunded: round2(completedRefunds(o).reduce((s, r) => s + r.amount, 0)),
    refundPending: round2(pendingRefunds(o).reduce((s, r) => s + r.amount, 0)),
    net: countsAsSpend(o) ? round2(o.total - completedRefunds(o).reduce((s, r) => s + r.amount, 0)) : 0,
    status: o.status,
    mode: o.mode || "simulated",
    payer: o.payer,
    refunds: o.refunds,
    integrityAlert: o.integrityAlert || null,
  }));
}

// One row per order line, for category / merchant breakdowns and filters.
export function lineRows(session) {
  return session.orders.flatMap((o) =>
    o.items.map((i) => {
      const amount = round2(i.price * i.qty);
      const status = lineStatus(o, i);
      const counts = countsAsSpend(o) && status !== "REFUNDED";
      return {
        id: `${o.orderId}:${i.sku}`,
        orderId: o.orderId,
        date: o.capturedAt,
        sku: i.sku,
        name: i.name,
        merchant: i.merchant,
        category: i.category,
        qty: i.qty,
        unitPrice: i.price,
        amount,
        tax: i.category === "gift_cards" ? 0 : round2(amount * TAX_RATE),
        net: counts ? amount : 0,
        status,
        orderStatus: o.status,
        mode: o.mode || "simulated",
      };
    }),
  );
}

export function parseFilters(q = {}) {
  const date = (v, endOfDay) => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return null;
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) ? t + (endOfDay ? DAY - 1 : 0) : null;
  };
  const str = (v) => (typeof v === "string" && v.length <= 80 && v ? v : null);
  return {
    from: date(q.from, false),
    to: date(q.to, true),
    merchant: str(q.merchant),
    category: CATEGORIES.includes(q.category) ? q.category : null,
    status: STATUSES.includes(q.status) ? q.status : null,
  };
}

export function analytics(session, filters = {}) {
  const f = { from: null, to: null, merchant: null, category: null, status: null, ...filters };
  const inRange = (iso) => {
    const t = Date.parse(iso);
    return (f.from == null || t >= f.from) && (f.to == null || t <= f.to);
  };
  const orders = ledgerRows(session).filter(
    (o) => inRange(o.capturedAt) && (!f.status || o.status === f.status) && (!f.merchant || o.merchants.includes(f.merchant)) && (!f.category || o.categories.includes(f.category)),
  );
  const ids = new Set(orders.map((o) => o.orderId));
  const lines = lineRows(session).filter((l) => ids.has(l.orderId) && (!f.merchant || l.merchant === f.merchant) && (!f.category || l.category === f.category));

  const sum = (rows, key) => round2(rows.reduce((s, r) => s + r[key], 0));
  const spendOrders = orders.filter((o) => !["DENIED", "REVERSED"].includes(o.status));
  const gross = sum(spendOrders, "total");
  const refunded = sum(orders, "refunded");
  const group = (key) =>
    Object.entries(
      lines.reduce((acc, l) => {
        const g = (acc[l[key]] ||= { gross: 0, net: 0, refunded: 0, lines: 0 });
        g.gross += l.amount;
        g.net += l.net;
        if (l.status === "REFUNDED") g.refunded += l.amount;
        g.lines++;
        return acc;
      }, {}),
    )
      .map(([k, g]) => ({ [key]: k, gross: round2(g.gross), net: round2(g.net), refunded: round2(g.refunded), lines: g.lines }))
      .sort((a, b) => b.net - a.net);

  // Daily series over the selected range (default: the last 30 days).
  const end = f.to ?? Date.now();
  const start = f.from ?? end - 29 * DAY;
  const days = [];
  for (let t = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate()); t <= end && days.length < 366; t += DAY)
    days.push({ date: new Date(t).toISOString().slice(0, 10), gross: 0, refunds: 0, net: 0, orders: 0 });
  const dayOf = new Map(days.map((d) => [d.date, d]));
  for (const o of spendOrders) {
    const d = dayOf.get(o.capturedAt.slice(0, 10));
    if (!d) continue;
    d.gross = round2(d.gross + o.total);
    d.orders++;
  }
  for (const o of orders)
    for (const r of completedRefunds(o)) {
      const d = dayOf.get(String(r.at || o.capturedAt).slice(0, 10));
      if (d) d.refunds = round2(d.refunds + r.amount);
    }
  for (const d of days) d.net = round2(d.gross - d.refunds);

  const awaiting = [...session.carts.values()].filter((c) => c.status === "checkout");
  const pendingCaptures = orders.filter((o) => o.status === "PENDING");
  const auditInRange = session.audit.filter((a) => inRange(a.time));
  const spentMonth = round2(spentThisMonth(session));
  const allLines = lineRows(session);

  return {
    filters: { ...f, from: f.from && new Date(f.from).toISOString().slice(0, 10), to: f.to && new Date(f.to).toISOString().slice(0, 10) },
    kpis: {
      netSpend: round2(gross - refunded),
      grossSpend: gross,
      refunded,
      refundPending: sum(orders, "refundPending"),
      orders: spendOrders.length,
      averageOrderValue: spendOrders.length ? round2(gross / spendOrders.length) : 0,
      spentThisMonth: spentMonth,
      monthlyBudget: session.policy.monthlyBudget,
      remainingThisMonth: round2(session.policy.monthlyBudget - spentMonth),
      pending: {
        count: awaiting.length + pendingCaptures.length + orders.filter((o) => o.refundPending > 0).length,
        awaitingApproval: { count: awaiting.length, amount: round2(awaiting.reduce((s, c) => s + c.total, 0)) },
        pendingCaptures: { count: pendingCaptures.length, amount: sum(pendingCaptures, "total") },
        pendingRefunds: { count: orders.filter((o) => o.refundPending > 0).length, amount: sum(orders, "refundPending") },
      },
      blocked: auditInRange.filter((a) => a.outcome === "blocked").length,
      suspiciousListings: session.riskEvents.length,
      highRiskListings: session.riskEvents.filter((e) => e.level === "high").length,
      integrityAlerts: orders.filter((o) => o.integrityAlert).length,
    },
    byCategory: group("category"),
    byMerchant: group("merchant"),
    overTime: days,
    statusBreakdown: STATUSES.map((s) => ({ status: s, count: orders.filter((o) => o.status === s).length })).filter((x) => x.count),
    facets: {
      merchants: [...new Set(allLines.map((l) => l.merchant))].sort(),
      categories: [...new Set(allLines.map((l) => l.category))].sort(),
      statuses: [...new Set(session.orders.map((o) => o.status))].sort(),
    },
    ledger: orders,
    lines,
  };
}

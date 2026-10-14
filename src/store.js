// In-memory per-session state. Each browser gets its own wallet, policy,
// conversation and ledger so several judges can use one hosted demo at once.
import crypto from "node:crypto";

export const DEFAULT_POLICY = {
  monthlyBudget: 500,
  perOrderLimit: 300,
  maxItemPrice: 250,
  minMerchantRating: 3.5,
  blockedCategories: ["gift_cards"],
  blockedMerchants: [],
  requireVerifiedMerchants: true,
};

export const VERIFIED_MERCHANTS = [
  "Summit Outfitters",
  "Ridge & River Co.",
  "VoltHouse Electronics",
  "Nest & Nook",
  "FreshCart Grocers",
  "Paper Trail Books",
  "GiftHub",
];

const sessions = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

export function getSession(id) {
  let s = id && sessions.get(id);
  if (!s) {
    s = {
      id: id || newId("sess"),
      policy: structuredClone(DEFAULT_POLICY),
      messages: [], // Claude conversation, appended only
      pendingEvents: [], // checkout/refund events the agent learns about next turn
      carts: new Map(),
      orders: [], // captured purchases
      audit: [],
      busy: false,
    };
    sessions.set(s.id, s);
  }
  s.touchedAt = Date.now();
  return s;
}

export function audit(session, actor, action, detail, outcome = "ok") {
  const entry = {
    id: session.audit.length + 1,
    time: new Date().toISOString(),
    actor, // "agent" | "user" | "guardrail" | "paypal"
    action,
    detail,
    outcome, // "ok" | "blocked" | "warning" | "error"
  };
  session.audit.push(entry);
  return entry;
}

// Money spent this calendar month = captures minus refunds.
export function spentThisMonth(session) {
  const now = new Date();
  return session.orders
    .filter((o) => {
      const d = new Date(o.capturedAt);
      return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
    })
    .reduce((sum, o) => sum + o.total - o.refunded, 0);
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.touchedAt < cutoff) sessions.delete(id);
}, 10 * 60 * 1000).unref();

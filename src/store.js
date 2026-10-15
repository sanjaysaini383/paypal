// Per-session state. Each browser gets its own wallet, policy, conversation
// and ledger so several judges can use one hosted demo at once. Sessions are
// kept in memory and saved to a JSON file so a restart doesn't wipe them.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_POLICY = {
  monthlyBudget: 500,
  perOrderLimit: 300,
  maxItemPrice: 250,
  minMerchantRating: 3.5,
  blockedCategories: ["gift_cards"],
  blockedMerchants: [],
  requireVerifiedMerchants: true,
  categoryLimits: {}, // e.g. { electronics: 50 } = max $50 of items per month
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
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- persistence
// PERSIST=0 (and the test runner) keep everything in memory only.
const PERSIST = process.env.PERSIST !== "0" && !process.env.NODE_TEST_CONTEXT;
const DATA_FILE = path.resolve(process.env.DATA_FILE || ".data/sessions.json");
const TRANSIENT = new Set(["busy", "chatTimes"]);

function serialize(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) if (!TRANSIENT.has(k)) out[k] = v instanceof Map ? [...v.values()] : v;
  return out;
}

function revive(raw) {
  return {
    ...raw,
    policy: { ...structuredClone(DEFAULT_POLICY), ...raw.policy },
    carts: new Map((raw.carts || []).map((c) => [c.id, c])),
    policyProposals: new Map((raw.policyProposals || []).map((p) => [p.id, p])),
    transcript: raw.transcript || [],
    busy: false,
  };
}

function load() {
  if (!PERSIST) return;
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const raw of saved.sessions || []) sessions.set(raw.id, revive(raw));
    console.log(`Loaded ${sessions.size} saved session(s) from ${path.relative(process.cwd(), DATA_FILE)}`);
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`Couldn't read ${DATA_FILE}: ${err.message}`);
  }
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!PERSIST) return;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: [...sessions.values()].map(serialize) }));
    fs.renameSync(tmp, DATA_FILE); // atomic: a crash never leaves a half-written file
  } catch (err) {
    console.warn(`Couldn't save sessions: ${err.message}`);
  }
}

// Debounced: many changes in one request become one write.
export function scheduleSave() {
  if (PERSIST && !saveTimer) saveTimer = setTimeout(saveNow, 400);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    saveNow();
    process.exit(0);
  });
}
load();

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
      policyProposals: new Map(), // rule changes the agent suggested, awaiting the user
      orders: [], // captured purchases
      audit: [],
      transcript: [], // what the chat showed, so a page reload can restore it
      busy: false,
    };
    sessions.set(s.id, s);
  }
  s.touchedAt = Date.now();
  scheduleSave();
  return s;
}

// What the chat UI showed, kept short so the saved file stays small.
export function remember(session, entry) {
  session.transcript.push({ ...entry, at: new Date().toISOString() });
  if (session.transcript.length > 200) session.transcript.splice(0, session.transcript.length - 200);
  scheduleSave();
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
  scheduleSave();
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

// Item spend (before tax) per category this calendar month, net of refunds.
export function categorySpendThisMonth(session) {
  const now = new Date();
  const out = {};
  for (const o of session.orders) {
    const d = new Date(o.capturedAt);
    if (d.getUTCFullYear() !== now.getUTCFullYear() || d.getUTCMonth() !== now.getUTCMonth()) continue;
    for (const i of o.items) if (!i.refunded) out[i.category] = Math.round(((out[i.category] || 0) + i.price * i.qty) * 100) / 100;
  }
  return out;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let pruned = false;
  for (const [id, s] of sessions) if (s.touchedAt < cutoff) pruned = sessions.delete(id);
  if (pruned) scheduleSave();
}, 10 * 60 * 1000).unref();

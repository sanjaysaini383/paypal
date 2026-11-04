import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSession, audit, spentThisMonth, categorySpendThisMonth, remember, setPolicy } from "./store.js";
import { sanitizePolicy, applyPolicyChanges } from "./policy.js";
import { runAgent, aiMode, MODEL } from "./agent.js";
import { editCart } from "./tools.js";
import * as paypal from "./paypal.js";
import { captureCheckout, rejectCart } from "./checkout.js";
import { publicAuthorization, expireStale } from "./authorization.js";
import { receiveWebhook } from "./webhooks.js";
import { detectPurchaseIntent } from "./validate.js";
import { CATALOG, MERCHANTS } from "./catalog.js";
import { assessListing, merchantReputation, RISK_ENGINE_VERSION } from "./risk.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Hosts like Render sit behind one proxy; trust it so req.ip is the client.
app.set("trust proxy", 1);

// PayPal webhooks need the raw body for signature verification, so this route
// is registered before the JSON parser. No session: events are verified with
// PayPal and matched to orders by capture id.
app.post("/api/webhooks/paypal", express.raw({ type: () => true, limit: "256kb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const r = await receiveWebhook(raw, req.headers);
  res.status(r.status).json(r.body);
});

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(here, "..", "public")));

// Session id comes from the browser (random UUID kept in localStorage).
function session(req) {
  const raw = String(req.get("x-session-id") || "");
  const id = /^[a-zA-Z0-9_-]{8,64}$/.test(raw) ? raw : undefined;
  return getSession(id);
}

const round2 = (n) => Math.round(n * 100) / 100;

function snapshot(s) {
  expireStale(s);
  const spent = round2(spentThisMonth(s));
  return {
    policy: s.policy,
    spent,
    remaining: round2(s.policy.monthlyBudget - spent),
    categorySpend: categorySpendThisMonth(s),
    carts: [...s.carts.values()].slice(-10),
    proposals: [...s.policyProposals.values()].slice(-20),
    policyVersion: s.policyVersion,
    authorizations: [...s.authorizations.values()].slice(-20).map(publicAuthorization),
    orders: s.orders,
    audit: s.audit,
    transcript: s.transcript,
  };
}

app.get("/api/config", (req, res) => {
  res.json({ aiMode, model: MODEL, paypalMode: paypal.paypalMode, paypalClientId: paypal.paypalClientId, repoUrl: process.env.REPO_URL || null });
});

app.get("/api/state", (req, res) => res.json(snapshot(session(req))));

// Trust & Risk center: the risk register for every listing (scored against
// this user's policy) plus what was flagged while this user shopped.
app.get("/api/risk", (req, res) => {
  const s = session(req);
  const listings = CATALOG.map((p) => {
    const a = assessListing(p, s.policy);
    return { sku: p.sku, name: p.name, merchant: p.merchant, category: p.category, price: p.price, rating: p.rating, reviews: p.reviews, level: a.level, score: a.score, signals: a.signals, action: a.action, injection: a.injection.matches.map((m) => m.pattern) };
  });
  res.json({ engine: RISK_ENGINE_VERSION, basis: "Heuristic score from listed signals; not a fraud probability.", merchants: MERCHANTS.map((m) => merchantReputation(m.name)), listings, events: s.riskEvents });
});

// Per-session and per-IP limits so a public demo can't burn through the API
// key (a new session id alone doesn't reset the IP limit).
const CHAT_LIMIT = Number(process.env.CHAT_LIMIT_PER_HOUR || 40);
const IP_LIMIT = Number(process.env.CHAT_LIMIT_PER_IP_PER_HOUR || 120);
const ipHits = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [ip, times] of ipHits) if (!times.some((t) => t > cutoff)) ipHits.delete(ip);
}, 10 * 60 * 1000).unref();

app.post("/api/chat", async (req, res) => {
  const s = session(req);
  const message = String(req.body?.message || "").trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: "Empty message" });
  if (s.busy) return res.status(409).json({ error: "The agent is still working on your last message." });
  s.chatTimes = (s.chatTimes || []).filter((t) => t > Date.now() - 3600_000);
  if (s.chatTimes.length >= CHAT_LIMIT) return res.status(429).json({ error: "Hourly demo limit reached for this session." });
  const ipTimes = (ipHits.get(req.ip) || []).filter((t) => t > Date.now() - 3600_000);
  if (ipTimes.length >= IP_LIMIT) return res.status(429).json({ error: "Hourly demo limit reached. Please try again later." });
  ipTimes.push(Date.now());
  ipHits.set(req.ip, ipTimes);
  s.chatTimes.push(Date.now());

  s.busy = true;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  // Everything the chat shows is also kept in the session transcript, so a
  // page reload can restore the conversation. Tool steps are grouped into one
  // "activity" entry per run, like the UI does.
  let activity = null;
  const flush = () => {
    if (!activity) return;
    const secs = Math.max(1, Math.round((Date.now() - activity.started) / 1000));
    remember(s, { role: "activity", secs, steps: activity.steps.map(({ name, input, ok, summary }) => ({ name, input, ok, summary })) });
    activity = null;
  };
  const record = (event) => {
    switch (event.type) {
      case "text":
      case "error":
      case "thinking":
        flush();
        remember(s, { role: event.type === "text" ? "agent" : event.type, text: event.text });
        break;
      case "tool_call":
        (activity ||= { started: Date.now(), steps: [] }).steps.push({ id: event.id, name: event.name, input: event.input });
        break;
      case "tool_result": {
        const step = activity?.steps.find((x) => x.id === event.id);
        if (step) Object.assign(step, { ok: event.ok, summary: event.summary });
        break;
      }
      case "products":
        flush();
        remember(s, { role: "products", title: event.title, items: event.items });
        break;
      case "policy_proposal":
        flush();
        remember(s, { role: "policy_proposal", proposalId: event.proposal.id });
        break;
      case "plan":
        flush();
        remember(s, { role: "plan", plan: event.plan });
        break;
      case "refund":
        flush();
        remember(s, { role: "refund", refund: event.refund });
        break;
    }
  };
  const emit = (event) => {
    record(event);
    if (!res.writableEnded) res.write(JSON.stringify(event) + "\n");
  };
  remember(s, { role: "user", text: message });
  s.purchaseIntent = detectPurchaseIntent(message); // only the user's own words count
  if (s.purchaseIntent) audit(s, "user", "purchase_intent", "The user asked to buy in this message");
  try {
    await runAgent(s, message, emit);
  } catch (err) {
    console.error(err);
    emit({ type: "error", text: err.message || "Agent error" });
  } finally {
    flush();
    s.busy = false;
    s.purchaseIntent = false;
    emit({ type: "done" });
    res.end();
  }
});

app.put("/api/policy", (req, res) => {
  const s = session(req);
  setPolicy(s, sanitizePolicy(req.body || {}, s.policy), "user", "Edited in the rules panel");
  audit(s, "user", "policy_updated", `v${s.policyVersion}: budget $${s.policy.monthlyBudget}/mo, $${s.policy.perOrderLimit}/order, $${s.policy.maxItemPrice}/item`);
  s.pendingEvents.push(`The user updated their spending policy: ${JSON.stringify(s.policy)}`);
  res.json(snapshot(s));
});

// Rule changes the agent proposed only take effect when the user applies them.
app.post("/api/policy/proposals/:id/:action", (req, res) => {
  const s = session(req);
  const proposal = s.policyProposals.get(req.params.id);
  if (!proposal) return res.status(404).json({ error: "Proposal not found" });
  if (proposal.status !== "pending") return res.status(409).json({ error: `Already ${proposal.status}` });
  if (req.params.action === "apply") {
    const { next, diff } = applyPolicyChanges(s.policy, proposal.changes);
    setPolicy(s, next, "user", `Applied proposal ${proposal.id}: ${proposal.summary}`);
    proposal.status = "applied";
    proposal.diff = diff.length ? diff : proposal.diff;
    audit(s, "user", "policy_updated", `v${s.policyVersion}: applied ${proposal.summary}`);
    s.pendingEvents.push(`The user applied the rule change "${proposal.summary}". Current policy: ${JSON.stringify(s.policy)}`);
  } else if (req.params.action === "dismiss") {
    proposal.status = "dismissed";
    audit(s, "user", "policy_dismissed", `Dismissed: ${proposal.summary}`);
    s.pendingEvents.push(`The user dismissed the proposed rule change "${proposal.summary}".`);
  } else {
    return res.status(404).json({ error: "Unknown action" });
  }
  res.json(snapshot(s));
});

// The user's own cart edits from product cards and the cart panel. They go
// through the same guardrails as the agent's carts.
app.post("/api/cart/items", (req, res) => {
  const s = session(req);
  const sku = String(req.body?.sku || "");
  const r = editCart(s, { add: sku });
  if (r.error) return res.status(400).json({ error: r.error });
  s.pendingEvents.push(`The user added ${sku} to the cart themselves. Current cart: ${r.cart_id} ($${r.total?.toFixed(2)}, ${r.status}).`);
  res.json({ result: r, state: snapshot(s) });
});

app.delete("/api/cart/items/:sku", (req, res) => {
  const s = session(req);
  const r = editCart(s, { remove: req.params.sku });
  if (r.error) return res.status(400).json({ error: r.error });
  s.pendingEvents.push(
    r.cleared ? `The user removed ${req.params.sku}; the cart is now empty.` : `The user removed ${req.params.sku} from the cart. Current cart: ${r.cart_id} ($${r.total.toFixed(2)}).`,
  );
  res.json({ result: r, state: snapshot(s) });
});

app.post("/api/carts/:id/reject", (req, res) => {
  const s = session(req);
  const cart = s.carts.get(req.params.id);
  if (!cart || ["paid", "pending", "capturing", "authorizing"].includes(cart.status)) return res.status(404).json({ error: "Cart not found" });
  rejectCart(s, cart);
  audit(s, "user", "cart_rejected", `Rejected ${cart.id} ($${cart.total.toFixed(2)})`);
  s.pendingEvents.push(`The user rejected cart ${cart.id}.`);
  res.json(snapshot(s));
});

// Called by the PayPal button's onApprove (or the simulator's approve button).
// All verification lives in checkout.js; nothing from the request body is used.
app.post("/api/orders/:orderId/capture", async (req, res) => {
  const s = session(req);
  const r = await captureCheckout(s, String(req.params.orderId));
  res.status(r.status).json(r.status === 200 ? { ...r.body, state: snapshot(s) } : r.body);
});

app.post("/api/reset", (req, res) => {
  const s = session(req);
  s.messages = [];
  s.oaMessages = [];
  s.pendingEvents = [];
  s.carts.clear();
  s.policyProposals.clear();
  s.transcript = [];
  audit(s, "user", "conversation_reset", "Started a new conversation");
  res.json(snapshot(s));
});

app.get("/healthz", (req, res) => res.send("ok"));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`CartPilot running on http://localhost:${port}`);
  console.log(`  AI: ${aiMode === "offline" ? "offline rule-based agent (set GEMINI_API_KEY or ANTHROPIC_API_KEY)" : `${aiMode} · ${MODEL}`}`);
  console.log(`  PayPal: ${paypal.paypalMode}${paypal.paypalMode === "simulated" ? " (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for sandbox)" : ""}`);
});

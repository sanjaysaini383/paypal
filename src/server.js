import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSession, audit, spentThisMonth } from "./store.js";
import { sanitizePolicy } from "./policy.js";
import { runAgent, aiMode, MODEL } from "./agent.js";
import * as paypal from "./paypal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
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
  const spent = round2(spentThisMonth(s));
  return {
    policy: s.policy,
    spent,
    remaining: round2(s.policy.monthlyBudget - spent),
    carts: [...s.carts.values()].slice(-10),
    orders: s.orders,
    audit: s.audit,
  };
}

app.get("/api/config", (req, res) => {
  res.json({ aiMode, model: aiMode === "claude" ? MODEL : null, paypalMode: paypal.paypalMode, paypalClientId: paypal.paypalClientId, repoUrl: process.env.REPO_URL || null });
});

app.get("/api/state", (req, res) => res.json(snapshot(session(req))));

// Per-session limit so a public demo can't burn through the API key.
const CHAT_LIMIT = Number(process.env.CHAT_LIMIT_PER_HOUR || 40);

app.post("/api/chat", async (req, res) => {
  const s = session(req);
  const message = String(req.body?.message || "").trim().slice(0, 2000);
  if (!message) return res.status(400).json({ error: "Empty message" });
  if (s.busy) return res.status(409).json({ error: "The agent is still working on your last message." });
  s.chatTimes = (s.chatTimes || []).filter((t) => t > Date.now() - 3600_000);
  if (s.chatTimes.length >= CHAT_LIMIT) return res.status(429).json({ error: "Hourly demo limit reached for this session." });
  s.chatTimes.push(Date.now());

  s.busy = true;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const emit = (event) => {
    if (!res.writableEnded) res.write(JSON.stringify(event) + "\n");
  };
  try {
    await runAgent(s, message, emit);
  } catch (err) {
    console.error(err);
    emit({ type: "error", text: err.message || "Agent error" });
  } finally {
    s.busy = false;
    emit({ type: "done" });
    res.end();
  }
});

app.put("/api/policy", (req, res) => {
  const s = session(req);
  s.policy = sanitizePolicy(req.body || {}, s.policy);
  audit(s, "user", "policy_updated", `Budget $${s.policy.monthlyBudget}/mo, $${s.policy.perOrderLimit}/order, $${s.policy.maxItemPrice}/item`);
  s.pendingEvents.push(`The user updated their spending policy: ${JSON.stringify(s.policy)}`);
  res.json(snapshot(s));
});

app.post("/api/carts/:id/reject", (req, res) => {
  const s = session(req);
  const cart = s.carts.get(req.params.id);
  if (!cart || cart.status === "paid") return res.status(404).json({ error: "Cart not found" });
  cart.status = "rejected";
  audit(s, "user", "cart_rejected", `Rejected ${cart.id} ($${cart.total.toFixed(2)})`);
  s.pendingEvents.push(`The user rejected cart ${cart.id}.`);
  res.json(snapshot(s));
});

// Called by the PayPal button's onApprove (or the simulator's approve button).
app.post("/api/orders/:orderId/capture", async (req, res) => {
  const s = session(req);
  const cart = [...s.carts.values()].find((c) => c.paypalOrderId === req.params.orderId);
  if (!cart) return res.status(404).json({ error: "This order doesn't belong to your session." });
  if (cart.status === "paid") return res.status(409).json({ error: "Already captured." });

  // Final guardrail at the moment money moves.
  const remaining = s.policy.monthlyBudget - spentThisMonth(s);
  if (cart.total > remaining + 0.005) {
    audit(s, "guardrail", "capture_blocked", `Capture of $${cart.total.toFixed(2)} exceeds remaining budget $${remaining.toFixed(2)}`, "blocked");
    return res.status(403).json({ error: "Capture blocked: this would exceed your monthly budget." });
  }

  try {
    const cap = await paypal.captureOrder(cart.paypalOrderId);
    if (cap.status !== "COMPLETED") throw new Error(`Capture status ${cap.status}`);
    cart.status = "paid";
    const order = {
      orderId: cap.orderId,
      captureId: cap.captureId,
      cartId: cart.id,
      capturedAt: new Date().toISOString(),
      payer: cap.payerName || cap.payerEmail || "PayPal buyer",
      items: cart.items.map((i) => ({ ...i, refunded: false })),
      subtotal: cart.subtotal,
      tax: cart.tax,
      shipping: cart.shipping,
      total: cart.total,
      refunded: 0,
      refunds: [],
      status: "COMPLETED",
      mode: paypal.paypalMode,
    };
    s.orders.push(order);
    audit(s, "paypal", "captured", `Captured ${cap.captureId} for $${cart.total.toFixed(2)} (order ${cap.orderId})${cap.debugId ? ` debug ${cap.debugId}` : ""}`);
    s.pendingEvents.push(`The user approved and paid PayPal order ${order.orderId} ($${order.total.toFixed(2)}).`);
    res.json({ ok: true, order, state: snapshot(s) });
  } catch (err) {
    audit(s, "paypal", "capture_failed", err.message, "error");
    const issue = err.details?.details?.[0]?.issue;
    // INSTRUMENT_DECLINED: let the buyer pick another funding source.
    res.status(422).json({ error: err.message, issue });
  }
});

app.post("/api/reset", (req, res) => {
  const s = session(req);
  s.messages = [];
  s.pendingEvents = [];
  s.carts.clear();
  audit(s, "user", "conversation_reset", "Started a new conversation");
  res.json(snapshot(s));
});

app.get("/healthz", (req, res) => res.send("ok"));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`CartPilot running on http://localhost:${port}`);
  console.log(`  AI: ${aiMode === "claude" ? MODEL : "offline rule-based agent (set ANTHROPIC_API_KEY)"}`);
  console.log(`  PayPal: ${paypal.paypalMode}${paypal.paypalMode === "simulated" ? " (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for sandbox)" : ""}`);
});

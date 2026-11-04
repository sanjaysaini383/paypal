// The two hackathon demo scenarios end to end over HTTP, on the real server
// with the offline agent and simulated PayPal (clearly labelled as such).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3989;
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
  const blank = Object.fromEntries(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "AI_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].map((k) => [k, ""]));
  server = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, ...blank, AI_PROVIDER: "offline", PERSIST: "0", PORT: String(PORT) } });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("running") && resolve());
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => server?.kill());

const SID = "demo_judge_session";
const api = (path, opts = {}) => fetch(BASE + path, { ...opts, headers: { "Content-Type": "application/json", "X-Session-Id": SID, ...(opts.headers || {}) } });
const chat = async (message) => (await (await api("/api/chat", { method: "POST", body: JSON.stringify({ message }) })).text()).trim().split("\n").map((l) => JSON.parse(l));
const state = async () => (await api("/api/state")).json();

test("scenario 1: camping setup for two within $300, scam caught, authorized, paid", async () => {
  const events = await chat("Find a complete camping setup for two people within a $300 budget and buy it.");
  const plan = events.find((e) => e.type === "plan")?.plan;
  assert.ok(plan?.feasible, "the agent produced an optimized plan");
  assert.ok(plan.totals.total <= 300);
  assert.ok(plan.excluded.some((e) => e.sku === "OUT-TENT-CHEAP"), "malicious listing excluded");
  const checkout = events.find((e) => e.type === "checkout");
  assert.ok(checkout, "checkout created because the user asked to buy");
  assert.equal(checkout.authorization.status, "bound");
  assert.equal(checkout.authorization.total, plan.totals.total);

  let st = await state();
  const cart = st.carts.at(-1);
  assert.equal(cart.status, "checkout");
  const res = await api(`/api/orders/${cart.paypalOrderId}/capture`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.mode, "simulated", "simulated payments are labelled");
  st = body.state;
  assert.equal(st.authorizations.at(-1).status, "consumed");
  const actions = st.audit.map((a) => a.action);
  for (const a of ["purchase_intent", "plan_purchase", "authorization_issued", "order_created", "captured"]) assert.ok(actions.includes(a), a);
  assert.ok(st.audit.some((a) => a.action === "injection_flag"), "injection recorded in the audit log");
});

test("scenario 2: damaged item refunded on its own with the calculation shown", async () => {
  const before = (await state()).orders.at(-1);
  const events = await chat("The sleeping pads arrived damaged. Please refund only those.");
  const refund = events.find((e) => e.type === "refund")?.refund;
  assert.ok(refund, "refund event emitted");
  assert.deepEqual(refund.calculation.lines.map((l) => [l.sku, l.qty, l.goods, l.tax]), [["OUT-PAD-FOAM", 2, 48, 3.96]]);
  assert.equal(refund.amount, 51.96);
  const after = (await state()).orders.at(-1);
  assert.equal(after.orderId, before.orderId);
  assert.equal(after.status, "PARTIALLY_REFUNDED");
  assert.equal(after.refunded, 51.96);
  assert.equal(after.items.find((i) => i.sku === "OUT-PAD-FOAM").refunded, true);
  assert.equal(after.items.find((i) => i.sku === "OUT-TENT-DOME").refunded, false);
});

test("suggest-only requests never open a checkout", async () => {
  const events = await (async () => {
    const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": "demo_suggest_only" }, body: JSON.stringify({ message: "Upgrade my work-from-home desk for about $250. Suggest a cart first." }) });
    return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  })();
  assert.ok(events.some((e) => e.type === "plan"));
  assert.ok(!events.some((e) => e.type === "checkout"));
});

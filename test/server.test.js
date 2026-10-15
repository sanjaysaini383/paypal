// HTTP-level tests against a real server process: offline agent + simulated
// PayPal. Keys are blanked so a local .env can't make this hit real APIs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3987;
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
  const blank = Object.fromEntries(
    ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "AI_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].map((k) => [k, ""]),
  );
  server = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, ...blank, AI_PROVIDER: "offline", PORT: String(PORT) } });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => String(d).includes("running") && resolve());
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => server?.kill());

const api = (sid, path, opts = {}) =>
  fetch(BASE + path, { ...opts, headers: { "Content-Type": "application/json", "X-Session-Id": sid, ...(opts.headers || {}) } });

async function chat(sid, message) {
  const res = await api(sid, "/api/chat", { method: "POST", body: JSON.stringify({ message }) });
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}

async function checkoutOrderId(sid) {
  await chat(sid, "Find me the cheapest 2-person tent you can and buy it.");
  const state = await (await api(sid, "/api/state")).json();
  return state.carts.at(-1).paypalOrderId;
}

test("a double click captures the payment only once", async () => {
  const sid = "test_double_capture";
  const orderId = await checkoutOrderId(sid);
  const results = await Promise.all([1, 2, 3].map(() => api(sid, `/api/orders/${orderId}/capture`, { method: "POST" })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  const state = await (await api(sid, "/api/state")).json();
  assert.equal(state.orders.length, 1);
});

test("a cancelled checkout can't be captured", async () => {
  const sid = "test_cancel_capture";
  const orderId = await checkoutOrderId(sid);
  const state = await (await api(sid, "/api/state")).json();
  await api(sid, `/api/carts/${state.carts.at(-1).id}/reject`, { method: "POST" });
  const res = await api(sid, `/api/orders/${orderId}/capture`, { method: "POST" });
  assert.equal(res.status, 409);
});

test("orders from another session can't be captured", async () => {
  const orderId = await checkoutOrderId("test_owner_session");
  const res = await api("test_other_session", `/api/orders/${orderId}/capture`, { method: "POST" });
  assert.equal(res.status, 404);
});

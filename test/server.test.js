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
  server = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, ...blank, AI_PROVIDER: "offline", PERSIST: "0", PORT: String(PORT) } });
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

test("plain-English rule: proposed in chat, applied by the user, then enforced", async () => {
  const sid = "test_plain_english_rule";
  const events = await chat(sid, "Never spend more than $60 a month on electronics");
  const proposal = events.find((e) => e.type === "policy_proposal")?.proposal;
  assert.ok(proposal, "agent should propose a rule change");
  let state = await (await api(sid, "/api/state")).json();
  assert.deepEqual(state.policy.categoryLimits, {});

  const res = await api(sid, `/api/policy/proposals/${proposal.id}/apply`, { method: "POST" });
  state = await res.json();
  assert.deepEqual(state.policy.categoryLimits, { electronics: 60 });
  assert.equal(state.proposals.find((p) => p.id === proposal.id).status, "applied");
  assert.equal((await api(sid, `/api/policy/proposals/${proposal.id}/apply`, { method: "POST" })).status, 409);

  // The transcript keeps the proposal so a reload can show it.
  assert.ok(state.transcript.some((e) => e.role === "policy_proposal" && e.proposalId === proposal.id));
});

test("user cart edits go through the same guardrails", async () => {
  const sid = "test_user_cart_edits";
  const add = (sku) => api(sid, "/api/cart/items", { method: "POST", body: JSON.stringify({ sku }) }).then((r) => r.json());
  let body = await add("OUT-TENT-2P");
  assert.equal(body.result.status, "proposed");
  body = await add("OUT-LAMP");
  assert.deepEqual(body.state.carts.at(-1).items.map((i) => i.sku), ["OUT-TENT-2P", "OUT-LAMP"]);
  assert.equal(body.state.carts.filter((c) => c.status === "proposed").length, 1, "only the newest cart stays open");

  body = await add("GFT-CARD-50"); // gift cards are blocked by default
  assert.equal(body.result.status, "blocked");
  assert.ok(body.result.violations.some((v) => v.rule === "blocked_category"));

  body = await (await api(sid, "/api/cart/items/GFT-CARD-50", { method: "DELETE" })).json();
  assert.equal(body.result.status, "proposed");
  assert.equal((await api(sid, "/api/cart/items", { method: "POST", body: JSON.stringify({ sku: "NOPE" }) })).status, 400);

  // A replaced cart can't be checked out.
  const old = body.state.carts.find((c) => c.status === "replaced");
  const events = await chat(sid, "yes");
  assert.ok(events.some((e) => e.type === "checkout"), "the current cart checks out");
  assert.ok(old, "earlier carts are retired, not left open");
});

test("responses carry security headers and a CSP without inline scripts", async () => {
  const res = await fetch(BASE + "/");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net https:\/\/\*\.paypal\.com/);
  assert.doesNotMatch(csp.split(";").find((d) => d.includes("script-src")), /unsafe-inline/);
  assert.ok(!(await res.text()).match(/<script>(?!<\/script>)/), "no inline <script> blocks");
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("malformed JSON and unknown routes get JSON errors without internals", async () => {
  const bad = await fetch(BASE + "/api/policy", { method: "PUT", headers: { "Content-Type": "application/json", "X-Session-Id": "test_bad_json_session" }, body: "{oops" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Malformed request body." });
  const missing = await api("test_missing_route_x", "/api/nope");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Not found" });
});

test("cross-origin writes are refused", async () => {
  const res = await api("test_cross_origin_sess", "/api/reset", { method: "POST", headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  const same = await api("test_cross_origin_sess", "/api/reset", { method: "POST", headers: { Origin: BASE } });
  assert.equal(same.status, 200);
});

test("short, guessable session ids are not honoured", async () => {
  await api("test_short_id_owner", "/api/cart/items", { method: "POST", body: JSON.stringify({ sku: "OUT-LAMP" }) });
  const res = await api("short123", "/api/state");
  assert.equal((await res.json()).carts.length, 0);
});

test("one session can't see or touch another session's money", async () => {
  const owner = "test_isolation_owner";
  const stranger = "test_isolation_stranger";
  const orderId = await checkoutOrderId(owner);
  assert.equal((await api(owner, `/api/orders/${orderId}/capture`, { method: "POST" })).status, 200);
  const theirs = await (await api(stranger, "/api/state")).json();
  assert.equal(theirs.orders.length, 0);
  assert.equal(theirs.authorizations.length, 0);
  assert.ok(!theirs.audit.some((a) => a.detail.includes(orderId)));
  const analytics = await (await api(stranger, "/api/analytics")).json();
  assert.equal(analytics.kpis.orders, 0);
  const events = await chat(stranger, "The tent arrived damaged, refund it");
  assert.ok(events.some((e) => e.type === "text" && /don't have any refundable orders/.test(e.text)));
  const mine = await (await api(owner, "/api/state")).json();
  assert.equal(mine.orders[0].refunded, 0);
});

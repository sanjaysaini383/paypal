// Sessions survive a server restart: start, chat, stop, start again, check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 3988;
const BASE = `http://localhost:${PORT}`;
const DATA_FILE = path.join(os.tmpdir(), `cartpilot-persist-${process.pid}.json`);
const SID = "test_persist_session";

function start() {
  const env = { ...process.env, AI_PROVIDER: "offline", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PORT: String(PORT), DATA_FILE, PERSIST: "1" };
  delete env.NODE_TEST_CONTEXT; // the store disables persistence under the test runner
  const child = spawn(process.execPath, ["src/server.js"], { env });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("running") && resolve(child));
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
}
const stop = (child) => new Promise((r) => (child.on("exit", r), child.kill()));
const api = (p, opts = {}) => fetch(BASE + p, { ...opts, headers: { "Content-Type": "application/json", "X-Session-Id": SID } });

test("carts, orders and the chat transcript survive a restart", async (t) => {
  t.after(() => fs.rmSync(DATA_FILE, { force: true }));
  let server = await start();
  await (await api("/api/chat", { method: "POST", body: JSON.stringify({ message: "Find me the cheapest 2-person tent you can and buy it." }) })).text();
  const before = await (await api("/api/state")).json();
  const orderId = before.carts.at(-1).paypalOrderId;
  assert.equal((await api(`/api/orders/${orderId}/capture`, { method: "POST" })).status, 200);
  await new Promise((r) => setTimeout(r, 800)); // let the debounced save land
  await stop(server);

  server = await start();
  try {
    const after = await (await api("/api/state")).json();
    assert.equal(after.orders.length, 1);
    assert.equal(after.orders[0].orderId, orderId);
    assert.equal(after.carts.at(-1).status, "paid");
    const roles = after.transcript.map((e) => e.role);
    assert.ok(roles.includes("user") && roles.includes("activity") && roles.includes("agent"));
  } finally {
    await stop(server);
  }
});

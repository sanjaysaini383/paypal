// OpenAI-compatible agent loop against a local fake API: model fallback on
// overload and quota errors, tool calls, and history handling.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
const { runOpenAICompatible } = await import("../src/llm-openai.js");
const { getSession } = await import("../src/store.js");

const requests = [];
let respond;
let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = JSON.parse(body);
      requests.push(json);
      const [status, payload] = respond(json);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const reply = (message) => [200, { choices: [{ message: { role: "assistant", ...message }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }];
const toolCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) }, extra_content: { google: { thought_signature: "sig" } } });

function run(cfg, sid, text) {
  const events = [];
  const promise = runOpenAICompatible(cfg, {
    session: getSession(sid),
    text,
    system: "test",
    maxSteps: 6,
    summarize: () => "ok",
    emit: (e) => events.push(e),
  });
  return promise.then(() => events);
}

test("falls back to the next model when one is overloaded or out of quota", async () => {
  requests.length = 0;
  respond = (body) => {
    if (body.model === "busy-model") return [503, { error: { message: "high demand" } }];
    if (body.model === "quota-model") return [429, { error: { details: [{ retryDelay: "40s" }] } }];
    const toolResults = body.messages.filter((m) => m.role === "tool").length;
    return toolResults ? reply({ content: "Found it." }) : reply({ content: null, tool_calls: [toolCall("c1", "search_catalog", { query: "tent" })] });
  };
  const cfg = { provider: "test", baseUrl, apiKey: "k", model: "busy-model", fallbackModels: ["quota-model", "good-model"] };
  const events = await run(cfg, "llm_fallback", "find a tent");

  assert.deepEqual(events.filter((e) => e.type === "tool_call").map((e) => e.name), ["search_catalog"]);
  assert.equal(events.at(-1).text, "Found it.");
  // Overloaded/quota-limited models are remembered and skipped on the next call.
  assert.deepEqual(requests.map((r) => r.model), ["busy-model", "busy-model", "quota-model", "good-model", "good-model"]);
  // The assistant tool-call message (with its thought signature) is sent back unchanged.
  const replayed = requests.at(-1).messages.find((m) => m.tool_calls);
  assert.equal(replayed.tool_calls[0].extra_content.google.thought_signature, "sig");
});

test("a failed turn is dropped from history so the next message still works", async () => {
  respond = () => [400, { error: { message: "bad request" } }];
  const cfg = { provider: "test", baseUrl, apiKey: "k", model: "good-model-2", fallbackModels: [] };
  await assert.rejects(run(cfg, "llm_rollback", "hello"), /API error 400/);
  assert.equal(getSession("llm_rollback").oaMessages.length, 0);
});

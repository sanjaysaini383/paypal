// Agent loop for any OpenAI-compatible chat completions API: Google Gemini
// (free tier), Groq, OpenRouter, or a custom endpoint. Uses the same tools,
// guardrails and PayPal calls as the Claude loop.
import { TOOL_DEFS, runTool } from "./tools.js";

export const PRESETS = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    model: "gemini-3.8-flash",
    // Used in order when the main model is overloaded (503 "high demand").
    fallbackModels: ["gemini-3.6-flash", "gemini-3.5-flash-lite"],
    reasoningEffort: "low",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    // Qwen plans multi-tool turns far better than gpt-oss here (parallel
    // searches, fewer loops); thinking off keeps latency and tokens down.
    model: "qwen/qwen3.8-27b",
    reasoningEffort: "none",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    model: "", // must be set with AI_MODEL, e.g. a ":free" model id
  },
  openai: {
    baseUrl: process.env.AI_BASE_URL || "",
    keyEnv: "AI_API_KEY",
    model: "",
  },
};

export function openAIConfig(provider) {
  const p = PRESETS[provider];
  return {
    provider,
    baseUrl: (process.env.AI_BASE_URL || p.baseUrl).replace(/\/$/, ""),
    apiKey: process.env[p.keyEnv] || process.env.AI_API_KEY || "",
    model: process.env.AI_MODEL || p.model,
    fallbackModels: process.env.AI_FALLBACK_MODELS
      ? process.env.AI_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean)
      : p.fallbackModels || [],
    reasoningEffort: process.env.AI_REASONING_EFFORT ?? p.reasoningEffort,
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 45_000,
  };
}

// Anthropic-style tool definitions -> OpenAI function tools. Tools without
// arguments omit `parameters`; some providers reject an empty properties object.
const TOOLS = TOOL_DEFS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    ...(Object.keys(t.input_schema.properties || {}).length ? { parameters: t.input_schema } : {}),
  },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thrown when a model can't serve right now (overloaded or out of quota);
// the caller then tries the next fallback model.
class UnavailableError extends Error {
  constructor(message, retryMs) {
    super(message);
    this.retryMs = retryMs;
  }
}

// Gemini puts the wait in the body ("retryDelay": "23s"); others use Retry-After.
function retryDelayMs(res, text) {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  return m ? Number(m[1]) * 1000 : null;
}

async function completeOne(cfg, body, canFallback) {
  // With no other model to try, sit out longer waits instead of failing.
  const maxWait = canFallback ? 12_000 : 60_000;
  // Free tiers rate limit aggressively: back off and retry on 429.
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // An overloaded model can take minutes to answer; give up and use the next one.
        signal: AbortSignal.timeout(cfg.timeoutMs || 45_000),
      });
    } catch (err) {
      const reason = err.name === "TimeoutError" ? "timed out" : "unreachable";
      if (canFallback) throw new UnavailableError(`${body.model} ${reason}`, 3 * 60_000);
      throw new Error(`${cfg.provider}: the model ${reason === "timed out" ? "took too long to answer" : "couldn't be reached"}. Try again in a minute.`);
    }
    if (res.ok) return res.json();
    const text = await res.text();
    // Groq rejects malformed tool calls (e.g. gpt-oss emitting a garbled tool
    // name) with 400 tool_use_failed. It's a sampling glitch: just retry.
    if (res.status === 400 && text.includes("tool_use_failed") && attempt < 3) continue;
    if (res.status === 503 || res.status === 529) {
      // Overloaded: one quick retry, then let the caller try another model.
      if (attempt < 1) {
        await sleep(1500);
        continue;
      }
      throw new UnavailableError(`${body.model} is overloaded`, 5 * 60_000);
    }
    if (res.status === 429) {
      // Short waits are worth sitting out; long ones (per-minute or daily
      // quota) mean another model with its own quota is the faster path.
      const wait = retryDelayMs(res, text) ?? 2000 * 2 ** attempt;
      console.warn(`[${cfg.provider}] 429 on ${body.model}, wait ${Math.round(wait / 1000)}s (attempt ${attempt + 1})`);
      if (wait <= maxWait && attempt < 3) {
        await sleep(wait);
        continue;
      }
      throw new UnavailableError(`${body.model} rate limited`, Math.max(wait, 30_000));
    }
    if (res.status === 401 || res.status === 403) throw new Error(`${cfg.provider}: API key rejected (${res.status}).`);
    throw new Error(`${cfg.provider} API error ${res.status}: ${text.slice(0, 300)}`);
  }
}

// Models that recently were overloaded or out of quota are skipped until then.
const unavailableUntil = new Map();

async function complete(cfg, body) {
  const all = [cfg.model, ...cfg.fallbackModels];
  let last;
  // Overload spikes usually pass within seconds, so when every model is busy
  // wait and go round again before giving up. Quota limits last far longer.
  for (let round = 0; round < 3; round++) {
    if (round) {
      if (/rate limited/.test(last?.message)) break;
      await sleep((cfg.overloadRetryMs ?? 4000) * round);
    }
    const healthy = all.filter((m) => !(unavailableUntil.get(m) > Date.now()));
    // All busy: try the one that frees up soonest, not ones out of daily quota.
    const queue = healthy.length ? healthy : [all.reduce((a, b) => ((unavailableUntil.get(b) ?? 0) < (unavailableUntil.get(a) ?? 0) ? b : a))];
    for (const [i, model] of queue.entries()) {
      try {
        return await completeOne(cfg, { ...body, model }, i < queue.length - 1);
      } catch (err) {
        if (!(err instanceof UnavailableError)) throw err;
        unavailableUntil.set(model, Date.now() + err.retryMs);
        console.warn(`[${cfg.provider}] ${err.message}, trying the next model`);
        last = err;
      }
    }
  }
  throw new Error(
    /rate limited/.test(last?.message)
      ? `${cfg.provider}: free-tier rate limit reached on every model. Wait about a minute and try again.`
      : `${cfg.provider}: the model is overloaded right now (high demand). Try again in a minute.`,
  );
}

function parseArgs(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

export async function runOpenAICompatible(cfg, { session, text, system, maxSteps, summarize, emit }) {
  const history = (session.oaMessages ||= []);
  const startLen = history.length;
  history.push({ role: "user", content: text });

  try {
    for (let step = 0; step < maxSteps; step++) {
      const body = {
        model: cfg.model,
        messages: [{ role: "system", content: system }, ...history],
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: 8000,
      };
      if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;

      const data = await complete(cfg, body);
      const choice = data.choices?.[0];
      if (!choice) throw new Error(`${cfg.provider}: empty response`);
      const msg = choice.message;
      // Keep the assistant message as returned (Gemini attaches thought
      // signatures to tool calls that must be sent back unchanged).
      history.push(msg);

      if (msg.content?.trim()) emit({ type: "text", text: msg.content });
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        if (choice.finish_reason === "length") emit({ type: "text", text: "(Response was cut off.)" });
        return;
      }

      const results = await Promise.all(
        calls.map(async (tc) => {
          let input;
          let result;
          try {
            input = parseArgs(tc.function?.arguments);
          } catch {
            result = { error: "Arguments were not valid JSON. Please call the tool again." };
          }
          emit({ type: "tool_call", id: tc.id, name: tc.function?.name, input: input || {} });
          if (!result) result = await runTool(session, tc.function?.name, input, emit);
          emit({ type: "tool_result", id: tc.id, name: tc.function?.name, ok: !result.error, summary: summarize(tc.function?.name, result) });
          return { role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) };
        }),
      );
      history.push(...results);
    }
    emit({ type: "text", text: "I stopped after too many steps. Could you narrow the request?" });
  } catch (err) {
    // Drop the failed turn so the history stays valid for the next message.
    history.length = startLen;
    throw err;
  }
}

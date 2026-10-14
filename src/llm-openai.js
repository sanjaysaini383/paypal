// Agent loop for any OpenAI-compatible chat completions API: Google Gemini
// (free tier), Groq, OpenRouter, or a custom endpoint. Uses the same tools,
// guardrails and PayPal calls as the Claude loop.
import { TOOL_DEFS, runTool } from "./tools.js";

export const PRESETS = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    model: "gemini-3.8-flash",
    reasoningEffort: "low",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b",
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
    reasoningEffort: process.env.AI_REASONING_EFFORT ?? p.reasoningEffort,
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

async function complete(cfg, body) {
  // Free tiers rate limit aggressively: back off and retry on 429/503.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    // Groq rejects malformed tool calls (e.g. gpt-oss emitting a garbled tool
    // name) with 400 tool_use_failed. It's a sampling glitch: just retry.
    if (res.status === 400 && text.includes("tool_use_failed") && attempt < 3) continue;
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      console.warn(`[${cfg.provider}] ${res.status} rate limited, retry-after=${res.headers.get("retry-after")} (attempt ${attempt + 1})`);
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`${cfg.provider}: API key rejected (${res.status}).`);
    if (res.status === 429) throw new Error(`${cfg.provider}: free-tier rate limit reached. Wait a minute and try again.`);
    throw new Error(`${cfg.provider} API error ${res.status}: ${text.slice(0, 300)}`);
  }
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

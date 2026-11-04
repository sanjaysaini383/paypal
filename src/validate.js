// Validates model-supplied tool arguments against each tool's JSON schema
// before anything runs. Supports the subset the tool definitions use: type,
// properties, required, enum, minimum/maximum, minItems/maxItems, items and
// maxLength. Unknown properties are dropped; numeric strings ("2") are
// coerced because models often send them. Errors read like instructions so
// the model can correct the call.
export function validate(schema, value, path = "input") {
  const errors = [];
  const out = check(schema, value, path, errors);
  return { ok: errors.length === 0, value: out, errors };
}

function check(schema, v, path, errors) {
  if (!schema) return v;
  const fail = (msg) => (errors.push(`${path} ${msg}`), v);
  switch (schema.type) {
    case "object": {
      if (v == null) v = {};
      if (typeof v !== "object" || Array.isArray(v)) return fail("must be an object");
      const out = {};
      for (const key of schema.required || []) if (v[key] === undefined || v[key] === null) errors.push(`${path}.${key} is required`);
      for (const [key, sub] of Object.entries(schema.properties || {}))
        if (v[key] !== undefined && v[key] !== null) out[key] = check(sub, v[key], `${path}.${key}`, errors);
      return out;
    }
    case "array": {
      if (!Array.isArray(v)) return fail("must be an array");
      if (schema.minItems != null && v.length < schema.minItems) fail(`needs at least ${schema.minItems} item(s)`);
      if (schema.maxItems != null && v.length > schema.maxItems) fail(`allows at most ${schema.maxItems} item(s)`);
      return v.slice(0, schema.maxItems ?? v.length).map((x, i) => check(schema.items, x, `${path}[${i}]`, errors));
    }
    case "string": {
      if (typeof v === "number") v = String(v);
      if (typeof v !== "string") return fail("must be a string");
      if (schema.enum && !schema.enum.includes(v)) return fail(`must be one of: ${schema.enum.join(", ")}`);
      return schema.maxLength ? v.slice(0, schema.maxLength) : v;
    }
    case "number":
    case "integer": {
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v)) return fail(`must be a ${schema.type}`);
      if (schema.type === "integer" && !Number.isInteger(v)) return fail("must be a whole number");
      if (schema.minimum != null && v < schema.minimum) return fail(`must be ≥ ${schema.minimum}`);
      if (schema.maximum != null && v > schema.maximum) return fail(`must be ≤ ${schema.maximum}`);
      return v;
    }
    case "boolean": {
      if (v === "true" || v === "false") v = v === "true";
      if (typeof v !== "boolean") return fail("must be true or false");
      return v;
    }
    default:
      return v;
  }
}

// Did the user's own words this turn ask CartPilot to buy? Used to gate
// checkout server-side: the model's claim that the user agreed is not enough.
const BUY = /\b(buy|purchase|check ?out|order (it|them|this|these|that)|place (the|my|an?) order|pay( for)?|go ahead|proceed|confirm|yes|yep|yeah|ok|okay|sure|do it|looks good|sounds good)\b/i;
const HOLD = /\b(don'?t|do not|not yet|no need to|never|without)\s+(buy|purchase|check ?out|order|pay)|\b(just )?(suggest|ideas?|recommend|compare|options)\b(?![^.]*\b(and|then) (buy|check ?out|order)\b)/i;
export const detectPurchaseIntent = (text) => BUY.test(String(text)) && !HOLD.test(String(text));

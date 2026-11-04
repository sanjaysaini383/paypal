// Trust & risk engine for listings and merchants.
//
// The score is a transparent heuristic, not a fraud probability: each signal
// has a fixed weight, the weights add up (capped at 100) and every point can
// be traced to a reason. Signals are labelled:
//   observed - a fact read straight from the data (merchant unverified,
//              2.1★ rating, listing text matched an instruction pattern)
//   inferred - a judgement derived by comparison (price far below similar
//              items, implausible stock)
// Listing text is only ever pattern-matched here, never interpreted.
import { CATALOG, getMerchant, kindOf } from "./catalog.js";

export const RISK_ENGINE_VERSION = "1.0";
const THIS_YEAR = new Date().getUTCFullYear();

// ------------------------------------------------------------ injection
// Instructions aimed at an AI agent inside seller-written text. Text is
// normalised first so look-alike characters and zero-width spaces can't
// hide a phrase.
const INJECTION_PATTERNS = [
  ["ignore_instructions", /\b(ignore|forget|bypass)\b[^.]{0,40}\b(instructions?|rules?|limits?|polic(y|ies)|budgets?|guardrails?)\b/],
  ["fake_authority", /\b(system|developer|admin|operator)\s+(note|prompt|message|instruction|override|notice)\b/],
  ["addresses_ai", /\b(ai|llm|gpt|shopping|autonomous)\s+(agents?|assistants?|bots?|models?)\b/],
  ["skip_confirmation", /\b(check ?out|buy|purchase|pay)\s+without\b|\bwithout\s+(asking|confirmation|approval|telling)\b/],
  ["override_language", /\b(disregard|override|supersedes?)\b/],
  ["coerced_purchase", /\byou\s+(must|should|need to|are required to)\s+(buy|purchase|add|order|check ?out)\b/],
  ["quantity_push", /\badd\s+\d+\s+(units?|items?|copies|of\b)/],
  ["concealment", /\b(do not|don't|never)\s+(tell|inform|show|ask|warn)\s+(the\s+)?(user|buyer|customer)\b/],
  ["rules_void", /\b(budget|spending)\s+(rules?|limits?)\s+(are|is)\s+(outdated|disabled|void|lifted|suspended)\b/],
  ["new_instructions", /\bnew\s+instructions?\b/],
];

export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿­]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function detectInjection(text) {
  const t = normalizeText(text);
  const matches = [];
  for (const [id, re] of INJECTION_PATTERNS) {
    const m = re.exec(t);
    if (m) matches.push({ pattern: id, excerpt: t.slice(Math.max(0, m.index - 10), m.index + m[0].length + 10).trim() });
  }
  // One weak cue (e.g. "override" in "override switch") is not enough.
  return { detected: matches.length >= 2 || matches.some((m) => ["ignore_instructions", "fake_authority", "rules_void", "concealment"].includes(m.pattern)), matches };
}

// Text safe to show a model: control and zero-width characters removed, length capped.
export const sanitizeListingText = (text, max = 160) =>
  String(text ?? "")
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿­\u0000-\u001F\u007F]/g, "")
    .slice(0, max);

const PRESSURE = /(!!+|\b100% (original|genuine|authentic)\b|\blimited!|\bact now\b|\bno returns\b|\blowest price anywhere\b|\bmega deal\b)/i;

// ------------------------------------------------------------ reputation
// Review-weighted average rating across a merchant's listings (observed data).
export function merchantReputation(name) {
  const listings = CATALOG.filter((p) => p.merchant === name);
  const reviews = listings.reduce((s, p) => s + p.reviews, 0);
  const avg = reviews ? listings.reduce((s, p) => s + p.rating * p.reviews, 0) / reviews : null;
  const m = getMerchant(name);
  return {
    merchant: name,
    verified: !!m?.verified,
    since: m?.since ?? null,
    listings: listings.length,
    reviews,
    avgRating: avg == null ? null : Math.round(avg * 100) / 100,
  };
}

// Cheapest comparable item (same kind) from a verified merchant.
// Gift cards are sold at face value, so denominations aren't comparable.
function verifiedBaseline(p) {
  if (p.category === "gift_cards") return null;
  const peers = CATALOG.filter((q) => q.sku !== p.sku && kindOf(q.sku) === kindOf(p.sku) && q.category === p.category && getMerchant(q.merchant)?.verified);
  if (!peers.length) return null;
  return peers.reduce((a, b) => (b.price < a.price ? b : a));
}

// ------------------------------------------------------------ assessment
const signal = (id, kind, weight, label, detail) => ({ id, kind, weight, label, detail });

export function assessListing(p, policy = null) {
  const signals = [];
  const rep = merchantReputation(p.merchant);
  const injection = detectInjection(`${p.name} ${p.description}`);

  if (injection.detected)
    signals.push(signal("prompt_injection", "observed", 70, "Instructions aimed at AI agents", `Listing text matches ${injection.matches.map((m) => m.pattern.replace(/_/g, " ")).join(", ")}.`));
  if (!rep.verified) signals.push(signal("merchant_unverified", "observed", 25, "Unverified merchant", `${p.merchant} has not passed merchant verification.`));
  if (rep.since && THIS_YEAR - rep.since < 1) signals.push(signal("merchant_new", "observed", 10, "New merchant", `${p.merchant} joined in ${rep.since}.`));
  if (rep.avgRating != null && rep.avgRating < 3.5 && rep.listings > 0)
    signals.push(signal("merchant_reputation", "inferred", 10, "Weak merchant reputation", `Review-weighted average ${rep.avgRating}★ across ${rep.listings} listing(s).`));
  if (p.rating < 3) signals.push(signal("low_rating", "observed", 30, "Very low rating", `Rated ${p.rating}★.`));
  else if (p.rating < 3.5) signals.push(signal("low_rating", "observed", 20, "Low rating", `Rated ${p.rating}★.`));
  if (p.reviews < 50) signals.push(signal("few_reviews", "observed", 15, "Few reviews", `Only ${p.reviews} review(s), so the rating is unreliable.`));
  const base = verifiedBaseline(p);
  if (base && p.price < base.price * 0.5)
    signals.push(
      signal("price_anomaly", "inferred", 25, "Price far below comparable items", `$${p.price.toFixed(2)} is ${Math.round((1 - p.price / base.price) * 100)}% below the cheapest comparable verified listing ($${base.price.toFixed(2)}, ${base.sku}).`),
    );
  if (p.category !== "gift_cards" && p.stock >= 999) signals.push(signal("implausible_stock", "inferred", 10, "Implausible stock level", `Claims ${p.stock} units of a physical item.`));
  if (PRESSURE.test(p.name) || PRESSURE.test(p.description)) signals.push(signal("pressure_language", "observed", 15, "High-pressure sales language", "Listing uses urgency or guarantee claims typical of scams."));
  if (p.stock <= 0) signals.push(signal("unavailable", "observed", 0, "Out of stock", "Cannot be purchased right now."));
  if (policy?.blockedCategories?.includes(p.category)) signals.push(signal("category_restricted", "observed", 0, "Category blocked by your rules", `${p.category.replace("_", " ")} is blocked in your spending policy.`));

  const score = Math.min(100, signals.reduce((s, x) => s + x.weight, 0));
  const level = injection.detected || score >= 60 ? "high" : score >= 25 ? "medium" : "low";
  const blockHigh = policy ? policy.blockHighRisk !== false : true;
  const action =
    level === "high" && blockHigh
      ? { type: "blocked", detail: "Excluded from carts by the server; listing text hidden from the AI model." }
      : level === "high"
        ? { type: "warn", detail: "High risk, but your rules allow it. Listing text is still hidden from the AI model." }
        : level === "medium"
          ? { type: "warn", detail: "Shown with a warning; prefer a verified alternative." }
          : { type: "allowed", detail: "No significant risk signals." };
  return {
    sku: p.sku,
    name: p.name,
    merchant: p.merchant,
    level,
    score,
    signals,
    injection,
    action,
    merchantProfile: rep,
    engine: RISK_ENGINE_VERSION,
    basis: "Heuristic score from listed signals; not a fraud probability.",
  };
}

// Compact form for the model: no raw seller text.
export const riskSummary = (a) => ({ level: a.level, score: a.score, reasons: a.signals.filter((s) => s.weight > 0).map((s) => s.label) });

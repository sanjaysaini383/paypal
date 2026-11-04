// Budget-aware cart optimizer.
//
// The model turns a request into a structured shopping plan (slots such as
// "tent", "sleeping bag ×2", optional "stove"); this module does the maths
// the model is bad at. For every slot it finds candidates that pass the
// user's item-level rules, then searches all combinations for the best one
// whose real total (tax and shipping included) fits the tightest of: the
// budget the user named, their per-order limit and what's left this month.
// Required slots must be filled; optional ones are added when they fit.
// The result explains every choice, alternative and exclusion.
import { CATALOG, getProduct, kindOf } from "./catalog.js";
import { searchCatalog } from "./search.js";
import { checkCart, TAX_RATE, FREE_SHIPPING_OVER, SHIPPING_FEE } from "./policy.js";
import { spentThisMonth } from "./store.js";

const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => `$${n.toFixed(2)}`;
const ITEM_RULES = new Set(["blocked_category", "blocked_merchant", "unverified_merchant", "low_rating", "item_price_cap", "stock", "quantity_cap", "high_risk_listing"]);
const MAX_CANDIDATES = 4;

// Rating shrunk toward 4.0 by review count: 4.9★ from 8 reviews ranks below
// 4.6★ from 800. Shown to the user as "review-adjusted rating".
export const adjustedRating = (p) => round2((p.rating * p.reviews + 4.0 * 25) / (p.reviews + 25));

export function priceLines(lines) {
  let subtotal = 0;
  let taxable = 0;
  let physical = false;
  for (const { p, qty } of lines) {
    subtotal += p.price * qty;
    if (p.category !== "gift_cards") (taxable += p.price * qty), (physical = true);
  }
  subtotal = round2(subtotal);
  const tax = round2(taxable * TAX_RATE);
  const shipping = physical && subtotal < FREE_SHIPPING_OVER ? SHIPPING_FEE : 0;
  return { subtotal, tax, shipping, total: round2(subtotal + tax + shipping) };
}

function candidatesFor(session, slot) {
  let pool;
  if (slot.skus?.length) pool = slot.skus.map(getProduct).filter(Boolean);
  else if (slot.kind) pool = CATALOG.filter((p) => kindOf(p.sku) === slot.kind);
  else {
    const found = searchCatalog({ query: slot.query || slot.label, category: slot.category });
    const top = Math.max(0, ...found.map((f) => f.relevance));
    pool = found.filter((f) => f.relevance >= top * 0.75).map((f) => getProduct(f.sku));
  }
  const eligible = [];
  const excluded = [];
  for (const p of pool) {
    const reasons = checkCart(session, [{ ...p, qty: slot.qty }], { subtotal: 0, tax: 0, shipping: 0, total: 0 })
      .filter((v) => ITEM_RULES.has(v.rule))
      .map((v) => v.message);
    if (slot.max_unit_price && p.price > slot.max_unit_price) reasons.push(`Over the ${fmt(slot.max_unit_price)} you set for ${slot.label}.`);
    if (reasons.length) excluded.push({ slot: slot.label, sku: p.sku, name: p.name, merchant: p.merchant, price: p.price, rating: p.rating, reasons });
    else eligible.push(p);
  }
  // Best few by quality, plus the cheapest so a tight budget stays solvable.
  const byQuality = [...eligible].sort((a, b) => adjustedRating(b) - adjustedRating(a) || a.price - b.price);
  const keep = byQuality.slice(0, MAX_CANDIDATES - 1);
  const cheapest = [...eligible].sort((a, b) => a.price - b.price)[0];
  if (cheapest && !keep.includes(cheapest)) keep.push(cheapest);
  else if (byQuality[MAX_CANDIDATES - 1]) keep.push(byQuality[MAX_CANDIDATES - 1]);
  return { eligible: keep, excluded };
}

const WEIGHTS = {
  balanced: { required: 2, optional: 1, fill: 6 }, // complete the set first, then quality
  quality: { required: 20, optional: 2, fill: 0.5 }, // better essentials beat more extras
  price: { required: 0, optional: 0, fill: 6 }, // complete the set as cheaply as possible
};

export function optimizeCart(session, { slots, budget, prefer = "balanced" }) {
  const policy = session.policy;
  const remaining = round2(policy.monthlyBudget - spentThisMonth(session));
  const limits = [
    ...(Number.isFinite(budget) && budget > 0 ? [{ label: "your budget for this request", value: budget }] : []),
    { label: "your per-order limit", value: policy.perOrderLimit },
    { label: "what's left of your monthly budget", value: remaining },
  ];
  const binding = limits.reduce((a, b) => (b.value < a.value ? b : a));
  const cap = binding.value;
  const w = WEIGHTS[prefer] || WEIGHTS.balanced;

  const prepared = slots.map((slot) => ({ slot: { qty: 1, required: true, ...slot }, ...candidatesFor(session, { qty: 1, required: true, ...slot }) }));
  const excluded = prepared.flatMap((x) => x.excluded);
  const missing = prepared.filter((x) => x.slot.required && !x.eligible.length);
  const base = { budget: { requested: budget ?? null, per_order_limit: policy.perOrderLimit, remaining_this_month: remaining, effective: cap, binding: binding.label }, excluded };
  if (missing.length)
    return {
      ...base,
      feasible: false,
      reason: `Nothing available for ${missing.map((m) => m.slot.label).join(", ")} passes your rules.`,
      suggestions: missing.map((m) => `${m.slot.label}: ${m.excluded.length ? `all ${m.excluded.length} option(s) were excluded (${m.excluded[0].reasons[0]})` : "no matching products"}.`),
    };

  // Exhaustive search with pruning; utility first, then lower total.
  const n = prepared.length;
  const picks = new Array(n).fill(null);
  const top = [];
  // Essentials score their rating; extras score the fill bonus plus quality above a 4-star baseline.
  const utilityOf = (slot, p) => (slot.required ? w.required * adjustedRating(p) : w.fill + w.optional * (adjustedRating(p) - 4));
  const consider = (utility) => {
    const lines = picks.map((p, i) => p && { p, qty: prepared[i].slot.qty }).filter(Boolean);
    const totals = priceLines(lines);
    if (totals.total > cap + 0.005) return;
    top.push({ utility: round2(utility), totals, picks: [...picks] });
    top.sort((a, b) => b.utility - a.utility || a.totals.total - b.totals.total);
    if (top.length > 8) top.pop();
  };
  const dfs = (i, subtotal, taxable, utility) => {
    if (subtotal + taxable * TAX_RATE > cap + 0.005) return; // shipping only adds
    if (i === n) return consider(utility);
    const { slot, eligible } = prepared[i];
    const dependsOn = slot.requires && prepared.findIndex((x) => x.slot.label === slot.requires);
    const blocked = dependsOn >= 0 && dependsOn < i && !picks[dependsOn];
    if (!blocked)
      for (const p of eligible) {
        picks[i] = p;
        const cost = p.price * slot.qty;
        dfs(i + 1, subtotal + cost, taxable + (p.category === "gift_cards" ? 0 : cost), utility + utilityOf(slot, p));
        picks[i] = null;
      }
    if (!slot.required) dfs(i + 1, subtotal, taxable, utility);
  };
  dfs(0, 0, 0, 0);

  // Category caps and the other cart-level rules: take the best that passes.
  const chosen = top.find((sol) => {
    const lines = sol.picks.map((p, i) => p && { ...p, qty: prepared[i].slot.qty }).filter(Boolean);
    return checkCart(session, lines, sol.totals).length === 0;
  });
  if (!chosen) {
    const cheapest = priceLines(prepared.filter((x) => x.slot.required).map((x) => ({ p: [...x.eligible].sort((a, b) => a.price - b.price)[0], qty: x.slot.qty })));
    return {
      ...base,
      feasible: false,
      reason: `The cheapest set that covers the essentials costs ${fmt(cheapest.total)}, over ${binding.label} (${fmt(cap)}).`,
      cheapest_total: cheapest.total,
      suggestions: [`Raise the budget to at least ${fmt(cheapest.total)}`, "Drop an essential item, or allow cheaper alternatives"],
    };
  }

  const items = [];
  const skipped = [];
  const alternatives = [];
  const tradeoffs = [];
  prepared.forEach(({ slot, eligible }, i) => {
    const p = chosen.picks[i];
    if (!p) {
      const cheapest = [...eligible].sort((a, b) => a.price - b.price)[0];
      if (slot.requires && !chosen.picks[prepared.findIndex((x) => x.slot.label === slot.requires)])
        skipped.push({ slot: slot.label, reason: `Only useful with ${slot.requires}, which didn't fit.` });
      else if (cheapest) {
        const extra = priceLines([...chosen.picks.map((q, j) => q && { p: q, qty: prepared[j].slot.qty }).filter(Boolean), { p: cheapest, qty: slot.qty }]).total - chosen.totals.total;
        skipped.push({ slot: slot.label, reason: `Cheapest option (${cheapest.name}, ${fmt(cheapest.price * slot.qty)}) would add ${fmt(extra)} and go over ${binding.label}.` });
      } else skipped.push({ slot: slot.label, reason: "No option passes your rules." });
      return;
    }
    const others = eligible.filter((q) => q.sku !== p.sku);
    const isCheapest = others.every((q) => q.price >= p.price);
    const isBest = others.every((q) => adjustedRating(q) <= adjustedRating(p));
    items.push({
      slot: slot.label,
      sku: p.sku,
      name: p.name,
      merchant: p.merchant,
      qty: slot.qty,
      unit_price: p.price,
      line_total: round2(p.price * slot.qty),
      rating: p.rating,
      reviews: p.reviews,
      adjusted_rating: adjustedRating(p),
      why: isBest && isCheapest ? "Best-rated and cheapest option" : isBest ? "Best review-adjusted rating" : isCheapest ? "Cheapest option that passes your rules" : "Best balance of rating and price within budget",
    });
    for (const q of others) {
      const swapped = chosen.picks.map((x, j) => (j === i ? q : x));
      const t = priceLines(swapped.map((x, j) => x && { p: x, qty: prepared[j].slot.qty }).filter(Boolean));
      const delta = round2(t.total - chosen.totals.total);
      const dr = round2(adjustedRating(q) - adjustedRating(p));
      alternatives.push({ slot: slot.label, sku: q.sku, name: q.name, merchant: q.merchant, unit_price: q.price, rating: q.rating, delta_total: delta, delta_rating: dr, fits: t.total <= cap + 0.005 });
      if (dr > 0 && delta > 0 && t.total > cap)
        tradeoffs.push(`${slot.label}: ${q.name} rates ${dr.toFixed(2)}★ higher but adds ${fmt(delta)}, putting the total at ${fmt(t.total)}, over ${binding.label}.`);
      else if (dr > 0 && delta > 0)
        tradeoffs.push(`${slot.label}: ${q.name} rates ${dr.toFixed(2)}★ higher for ${fmt(delta)} more; I used the room to cover more of your list instead.`);
    }
  });
  return {
    ...base,
    feasible: true,
    prefer,
    items,
    skipped,
    totals: chosen.totals,
    headroom: round2(cap - chosen.totals.total),
    alternatives: alternatives.sort((a, b) => a.delta_total - b.delta_total),
    tradeoffs: tradeoffs.slice(0, 6),
  };
}

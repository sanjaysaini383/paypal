// Spending guardrails. These run on the server, outside the model, so a
// confused or prompt-injected agent still cannot spend outside the rules the
// user set.
import { VERIFIED_MERCHANTS, spentThisMonth, categorySpendThisMonth } from "./store.js";

export const CATEGORIES = ["outdoor", "electronics", "home", "grocery", "gift_cards", "books"];

const round2 = (n) => Math.round(n * 100) / 100;

export const TAX_RATE = 0.0825;
export const FREE_SHIPPING_OVER = 75;
export const SHIPPING_FEE = 6.99;

export function priceCart(lines) {
  const subtotal = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const taxable = lines.filter((l) => l.category !== "gift_cards");
  const tax = round2(taxable.reduce((s, l) => s + l.price * l.qty, 0) * TAX_RATE);
  const physical = lines.some((l) => l.category !== "gift_cards");
  const shipping = physical && subtotal < FREE_SHIPPING_OVER ? SHIPPING_FEE : 0;
  return { subtotal, tax, shipping, total: round2(subtotal + tax + shipping) };
}

// Returns a list of violations; an empty list means the cart may proceed.
export function checkCart(session, lines, totals) {
  const p = session.policy;
  const violations = [];
  for (const l of lines) {
    if (p.blockedCategories.includes(l.category))
      violations.push({ rule: "blocked_category", sku: l.sku, message: `Category "${l.category}" is blocked by your policy.` });
    if (p.blockedMerchants.includes(l.merchant))
      violations.push({ rule: "blocked_merchant", sku: l.sku, message: `Merchant "${l.merchant}" is blocked by your policy.` });
    if (p.requireVerifiedMerchants && !VERIFIED_MERCHANTS.includes(l.merchant))
      violations.push({ rule: "unverified_merchant", sku: l.sku, message: `"${l.merchant}" is not a verified merchant.` });
    if (l.rating < p.minMerchantRating)
      violations.push({ rule: "low_rating", sku: l.sku, message: `${l.name} is rated ${l.rating}, below your minimum of ${p.minMerchantRating}.` });
    if (l.price > p.maxItemPrice)
      violations.push({ rule: "item_price_cap", sku: l.sku, message: `${l.name} costs $${l.price}, above your per-item cap of $${p.maxItemPrice}.` });
    if (l.qty > l.stock)
      violations.push({ rule: "stock", sku: l.sku, message: `Only ${l.stock} of ${l.name} in stock.` });
    if (l.qty > 10)
      violations.push({ rule: "quantity_cap", sku: l.sku, message: `Quantity ${l.qty} of ${l.name} looks unusual (max 10 per item).` });
  }
  if (totals.total > p.perOrderLimit)
    violations.push({
      rule: "per_order_limit",
      message: `Order total $${totals.total.toFixed(2)} exceeds your per-order limit of $${p.perOrderLimit}.`,
      over_by: round2(totals.total - p.perOrderLimit),
    });
  // Per-category monthly caps (item prices, before tax).
  const limits = p.categoryLimits || {};
  if (Object.keys(limits).length) {
    const spent = categorySpendThisMonth(session);
    const inCart = {};
    for (const l of lines) inCart[l.category] = round2((inCart[l.category] || 0) + l.price * l.qty);
    for (const [cat, amount] of Object.entries(inCart)) {
      if (limits[cat] == null) continue;
      const already = spent[cat] || 0;
      if (already + amount > limits[cat] + 0.005)
        violations.push({
          rule: "category_limit",
          message: `$${amount.toFixed(2)} of ${cat.replace("_", " ")} would exceed your $${limits[cat]}/month limit for that category ($${already.toFixed(2)} already spent).`,
          over_by: round2(already + amount - limits[cat]),
        });
    }
  }
  const remaining = round2(p.monthlyBudget - spentThisMonth(session));
  if (totals.total > remaining)
    violations.push({
      rule: "monthly_budget",
      message: `Order total $${totals.total.toFixed(2)} exceeds your remaining monthly budget of $${remaining.toFixed(2)}.`,
      over_by: round2(totals.total - remaining),
    });
  return violations;
}

export function sanitizePolicy(input, current) {
  const num = (v, min, max, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, round2(n))) : d;
  };
  const list = (v, d) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 20) : d);
  const limits = (v, d) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return d;
    const out = {};
    for (const [cat, amount] of Object.entries(v)) {
      const n = Number(amount);
      if (CATEGORIES.includes(cat) && amount !== null && Number.isFinite(n) && n >= 0) out[cat] = Math.min(100000, round2(n));
    }
    return out;
  };
  return {
    monthlyBudget: num(input.monthlyBudget, 0, 100000, current.monthlyBudget),
    perOrderLimit: num(input.perOrderLimit, 0, 100000, current.perOrderLimit),
    maxItemPrice: num(input.maxItemPrice, 0, 100000, current.maxItemPrice),
    minMerchantRating: num(input.minMerchantRating, 0, 5, current.minMerchantRating),
    blockedCategories: list(input.blockedCategories, current.blockedCategories),
    blockedMerchants: list(input.blockedMerchants, current.blockedMerchants),
    requireVerifiedMerchants:
      typeof input.requireVerifiedMerchants === "boolean" ? input.requireVerifiedMerchants : current.requireVerifiedMerchants,
    categoryLimits: limits(input.categoryLimits, current.categoryLimits || {}),
  };
}

const label = (c) => c.replace("_", " ");

// Turn a change request (from the agent's propose_policy_change tool or the
// offline parser) into the next policy plus a human-readable list of diffs.
export function applyPolicyChanges(current, changes = {}) {
  const next = structuredClone(current);
  const setNum = (key, v) => v != null && Number.isFinite(Number(v)) && (next[key] = Number(v));
  setNum("monthlyBudget", changes.monthly_budget);
  setNum("perOrderLimit", changes.per_order_limit);
  setNum("maxItemPrice", changes.max_item_price);
  setNum("minMerchantRating", changes.min_rating);
  if (typeof changes.verified_merchants_only === "boolean") next.requireVerifiedMerchants = changes.verified_merchants_only;
  const cats = (v) => (Array.isArray(v) ? v.filter((c) => CATEGORIES.includes(c)) : []);
  next.blockedCategories = [...new Set([...next.blockedCategories, ...cats(changes.block_categories)])].filter(
    (c) => !cats(changes.unblock_categories).includes(c),
  );
  next.categoryLimits = { ...(next.categoryLimits || {}) };
  for (const l of Array.isArray(changes.category_limits) ? changes.category_limits : [])
    if (CATEGORIES.includes(l?.category) && Number.isFinite(Number(l.monthly_limit))) next.categoryLimits[l.category] = Number(l.monthly_limit);
  for (const c of cats(changes.remove_category_limits)) delete next.categoryLimits[c];

  const sanitized = sanitizePolicy(next, current);
  return { next: sanitized, diff: diffPolicies(current, sanitized) };
}

export function diffPolicies(a, b) {
  const out = [];
  const money = (n) => `$${Number(n).toLocaleString("en-US")}`;
  const num = (key, name, fmt = money) => a[key] !== b[key] && out.push({ label: name, from: fmt(a[key]), to: fmt(b[key]) });
  num("monthlyBudget", "Monthly budget");
  num("perOrderLimit", "Per-order limit");
  num("maxItemPrice", "Per-item cap");
  num("minMerchantRating", "Minimum rating", (n) => `${n}★`);
  if (a.requireVerifiedMerchants !== b.requireVerifiedMerchants)
    out.push({ label: "Verified stores only", from: a.requireVerifiedMerchants ? "On" : "Off", to: b.requireVerifiedMerchants ? "On" : "Off" });
  for (const c of CATEGORIES) {
    const was = a.blockedCategories.includes(c);
    const is = b.blockedCategories.includes(c);
    if (was !== is) out.push({ label: `${label(c)[0].toUpperCase() + label(c).slice(1)}`, from: was ? "Blocked" : "Allowed", to: is ? "Blocked" : "Allowed" });
    const la = a.categoryLimits?.[c];
    const lb = b.categoryLimits?.[c];
    if (la !== lb)
      out.push({ label: `${label(c)[0].toUpperCase() + label(c).slice(1)} limit`, from: la == null ? "No limit" : `${money(la)}/mo`, to: lb == null ? "No limit" : `${money(lb)}/mo` });
  }
  return out;
}

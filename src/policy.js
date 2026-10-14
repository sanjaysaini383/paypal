// Spending guardrails. These run on the server, outside the model, so a
// confused or prompt-injected agent still cannot spend outside the rules the
// user set.
import { VERIFIED_MERCHANTS, spentThisMonth } from "./store.js";

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
  return {
    monthlyBudget: num(input.monthlyBudget, 0, 100000, current.monthlyBudget),
    perOrderLimit: num(input.perOrderLimit, 0, 100000, current.perOrderLimit),
    maxItemPrice: num(input.maxItemPrice, 0, 100000, current.maxItemPrice),
    minMerchantRating: num(input.minMerchantRating, 0, 5, current.minMerchantRating),
    blockedCategories: list(input.blockedCategories, current.blockedCategories),
    blockedMerchants: list(input.blockedMerchants, current.blockedMerchants),
    requireVerifiedMerchants:
      typeof input.requireVerifiedMerchants === "boolean" ? input.requireVerifiedMerchants : current.requireVerifiedMerchants,
  };
}

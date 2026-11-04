// CartPilot front end: chat stream, cart + PayPal checkout, spending rules,
// AG Grid activity tables. Motion (motion.dev) drives the animations and
// Lucide provides icons; both degrade gracefully if their CDN fails.
import { createControlCenter } from "./control-center.js";

const $ = (sel, root = document) => root.querySelector(sel);
const CATEGORIES = ["outdoor", "electronics", "home", "grocery", "gift_cards", "books"];
const CATEGORY_ICONS = { outdoor: "tent", electronics: "cpu", home: "lamp", grocery: "coffee", gift_cards: "gift", books: "book-open" };
const TOOL_ICONS = { search_catalog: "search", get_wallet_status: "wallet", propose_cart: "shopping-cart", create_paypal_checkout: "credit-card", refund_order: "undo-2", propose_policy_change: "shield-check", show_products: "layout-grid", plan_purchase: "route", get_risk_report: "shield-alert" };
const MODE_LABELS = { simulated: "Simulated PayPal", sandbox: "PayPal sandbox", live: "PayPal live" };
const LOGO = '<svg viewBox="0 0 32 32"><path d="M8 10h3l2.5 10h9l2-7H12" /><circle cx="14" cy="24" r="1.6" /><circle cx="21" cy="24" r="1.6" /></svg>';
const fmt = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name) => `<i data-lucide="${name}"></i>`;

// ------------------------------------------------------------------ motion + icons
const Motion = window.Motion;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const canAnimate = !!Motion && !reduceMotion;

let restoring = false; // true while replaying saved history: no entrance animations

function enter(els, { y = 8, delay = 0, stagger = 0, duration = 0.32 } = {}) {
  if (!canAnimate || restoring || !els || els.length === 0) return;
  Motion.animate(els, { opacity: [0, 1], y: [y, 0] }, { duration, delay: stagger ? Motion.stagger(stagger, { startDelay: delay }) : delay, ease: [0.22, 1, 0.36, 1] });
}

// Count a number up/down from its previous value.
const countFrom = new WeakMap();
function countTo(el, value, format = fmt) {
  const from = countFrom.get(el) ?? 0;
  countFrom.set(el, value);
  if (!canAnimate || from === value) return void (el.textContent = format(value));
  Motion.animate(from, value, { duration: 0.7, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => (el.textContent = format(v)) });
}

let iconFrame = 0;
function refreshIcons() {
  if (!window.lucide || iconFrame) return;
  iconFrame = requestAnimationFrame(() => {
    iconFrame = 0;
    window.lucide.createIcons({ attrs: { "aria-hidden": "true" } });
  });
}

// ------------------------------------------------------------------ session + api
function sessionId() {
  try {
    let id = localStorage.getItem("cartpilot-session");
    if (!id) {
      id = "s_" + crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem("cartpilot-session", id);
    }
    return id;
  } catch {
    return (window.__sid ||= "s_" + crypto.randomUUID().replace(/-/g, ""));
  }
}
const SID = sessionId();
const api = (path, opts = {}) =>
  fetch(path, { ...opts, headers: { "Content-Type": "application/json", "X-Session-Id": SID, ...(opts.headers || {}) } });

let config = {};
let state = null;
let busy = false;

// ------------------------------------------------------------------ toasts
function toast(kind, title, text = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  const ic = { ok: "circle-check", bad: "circle-alert", info: "info" }[kind] || "info";
  el.innerHTML = `${icon(ic)}<div><strong>${esc(title)}</strong>${text ? `<small>${esc(text)}</small>` : ""}</div>`;
  $("#toasts").append(el);
  refreshIcons();
  enter(el, { y: -10 });
  setTimeout(async () => {
    if (canAnimate) await Motion.animate(el, { opacity: 0, x: 24 }, { duration: 0.25 }).finished;
    el.remove();
  }, 4200);
}

// ------------------------------------------------------------------ theme
function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
$("#theme-btn").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("cartpilot-theme", next);
  } catch {}
  applyGridTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyGridTheme);

// ------------------------------------------------------------------ boot
const welcomeTemplate = $("#welcome").cloneNode(true);

async function boot() {
  refreshIcons();
  enter([...document.querySelectorAll(".empty > *:not(.suggestions)")], { stagger: 0.06 });
  enter([...document.querySelectorAll(".suggestion")], { stagger: 0.05, delay: 0.15 });

  config = await (await api("/api/config")).json();
  if (config.repoUrl && /github\.com\/[^/]+\/[^/]+/.test(config.repoUrl)) $("#repo-link").href = config.repoUrl;
  renderModes();

  $("#cat-checks").innerHTML = CATEGORIES.map(
    (c) => `<label class="toggle-chip"><input type="checkbox" value="${c}" /><span>${c.replace("_", " ")}</span></label>`,
  ).join("");
  $("#wallet-period").textContent = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });

  controlCenter.init();
  await refresh();
  renderHistory(state.transcript);
  if (config.paypalMode === "sandbox" || config.paypalMode === "live") loadPayPalSdk();
}

// Which AI and which payment rail are live: never ambiguous about real money.
function renderModes() {
  const pay = {
    simulated: ["sim", "flask-conical", "Simulated payments", "No PayPal credentials configured: a local simulator stands in for PayPal and no money moves."],
    sandbox: ["sandbox", "test-tube", "PayPal sandbox", "Real PayPal REST APIs with test accounts and test money."],
    live: ["live", "badge-dollar-sign", "PayPal LIVE", "Real money: captures move funds from real PayPal accounts."],
  }[config.paypalMode] || ["sim", "circle-help", config.paypalMode, ""];
  const ai = config.aiMode === "offline" ? ["Offline planner", "Rule-based planner driving the same tools (no AI key configured)."] : [`${config.aiMode} · ${config.model}`, "LLM agent with tool use."];
  $("#modes").innerHTML = `
    <span class="mode ${pay[0]}" title="${esc(pay[3])}">${icon(pay[1])}${esc(pay[2])}</span>
    <span class="mode ai" title="${esc(ai[1])}">${icon("bot")}${esc(ai[0])}</span>
    ${config.webhooks ? `<span class="mode ok" title="PayPal webhooks are verified and reconciled">${icon("webhook")}Webhooks</span>` : ""}`;
  refreshIcons();
}

// Live countdown for authorizations waiting on the buyer.
function tickCountdowns() {
  for (const el of document.querySelectorAll("[data-expires]")) {
    const ms = Date.parse(el.dataset.expires) - Date.now();
    el.textContent = ms > 0 ? `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}` : "expired";
    el.classList.toggle("soon", ms > 0 && ms < 120000);
  }
}
setInterval(tickCountdowns, 1000);

// ------------------------------------------------------------------ risk
const RISK_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk" };
function riskDetails(risk, { compact = false } = {}) {
  if (!risk) return "";
  const signals = risk.signals.filter((x) => x.weight > 0 || x.id === "category_restricted" || x.id === "unavailable");
  return `<details class="risk ${risk.level}${compact ? " compact" : ""}">
    <summary><span class="risk-dot"></span>${RISK_LABEL[risk.level]}<span class="risk-score">${risk.score}</span></summary>
    <div class="risk-body">
      ${signals.length ? `<ul>${signals.map((x) => `<li><span class="sig ${x.kind}">${x.kind}</span><span><b>${esc(x.label)}</b> ${esc(x.detail)}</span></li>`).join("")}</ul>` : `<p>No risk signals.</p>`}
      <p class="risk-action">${icon(risk.action.type === "blocked" ? "shield-ban" : risk.action.type === "warn" ? "triangle-alert" : "shield-check")}${esc(risk.action.detail)}</p>
      <p class="risk-basis">Heuristic score (0-100) from the signals above, not a fraud probability.</p>
    </div>
  </details>`;
}

// ------------------------------------------------------------------ plan, refund cards
function excludedBlock(plan) {
  if (!plan.excluded?.length) return "";
  return `<details class="plan-more"><summary>${icon("shield-ban")}Excluded by your rules or the risk engine (${plan.excluded.length})</summary>
    <ul class="excluded">${plan.excluded
      .map((e) => `<li><span class="mono">${esc(e.sku)}</span><span><b>${esc(e.name)}</b> · ${esc(e.merchant)} · ${fmt(e.price)}<small>${e.reasons.map(esc).join(" ")}</small></span></li>`)
      .join("")}</ul></details>`;
}

function renderPlan(plan) {
  $("#welcome")?.remove();
  const el = document.createElement("section");
  el.className = "plan";
  if (!plan.feasible) {
    el.innerHTML = `<div class="plan-head"><span class="plan-icon bad">${icon("route")}</span><div><strong>No plan fits your limits</strong><small>${esc(plan.reason)}</small></div></div>
      <ul class="plan-notes">${(plan.suggestions || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${excludedBlock(plan)}`;
  } else {
    const merchants = new Set(plan.items.map((i) => i.merchant)).size;
    const pct = Math.min(100, (plan.totals.total / plan.budget.effective) * 100);
    el.innerHTML = `
      <div class="plan-head">
        <span class="plan-icon">${icon("route")}</span>
        <div><strong>Optimized shopping plan</strong><small>${plan.items.length} items from ${merchants} merchant${merchants === 1 ? "" : "s"} · limit ${fmt(plan.budget.effective)} (${esc(plan.budget.binding)})</small></div>
        <span class="plan-total">${fmt(plan.totals.total)}</span>
      </div>
      <div class="meter" role="img" aria-label="${fmt(plan.totals.total)} of ${fmt(plan.budget.effective)}"><div style="width:${pct}%"></div></div>
      <div class="meter-legend"><span>Total incl. ${fmt(plan.totals.tax)} tax${plan.totals.shipping ? ` and ${fmt(plan.totals.shipping)} shipping` : ", free shipping"}</span><span>${fmt(plan.headroom)} headroom</span></div>
      <table class="plan-table"><tbody>
        ${plan.items
          .map(
            (i) => `<tr><td class="slot">${esc(i.slot)}</td><td><span class="nm">${esc(i.name)}${i.qty > 1 ? ` <b>×${i.qty}</b>` : ""}</span><small>${esc(i.merchant)} · ★ ${i.rating} (${i.reviews.toLocaleString("en-US")}) · ${esc(i.why)}</small></td><td class="num">${fmt(i.line_total)}</td></tr>`,
          )
          .join("")}
        ${plan.skipped.map((x) => `<tr class="skipped"><td class="slot">${esc(x.slot)}</td><td colspan="2"><small>${icon("circle-minus")}${esc(x.reason)}</small></td></tr>`).join("")}
      </tbody></table>
      ${plan.tradeoffs?.length ? `<details class="plan-more"><summary>${icon("scale")}Trade-offs considered (${plan.tradeoffs.length})</summary><ul>${plan.tradeoffs.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>` : ""}
      ${excludedBlock(plan)}
      ${plan.cart_status === "blocked" ? `<p class="plan-blocked">${icon("shield-ban")}The guardrails blocked the resulting cart; see the cart for why.</p>` : ""}`;
  }
  messagesEl.append(el);
  refreshIcons();
  enter(el);
  scrollDown();
}

function renderRefund(r) {
  $("#welcome")?.remove();
  const c = r.calculation;
  const el = document.createElement("section");
  el.className = "refund-card";
  el.innerHTML = `
    <div class="plan-head"><span class="plan-icon ok">${icon("undo-2")}</span>
      <div><strong>PayPal refund ${r.status === "COMPLETED" ? "completed" : "submitted (pending at PayPal)"}</strong><small class="mono">${esc(r.refund_id)} · order ${esc(r.order_id)} · ${esc(MODE_LABELS[config.paypalMode] || config.paypalMode)}</small></div>
      <span class="plan-total">${fmt(r.amount)}</span></div>
    <table class="plan-table"><tbody>
      ${c.lines.map((l) => `<tr><td><span class="nm">${esc(l.name)}${l.qty > 1 ? ` <b>×${l.qty}</b>` : ""}</span><small>${fmt(l.goods)} item + ${fmt(l.tax)} tax</small></td><td class="num">${fmt(l.goods + l.tax)}</td></tr>`).join("")}
      ${c.shipping ? `<tr><td><span class="nm">Shipping</span><small>Refunded because nothing else is left on the order</small></td><td class="num">${fmt(c.shipping)}</td></tr>` : ""}
      <tr class="total"><td>Refund total</td><td class="num">${fmt(r.amount)}</td></tr>
    </tbody></table>
    <p class="refund-note">${icon("info")}Calculated on the server from the authorized order snapshot. Order is now <b>${esc(r.order_status.replace(/_/g, " ").toLowerCase())}</b>.</p>`;
  messagesEl.append(el);
  refreshIcons();
  enter(el);
  scrollDown();
}

// ------------------------------------------------------------------ product cards
const stars = (r) => `<span class="stars" style="--r:${(r / 5) * 100}%" aria-label="${r} out of 5"></span>`;

function renderProducts({ title, items }) {
  $("#welcome")?.remove();
  const group = document.createElement("section");
  group.className = "products";
  group.innerHTML = `
    <div class="products-head">
      <strong>${icon("layout-grid")}${esc(title)}</strong>
      <button type="button" class="btn btn-secondary btn-sm compare-btn" disabled>${icon("scale")}Compare</button>
    </div>
    <div class="product-grid">${items
      .map(
        (p) => `<article class="product" data-sku="${esc(p.sku)}">
          <div class="p-media cat-${esc(p.category)}">${icon(CATEGORY_ICONS[p.category] || "package")}
            ${p.stock <= 10 ? `<span class="p-tag">Only ${p.stock} left</span>` : ""}
            ${p.flagged ? `<span class="p-tag bad">Hidden AI instructions</span>` : ""}</div>
          <div class="p-body">
            <span class="p-merchant">${esc(p.merchant)}${p.verified ? icon("badge-check") : ""}</span>
            <h4 title="${esc(p.name)}">${esc(p.name)}</h4>
            <span class="p-rating">${stars(p.rating)}<b>${p.rating}</b><span>(${p.reviews.toLocaleString("en-US")})</span></span>
            ${p.note ? `<p class="p-note">${esc(p.note)}</p>` : ""}
            ${riskDetails(p.risk, { compact: true })}
            <div class="p-foot">
              <span class="p-price">${fmt(p.price)}</span>
              <label class="p-compare" title="Compare"><input type="checkbox" value="${esc(p.sku)}" /><span>Compare</span></label>
            </div>
            <button type="button" class="btn btn-primary btn-sm btn-block p-add"${p.flagged || p.risk?.action?.type === "blocked" ? ` disabled title="Blocked: high-risk listing"` : ""}>${icon(p.risk?.action?.type === "blocked" ? "shield-ban" : "plus")}${p.risk?.action?.type === "blocked" ? "Blocked" : "Add to cart"}</button>
          </div>
        </article>`,
      )
      .join("")}</div>`;
  messagesEl.append(group);

  const compareBtn = $(".compare-btn", group);
  const picked = () => [...group.querySelectorAll(".p-compare input:checked")].map((c) => c.value);
  group.addEventListener("change", () => {
    const n = picked().length;
    compareBtn.disabled = n < 2;
    compareBtn.lastChild.textContent = n >= 2 ? `Compare ${n}` : "Compare";
  });
  compareBtn.addEventListener("click", () => openCompare(items.filter((p) => picked().includes(p.sku))));
  group.addEventListener("click", async (e) => {
    const add = e.target.closest(".p-add");
    if (!add) return;
    const sku = add.closest(".product").dataset.sku;
    add.disabled = true;
    const res = await api("/api/cart/items", { method: "POST", body: JSON.stringify({ sku }) });
    const body = await res.json().catch(() => ({}));
    add.disabled = false;
    if (!res.ok) return toast("bad", "Couldn't add that", body.error || "");
    state = body.state;
    render();
    const name = items.find((p) => p.sku === sku)?.name || "Item";
    if (body.result?.status === "blocked") toast("bad", "Added, but the cart breaks a rule", "See the cart for details.");
    else toast("ok", "Added to cart", name);
    add.innerHTML = `${icon("check")}Added`;
    refreshIcons();
    setTimeout(() => {
      add.innerHTML = `${icon("plus")}Add to cart`;
      refreshIcons();
    }, 1600);
  });

  refreshIcons();
  enter([...group.querySelectorAll(".product")], { stagger: 0.05, y: 10 });
  scrollDown();
}

// Side-by-side comparison with the best value in each row highlighted.
function openCompare(products) {
  const dialog = $("#compare");
  const best = (key, dir) => {
    const vals = products.map((p) => p[key]);
    return dir === "min" ? Math.min(...vals) : Math.max(...vals);
  };
  const rows = [
    ["Price", (p) => fmt(p.price), (p) => p.price === best("price", "min")],
    ["Rating", (p) => `${stars(p.rating)} ${p.rating}`, (p) => p.rating === best("rating", "max")],
    ["Reviews", (p) => p.reviews.toLocaleString("en-US"), (p) => p.reviews === best("reviews", "max")],
    ["Store", (p) => `${esc(p.merchant)}${p.verified ? ` ${icon("badge-check")}` : ""}`],
    ["In stock", (p) => String(p.stock)],
    ["Risk", (p) => (p.risk ? `<span class="risk-inline ${p.risk.level}">${RISK_LABEL[p.risk.level]} · ${p.risk.score}</span>` : "—"), (p) => p.risk?.level === "low"],
    ["Why it fits", (p) => esc(p.note || "—")],
  ];
  $("#compare-body").innerHTML = `<table>
    <thead><tr><th></th>${products.map((p) => `<th><span class="c-icon cat-${esc(p.category)}">${icon(CATEGORY_ICONS[p.category] || "package")}</span>${esc(p.name)}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map(([label, cell, isBest]) => `<tr><th>${label}</th>${products.map((p) => `<td class="${isBest?.(p) ? "best" : ""}">${cell(p)}</td>`).join("")}</tr>`)
      .join("")}
      <tr><th></th>${products.map((p) => `<td><button type="button" class="btn btn-primary btn-sm" data-add="${esc(p.sku)}"${p.flagged ? " disabled" : ""}>${icon("plus")}Add</button></td>`).join("")}</tr>
    </tbody></table>`;
  refreshIcons();
  dialog.showModal();
  if (canAnimate) Motion.animate(dialog, { opacity: [0, 1], scale: [0.97, 1] }, { duration: 0.2 });
}
$("#compare").addEventListener("click", async (e) => {
  const dialog = $("#compare");
  if (e.target === dialog || e.target.closest("[data-close]")) return dialog.close();
  const sku = e.target.closest("[data-add]")?.dataset.add;
  if (!sku) return;
  const res = await api("/api/cart/items", { method: "POST", body: JSON.stringify({ sku }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return toast("bad", "Couldn't add that", body.error || "");
  state = body.state;
  render();
  toast(body.result?.status === "blocked" ? "bad" : "ok", body.result?.status === "blocked" ? "Added, but the cart breaks a rule" : "Added to cart");
  dialog.close();
});

// ------------------------------------------------------------------ rule proposals
// The agent can only propose rule changes; this card lets the user apply them.
function renderProposal(p) {
  $("#welcome")?.remove();
  const card = document.createElement("div");
  card.className = "proposal";
  messagesEl.append(card);
  paintProposal(card, p);
  enter(card);
  scrollDown();
}

function paintProposal(card, p) {
  const done = { applied: ["paid", "Applied"], dismissed: ["rejected", "Dismissed"] }[p.status];
  card.innerHTML = `
    <div class="proposal-head">
      <span class="proposal-icon">${icon("shield-check")}</span>
      <div><strong>Proposed rule change</strong><small>${esc(p.summary)}</small></div>
      ${done ? `<span class="badge ${done[0]}">${done[1]}</span>` : ""}
    </div>
    <ul class="diff">${p.diff
      .map((d) => `<li><span class="d-label">${esc(d.label)}</span><span class="d-from">${esc(d.from)}</span>${icon("arrow-right")}<span class="d-to">${esc(d.to)}</span></li>`)
      .join("")}</ul>
    ${p.impact?.length ? `<div class="impact"><span class="impact-title">${icon("radar")}What this would do</span><ul>${p.impact.map((i) => `<li class="${esc(i.kind)}">${icon({ tighten: "lock", loosen: "lock-open", warning: "triangle-alert", info: "info" }[i.kind] || "info")}<span>${esc(i.text)}</span></li>`).join("")}</ul></div>` : ""}
    ${p.status === "pending" ? `<div class="proposal-actions"><button class="btn btn-primary" data-act="apply">${icon("check")}Apply rule</button><button class="btn btn-secondary" data-act="dismiss">Dismiss</button></div>` : ""}`;
  card.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      const res = await api(`/api/policy/proposals/${p.id}/${act}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return toast("bad", "Couldn't update your rules", body.error || "");
      state = body;
      paintProposal(card, state.proposals.find((x) => x.id === p.id) || { ...p, status: act === "apply" ? "applied" : "dismissed" });
      render();
      toast("ok", act === "apply" ? "Rule applied" : "Change dismissed", act === "apply" ? p.summary : "");
    }),
  );
  refreshIcons();
}

function renderLimits() {
  const limits = state.policy.categoryLimits || {};
  const spent = state.categorySpend || {};
  const el = $("#category-limits");
  const entries = Object.entries(limits);
  el.hidden = !entries.length;
  el.innerHTML = entries
    .map(([cat, limit]) => {
      const used = spent[cat] || 0;
      const pct = limit ? Math.min(100, (used / limit) * 100) : 100;
      return `<div class="limit">
        <span class="limit-icon">${icon(CATEGORY_ICONS[cat] || "package")}</span>
        <div class="limit-main">
          <div class="limit-top"><span>${esc(cat.replace("_", " "))}</span><span class="muted">${fmt(used)} / ${fmt(limit)} a month</span></div>
          <div class="progress thin"><div class="progress-fill${pct >= 100 ? " full" : pct >= 75 ? " high" : ""}" style="width:${pct}%"></div></div>
        </div>
        <button type="button" class="icon-btn sm" data-remove-limit="${esc(cat)}" title="Remove limit" aria-label="Remove ${esc(cat)} limit">${icon("x")}</button>
      </div>`;
    })
    .join("");
  refreshIcons();
}

$("#category-limits").addEventListener("click", async (e) => {
  const cat = e.target.closest("[data-remove-limit]")?.dataset.removeLimit;
  if (!cat) return;
  const categoryLimits = { ...state.policy.categoryLimits };
  delete categoryLimits[cat];
  const res = await api("/api/policy", { method: "PUT", body: JSON.stringify({ categoryLimits }) });
  state = await res.json();
  render();
  toast("ok", "Limit removed", `No monthly cap on ${cat.replace("_", " ")} anymore.`);
});

function askRule() {
  const text = $("#nl-rule").value.trim();
  if (!text || busy) return;
  $("#nl-rule").value = "";
  send(text);
}
$("#nl-rule-btn").addEventListener("click", askRule);
$("#nl-rule").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault(); // don't submit the rules form
    askRule();
  }
});

async function refresh() {
  state = await (await api("/api/state")).json();
  render();
}

function render() {
  if (!state) return;
  const p = state.policy;
  countTo($("#remaining"), Math.max(0, state.remaining));
  countTo($("#spent"), state.spent);
  countTo($("#budget"), p.monthlyBudget);
  countTo($("#per-order"), p.perOrderLimit, (v) => "$" + Math.round(v).toLocaleString("en-US"));

  const pct = p.monthlyBudget ? Math.min(100, (state.spent / p.monthlyBudget) * 100) : 100;
  const fill = $("#progress-fill");
  fill.className = "progress-fill" + (pct >= 100 ? " full" : pct >= 75 ? " high" : "");
  if (canAnimate) Motion.animate(fill, { width: pct + "%" }, { duration: 0.7, ease: [0.22, 1, 0.36, 1] });
  else fill.style.width = pct + "%";

  const blocked = p.blockedCategories.map((c) => c.replace("_", " "));
  $("#policy-summary").textContent = `$${p.perOrderLimit}/order${blocked.length ? ` · ${blocked.join(", ")} blocked` : ""}`;
  const form = $("#policy");
  if (!form.contains(document.activeElement)) {
    for (const k of ["monthlyBudget", "perOrderLimit", "maxItemPrice", "minMerchantRating"]) form.elements[k].value = p[k];
    form.elements.requireVerifiedMerchants.checked = p.requireVerifiedMerchants;
    for (const cb of form.querySelectorAll("#cat-checks input")) cb.checked = p.blockedCategories.includes(cb.value);
  }

  const limitCount = Object.keys(p.categoryLimits || {}).length;
  if (limitCount) $("#policy-summary").textContent += ` · ${limitCount} category limit${limitCount === 1 ? "" : "s"}`;
  renderLimits();
  renderCart();
  controlCenter.update();
}

// ------------------------------------------------------------------ chat
const messagesEl = $("#messages");
const input = $("#input");

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addRow(kind, html) {
  $("#welcome")?.remove();
  const row = document.createElement("div");
  row.className = `row ${kind}`;
  if (kind === "agent") row.innerHTML = `<span class="avatar" aria-hidden="true">${LOGO}</span><div class="bubble">${html}</div>`;
  else if (kind === "error") row.innerHTML = `<div class="bubble">${icon("circle-alert")}<span>${html}</span></div>`;
  else row.innerHTML = `<div class="bubble">${html}</div>`;
  messagesEl.append(row);
  refreshIcons();
  enter(row);
  scrollDown();
  return row;
}

// Minimal, safe formatting: escape first, then bullets and **bold**.
function formatText(text) {
  const lines = esc(text.trim()).split("\n");
  let html = "";
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const bullet = /^\s*[-•*]\s+(.*)/.exec(line);
    if (bullet) {
      if (!inList) (html += "<ul>"), (inList = true);
      html += `<li>${bullet[1]}</li>`;
      continue;
    }
    if (inList) (html += "</ul>"), (inList = false);
    if (line.trim()) html += `<p>${line}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

const TOOL_LABELS = {
  search_catalog: (i) => `Searching for “${i.query}”${i.category ? ` in ${i.category.replace("_", " ")}` : ""}`,
  get_wallet_status: () => "Checking budget and spending rules",
  propose_cart: (i) => `Building a cart with ${(i.items || []).length} item${(i.items || []).length === 1 ? "" : "s"}`,
  create_paypal_checkout: () => "Preparing PayPal checkout",
  refund_order: (i) => (i.skus?.length ? `Refunding ${i.skus.length} item${i.skus.length === 1 ? "" : "s"}` : "Refunding order"),
  propose_policy_change: () => "Drafting a spending-rule change",
  show_products: (i) => `Showing ${(i.products || []).length} options`,
  plan_purchase: (i) => `Optimizing ${(i.slots || []).length} item types${i.budget ? ` within $${i.budget}` : ""}`,
  get_risk_report: (i) => `Checking risk for ${(i.skus || []).join(", ")}`,
};

// One collapsible "activity" block per run of tool calls.
function createActivity() {
  const block = document.createElement("details");
  block.className = "activity-block";
  block.open = true;
  block.innerHTML = `<summary><span class="spinner"></span><span class="shimmer">Working</span>${icon("chevron-down")}</summary><ol></ol>`;
  messagesEl.append(block);
  refreshIcons();
  enter(block);
  const startedAt = Date.now();
  return {
    el: block,
    list: $("ol", block),
    steps: 0,
    failed: 0,
    finish(savedSecs) {
      const secs = savedSecs || Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const summary = $("summary", block);
      summary.innerHTML = `${icon(this.failed ? "circle-alert" : "circle-check")}<span>${this.steps} step${this.steps === 1 ? "" : "s"} · ${secs}s</span>${icon("chevron-down")}`;
      $("[data-lucide]", summary)?.setAttribute("style", `color: var(--${this.failed ? "warn" : "ok"})`);
      refreshIcons();
      block.open = false;
    },
  };
}

function addStep(activity, { name, input }) {
  activity.steps++;
  const li = document.createElement("li");
  li.className = "step pending";
  const label = TOOL_LABELS[name]?.(input || {}) || name;
  li.innerHTML = `<span class="ic">${icon(TOOL_ICONS[name] || "sparkles")}</span><span class="lbl">${esc(label)}</span><span class="res"><span class="spinner"></span></span>`;
  activity.list.append(li);
  refreshIcons();
  enter(li, { y: 4, duration: 0.2 });
  return li;
}

function completeStep(activity, li, { ok, summary }) {
  const warn = /suspicious|Blocked|high-risk|No plan fits/.test(summary || "");
  li.className = "step " + (!ok ? "bad" : warn ? "warn" : "ok");
  if (!ok && activity) activity.failed++;
  $(".res", li).innerHTML = `<span>${esc(summary || "")}</span>${icon(!ok ? "circle-x" : warn ? "triangle-alert" : "check")}`;
  refreshIcons();
}

// Rebuild the conversation from the server's saved transcript (page reload).
function renderHistory(entries) {
  if (!entries?.length) return;
  restoring = true;
  $("#welcome")?.remove();
  for (const e of entries) {
    if (e.role === "user") addRow("user", esc(e.text));
    else if (e.role === "agent") addRow("agent", formatText(e.text));
    else if (e.role === "error") addRow("error", esc(e.text));
    else if (e.role === "thinking") {
      const d = document.createElement("details");
      d.className = "reasoning";
      d.innerHTML = `<summary>${icon("brain")}Reasoning</summary><div>${esc(e.text)}</div>`;
      messagesEl.append(d);
    } else if (e.role === "activity") {
      const a = createActivity();
      for (const step of e.steps) completeStep(a, addStep(a, step), step);
      a.finish(e.secs);
    } else if (e.role === "products") renderProducts(e);
    else if (e.role === "plan") renderPlan(e.plan);
    else if (e.role === "refund") renderRefund(e.refund);
    else if (e.role === "policy_proposal") {
      const p = state.proposals.find((x) => x.id === e.proposalId);
      if (p) renderProposal(p);
    }
  }
  restoring = false;
  refreshIcons();
  scrollDown();
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  $("#send-btn").disabled = true;
  addRow("user", esc(text));
  input.value = "";
  autosize();

  let activity = null;
  const stepEls = new Map();
  const thinking = document.createElement("div");
  thinking.className = "row agent";
  thinking.innerHTML = `<span class="avatar" aria-hidden="true">${LOGO}</span><div class="thinking"><span class="shimmer">Thinking…</span></div>`;
  messagesEl.append(thinking);
  enter(thinking);
  const keepThinkingLast = () => {
    messagesEl.append(thinking);
    scrollDown();
  };
  const closeActivity = () => {
    activity?.finish();
    activity = null;
  };

  const handle = (ev) => {
    switch (ev.type) {
      case "thinking": {
        closeActivity();
        const d = document.createElement("details");
        d.className = "reasoning";
        d.innerHTML = `<summary>${icon("brain")}Reasoning</summary><div>${esc(ev.text)}</div>`;
        messagesEl.append(d);
        refreshIcons();
        enter(d);
        break;
      }
      case "text":
        closeActivity();
        addRow("agent", formatText(ev.text));
        break;
      case "tool_call":
        activity ||= createActivity();
        stepEls.set(ev.id, addStep(activity, ev));
        break;
      case "tool_result": {
        const li = stepEls.get(ev.id);
        if (li) completeStep(activity, li, ev);
        if (ev.name !== "search_catalog") refresh();
        break;
      }
      case "products":
        closeActivity();
        renderProducts(ev);
        break;
      case "plan":
        closeActivity();
        renderPlan(ev.plan);
        break;
      case "refund":
        closeActivity();
        renderRefund(ev.refund);
        break;
      case "policy_proposal":
        closeActivity();
        state?.proposals?.push(ev.proposal);
        renderProposal(ev.proposal);
        break;
      case "cart":
      case "checkout":
        refresh();
        break;
      case "ledger":
        refresh();
        toast("ok", "Refund issued", "The money is on its way back to your PayPal account.");
        break;
      case "error":
        closeActivity();
        addRow("error", esc(ev.text));
        break;
    }
    keepThinkingLast();
  };

  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
  } catch (err) {
    closeActivity();
    addRow("error", esc(err.message));
  } finally {
    closeActivity();
    thinking.remove();
    busy = false;
    $("#send-btn").disabled = false;
    input.focus();
    refresh();
  }
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(160, input.scrollHeight) + "px";
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
messagesEl.addEventListener("click", (e) => {
  const s = e.target.closest(".suggestion");
  if (s) send(s.dataset.prompt);
});
$("#reset-btn").addEventListener("click", async () => {
  if (busy) return;
  await api("/api/reset", { method: "POST" });
  messagesEl.replaceChildren(welcomeTemplate.cloneNode(true));
  refreshIcons();
  enter([...document.querySelectorAll(".suggestion")], { stagger: 0.05 });
  await refresh();
  input.focus();
});

// ------------------------------------------------------------------ cart + PayPal
const STATUS_LABELS = { proposed: "Review", authorizing: "Authorizing", checkout: "Awaiting payment", capturing: "Verifying & capturing", paid: "Paid", pending: "Payment pending", blocked: "Blocked", rejected: "Cancelled", expired: "Expired", denied: "Denied by PayPal" };
const AUTH_LABELS = { issued: "Issued", bound: "Active", consumed: "Used", cancelled: "Cancelled", expired: "Expired", revoked: "Revoked" };

// The signed authorization that limits what PayPal can capture for this cart.
function authPanel(cart) {
  const a = state.authorizations?.find((x) => x.id === cart.authorizationId);
  if (!a) return "";
  const live = a.status === "bound";
  return `<div class="auth ${a.status}">
    <div class="auth-head"><span class="auth-icon">${icon("fingerprint")}</span>
      <div><strong>Purchase authorization</strong><small class="mono">${esc(a.id)}</small></div>
      <span class="badge auth-${a.status}">${AUTH_LABELS[a.status] || a.status}</span></div>
    <dl class="auth-grid">
      <div><dt>Max charge</dt><dd>${fmt(a.maxAmount)} ${esc(a.currency)}</dd></div>
      <div><dt>Locked items</dt><dd>${a.items.length} (${a.items.reduce((n, i) => n + i.qty, 0)} units)</dd></div>
      <div><dt>Policy</dt><dd>v${a.policyVersion} · ${esc(a.policyHash.slice(0, 6))}</dd></div>
      <div><dt>${live ? "Expires in" : "Expiry"}</dt><dd ${live ? `data-expires="${esc(a.expiresAt)}"` : ""}>${live ? "…" : new Date(a.expiresAt).toLocaleTimeString()}</dd></div>
      <div class="wide"><dt>PayPal order</dt><dd class="mono">${esc(a.paypalOrderId || "not created")}</dd></div>
      <div class="wide"><dt>Integrity</dt><dd class="mono ${a.integrity === "valid" ? "ok" : "bad"}">${icon(a.integrity === "valid" ? "shield-check" : "shield-x")}HMAC-SHA256 ${esc(a.signature)}… ${a.integrity === "valid" ? "verified" : "INVALID"}</dd></div>
    </dl>
    <p class="auth-note">${live ? "PayPal can capture exactly this: same items, prices, payee and total, once, before it expires. Rules are re-checked at capture." : esc(a.events.at(-1)?.detail || "")}</p>
  </div>`;
}
let renderedCheckout = null;
let lastCartKey = null;

function latestCart() {
  const carts = state?.carts || [];
  return carts[carts.length - 1];
}

const EMPTY_CART = `<div class="cart-empty">${icon("package-open")}<p>Your cart is empty</p>
  <small>The agent's proposed cart appears here for you to review and pay.</small></div>`;

function renderCart() {
  const cart = latestCart();
  const el = $("#cart");
  const status = $("#cart-status");
  if (!cart || cart.status === "rejected" || cart.status === "replaced") {
    status.innerHTML = "";
    if (lastCartKey !== "empty") {
      el.innerHTML = EMPTY_CART;
      refreshIcons();
    }
    lastCartKey = "empty";
    renderedCheckout = null;
    return;
  }
  // Don't re-render while PayPal buttons for this cart are mounted.
  if (cart.status === "checkout" && renderedCheckout === cart.id) return;
  renderedCheckout = null;

  const key = `${cart.id}:${cart.status}`;
  const isNew = key !== lastCartKey;
  lastCartKey = key;

  status.innerHTML = `<span class="badge ${cart.status}">${STATUS_LABELS[cart.status] || cart.status}</span>`;
  const editable = cart.status === "proposed" || cart.status === "blocked";
  const items = cart.items
    .map(
      (i) => `<li>
        <span class="thumb cat-${esc(i.category)}">${icon(CATEGORY_ICONS[i.category] || "package")}</span>
        <span class="item-main"><span class="nm" title="${esc(i.name)}">${esc(i.name)}</span>
          <span class="meta">${esc(i.merchant)} · ★ ${i.rating}${i.qty > 1 ? ` · Qty ${i.qty}` : ""}</span></span>
        <span class="item-price">${fmt(i.price * i.qty)}</span>
        ${editable ? `<button type="button" class="icon-btn sm item-remove" data-remove-sku="${esc(i.sku)}" title="Remove" aria-label="Remove ${esc(i.name)}">${icon("x")}</button>` : ""}</li>`,
    )
    .join("");
  const violations = cart.violations?.length
    ? `<ul class="violations">${cart.violations.map((v) => `<li>${icon("circle-x")}<span>${esc(v.message)}</span></li>`).join("")}</ul>`
    : "";
  el.innerHTML = `
    ${violations}
    ${cart.rationale ? `<p class="rationale">${icon("sparkles")}<span>${esc(cart.rationale)}</span></p>` : ""}
    <ul class="cart-items">${items}</ul>
    <div class="totals">
      <div><span>Subtotal</span><span>${fmt(cart.subtotal)}</span></div>
      <div><span>Tax</span><span>${fmt(cart.tax)}</span></div>
      <div><span>Shipping</span><span>${cart.shipping ? fmt(cart.shipping) : "Free"}</span></div>
      <div class="grand"><span>Total</span><span>${fmt(cart.total)}</span></div>
    </div>
    ${authPanel(cart)}
    <div class="cart-actions" id="cart-actions"></div>`;

  const actions = $("#cart-actions");
  if (cart.status === "proposed") {
    actions.innerHTML = `<div class="row-btns"><button class="btn btn-primary" id="ask-buy">${icon("credit-card")}Check out</button><button class="btn btn-secondary" id="reject">Cancel</button></div>`;
    $("#ask-buy").onclick = () => send("Looks good, please check out.");
    $("#reject").onclick = () => rejectCart(cart.id);
  } else if (cart.status === "checkout") {
    renderedCheckout = cart.id;
    mountCheckout(cart, actions);
  } else if (cart.status === "paid" || cart.status === "pending") {
    const order = state.orders.find((o) => o.cartId === cart.id);
    actions.innerHTML = `<div class="paid-note${cart.status === "pending" ? " pending" : ""}">${icon(cart.status === "pending" ? "hourglass" : "circle-check")}<span>${cart.status === "pending" ? "Submitted to PayPal, waiting for it to settle" : `Paid via ${esc(MODE_LABELS[order?.mode || config.paypalMode] || "PayPal")}`}<small>${esc(order?.orderId || cart.paypalOrderId)} · capture ${esc(order?.captureId || "")}</small></span></div>`;
  } else if (cart.status === "expired" || cart.status === "denied") {
    actions.innerHTML = `<p class="blocked-note">${cart.status === "expired" ? "The authorization expired before payment. Ask the agent to check out again for a fresh one." : "PayPal denied this payment; no money was taken."}</p>`;
  } else if (cart.status === "blocked") {
    actions.innerHTML = `<p class="blocked-note">This cart breaks your spending rules. The agent will adjust it, or you can change the rules below.</p>`;
  }
  refreshIcons();
  if (isNew) enter([...el.querySelectorAll(".violations li, .rationale, .cart-items li, .totals, .cart-actions")], { stagger: 0.04, y: 6 });
}

$("#cart").addEventListener("click", async (e) => {
  const sku = e.target.closest("[data-remove-sku]")?.dataset.removeSku;
  if (!sku) return;
  const res = await api(`/api/cart/items/${encodeURIComponent(sku)}`, { method: "DELETE" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return toast("bad", "Couldn't remove that", body.error || "");
  state = body.state;
  render();
});

async function rejectCart(id) {
  await api(`/api/carts/${id}/reject`, { method: "POST" });
  refresh();
}

function mountCheckout(cart, actions) {
  const sandbox = config.paypalMode === "sandbox" || config.paypalMode === "live";
  actions.innerHTML = `<div id="paypal-buttons"></div>
    <p class="secure-note">${icon("lock")}${sandbox ? (config.paypalMode === "live" ? "Secure PayPal checkout · real payment" : "Secure PayPal checkout · sandbox test payment") : "Simulated PayPal · no real money moves"}</p>
    <button class="btn btn-ghost" id="reject">Cancel order</button>`;
  $("#reject").onclick = () => rejectCart(cart.id);
  const target = $("#paypal-buttons");

  if (!sandbox) {
    target.innerHTML = `<button class="btn btn-primary btn-block" id="sim-approve">${icon("credit-card")}Approve ${fmt(cart.total)} in simulator</button>`;
    $("#sim-approve").onclick = () => capture(cart.paypalOrderId);
    return;
  }
  whenPayPalReady(() => {
    window.paypal
      .Buttons({
        style: { layout: "vertical", shape: "rect", label: "pay", height: 42, borderRadius: 10 },
        createOrder: () => cart.paypalOrderId, // order was created server-side by the agent
        onApprove: (data, actionsApi) => capture(data.orderID, actionsApi),
        onCancel: () => toast("info", "Payment not completed", "Your order is still waiting whenever you're ready."),
        onError: (err) => toast("bad", "PayPal error", String(err?.message || err)),
      })
      .render(target);
  });
}

async function capture(orderId, actionsApi) {
  const res = await api(`/api/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    renderedCheckout = null;
    const pending = body.order.status === "PENDING";
    toast(pending ? "info" : "ok", `${pending ? "Payment submitted" : "Payment captured"} · ${fmt(body.order.total)}`, `Authorization ${body.order.authorizationId} verified and used.`);
    addRow(
      "agent",
      formatText(
        pending
          ? `Payment submitted: **${fmt(body.order.total)}** via ${MODE_LABELS[body.order.mode]}. PayPal is still processing it; the ledger updates when it settles.`
          : `Payment complete: **${fmt(body.order.total)}** via ${MODE_LABELS[body.order.mode]}. Authorization ${body.order.authorizationId} matched the PayPal order exactly and is now used up.`,
      ),
    );
    state = body.state;
    render();
    return;
  }
  // Recoverable decline: reopen PayPal so the buyer can choose another funding source.
  if (body.issue === "INSTRUMENT_DECLINED" && actionsApi?.restart) return actionsApi.restart();
  if (res.status === 403) {
    renderedCheckout = null;
    toast("bad", "Capture blocked by CartPilot", (body.problems || []).map((x) => x.message).join(" ") || body.error);
    addRow("error", esc(`${body.error}`));
  } else toast("bad", "Payment not completed", body.error || "Capture failed");
  refresh();
}

let paypalReady = false;
const paypalWaiters = [];
function loadPayPalSdk() {
  const s = document.createElement("script");
  s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypalClientId)}&currency=USD&intent=capture&components=buttons`;
  // Sandbox only: show the US checkout everywhere, so testers outside the US
  // (e.g. India, where PayPal blocks domestic payments) get the same flow.
  if (config.paypalMode === "sandbox") s.src += "&buyer-country=US";
  s.onload = () => {
    paypalReady = true;
    paypalWaiters.splice(0).forEach((f) => f());
  };
  s.onerror = () => toast("bad", "PayPal unavailable", "Couldn't load the PayPal SDK.");
  document.head.append(s);
}
function whenPayPalReady(fn) {
  paypalReady ? fn() : paypalWaiters.push(fn);
}

// ------------------------------------------------------------------ spending rules
$("#policy-toggle").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  $("#policy").hidden = !open;
  if (open) enter([...$("#policy").children], { stagger: 0.03, y: 4, duration: 0.25 });
});

$("#policy").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    monthlyBudget: Number(f.monthlyBudget.value),
    perOrderLimit: Number(f.perOrderLimit.value),
    maxItemPrice: Number(f.maxItemPrice.value),
    minMerchantRating: Number(f.minMerchantRating.value),
    requireVerifiedMerchants: f.requireVerifiedMerchants.checked,
    blockedCategories: [...document.querySelectorAll("#cat-checks input:checked")].map((c) => c.value),
  };
  const res = await api("/api/policy", { method: "PUT", body: JSON.stringify(body) });
  state = await res.json();
  document.activeElement?.blur();
  render();
  toast("ok", "Spending rules saved", "The agent will follow them from its next step.");
});

// ------------------------------------------------------------------ control center
function gridTheme() {
  const dark = effectiveTheme() === "dark";
  const base = agGrid.themeQuartz.withParams({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 13,
    headerFontWeight: 600,
    accentColor: dark ? "#6366f1" : "#4f46e5",
    wrapperBorderRadius: 0,
    headerBackgroundColor: dark ? "#141416" : "#fafafa",
    backgroundColor: dark ? "#111113" : "#ffffff",
    borderColor: dark ? "#232327" : "#e4e4e7",
    rowBorder: { color: dark ? "#1d1d21" : "#f0f0f2" },
    foregroundColor: dark ? "#fafafa" : "#18181b",
  });
  return dark ? base.withPart(agGrid.colorSchemeDark) : base;
}

function chartColors() {
  const dark = effectiveTheme() === "dark";
  return {
    dark,
    mark: dark ? "#7c7ff5" : "#4f46e5", // validated against each surface (dataviz validator)
    text: dark ? "#a1a1aa" : "#71717a",
    grid: dark ? "#232327" : "#ececee",
  };
}

const controlCenter = createControlCenter({
  $,
  api,
  esc,
  fmt,
  icon,
  refreshIcons,
  toast,
  gridTheme,
  chartColors,
  MODE_LABELS,
  getState: () => state,
  getConfig: () => config,
  setState: (next) => {
    state = next;
    render();
  },
  prefill: (text) => {
    input.value = text;
    input.focus();
    autosize();
    input.scrollIntoView({ behavior: "smooth", block: "center" });
  },
});

function applyGridTheme() {
  controlCenter.applyTheme();
}

boot();

// CartPilot front end: chat stream, cart + PayPal checkout, spending rules,
// AG Grid activity tables. Motion (motion.dev) drives the animations and
// Lucide provides icons; both degrade gracefully if their CDN fails.
const $ = (sel, root = document) => root.querySelector(sel);
const CATEGORIES = ["outdoor", "electronics", "home", "grocery", "gift_cards", "books"];
const CATEGORY_ICONS = { outdoor: "tent", electronics: "cpu", home: "lamp", grocery: "coffee", gift_cards: "gift", books: "book-open" };
const TOOL_ICONS = { search_catalog: "search", get_wallet_status: "wallet", propose_cart: "shopping-cart", create_paypal_checkout: "credit-card", refund_order: "undo-2", propose_policy_change: "shield-check", show_products: "layout-grid" };
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

  $("#cat-checks").innerHTML = CATEGORIES.map(
    (c) => `<label class="toggle-chip"><input type="checkbox" value="${c}" /><span>${c.replace("_", " ")}</span></label>`,
  ).join("");
  $("#wallet-period").textContent = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });

  initGrids();
  moveTabIndicator(false);
  await refresh();
  renderHistory(state.transcript);
  if (config.paypalMode === "sandbox") loadPayPalSdk();
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
            ${p.flagged ? `<span class="p-tag bad">Suspicious listing</span>` : ""}</div>
          <div class="p-body">
            <span class="p-merchant">${esc(p.merchant)}${p.verified ? icon("badge-check") : ""}</span>
            <h4 title="${esc(p.name)}">${esc(p.name)}</h4>
            <span class="p-rating">${stars(p.rating)}<b>${p.rating}</b><span>(${p.reviews.toLocaleString("en-US")})</span></span>
            ${p.note ? `<p class="p-note">${esc(p.note)}</p>` : ""}
            <div class="p-foot">
              <span class="p-price">${fmt(p.price)}</span>
              <label class="p-compare" title="Compare"><input type="checkbox" value="${esc(p.sku)}" /><span>Compare</span></label>
            </div>
            <button type="button" class="btn btn-primary btn-sm btn-block p-add"${p.flagged ? " disabled" : ""}>${icon("plus")}Add to cart</button>
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
  ordersGrid?.setGridOption("rowData", [...state.orders].reverse());
  auditGrid?.setGridOption("rowData", [...state.audit].reverse());
  $("#audit-count").textContent = state.audit.length;
  renderInsights();
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
  const warn = /suspicious|Blocked/.test(summary || "");
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
const STATUS_LABELS = { proposed: "Review", checkout: "Awaiting payment", capturing: "Processing", paid: "Paid", blocked: "Blocked", rejected: "Cancelled" };
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
    <div class="cart-actions" id="cart-actions"></div>`;

  const actions = $("#cart-actions");
  if (cart.status === "proposed") {
    actions.innerHTML = `<div class="row-btns"><button class="btn btn-primary" id="ask-buy">${icon("credit-card")}Check out</button><button class="btn btn-secondary" id="reject">Cancel</button></div>`;
    $("#ask-buy").onclick = () => send("Looks good, please check out.");
    $("#reject").onclick = () => rejectCart(cart.id);
  } else if (cart.status === "checkout") {
    renderedCheckout = cart.id;
    mountCheckout(cart, actions);
  } else if (cart.status === "paid") {
    const order = state.orders.find((o) => o.cartId === cart.id);
    actions.innerHTML = `<div class="paid-note">${icon("circle-check")}<span>Paid with PayPal<small>${esc(order?.orderId || cart.paypalOrderId)}</small></span></div>`;
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
  const sandbox = config.paypalMode === "sandbox";
  actions.innerHTML = `<div id="paypal-buttons"></div>
    <p class="secure-note">${icon("lock")}${sandbox ? "Secure PayPal checkout · sandbox test payment" : "Demo mode · no real payment is made"}</p>
    <button class="btn btn-ghost" id="reject">Cancel order</button>`;
  $("#reject").onclick = () => rejectCart(cart.id);
  const target = $("#paypal-buttons");

  if (!sandbox) {
    target.innerHTML = `<button class="btn btn-primary btn-block" id="sim-approve">${icon("credit-card")}Approve ${fmt(cart.total)}</button>`;
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
    toast("ok", `Payment complete · ${fmt(body.order.total)}`, "Your order is in Purchases below.");
    addRow("agent", formatText(`Payment complete: **${fmt(body.order.total)}** paid with PayPal. You'll find the order in Purchases below.`));
    state = body.state;
    render();
    return;
  }
  // Recoverable decline: reopen PayPal so the buyer can choose another funding source.
  if (body.issue === "INSTRUMENT_DECLINED" && actionsApi?.restart) return actionsApi.restart();
  toast("bad", "Payment failed", body.error || "Capture failed");
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

// ------------------------------------------------------------------ activity (AG Grid)
let ordersGrid, auditGrid;

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
function applyGridTheme() {
  renderInsights(); // charts follow the theme too
  if (!ordersGrid) return;
  ordersGrid.setGridOption("theme", gridTheme());
  auditGrid.setGridOption("theme", gridTheme());
}

function pill(value) {
  return `<span class="cell-pill ${esc(value)}">${esc(String(value).replace(/_/g, " ").toLowerCase())}</span>`;
}

function initGrids() {
  if (!window.agGrid) return;
  const common = { theme: gridTheme(), animateRows: true, rowHeight: 44, headerHeight: 40, defaultColDef: { sortable: true, resizable: true, filter: true } };

  ordersGrid = agGrid.createGrid($("#orders-grid"), {
    ...common,
    rowData: [],
    overlayNoRowsTemplate: '<span class="muted">No purchases yet. Paid orders appear here.</span>',
    columnDefs: [
      { field: "capturedAt", headerName: "Date", width: 180, valueFormatter: (p) => new Date(p.value).toLocaleString(), sort: "desc" },
      { field: "orderId", headerName: "PayPal order", width: 200, cellClass: "mono" },
      { headerName: "Items", flex: 2, minWidth: 240, valueGetter: (p) => p.data.items.map((i) => (i.refunded ? `↩ ${i.name}` : i.name)).join(", "), tooltipValueGetter: (p) => p.value },
      { field: "total", headerName: "Total", width: 120, type: "rightAligned", valueFormatter: (p) => fmt(p.value) },
      { field: "refunded", headerName: "Refunded", width: 120, type: "rightAligned", valueFormatter: (p) => (p.value ? fmt(p.value) : "—") },
      { field: "status", width: 170, cellRenderer: (p) => pill(p.value) },
      {
        headerName: "",
        width: 110,
        sortable: false,
        filter: false,
        cellRenderer: (p) => {
          if (p.data.status === "REFUNDED") return "";
          const b = document.createElement("button");
          b.className = "grid-btn";
          b.textContent = "Return";
          b.onclick = () => {
            input.value = `I want to return something from order ${p.data.orderId}: `;
            input.focus();
            autosize();
          };
          return b;
        },
      },
    ],
  });

  auditGrid = agGrid.createGrid($("#audit-grid"), {
    ...common,
    rowData: [],
    tooltipShowDelay: 300,
    columnDefs: [
      { field: "id", headerName: "#", width: 70, sort: "desc" },
      { field: "time", width: 120, valueFormatter: (p) => new Date(p.value).toLocaleTimeString() },
      { field: "actor", width: 120, cellRenderer: (p) => `<span class="actor ${esc(p.value)}">${esc(p.value)}</span>` },
      { field: "action", width: 170, valueFormatter: (p) => String(p.value).replace(/_/g, " ") },
      { field: "detail", flex: 1, minWidth: 260, tooltipField: "detail" },
      { field: "outcome", width: 120, cellRenderer: (p) => pill(p.value) },
    ],
  });
}

// ------------------------------------------------------------------ insights (AG Charts)
const charts = {};
const chartView = { category: "chart", daily: "chart" };
const CAT_LABELS = { outdoor: "Outdoor", electronics: "Electronics", home: "Home", grocery: "Grocery", gift_cards: "Gift cards", books: "Books" };
const sameMonth = (iso) => {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
};

function insightsData() {
  const byCat = {};
  for (const o of state.orders.filter((o) => sameMonth(o.capturedAt)))
    for (const i of o.items) if (!i.refunded) byCat[i.category] = (byCat[i.category] || 0) + i.price * i.qty;
  const category = Object.entries(byCat)
    .map(([c, amount]) => ({ label: CAT_LABELS[c] || c, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);

  const days = [];
  for (let n = 13; n >= 0; n--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - n);
    days.push({ key: d.toDateString(), label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), amount: 0 });
  }
  for (const o of state.orders) {
    const day = days.find((x) => x.key === new Date(o.capturedAt).toDateString());
    if (day) day.amount = Math.round((day.amount + o.total - o.refunded) * 100) / 100;
  }
  return { category, daily: days };
}

function renderStats() {
  const monthOrders = state.orders.filter((o) => sameMonth(o.capturedAt));
  const refunded = state.orders.reduce((s, o) => s + o.refunded, 0);
  const blocks = state.audit.filter((a) => a.outcome === "blocked").length;
  const scams = new Set(state.audit.filter((a) => a.action === "injection_flag").map((a) => a.detail)).size;
  const tiles = [
    ["Spent this month", fmt(state.spent), `of ${fmt(state.policy.monthlyBudget)} budget`, "wallet"],
    ["Orders", String(monthOrders.length), "paid this month", "receipt"],
    ["Refunded", fmt(refunded), `${state.orders.filter((o) => o.refunded).length} order(s)`, "undo-2"],
    ["Blocked by your rules", String(blocks), "carts, checkouts or payments", "shield-ban"],
    ["Scam listings caught", String(scams), "flagged before buying", "scan-search"],
  ];
  $("#stats").innerHTML = tiles
    .map(([label, value, sub, ic]) => `<div class="stat"><span class="stat-label">${icon(ic)}${label}</span><span class="stat-value">${value}</span><span class="stat-sub">${sub}</span></div>`)
    .join("");
  refreshIcons();
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

// Approximate plot length along the category axis (container minus axis band).
const PLOT_EXTENT = { category: 190, daily: 560 };

// A lone band ignores inner padding and fills the plot, so the category chart
// always has at least this many rows; the extra rows are blank.
const MIN_CATEGORY_ROWS = 5;

function chartOptions(kind, rows) {
  const data =
    kind === "category" && rows.length < MIN_CATEGORY_ROWS
      ? [...rows, ...Array.from({ length: MIN_CATEGORY_ROWS - rows.length }, (_, i) => ({ label: " ".repeat(i + 1), amount: 0 }))]
      : rows;
  const c = chartColors();
  const horizontal = kind === "category";
  const font = "Inter, system-ui, sans-serif";
  return {
    container: $(`#chart-${kind}`),
    data,
    theme: { baseTheme: c.dark ? "ag-default-dark" : "ag-default", overrides: { common: { background: { fill: "transparent" } } } },
    padding: { top: 8, right: horizontal ? 56 : 12, bottom: 4, left: 4 },
    series: [
      {
        type: "bar",
        direction: horizontal ? "horizontal" : "vertical",
        xKey: "label",
        yKey: "amount",
        yName: horizontal ? "Spent" : "Net spend",
        fill: c.mark,
        strokeWidth: 0,
        cornerRadius: 4,
        label: horizontal
          ? { enabled: true, placement: "outside-end", color: c.text, fontFamily: font, fontSize: 12, padding: 8, formatter: ({ datum, value }) => (datum.label.trim() ? fmt(value) : "") }
          : { enabled: false },
        tooltip: { renderer: ({ datum }) => ({ heading: datum.label, title: horizontal ? "Spent" : "Net spend", data: [{ label: "Amount", value: fmt(datum.amount) }] }) },
      },
    ],
    axes: [
      {
        type: "category",
        position: horizontal ? "left" : "bottom",
        // Keep bars <= 24px thick whatever the number of categories (band = plot / n).
        paddingInner: Math.min(0.85, Math.max(0.3, 1 - 24 / (PLOT_EXTENT[kind] / Math.max(1, data.length)))),
        paddingOuter: 0.2,
        line: { width: 0 },
        tick: { width: 0 },
        label: { color: c.text, fontFamily: font, fontSize: 12 },
      },
      {
        type: "number",
        position: horizontal ? "bottom" : "left",
        nice: true,
        line: { width: 0 },
        tick: { width: 0 },
        gridLine: { style: [{ stroke: c.grid, lineDash: [] }] },
        label: { color: c.text, fontFamily: font, fontSize: 11, formatter: ({ value }) => (value >= 1000 ? `$${(value / 1000).toFixed(1)}K` : `$${value}`) },
      },
    ],
    legend: { enabled: false },
  };
}

function renderTable(kind, rows, header) {
  $(`#table-${kind}`).innerHTML = `<table><thead><tr><th>${header}</th><th>Amount</th></tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${fmt(r.amount)}</td></tr>`).join("") : `<tr><td colspan="2" class="muted">No purchases yet</td></tr>`
  }</tbody></table>`;
}

function renderInsights() {
  if (!state || $("#insights").hidden) return;
  renderStats();
  const { category, daily } = insightsData();
  const datasets = { category, daily };
  renderTable("category", category, "Category");
  renderTable("daily", daily.filter((d) => d.amount), "Day");
  for (const kind of ["category", "daily"]) {
    const el = $(`#chart-${kind}`);
    const empty = kind === "category" ? !category.length : !daily.some((d) => d.amount);
    el.classList.toggle("is-empty", empty);
    el.dataset.empty = "No purchases yet. Paid orders show up here.";
    if (empty || !window.agCharts) continue;
    const options = chartOptions(kind, datasets[kind]);
    if (charts[kind]) charts[kind].update(options);
    else charts[kind] = agCharts.AgCharts.create(options);
  }
}

document.querySelectorAll(".view-toggle").forEach((btn) =>
  btn.addEventListener("click", () => {
    const kind = btn.dataset.chart;
    chartView[kind] = chartView[kind] === "chart" ? "table" : "chart";
    const table = chartView[kind] === "table";
    $(`#chart-${kind}`).hidden = table;
    $(`#table-${kind}`).hidden = !table;
    btn.innerHTML = `${icon(table ? "chart-column" : "table-2")}${table ? "Chart" : "Table"}`;
    refreshIcons();
    if (!table) renderInsights();
  }),
);

function moveTabIndicator(animated = true) {
  const active = $(".tab.active");
  const ind = $("#tab-indicator");
  if (!active || !ind) return;
  const target = { left: active.offsetLeft + "px", width: active.offsetWidth + "px" };
  if (animated && canAnimate) Motion.animate(ind, target, { type: "spring", stiffness: 500, damping: 40 });
  else Object.assign(ind.style, target);
}
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab);
    });
    $("#orders-grid").hidden = tab.dataset.tab !== "orders";
    $("#audit-grid").hidden = tab.dataset.tab !== "audit";
    $("#insights").hidden = tab.dataset.tab !== "insights";
    moveTabIndicator();
    renderInsights();
  }),
);
addEventListener("resize", () => moveTabIndicator(false));
document.fonts?.ready.then(() => moveTabIndicator(false));

boot();

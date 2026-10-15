// CartPilot front end: chat stream, cart + PayPal checkout, spending rules,
// AG Grid activity tables. Motion (motion.dev) drives the animations and
// Lucide provides icons; both degrade gracefully if their CDN fails.
const $ = (sel, root = document) => root.querySelector(sel);
const CATEGORIES = ["outdoor", "electronics", "home", "grocery", "gift_cards", "books"];
const CATEGORY_ICONS = { outdoor: "tent", electronics: "cpu", home: "lamp", grocery: "coffee", gift_cards: "gift", books: "book-open" };
const TOOL_ICONS = { search_catalog: "search", get_wallet_status: "wallet", propose_cart: "shopping-cart", create_paypal_checkout: "credit-card", refund_order: "undo-2" };
const LOGO = '<svg viewBox="0 0 32 32"><path d="M8 10h3l2.5 10h9l2-7H12" /><circle cx="14" cy="24" r="1.6" /><circle cx="21" cy="24" r="1.6" /></svg>';
const fmt = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name) => `<i data-lucide="${name}"></i>`;

// ------------------------------------------------------------------ motion + icons
const Motion = window.Motion;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const canAnimate = !!Motion && !reduceMotion;

function enter(els, { y = 8, delay = 0, stagger = 0, duration = 0.32 } = {}) {
  if (!canAnimate || !els || (els.length === 0)) return;
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
  if (config.paypalMode === "sandbox") loadPayPalSdk();
}

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

  renderCart();
  ordersGrid?.setGridOption("rowData", [...state.orders].reverse());
  auditGrid?.setGridOption("rowData", [...state.audit].reverse());
  $("#audit-count").textContent = state.audit.length;
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
    finish() {
      const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const summary = $("summary", block);
      summary.innerHTML = `${icon(this.failed ? "circle-alert" : "circle-check")}<span>${this.steps} step${this.steps === 1 ? "" : "s"} · ${secs}s</span>${icon("chevron-down")}`;
      $("[data-lucide]", summary)?.setAttribute("style", `color: var(--${this.failed ? "warn" : "ok"})`);
      refreshIcons();
      block.open = false;
    },
  };
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
      case "tool_call": {
        activity ||= createActivity();
        activity.steps++;
        const li = document.createElement("li");
        li.className = "step pending";
        const label = TOOL_LABELS[ev.name]?.(ev.input || {}) || ev.name;
        li.innerHTML = `<span class="ic">${icon(TOOL_ICONS[ev.name] || "sparkles")}</span><span class="lbl">${esc(label)}</span><span class="res"><span class="spinner"></span></span>`;
        activity.list.append(li);
        stepEls.set(ev.id, li);
        refreshIcons();
        enter(li, { y: 4, duration: 0.2 });
        break;
      }
      case "tool_result": {
        const li = stepEls.get(ev.id);
        if (li) {
          const warn = /suspicious|Blocked/.test(ev.summary || "");
          li.className = "step " + (!ev.ok ? "bad" : warn ? "warn" : "ok");
          if (!ev.ok && activity) activity.failed++;
          $(".res", li).innerHTML = `<span>${esc(ev.summary)}</span>${icon(!ev.ok ? "circle-x" : warn ? "triangle-alert" : "check")}`;
          refreshIcons();
        }
        if (ev.name !== "search_catalog") refresh();
        break;
      }
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

function renderCart() {
  const cart = latestCart();
  const el = $("#cart");
  const status = $("#cart-status");
  if (!cart) {
    status.innerHTML = "";
    return;
  }
  // Don't re-render while PayPal buttons for this cart are mounted.
  if (cart.status === "checkout" && renderedCheckout === cart.id) return;
  renderedCheckout = null;

  const key = `${cart.id}:${cart.status}`;
  const isNew = key !== lastCartKey;
  lastCartKey = key;

  status.innerHTML = `<span class="badge ${cart.status}">${STATUS_LABELS[cart.status] || cart.status}</span>`;
  const items = cart.items
    .map(
      (i) => `<li>
        <span class="thumb">${icon(CATEGORY_ICONS[i.category] || "package")}</span>
        <span class="item-main"><span class="nm" title="${esc(i.name)}">${esc(i.name)}</span>
          <span class="meta">${esc(i.merchant)} · ★ ${i.rating}${i.qty > 1 ? ` · Qty ${i.qty}` : ""}</span></span>
        <span class="item-price">${fmt(i.price * i.qty)}</span></li>`,
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
    moveTabIndicator();
  }),
);
addEventListener("resize", () => moveTabIndicator(false));
document.fonts?.ready.then(() => moveTabIndicator(false));

boot();

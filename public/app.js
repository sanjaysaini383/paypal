// CartPilot front end: chat stream, cart + PayPal checkout, policy form, AG Grid ledger.
const $ = (sel) => document.querySelector(sel);
const CATEGORIES = ["outdoor", "electronics", "home", "grocery", "gift_cards", "books"];
const fmt = (n) => "$" + Number(n || 0).toFixed(2);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

// ------------------------------------------------------------------ boot
async function boot() {
  config = await (await api("/api/config")).json();
  const ai = $("#ai-badge");
  ai.textContent = config.aiMode !== "offline" ? `AI: ${prettyModel(config.model)}` : "AI: offline demo";
  ai.className = "badge " + (config.aiMode !== "offline" ? "live" : "sim");
  const pp = $("#pp-badge");
  pp.textContent = config.paypalMode === "sandbox" ? "PayPal: Sandbox" : "PayPal: Simulated";
  pp.className = "badge " + (config.paypalMode === "sandbox" ? "live" : "sim");
  if (config.repoUrl) $("#repo-link").href = config.repoUrl;

  $("#cat-checks").innerHTML = CATEGORIES.map(
    (c) => `<label><input type="checkbox" value="${c}" /> ${c.replace("_", " ")}</label>`,
  ).join("");

  initGrids();
  await refresh();
  if (config.paypalMode === "sandbox") loadPayPalSdk();
}

function prettyModel(id) {
  const m = /^claude-(\w+)-(\d+)(?:-(\d+))?$/.exec(id || "");
  if (m) return `Claude ${m[1][0].toUpperCase() + m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}`;
  // e.g. "gemini-3.8-flash" -> "Gemini 3.8 Flash", "openai/gpt-oss-120b" -> "Gpt Oss 120b"
  const name = String(id || "").split("/").pop().replace(/:free$/, "");
  return name.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function refresh() {
  state = await (await api("/api/state")).json();
  render();
}

function render() {
  if (!state) return;
  const p = state.policy;
  $("#spent").textContent = fmt(state.spent);
  $("#budget").textContent = fmt(p.monthlyBudget);
  const pct = p.monthlyBudget ? Math.min(100, (state.spent / p.monthlyBudget) * 100) : 100;
  const fill = $("#meter-fill");
  fill.style.width = pct + "%";
  fill.className = "meter-fill" + (pct >= 100 ? " full" : pct >= 75 ? " high" : "");

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

function addMsg(kind, html) {
  $("#welcome")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.innerHTML = html;
  messagesEl.append(el);
  scrollDown();
  return el;
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
  search_catalog: (i) => `Searching "${i.query}"${i.category ? ` in ${i.category}` : ""}${i.max_price ? ` ≤ $${i.max_price}` : ""}`,
  get_wallet_status: () => "Checking budget and policy",
  propose_cart: (i) => `Building cart (${(i.items || []).length} items)`,
  create_paypal_checkout: () => "Creating PayPal order",
  refund_order: (i) => `Refunding ${i.skus?.length ? i.skus.join(", ") : "order"} on ${i.order_id}`,
};

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  $("#send-btn").disabled = true;
  addMsg("user", esc(text));
  input.value = "";
  autosize();

  let steps = null;
  const stepEls = new Map();
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span>Working</span>';
  messagesEl.append(typing);
  const keepTypingLast = () => {
    messagesEl.append(typing);
    scrollDown();
  };

  const handle = (ev) => {
    switch (ev.type) {
      case "thinking": {
        steps = null;
        const d = document.createElement("details");
        d.className = "reasoning";
        d.innerHTML = `<summary>Reasoning</summary><div>${esc(ev.text)}</div>`;
        messagesEl.append(d);
        break;
      }
      case "text":
        steps = null;
        addMsg("agent", formatText(ev.text));
        break;
      case "tool_call": {
        if (!steps) {
          steps = document.createElement("div");
          steps.className = "steps";
          messagesEl.append(steps);
        }
        const el = document.createElement("div");
        el.className = "step pending";
        const label = TOOL_LABELS[ev.name]?.(ev.input || {}) || ev.name;
        el.innerHTML = `<span class="name">${esc(ev.name)}</span><span class="sum">${esc(label)}</span>`;
        steps.append(el);
        stepEls.set(ev.id, el);
        break;
      }
      case "tool_result": {
        const el = stepEls.get(ev.id);
        if (el) {
          el.className = "step " + (ev.ok ? "ok" : "bad");
          el.querySelector(".sum").textContent = ev.summary;
        }
        if (ev.name !== "search_catalog") refresh();
        break;
      }
      case "cart":
      case "checkout":
      case "ledger":
        refresh();
        break;
      case "error":
        addMsg("error", esc(ev.text));
        break;
    }
    keepTypingLast();
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
    addMsg("error", esc(err.message));
  } finally {
    typing.remove();
    busy = false;
    $("#send-btn").disabled = false;
    input.focus();
    refresh();
  }
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(140, input.scrollHeight) + "px";
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
  const chip = e.target.closest(".chip");
  if (chip) send(chip.dataset.prompt);
});
$("#reset-btn").addEventListener("click", async () => {
  if (busy) return;
  await api("/api/reset", { method: "POST" });
  location.reload();
});

// ------------------------------------------------------------------ cart + PayPal
let renderedCheckout = null;

function latestCart() {
  const carts = state?.carts || [];
  return carts[carts.length - 1];
}

function renderCart() {
  const cart = latestCart();
  const el = $("#cart");
  const status = $("#cart-status");
  if (!cart) {
    status.textContent = "";
    return;
  }
  // Don't re-render while PayPal buttons for this cart are mounted.
  if (cart.status === "checkout" && renderedCheckout === cart.id) return;
  renderedCheckout = null;

  status.innerHTML = `<span class="pill ${cart.status}">${cart.status}</span>`;
  el.className = "cart";
  const items = cart.items
    .map(
      (i) => `<li><span class="nm">${esc(i.name)}${i.qty > 1 ? ` × ${i.qty}` : ""}</span>
        <span class="px">${fmt(i.price * i.qty)}</span>
        <span class="meta">${esc(i.merchant)} · ★ ${i.rating}</span></li>`,
    )
    .join("");
  const violations = cart.violations?.length
    ? `<ul class="violations">${cart.violations.map((v) => `<li>⛔ ${esc(v.message)}</li>`).join("")}</ul>`
    : "";
  el.innerHTML = `
    ${violations}
    ${cart.rationale ? `<p class="rationale">${esc(cart.rationale)}</p>` : ""}
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
    actions.innerHTML = `<div class="row"><button class="primary" id="ask-buy">Ask agent to check out</button><button class="ghost" id="reject">Reject</button></div>`;
    $("#ask-buy").onclick = () => send("Looks good, please check out.");
    $("#reject").onclick = () => rejectCart(cart.id);
  } else if (cart.status === "checkout") {
    renderedCheckout = cart.id;
    mountCheckout(cart, actions);
  } else if (cart.status === "paid") {
    const order = state.orders.find((o) => o.cartId === cart.id);
    actions.innerHTML = `<div class="paid-note">✓ Paid with PayPal · order ${esc(order?.orderId || cart.paypalOrderId)}</div>`;
  } else if (cart.status === "blocked") {
    actions.innerHTML = `<p class="sim-note">Blocked by your spending policy. The agent will revise it, or you can adjust the policy below.</p>`;
  }
}

async function rejectCart(id) {
  await api(`/api/carts/${id}/reject`, { method: "POST" });
  refresh();
}

function mountCheckout(cart, actions) {
  actions.innerHTML = `<div id="paypal-buttons"></div><div class="row"><button class="ghost small" id="reject">Cancel</button></div>`;
  $("#reject").onclick = () => rejectCart(cart.id);
  const target = $("#paypal-buttons");

  if (config.paypalMode !== "sandbox") {
    target.innerHTML = `<button class="primary" id="sim-approve" style="width:100%">Approve ${fmt(cart.total)} (simulated PayPal)</button>
      <p class="sim-note">Simulation mode: add PayPal sandbox credentials to use real PayPal checkout.</p>`;
    $("#sim-approve").onclick = () => capture(cart.paypalOrderId);
    return;
  }
  whenPayPalReady(() => {
    window.paypal
      .Buttons({
        style: { layout: "vertical", shape: "rect", label: "pay", height: 42 },
        createOrder: () => cart.paypalOrderId, // order was created server-side by the agent
        onApprove: (data, actionsApi) => capture(data.orderID, actionsApi),
        onCancel: () => addMsg("agent", formatText("Payment window closed. The order is still waiting whenever you're ready.")),
        onError: (err) => addMsg("error", esc("PayPal error: " + (err?.message || err))),
      })
      .render(target);
  });
}

async function capture(orderId, actionsApi) {
  const res = await api(`/api/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    renderedCheckout = null;
    addMsg("agent", formatText(`Payment complete: ${fmt(body.order.total)} captured via PayPal (order ${body.order.orderId}). It's in your purchases below.`));
    state = body.state;
    render();
    return;
  }
  // Recoverable decline: reopen PayPal so the buyer can choose another funding source.
  if (body.issue === "INSTRUMENT_DECLINED" && actionsApi?.restart) return actionsApi.restart();
  addMsg("error", esc(body.error || "Capture failed"));
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
  s.onerror = () => addMsg("error", "Couldn't load the PayPal SDK. Check your client ID.");
  document.head.append(s);
}
function whenPayPalReady(fn) {
  paypalReady ? fn() : paypalWaiters.push(fn);
}

// ------------------------------------------------------------------ policy
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
  const btn = e.submitter;
  if (btn) {
    btn.textContent = "Saved ✓";
    setTimeout(() => (btn.textContent = "Save policy"), 1400);
  }
});

// ------------------------------------------------------------------ AG Grid ledger
let ordersGrid, auditGrid;

function gridTheme() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const base = agGrid.themeQuartz.withParams({
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 13,
    headerFontWeight: 600,
    accentColor: dark ? "#5b8cff" : "#1f5eff",
    wrapperBorderRadius: 0,
  });
  return dark ? base.withPart(agGrid.colorSchemeDarkBlue) : base;
}

function pill(value) {
  return `<span class="cell-pill ${esc(value)}">${esc(String(value).replace(/_/g, " "))}</span>`;
}

function initGrids() {
  if (!window.agGrid) return;
  const common = { theme: gridTheme(), animateRows: true, defaultColDef: { sortable: true, resizable: true, filter: true } };

  ordersGrid = agGrid.createGrid($("#orders-grid"), {
    ...common,
    rowData: [],
    overlayNoRowsTemplate: '<span class="muted">No purchases yet. Ask the agent to buy something.</span>',
    columnDefs: [
      { field: "capturedAt", headerName: "Date", width: 170, valueFormatter: (p) => new Date(p.value).toLocaleString(), sort: "desc" },
      { field: "orderId", headerName: "PayPal order", width: 190, cellStyle: { fontFamily: "JetBrains Mono, monospace", fontSize: "12px" } },
      { headerName: "Items", flex: 2, minWidth: 220, valueGetter: (p) => p.data.items.map((i) => (i.refunded ? `↩ ${i.name}` : i.name)).join(", "), tooltipValueGetter: (p) => p.value },
      { field: "total", headerName: "Total", width: 110, type: "rightAligned", valueFormatter: (p) => fmt(p.value) },
      { field: "refunded", headerName: "Refunded", width: 110, type: "rightAligned", valueFormatter: (p) => (p.value ? fmt(p.value) : "—") },
      { field: "status", width: 170, cellRenderer: (p) => pill(p.value) },
      { field: "mode", headerName: "PayPal", width: 110 },
      {
        headerName: "",
        width: 110,
        sortable: false,
        filter: false,
        cellRenderer: (p) => {
          if (p.data.status === "REFUNDED") return "";
          const b = document.createElement("button");
          b.className = "grid-btn";
          b.textContent = "Return…";
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
      { field: "action", width: 170 },
      { field: "detail", flex: 1, minWidth: 260, tooltipField: "detail" },
      { field: "outcome", width: 120, cellRenderer: (p) => pill(p.value) },
    ],
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    ordersGrid.setGridOption("theme", gridTheme());
    auditGrid.setGridOption("theme", gridTheme());
  });
}

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab);
    });
    $("#orders-grid").hidden = tab.dataset.tab !== "orders";
    $("#audit-grid").hidden = tab.dataset.tab !== "audit";
  }),
);

boot();

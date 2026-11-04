// Control center: the financial overview (AG Charts), the transaction ledger,
// the trust & risk register and the audit & security log (AG Grid). Every
// number comes from the server's /api/analytics, /api/risk and /api/state
// endpoints, which compute it from stored records; nothing here is sample data.
export function createControlCenter(ctx) {
  const { $, api, esc, fmt, icon, refreshIcons, toast, gridTheme, chartColors, getState, setState, MODE_LABELS, prefill } = ctx;
  const filters = { from: "", to: "", merchant: "", category: "", status: "" };
  const charts = {};
  const chartView = { time: "chart", category: "chart", merchant: "chart" };
  let active = "overview";
  let data = null;
  let risk = null;
  let ledgerGrid, riskGrid, auditGrid;
  let ledgerView = "orders";
  let riskLevel = "all";
  let timer = 0;

  const CAT = { outdoor: "Outdoor", electronics: "Electronics", home: "Home", grocery: "Grocery", gift_cards: "Gift cards", books: "Books" };
  const pill = (value, extra = "") => `<span class="cell-pill ${esc(value)} ${extra}">${esc(String(value).replace(/_/g, " ").toLowerCase())}</span>`;
  const dateTime = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const csvCell = ({ value }) => (value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join("; ") : value ?? "");
  const query = () => new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();

  // ---------------------------------------------------------------- data
  async function load() {
    const [a, r] = await Promise.all([api(`/api/analytics?${query()}`).then((x) => x.json()), active === "risk" || !risk ? api("/api/risk").then((x) => x.json()) : risk]);
    data = a;
    risk = r;
    paint();
  }
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  };

  function paint() {
    const st = getState();
    if (!st || !data) return;
    $("#ledger-count").textContent = data.ledger.length;
    $("#risk-count").textContent = st.riskEvents?.length || 0;
    $("#audit-count").textContent = st.audit.length;
    renderFilters();
    if (active === "overview") renderOverview();
    if (active === "ledger") renderLedger();
    if (active === "risk") renderRisk();
    if (active === "audit") renderAudit();
  }

  // ---------------------------------------------------------------- filters
  function renderFilters() {
    const f = data.facets;
    const options = (list, current, label, fmtFn = (x) => x) => `<option value="">${label}</option>${[...new Set([...list, ...(current ? [current] : [])])].map((v) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(fmtFn(v))}</option>`).join("")}`;
    const el = $("#cc-filters");
    if (el.contains(document.activeElement)) return;
    el.querySelector("[name=merchant]").innerHTML = options(f.merchants, filters.merchant, "All merchants");
    el.querySelector("[name=category]").innerHTML = options(f.categories, filters.category, "All categories", (c) => CAT[c] || c);
    el.querySelector("[name=status]").innerHTML = options(["COMPLETED", "PENDING", "PARTIALLY_REFUNDED", "REFUNDED", "DENIED", "REVERSED"].filter((s) => f.statuses.includes(s) || s === filters.status), filters.status, "All statuses", (s) => s.replace(/_/g, " ").toLowerCase());
    el.querySelector("[name=from]").value = filters.from;
    el.querySelector("[name=to]").value = filters.to;
    $("#cc-reset").disabled = !Object.values(filters).some(Boolean);
  }

  // ---------------------------------------------------------------- overview
  function renderOverview() {
    const k = data.kpis;
    const st = getState();
    const tiles = [
      ["Net spend", fmt(k.netSpend), `${k.orders} order${k.orders === 1 ? "" : "s"} · ${fmt(k.grossSpend)} gross`, "wallet"],
      ["Left this month", fmt(Math.max(0, k.remainingThisMonth)), `of ${fmt(k.monthlyBudget)} budget`, "piggy-bank", k.remainingThisMonth < k.monthlyBudget * 0.1 ? "warn" : ""],
      ["Average order", fmt(k.averageOrderValue), "gross, per captured order", "receipt"],
      ["Refunded", fmt(k.refunded), k.refundPending ? `${fmt(k.refundPending)} pending at PayPal` : "completed via PayPal", "undo-2"],
      ["Pending", String(k.pending.count), `${k.pending.awaitingApproval.count} awaiting approval · ${k.pending.pendingCaptures.count} capture(s)`, "hourglass", k.pending.count ? "warn" : ""],
      ["Blocked by guardrails", String(k.blocked), "carts, checkouts, captures", "shield-ban"],
      ["Suspicious listings", String(k.suspiciousListings), `${k.highRiskListings} high risk, excluded`, "scan-search"],
      ["Integrity alerts", String(k.integrityAlerts), k.integrityAlerts ? "PayPal disagreed with an authorization" : "every capture matched its authorization", k.integrityAlerts ? "shield-x" : "shield-check", k.integrityAlerts ? "bad" : "ok"],
    ];
    $("#cc-stats").innerHTML = tiles
      .map(([label, value, sub, ic, tone = ""]) => `<div class="stat ${tone}"><span class="stat-label">${icon(ic)}${label}</span><span class="stat-value">${value}</span><span class="stat-sub">${sub}</span></div>`)
      .join("");
    $("#cc-status").innerHTML = data.statusBreakdown.length
      ? data.statusBreakdown.map((x) => `<span class="chip">${pill(x.status)}<b>${x.count}</b></span>`).join("")
      : `<span class="muted small">No orders ${Object.values(filters).some(Boolean) ? "match these filters" : "yet"}.</span>`;
    const short = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const sets = {
      time: { rows: data.overTime.map((d) => ({ label: short(d.date), amount: d.net })), name: "Net spend", header: "Day", empty: !data.overTime.some((d) => d.gross || d.refunds), tableRows: data.overTime.filter((d) => d.gross || d.refunds).map((d) => ({ label: short(d.date), amount: d.net })) },
      category: { rows: data.byCategory.map((c) => ({ label: CAT[c.category] || c.category, amount: c.net })), name: "Net item spend", header: "Category", horizontal: true },
      merchant: { rows: data.byMerchant.map((m) => ({ label: m.merchant, amount: m.net })), name: "Net item spend", header: "Merchant", horizontal: true },
    };
    for (const [kind, set] of Object.entries(sets)) {
      const empty = set.empty ?? !set.rows.some((r) => r.amount);
      const el = $(`#chart-${kind}`);
      el.classList.toggle("is-empty", empty);
      el.dataset.empty = Object.values(filters).some(Boolean) ? "No transactions match these filters." : "No purchases yet. Captured orders show up here.";
      $(`#table-${kind}`).innerHTML = `<table><thead><tr><th>${set.header}</th><th>${set.name}</th></tr></thead><tbody>${
        (set.tableRows || set.rows).length ? (set.tableRows || set.rows).map((r) => `<tr><td>${esc(r.label)}</td><td>${fmt(r.amount)}</td></tr>`).join("") : `<tr><td colspan="2" class="muted">No data</td></tr>`
      }</tbody></table>`;
      if (empty || !window.agCharts || chartView[kind] !== "chart") continue;
      const options = chartOptions(kind, set);
      if (charts[kind]) charts[kind].update(options);
      else charts[kind] = agCharts.AgCharts.create(options);
    }
    refreshIcons();
  }

  // Thin bars, rounded data ends, recessive axes, hover tooltips, table view.
  const PLOT = { time: 640, category: 200, merchant: 200 };
  function chartOptions(kind, set) {
    const c = chartColors();
    const font = "Inter, system-ui, sans-serif";
    const horizontal = !!set.horizontal;
    // A lone band would fill the plot; pad short horizontal lists with blank rows.
    const rows = horizontal && set.rows.length < 4 ? [...set.rows, ...Array.from({ length: 4 - set.rows.length }, (_, i) => ({ label: " ".repeat(i + 1), amount: 0 }))] : set.rows;
    return {
      container: $(`#chart-${kind}`),
      data: rows,
      theme: { baseTheme: c.dark ? "ag-default-dark" : "ag-default", overrides: { common: { background: { fill: "transparent" } } } },
      padding: { top: 8, right: horizontal ? 64 : 12, bottom: 4, left: 4 },
      series: [
        {
          type: "bar",
          direction: horizontal ? "horizontal" : "vertical",
          xKey: "label",
          yKey: "amount",
          yName: set.name,
          fill: c.mark,
          strokeWidth: 0,
          cornerRadius: 4,
          label: horizontal ? { enabled: true, placement: "outside-end", color: c.text, fontFamily: font, fontSize: 12, padding: 8, formatter: ({ datum, value }) => (datum.label.trim() ? fmt(value) : "") } : { enabled: false },
          tooltip: { renderer: ({ datum }) => ({ heading: datum.label, title: set.name, data: [{ label: "Amount", value: fmt(datum.amount) }] }) },
        },
      ],
      axes: [
        {
          type: "category",
          position: horizontal ? "left" : "bottom",
          paddingInner: Math.min(0.85, Math.max(0.25, 1 - 22 / (PLOT[kind] / Math.max(1, rows.length)))),
          paddingOuter: 0.2,
          line: { width: 0 },
          tick: { width: 0 },
          label: { color: c.text, fontFamily: font, fontSize: 11, ...(horizontal ? {} : { autoRotate: false, avoidCollisions: true }) },
        },
        {
          type: "number",
          position: horizontal ? "bottom" : "left",
          nice: true,
          line: { width: 0 },
          tick: { width: 0 },
          gridLine: { style: [{ stroke: c.grid, lineDash: [] }] },
          label: { color: c.text, fontFamily: font, fontSize: 11, formatter: ({ value }) => (Math.abs(value) >= 1000 ? `$${(value / 1000).toFixed(1)}K` : `$${value}`) },
        },
      ],
      legend: { enabled: false },
    };
  }

  // ---------------------------------------------------------------- ledger
  const ORDER_COLS = () => [
    { field: "capturedAt", headerName: "Captured", width: 150, sort: "desc", filter: "agDateColumnFilter", valueGetter: (p) => new Date(p.data.capturedAt), valueFormatter: (p) => dateTime(p.value) },
    { field: "orderId", headerName: "PayPal order", width: 190, cellClass: "mono" },
    { field: "merchants", headerName: "Merchants", flex: 1, minWidth: 180, valueFormatter: (p) => p.value.join(", "), filterValueGetter: (p) => p.data.merchants.join(", ") },
    { field: "categories", headerName: "Categories", width: 150, valueFormatter: (p) => p.value.map((c) => CAT[c] || c).join(", "), filterValueGetter: (p) => p.data.categories.join(", ") },
    { field: "itemCount", headerName: "Units", width: 90, type: "rightAligned", filter: "agNumberColumnFilter" },
    { field: "total", headerName: "Total", width: 110, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => fmt(p.value) },
    { field: "refunded", headerName: "Refunded", width: 115, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => (p.value ? fmt(p.value) : "—") },
    { field: "net", headerName: "Net", width: 105, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => fmt(p.value) },
    { field: "status", width: 170, cellRenderer: (p) => pill(p.value) + (p.data.refundPending ? ` ${pill("REFUND_PENDING")}` : "") },
    { field: "mode", headerName: "Rail", width: 120, cellRenderer: (p) => `<span class="rail ${esc(p.value)}">${esc(MODE_LABELS[p.value] || p.value)}</span>` },
    { field: "authorizationId", headerName: "Authorization", width: 160, cellClass: "mono", hide: true },
    { field: "captureId", headerName: "Capture", width: 190, cellClass: "mono", hide: true },
    { colId: "open", headerName: "", width: 92, sortable: false, filter: false, suppressMovable: true, cellRenderer: () => `<button type="button" class="grid-btn">Details</button>` },
  ];
  const LINE_COLS = () => [
    { field: "date", headerName: "Captured", width: 150, sort: "desc", filter: "agDateColumnFilter", valueGetter: (p) => new Date(p.data.date), valueFormatter: (p) => dateTime(p.value) },
    { field: "name", headerName: "Item", flex: 1, minWidth: 220 },
    { field: "sku", width: 140, cellClass: "mono", hide: true },
    { field: "merchant", width: 170 },
    { field: "category", width: 120, valueFormatter: (p) => CAT[p.value] || p.value },
    { field: "qty", width: 80, type: "rightAligned", filter: "agNumberColumnFilter" },
    { field: "unitPrice", headerName: "Unit price", width: 115, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => fmt(p.value) },
    { field: "amount", width: 110, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => fmt(p.value) },
    { field: "tax", width: 95, type: "rightAligned", valueFormatter: (p) => fmt(p.value) },
    { field: "status", width: 160, cellRenderer: (p) => pill(p.value) },
    { field: "orderId", headerName: "PayPal order", width: 190, cellClass: "mono" },
    { colId: "open", headerName: "", width: 92, sortable: false, filter: false, cellRenderer: () => `<button type="button" class="grid-btn">Order</button>` },
  ];

  function renderLedger() {
    if (!ledgerGrid) return;
    ledgerGrid.setGridOption("rowData", ledgerView === "orders" ? data.ledger : data.lines);
    renderColumnMenu();
  }

  function setLedgerView(view) {
    ledgerView = view;
    document.querySelectorAll("[data-ledger-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ledgerView === view)));
    ledgerGrid.setGridOption("columnDefs", view === "orders" ? ORDER_COLS() : LINE_COLS());
    renderLedger();
  }

  function renderColumnMenu() {
    const cols = ledgerGrid.getColumns().filter((c) => c.getColDef().headerName !== "");
    $("#ledger-columns").innerHTML = cols
      .map((c) => `<label><input type="checkbox" value="${esc(c.getColId())}"${c.isVisible() ? " checked" : ""}/> ${esc(c.getColDef().headerName || c.getColId())}</label>`)
      .join("");
  }

  // ---------------------------------------------------------------- detail drawer
  async function openOrder(orderId) {
    const st = getState();
    const row = data.ledger.find((o) => o.orderId === orderId) || (await api("/api/analytics").then((r) => r.json())).ledger.find((o) => o.orderId === orderId);
    if (!row) return;
    const auth = st.authorizations?.find((a) => a.id === row.authorizationId);
    const related = st.audit.filter((a) => [row.orderId, row.captureId, row.authorizationId].filter(Boolean).some((id) => a.detail.includes(id)));
    const refundable = ["COMPLETED", "PARTIALLY_REFUNDED"].includes(row.status);
    const body = `
      <div class="drawer-head">
        <div><span class="eyebrow">${icon("receipt")}PayPal order</span><h2 class="mono">${esc(row.orderId)}</h2>
          <div class="drawer-badges">${pill(row.status)}<span class="rail ${esc(row.mode)}">${esc(MODE_LABELS[row.mode] || row.mode)}</span>${row.integrityAlert ? pill("integrity_alert", "error") : ""}</div></div>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button>
      </div>
      <dl class="kv">
        <div><dt>Captured</dt><dd>${esc(new Date(row.capturedAt).toLocaleString())}</dd></div>
        <div><dt>Payer</dt><dd>${esc(row.payer || "—")}</dd></div>
        <div><dt>Capture id</dt><dd class="mono">${esc(row.captureId)}</dd></div>
        <div><dt>Authorization</dt><dd class="mono">${esc(row.authorizationId || "—")}</dd></div>
        <div><dt>Total</dt><dd>${fmt(row.total)}</dd></div>
        <div><dt>Refunded</dt><dd>${fmt(row.refunded)}${row.refundPending ? ` (+${fmt(row.refundPending)} pending)` : ""}</dd></div>
      </dl>
      ${row.integrityAlert ? `<p class="alert bad">${icon("shield-x")}${row.integrityAlert.map(esc).join(" ")}</p>` : ""}
      <h3>Items</h3>
      <table class="mini"><thead><tr><th></th><th>Item</th><th>Qty</th><th>Amount</th><th>Status</th></tr></thead><tbody>
        ${row.items
          .map((i) => {
            const can = refundable && i.status === "COMPLETED";
            return `<tr><td>${can ? `<input type="checkbox" class="refund-pick" value="${esc(i.sku)}" aria-label="Select ${esc(i.name)}"/>` : ""}</td><td>${esc(i.name)}<small>${esc(i.merchant)}</small></td><td>${i.qty}</td><td>${fmt(i.price * i.qty)}</td><td>${pill(i.status)}</td></tr>`;
          })
          .join("")}
      </tbody></table>
      ${
        refundable
          ? `<div class="refund-box" id="refund-box"><input class="text-input" id="refund-reason" maxlength="200" placeholder="Reason (shown to the buyer), e.g. arrived damaged"/>
          <div class="row-btns"><button type="button" class="btn btn-secondary btn-sm" id="refund-preview" disabled>${icon("calculator")}Preview refund</button><button type="button" class="btn btn-ghost btn-sm" id="refund-ask">${icon("message-square")}Ask the agent</button></div>
          <div id="refund-calc"></div></div>`
          : ""
      }
      ${
        row.refunds.length
          ? `<h3>Refunds</h3><ul class="timeline">${row.refunds
              .map((r) => `<li><b>${fmt(r.amount)}</b> ${pill(r.status || "COMPLETED")} <span class="mono">${esc(r.id)}</span><small>${esc(r.reason || "")}${r.source === "webhook" ? " · recorded from a PayPal webhook" : ""} · ${esc(new Date(r.at).toLocaleString())}</small></li>`)
              .join("")}</ul>`
          : ""
      }
      <h3>Purchase authorization</h3>
      ${
        auth
          ? `<dl class="kv"><div><dt>Status</dt><dd>${pill(auth.status)}</dd></div><div><dt>Max charge</dt><dd>${fmt(auth.maxAmount)} ${esc(auth.currency)}</dd></div>
             <div><dt>Policy</dt><dd>v${auth.policyVersion} · ${esc(auth.policyHash)}</dd></div><div><dt>Integrity</dt><dd class="${auth.integrity === "valid" ? "ok" : "bad"}">HMAC ${esc(auth.signature)}… ${esc(auth.integrity)}</dd></div>
             <div><dt>Payee</dt><dd class="mono">${esc(auth.payee?.merchantId || auth.payee?.email || "—")}</dd></div><div><dt>Created</dt><dd>${esc(new Date(auth.createdAt).toLocaleString())}</dd></div></dl>
             <ul class="timeline">${auth.events.map((e) => `<li>${pill(e.status)}<small>${esc(e.detail || "")} · ${esc(new Date(e.at).toLocaleTimeString())}</small></li>`).join("")}</ul>`
          : `<p class="muted small">Not in the recent authorization history.</p>`
      }
      <h3>Audit trail</h3>
      <ul class="timeline">${related.map((a) => `<li><span class="actor ${esc(a.actor)}">${esc(a.actor)}</span> <b>${esc(a.action.replace(/_/g, " "))}</b> ${pill(a.outcome)}<small>${esc(a.detail)} · ${esc(new Date(a.time).toLocaleTimeString())}</small></li>`).join("") || `<li class="muted small">No related audit entries.</li>`}</ul>`;
    showDrawer(body);
    if (!refundable) return;
    const picks = () => [...document.querySelectorAll(".refund-pick:checked")].map((c) => c.value);
    const calcEl = $("#refund-calc");
    // A property handler (not addEventListener): the drawer is reused for every order.
    $("#detail").onchange = (e) => {
      if (!e.target.classList.contains("refund-pick")) return;
      $("#refund-preview").disabled = !picks().length;
      calcEl.innerHTML = "";
    };
    $("#refund-ask").onclick = () => {
      $("#detail").close();
      const names = row.items.filter((i) => picks().includes(i.sku)).map((i) => i.name);
      prefill(`Please refund ${names.length ? names.join(" and ") : "an item"} from order ${row.orderId}: `);
    };
    $("#refund-preview").onclick = async () => {
      const res = await api(`/api/orders/${encodeURIComponent(row.orderId)}/refund-preview?skus=${encodeURIComponent(picks().join(","))}`);
      const c = await res.json();
      if (!res.ok) return (calcEl.innerHTML = `<p class="alert bad">${esc(c.error)}</p>`);
      calcEl.innerHTML = `<table class="mini calc"><tbody>${c.lines.map((l) => `<tr><td>${esc(l.name)}${l.qty > 1 ? ` ×${l.qty}` : ""}</td><td>${fmt(l.goods)} + ${fmt(l.tax)} tax</td></tr>`).join("")}
        ${c.shipping ? `<tr><td>Shipping</td><td>${fmt(c.shipping)}</td></tr>` : ""}<tr class="total"><td>Refund via PayPal</td><td>${fmt(c.amount)}</td></tr></tbody></table>
        <button type="button" class="btn btn-primary btn-sm btn-block" id="refund-confirm">${icon("undo-2")}Refund ${fmt(c.amount)} through ${esc(MODE_LABELS[row.mode] || "PayPal")}</button>`;
      refreshIcons();
      $("#refund-confirm").onclick = async (e) => {
        e.currentTarget.disabled = true;
        const r = await api(`/api/orders/${encodeURIComponent(row.orderId)}/refunds`, { method: "POST", body: JSON.stringify({ skus: picks(), reason: $("#refund-reason").value.trim() || undefined }) });
        const out = await r.json();
        if (!r.ok) return (calcEl.innerHTML = `<p class="alert bad">${esc(out.error)}</p>`);
        setState(out.state);
        toast("ok", `Refund ${out.refund.status === "COMPLETED" ? "completed" : "submitted"} · ${fmt(out.refund.amount)}`, `PayPal refund ${out.refund.refund_id}`);
        await load();
        openOrder(row.orderId);
      };
    };
  }

  function showDrawer(html) {
    const d = $("#detail");
    d.innerHTML = `<div class="drawer-body">${html}</div>`;
    refreshIcons();
    if (!d.open) d.showModal();
  }

  // ---------------------------------------------------------------- trust & risk
  function renderRisk() {
    if (!risk || !riskGrid) return;
    const st = getState();
    const by = (lvl) => risk.listings.filter((l) => l.level === lvl).length;
    const events = st.riskEvents || [];
    $("#risk-summary").innerHTML = `
      <div class="stat bad"><span class="stat-label">${icon("shield-ban")}High risk</span><span class="stat-value">${by("high")}</span><span class="stat-sub">blocked by your rules${st.policy.blockHighRisk === false ? " (rule is OFF)" : ""}</span></div>
      <div class="stat warn"><span class="stat-label">${icon("triangle-alert")}Medium risk</span><span class="stat-value">${by("medium")}</span><span class="stat-sub">shown with a warning</span></div>
      <div class="stat ok"><span class="stat-label">${icon("shield-check")}Low risk</span><span class="stat-value">${by("low")}</span><span class="stat-sub">no significant signals</span></div>
      <div class="stat"><span class="stat-label">${icon("scan-search")}Flagged while you shopped</span><span class="stat-value">${events.length}</span><span class="stat-sub">${events.map((e) => esc(e.sku)).slice(0, 3).join(", ") || "nothing yet"}</span></div>`;
    $("#risk-basis").textContent = `Risk engine v${risk.engine}. ${risk.basis} Observed = a fact from the data; inferred = a comparison.`;
    riskGrid.setGridOption("rowData", risk.listings.map((l) => ({ ...l, seen: events.find((e) => e.sku === l.sku)?.count || 0, verified: risk.merchants.find((m) => m.merchant === l.merchant)?.verified })));
    refreshIcons();
  }

  function openRisk(l) {
    const m = risk.merchants.find((x) => x.merchant === l.merchant);
    showDrawer(`
      <div class="drawer-head"><div><span class="eyebrow">${icon("shield-alert")}Listing risk</span><h2>${esc(l.name)}</h2>
        <div class="drawer-badges">${pill(l.level)}<span class="chip"><b>${l.score}</b>/100</span><span class="mono small">${esc(l.sku)}</span></div></div>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
      <p class="alert ${l.action.type === "blocked" ? "bad" : l.action.type === "warn" ? "warn" : "ok"}">${icon(l.action.type === "blocked" ? "shield-ban" : l.action.type === "warn" ? "triangle-alert" : "shield-check")}${esc(l.action.detail)}</p>
      <h3>Signals</h3>
      <table class="mini"><thead><tr><th>Kind</th><th>Signal</th><th>Points</th></tr></thead><tbody>
        ${l.signals.map((x) => `<tr><td><span class="sig ${x.kind}">${x.kind}</span></td><td><b>${esc(x.label)}</b><small>${esc(x.detail)}</small></td><td>${x.weight ? `+${x.weight}` : "—"}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No risk signals.</td></tr>`}
      </tbody></table>
      ${l.injection.length ? `<p class="alert bad">${icon("bot")}Instruction patterns found in the seller's text: ${l.injection.map((x) => esc(x.replace(/_/g, " "))).join(", ")}. The text is never shown to the AI model.</p>` : ""}
      <h3>Merchant</h3>
      <dl class="kv"><div><dt>Merchant</dt><dd>${esc(l.merchant)}</dd></div><div><dt>Verified</dt><dd>${m?.verified ? "Yes" : "No"}</dd></div>
        <div><dt>Since</dt><dd>${m?.since ?? "—"}</dd></div><div><dt>Listings</dt><dd>${m?.listings ?? "—"}</dd></div>
        <div><dt>Reviews</dt><dd>${m?.reviews?.toLocaleString("en-US") ?? "—"}</dd></div><div><dt>Review-weighted rating</dt><dd>${m?.avgRating ?? "—"}★</dd></div></dl>
      <p class="muted small">${esc(risk.basis)}</p>`);
  }

  // ---------------------------------------------------------------- audit & security
  function renderAudit() {
    const st = getState();
    if (!auditGrid) return;
    const auths = st.authorizations || [];
    const count = (s) => auths.filter((a) => a.status === s).length;
    const act = (name) => st.audit.filter((a) => a.action === name).length;
    $("#security-strip").innerHTML = [
      ["fingerprint", "Authorizations", `${auths.length}`, `${count("consumed")} used · ${count("bound")} active · ${count("revoked") + count("expired") + count("cancelled")} voided`],
      ["shield-ban", "Guardrail blocks", String(st.audit.filter((a) => a.outcome === "blocked").length), `${act("capture_blocked")} at capture · ${act("checkout_needs_confirmation")} without consent`],
      ["bot", "Injection attempts", String(act("injection_flag")), "listings hiding instructions for AI agents"],
      ["shield-x", "Integrity alerts", String(act("integrity_alert")), "PayPal vs authorization mismatches"],
      ["webhook", "Verified webhooks", String(act("webhook")), config().webhooks ? "signature-checked with PayPal" : "not configured in this mode"],
      ["scroll-text", "Policy version", `v${st.policyVersion || 1}`, `${(st.policyHistory || []).length} change(s) recorded`],
    ]
      .map(([ic, label, value, sub]) => `<div class="stat"><span class="stat-label">${icon(ic)}${label}</span><span class="stat-value">${value}</span><span class="stat-sub">${sub}</span></div>`)
      .join("");
    auditGrid.setGridOption("rowData", [...st.audit].reverse());
    refreshIcons();
  }

  function openAudit(entry) {
    const st = getState();
    const ids = [...new Set(entry.detail.match(/\b(auth_[0-9a-f]+|cart_[0-9a-f]+|SIM-[A-Z]+-[0-9A-F]+|[A-Z0-9]{17})\b/g) || [])];
    const related = st.audit.filter((a) => a.id !== entry.id && ids.some((id) => a.detail.includes(id)));
    showDrawer(`
      <div class="drawer-head"><div><span class="eyebrow">${icon("list-checks")}Audit entry #${entry.id}</span><h2>${esc(entry.action.replace(/_/g, " "))}</h2>
        <div class="drawer-badges"><span class="actor ${esc(entry.actor)}">${esc(entry.actor)}</span>${pill(entry.outcome)}<span class="small muted">${esc(new Date(entry.time).toLocaleString())}</span></div></div>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div>
      <p class="audit-detail">${esc(entry.detail)}</p>
      <h3>Raw record</h3><pre class="json">${esc(JSON.stringify(entry, null, 2))}</pre>
      ${ids.length ? `<h3>Related entries (${esc(ids.join(", "))})</h3><ul class="timeline">${related.map((a) => `<li><span class="actor ${esc(a.actor)}">${esc(a.actor)}</span> <b>${esc(a.action.replace(/_/g, " "))}</b> ${pill(a.outcome)}<small>${esc(a.detail)}</small></li>`).join("") || `<li class="muted small">None.</li>`}</ul>` : ""}`);
  }

  // ---------------------------------------------------------------- setup
  const config = () => ctx.getConfig();
  function init() {
    if (window.agGrid) {
      const common = { theme: gridTheme(), animateRows: true, rowHeight: 42, headerHeight: 38, floatingFiltersHeight: 34, tooltipShowDelay: 300, defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: true } };
      ledgerGrid = agGrid.createGrid($("#ledger-grid"), {
        ...common,
        columnDefs: ORDER_COLS(),
        rowData: [],
        overlayNoRowsTemplate: '<span class="muted">No transactions yet. Captured PayPal orders appear here.</span>',
        onRowClicked: (e) => openOrder(e.data.orderId),
        onColumnVisible: renderColumnMenu,
      });
      riskGrid = agGrid.createGrid($("#risk-grid"), {
        ...common,
        rowData: [],
        isExternalFilterPresent: () => riskLevel !== "all",
        doesExternalFilterPass: (n) => n.data.level === riskLevel,
        onRowClicked: (e) => openRisk(e.data),
        columnDefs: [
          { field: "level", width: 120, sort: "desc", comparator: (a, b) => ["low", "medium", "high"].indexOf(a) - ["low", "medium", "high"].indexOf(b), cellRenderer: (p) => pill(p.value) },
          { field: "score", width: 130, filter: "agNumberColumnFilter", cellRenderer: (p) => `<span class="score"><span class="score-bar ${esc(p.data.level)}" style="width:${p.value}%"></span><b>${p.value}</b></span>` },
          { field: "name", headerName: "Listing", flex: 1, minWidth: 220, tooltipField: "name" },
          { field: "merchant", width: 190, cellRenderer: (p) => `${esc(p.value)}${p.data.verified ? ` <span class="verified" title="Verified merchant">${icon("badge-check")}</span>` : ""}` },
          { field: "price", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => fmt(p.value) },
          { field: "rating", width: 95, type: "rightAligned", filter: "agNumberColumnFilter" },
          { field: "reviews", width: 105, type: "rightAligned", filter: "agNumberColumnFilter" },
          { colId: "signals", headerName: "Signals", flex: 1, minWidth: 220, valueGetter: (p) => p.data.signals.filter((x) => x.weight > 0).map((x) => x.label).join(", ") || "—", tooltipValueGetter: (p) => p.value },
          { field: "seen", headerName: "Seen", width: 90, type: "rightAligned", headerTooltip: "Times this listing came up while you shopped" },
          { field: "sku", width: 160, cellClass: "mono", hide: true },
        ],
      });
      auditGrid = agGrid.createGrid($("#audit-grid"), {
        ...common,
        rowData: [],
        onRowClicked: (e) => openAudit(e.data),
        columnDefs: [
          { field: "id", headerName: "#", width: 80, sort: "desc", filter: "agNumberColumnFilter" },
          { field: "time", width: 150, filter: "agDateColumnFilter", valueGetter: (p) => new Date(p.data.time), valueFormatter: (p) => dateTime(p.value) },
          { field: "actor", width: 120, cellRenderer: (p) => `<span class="actor ${esc(p.value)}">${esc(p.value)}</span>` },
          { field: "action", width: 190, valueFormatter: (p) => String(p.value).replace(/_/g, " ") },
          { field: "detail", flex: 1, minWidth: 280, tooltipField: "detail" },
          { field: "outcome", width: 125, cellRenderer: (p) => pill(p.value) },
        ],
      });
      // Buttons inside cells open the same drawer as a row click.
      renderColumnMenu();
    }

    document.querySelectorAll("#cc-tabs .tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        active = tab.dataset.tab;
        document.querySelectorAll("#cc-tabs .tab").forEach((t) => {
          t.classList.toggle("active", t === tab);
          t.setAttribute("aria-selected", String(t === tab));
        });
        for (const p of ["overview", "ledger", "risk", "audit"]) $(`#panel-${p}`).hidden = p !== active;
        $("#cc-filters").hidden = !["overview", "ledger"].includes(active);
        moveIndicator();
        load();
      }),
    );
    addEventListener("resize", () => moveIndicator(false));
    document.fonts?.ready.then(() => moveIndicator(false));
    moveIndicator(false);

    $("#cc-filters").addEventListener("submit", (e) => e.preventDefault());
    $("#cc-filters").addEventListener("change", (e) => {
      if (!e.target.name) return;
      filters[e.target.name] = e.target.value;
      load();
    });
    $("#cc-reset").addEventListener("click", () => {
      Object.keys(filters).forEach((k) => (filters[k] = ""));
      load();
    });
    document.querySelectorAll("[data-ledger-view]").forEach((b) => b.addEventListener("click", () => setLedgerView(b.dataset.ledgerView)));
    $("#ledger-search").addEventListener("input", (e) => ledgerGrid?.setGridOption("quickFilterText", e.target.value));
    $("#audit-search").addEventListener("input", (e) => auditGrid?.setGridOption("quickFilterText", e.target.value));
    $("#risk-search").addEventListener("input", (e) => riskGrid?.setGridOption("quickFilterText", e.target.value));
    $("#ledger-export").addEventListener("click", () =>
      ledgerGrid?.exportDataAsCsv({ fileName: `cartpilot-${ledgerView}-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys: ledgerGrid.getColumns().filter((c) => c.isVisible() && c.getColId() !== "open").map((c) => c.getColId()), processCellCallback: csvCell }),
    );
    $("#audit-export").addEventListener("click", () => auditGrid?.exportDataAsCsv({ fileName: `cartpilot-audit-${new Date().toISOString().slice(0, 10)}.csv`, processCellCallback: csvCell }));
    $("#risk-export").addEventListener("click", () =>
      riskGrid?.exportDataAsCsv({
        fileName: `cartpilot-risk-register-${new Date().toISOString().slice(0, 10)}.csv`,
        processCellCallback: (p) => (p.column.getColId() === "signals" ? p.node.data.signals.map((x) => `${x.kind}:${x.label}`).join("; ") : csvCell(p)),
      }),
    );
    document.querySelectorAll("[data-risk-level]").forEach((b) =>
      b.addEventListener("click", () => {
        riskLevel = b.dataset.riskLevel;
        document.querySelectorAll("[data-risk-level]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        riskGrid?.onFilterChanged();
      }),
    );
    $("#ledger-columns-btn").addEventListener("click", (e) => {
      const menu = $("#ledger-columns");
      menu.hidden = !menu.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!menu.hidden));
    });
    $("#ledger-columns").addEventListener("change", (e) => ledgerGrid?.setColumnsVisible([e.target.value], e.target.checked));
    document.querySelectorAll(".view-toggle").forEach((btn) =>
      btn.addEventListener("click", () => {
        const kind = btn.dataset.chart;
        chartView[kind] = chartView[kind] === "chart" ? "table" : "chart";
        const table = chartView[kind] === "table";
        $(`#chart-${kind}`).hidden = table;
        $(`#table-${kind}`).hidden = !table;
        btn.innerHTML = `${icon(table ? "chart-column" : "table-2")}${table ? "Chart" : "Table"}`;
        btn.setAttribute("aria-pressed", String(table));
        refreshIcons();
        if (!table) renderOverview();
      }),
    );
    $("#detail").addEventListener("click", (e) => {
      if (e.target === $("#detail") || e.target.closest("[data-close]")) $("#detail").close();
    });
    load();
  }

  function moveIndicator(animated = true) {
    const activeTab = $("#cc-tabs .tab.active");
    const ind = $("#tab-indicator");
    if (!activeTab || !ind) return;
    const target = { left: activeTab.offsetLeft + "px", width: activeTab.offsetWidth + "px" };
    if (animated && window.Motion && !matchMedia("(prefers-reduced-motion: reduce)").matches) Motion.animate(ind, target, { type: "spring", stiffness: 500, damping: 40 });
    else Object.assign(ind.style, target);
  }

  function applyTheme() {
    for (const g of [ledgerGrid, riskGrid, auditGrid]) g?.setGridOption("theme", gridTheme());
    if (data && active === "overview") renderOverview();
  }

  return { init, update, applyTheme, openOrder, show: (tab) => document.querySelector(`#cc-tabs .tab[data-tab="${tab}"]`)?.click() };
}

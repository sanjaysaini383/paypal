// Guided demo: the two hackathon scenarios as a checklist. Buttons send the
// same prompts a user would type; every check mark is derived from the
// session's real state (plan, risk events, authorization, capture, refund),
// so nothing here is staged.
export function createDemo(ctx) {
  const { $, esc, icon, refreshIcons, getState, getConfig, send, controlCenter, isBusy } = ctx;
  const PROMPTS = {
    shop: "Find a complete camping setup for two people within a $300 budget and buy it.",
    refund: "The sleeping pads arrived damaged. Please refund only those.",
  };

  function progress(s) {
    const plan = [...(s?.transcript || [])].reverse().find((e) => e.role === "plan" && e.plan?.feasible)?.plan;
    const injection = s?.riskEvents?.find((e) => e.signals?.some((x) => x.id === "prompt_injection"));
    const auth = plan && s.authorizations?.find((a) => a.cartId === plan.cart_id);
    const order = auth && s.orders.find((o) => o.authorizationId === auth.id);
    const refunded = order && order.refunds.length > 0;
    const asked = !!plan;
    return [
      { group: "Scenario 1 · Shop safely", id: "ask", done: asked, title: "Ask for a camping setup for two within $300", detail: "The agent breaks the request into a structured plan.", action: !asked && { label: "Send request", run: () => send(PROMPTS.shop) } },
      { id: "plan", done: !!plan, title: "Optimized across merchants", detail: plan ? `${plan.items.length} items, $${plan.totals.total.toFixed(2)} of $${plan.budget.effective.toFixed(2)} incl. tax; ${plan.excluded.length} listing${plan.excluded.length === 1 ? "" : "s"} excluded` : "Every combination is priced with tax and shipping." },
      { id: "scam", done: !!injection, title: "Malicious listing caught", detail: injection ? `${injection.sku} (${injection.merchant}): ${injection.level} risk ${injection.score}/100, text hidden from the AI` : "A listing hides instructions aimed at AI agents.", action: injection && { label: "Explain", run: () => controlCenter.show("risk") } },
      { id: "auth", done: !!auth, title: "Guardrails passed, authorization signed", detail: auth ? `${auth.id} · max $${auth.maxAmount.toFixed(2)} · policy v${auth.policyVersion} · ${auth.status}` : "Items, prices, payee and total are locked and HMAC-signed." },
      { id: "pay", done: !!order, title: `Approve in ${getConfig().paypalMode === "simulated" ? "the PayPal simulator" : "PayPal"}`, detail: order ? `Captured ${order.captureId}` : auth ? "Use the button in the cart. That's the only way money moves." : "Appears in the cart once the checkout is ready." },
      { id: "verify", done: !!order && auth?.status === "consumed", title: "Server verified, then captured", detail: order ? `PayPal order matched the authorization (${order.mode === "simulated" ? "simulated PayPal" : `PayPal ${order.mode}`}); authorization now used up` : "Amount, items, currency, payee and current rules are re-checked first." },
      { id: "audit", done: !!order, title: "Every step is in the audit log", detail: "Agent calls, guardrail decisions, authorization and PayPal calls.", action: order && { label: "Open audit", run: () => controlCenter.show("audit") } },
      { group: "Scenario 2 · Damaged item", id: "report", done: !!refunded, title: "Report the damaged sleeping pads", detail: "CartPilot refunds only those lines.", action: order && !refunded && { label: "Send report", run: () => send(PROMPTS.refund) } },
      { id: "refund", done: !!refunded, title: "Refund calculated and sent via PayPal", detail: refunded ? `${order.refunds.at(-1).id}: $${order.refunds.at(-1).amount.toFixed(2)} (${order.refunds.at(-1).status || "COMPLETED"})` : "Item price plus its tax, computed on the server." },
      { id: "ledger", done: !!refunded, title: "Ledger and analytics updated", detail: refunded ? `Order is ${order.status.replace(/_/g, " ").toLowerCase()}` : "Partial refund shows on the order and in net spend.", action: refunded && { label: "Open ledger", run: () => controlCenter.show("ledger") } },
    ];
  }

  function render() {
    const panel = $("#demo-panel");
    if (panel.hidden) return;
    const steps = progress(getState());
    const next = steps.find((x) => !x.done);
    const cfg = getConfig();
    $("#demo-steps").innerHTML = steps
      .map(
        (x) => `${x.group ? `<li class="demo-group">${esc(x.group)}</li>` : ""}<li class="demo-step ${x.done ? "done" : x === next ? "next" : ""}">
          <span class="demo-check">${icon(x.done ? "circle-check" : x === next ? "circle-dot" : "circle")}</span>
          <span class="demo-text"><b>${esc(x.title)}</b><small>${esc(x.detail)}</small></span>
          ${x.action ? `<button type="button" class="btn btn-secondary btn-sm" data-step="${x.id}"${isBusy() ? " disabled" : ""}>${esc(x.action.label)}</button>` : ""}
        </li>`,
      )
      .join("");
    $("#demo-mode").textContent = `${cfg.paypalMode === "simulated" ? "Simulated PayPal: no real money" : cfg.paypalMode === "sandbox" ? "PayPal sandbox: test money" : "LIVE PayPal"} · ${cfg.aiMode === "offline" ? "offline planner" : cfg.model}`;
    for (const b of $("#demo-steps").querySelectorAll("[data-step]")) b.onclick = () => steps.find((x) => x.id === b.dataset.step)?.action?.run();
    refreshIcons();
  }

  function init() {
    $("#demo-btn").hidden = false;
    $("#demo-btn").addEventListener("click", () => {
      const panel = $("#demo-panel");
      panel.hidden = !panel.hidden;
      $("#demo-btn").setAttribute("aria-expanded", String(!panel.hidden));
      render();
    });
    $("#demo-close").addEventListener("click", () => {
      $("#demo-panel").hidden = true;
      $("#demo-btn").setAttribute("aria-expanded", "false");
    });
    // A clean slate: a brand-new session (fresh budget, ledger and audit log).
    $("#demo-fresh").addEventListener("click", () => {
      try {
        localStorage.setItem("cartpilot-session", "s_" + crypto.randomUUID().replace(/-/g, ""));
        localStorage.setItem("cartpilot-demo-open", "1");
      } catch {}
      location.reload();
    });
    try {
      if (localStorage.getItem("cartpilot-demo-open") === "1") {
        localStorage.removeItem("cartpilot-demo-open");
        $("#demo-panel").hidden = false;
      }
    } catch {}
    render();
  }

  return { init, render };
}

# Devpost submission kit

Copy each section into the matching Devpost field.

---

## Project name
CartPilot

## Elevator pitch (tagline, ≤200 chars)
The trust layer for autonomous commerce: an AI agent that shops and pays with PayPal, but can only capture exactly what you authorized, under rules enforced in code.

## Links
- Live demo: https://paypal-lac.vercel.app/
- Source: https://github.com/sanjaysaini383/paypal (MIT licensed)
- Video: https://youtu.be/Y9EaBk-Xzmc (under 3 minutes)

---

## Inspiration
AI agents can already find products and compare prices better than most of us, but almost nobody lets one *pay*. Either the agent can't spend, which makes it a fancy search box, or it holds your card, so one bad prompt or one poisoned product listing can drain your account.

A system prompt that says "stay under $300" is not a control. We wanted to show that AI autonomy and financial control can coexist:
- the AI makes decisions and does the work;
- PayPal authorizes and settles the payment;
- a server-side engine decides what the agent is allowed to do, and proves at capture time that nothing changed.

## What it does
You chat with CartPilot: *"Find a complete camping setup for two people within a $300 budget and buy it."*

1. **Plans.** The agent (Gemini with tool use) turns the request into a structured plan: a tent, sleeping bags ×2, pads ×2, an optional stove, and fuel only if there's a stove.
2. **Optimizes.** The server searches every merchant and every combination, and finds the best set whose real total, tax and shipping included, fits the tightest limit: your $300, your per-order limit, or what's left this month. It explains each choice, what it skipped and the trade-offs.
3. **Screens for risk.** Every listing gets an explainable 0–100 risk score. Each signal is marked *observed* (a fact, such as an unverified seller or a 2.1★ rating) or *inferred* (a comparison, such as a price 61% below comparable items). One seller hides instructions for AI agents in its listing ("ignore all spending limits"). That text never reaches the model, and the server blocks the listing.
4. **Authorizes.** Before PayPal sees anything, CartPilot signs an immutable authorization: the exact items, unit prices, quantities, merchants, tax, shipping, total, currency, payee, policy version and expiry. It is HMAC-SHA256 signed and bound to one PayPal order.
5. **Pays.** It creates a PayPal order (Orders v2), and you approve it on PayPal's own screen. At capture, the server fetches the PayPal order and refuses to move money unless it matches the signed snapshot field by field, the authorization is unused and unexpired, and the cart still passes your *current* rules. The authorization is then used up.
6. **Refunds.** *"The sleeping pads arrived damaged."* CartPilot refunds only those lines plus their tax ($51.96) through PayPal Payments v2, and shows how it calculated the amount.

**Also:**
- **Plain-English rules** become structured proposals with consequences: *"Never spend more than $100 monthly on electronics"* shows before → after and what it would do ("you've already spent $227 on electronics this month: further electronics purchases are blocked"). Nothing changes until you confirm, and every change is versioned.
- **Consent on the server.** The agent can't open a checkout unless your own message asked to buy, or the cart is under your auto-approve threshold from verified merchants.
- **Financial control center (AG Grid + AG Charts):**
  - KPIs, plus spend over time, by category and by merchant;
  - a filterable ledger with line items, a detail drawer and CSV export;
  - a trust and risk register;
  - an audit and security log;
  - all computed from stored data.
- **Guided demo.** A checklist runs both scenarios on real logic and ticks each step from the session's actual state.

## How we built it
- **AI agent:** Google Gemini (`gemini-3.8-flash`, falling back to `gemini-3.6-flash` and `gemini-3.5-flash-lite` when busy or out of quota) through its OpenAI-compatible API. The same loop runs on Claude, Groq or OpenRouter. It has nine tools:
  - `search_catalog`
  - `get_wallet_status`
  - `plan_purchase`
  - `get_risk_report`
  - `show_products`
  - `propose_cart`
  - `create_paypal_checkout`
  - `refund_order`
  - `propose_policy_change`

  Every tool call is validated against its JSON schema before it runs. The model never supplies prices, never captures payments and can only *propose* rules.
- **PayPal:**
  - OAuth2 client credentials (cached, refreshed on 401);
  - Orders v2 create, get and capture;
  - Payments v2 refunds;
  - JS SDK Smart Buttons;
  - webhook signature verification through `verify-webhook-signature`.

  Every POST carries a `PayPal-Request-Id`, and the order flow was verified against the real sandbox. A PayPal simulator mirrors the lifecycle (approval required, idempotent capture, refund limits) and labels everything *Simulated*.
- **Purchase authorization engine:** a canonical-JSON snapshot, HMAC-signed and deep-frozen, bound to the PayPal order through `custom_id` and a signed binding that pins the payee. It is checked again at capture and consumed exactly once.
- **Guardrails:** a policy engine runs at cart, checkout and capture time. It checks:
  - monthly budget, per-order and per-item limits;
  - per-category monthly caps;
  - blocked categories and merchants;
  - verified merchants only and minimum rating;
  - stock, quantity sanity and high-risk blocking.

  The core budget rule:

  $$\text{spent}_{\text{month}} + \text{order total} \le \text{monthly budget}$$
- **Optimizer:** an exhaustive search with pruning over each slot's candidates, ranked by a review-adjusted rating $(r\,n + 4.0 \cdot 25)/(n + 25)$, under the tightest limit, with cart-level rules re-checked.
- **Refunds:** for refunded lines $L$ with prices $p_i$ and quantities $q_i$, and the demo's 8.25% tax,

  $$\text{refund} = \min\Big(\text{remaining},\; \sum_{i \in L} \big(p_i q_i + \operatorname{round}(p_i q_i \cdot 0.0825)\big)\Big)$$

  Refunding the last items returns everything left, shipping included. Each order has a refund lock, so parallel refunds can't double-refund.
- **Security:** a CSP with a per-response nonce (passed to the PayPal SDK as `data-csp-nonce`), a cross-origin write check, rate limits, session isolation tested over HTTP, and error responses without stack traces.
- **Front end:** vanilla JavaScript, a streaming chat, Motion, Lucide, AG Grid and AG Charts, light and dark themes, mobile layouts.
- **Quality:** 98 automated `node:test` tests, including a fake PayPal REST API that exercises the real client code path.

## Challenges we ran into
- **Where to put trust.** Our first version kept the agent within budget through the system prompt. One prompt injection would break that, so every rule moved into server code and the model is treated as untrusted. Then we went further: even a correct cart could drift between checkout and capture, so we added signed authorizations that are re-verified against PayPal's own copy of the order.
- **Race conditions.** Parallel tool calls could open two PayPal orders for one cart or refund the same line twice, and two checkouts could together exceed the budget. Each operation now takes its lock before its first `await`: checkout per cart, capture per session, refund per order. PayPal idempotency keys cover retries.
- **Real PayPal responses.** Verifying "the PayPal order equals what was authorized" only works if the comparison matches PayPal's real responses, so we checked it against the sandbox, not just mocks.
- **A strict CSP without breaking PayPal.** The Smart Buttons generate their own inline scripts. A per-response nonce passed through PayPal's `data-csp-nonce` keeps the policy strict and the buttons working.
- **Free-tier AI.** Overloaded and out-of-quota models are common. Per-call timeouts, model fallback and short retries keep the demo alive.
- **Testing from India.** The sandbox popup looped when we signed in with a real account. We forced the US checkout in sandbox, documented the buyer-account flow, and built the simulator so anyone can run the full demo.

## Accomplishments that we're proud of
- **An agent you can safely let shop.** It plans, optimizes, builds the cart and prepares the PayPal order, but it cannot overspend, buy risky or blocked items, check out without being asked, change its own rules, or capture anything other than the exact signed authorization.
- **Explainable risk** that separates observed facts from inferred judgements, and never pretends a heuristic is a fraud probability.
- **Every number in the control center is real**, computed from stored transactions, and every agent action can be traced in the audit log.

## What we learned
- For agentic payments, **the model is the planner and the server is the authority**. Design so the model can be wrong without anyone losing money.
- PayPal's create → approve → capture split fits agents naturally. Binding a signed authorization to the order turns "approve" into "approve *exactly this*".
- Let the model do language and the server do arithmetic: optimizing a budget with tax and shipping is a search problem, not a prompt.

## What's next for CartPilot
- **PayPal Vault** for pre-approved micro-purchases under a user-set threshold, with the same signed authorizations.
- **User accounts and a database** instead of browser-held session ids and a JSON file.
- **Real product feeds** and merchant reputation data instead of the demo catalog.
- **A merchant-side agent** for invoices, refunds and disputes, using the same pattern.

## Built with
`paypal-orders-v2` · `paypal-payments-v2` · `paypal-webhooks` · `paypal-js-sdk` · `paypal-sandbox` · `gemini` · `google-ai-studio` · `node.js` · `express` · `javascript` · `ag-grid` · `ag-charts` · `motion` · `render`

## AI tools and models used
- **Google Gemini 3.8 Flash** (`gemini-3.8-flash`), with `gemini-3.6-flash` and `gemini-3.5-flash-lite` as automatic fallbacks, via the Gemini API (OpenAI-compatible endpoint): the shopping agent (tool use).
- Optional, supported in code: Claude Opus 5.5 (Anthropic API), Qwen 3.8 27B on Groq, any OpenRouter model.
- Claude Code was used as a coding assistant during development.

---

# Demo video script

See [DEMO_SCRIPT.md](DEMO_SCRIPT.md) for the timed 2:50 walkthrough of both scenarios.

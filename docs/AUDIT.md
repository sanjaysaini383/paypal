# CartPilot repository audit (Phase 1)

Baseline: `npm test` → **18/18 passing** (Node 24, offline agent, simulated PayPal).
`npm audit --omit=dev` → 2 advisories (body-parser high, qs moderate), both fixable without breaking changes.

## What already works well

- **Policy is enforced on the server.** `checkCart` runs at `propose_cart`, again at `create_paypal_checkout`, and the monthly budget is re-checked at capture. The model only ever passes SKUs and quantities; prices come from the server-side catalog.
- **Idempotency.** `PayPal-Request-Id` is sent on order create, capture and refund.
- **Capture lock.** The cart flips to `capturing` before the PayPal call, so a double click records one payment (covered by a test).
- **Session scoping.** Carts, orders, proposals and audit entries live inside one session object. A capture for another session's order returns 404 (covered by a test).
- **Prompt-injection flagging.** Flagged listings are hidden from the model, and the guardrails would still block the scam listing (unverified merchant, 2.1★).
- **Rule changes need consent.** The agent can only *propose* policy changes; the user applies them.

## Findings

| # | Area | Severity | Finding |
|---|---|---|---|
| F1 | Capture | **High** | The capture endpoint trusts the local cart object. It never fetches the PayPal order to confirm its amount, currency, items or payee, and never checks the captured amount against the cart. A cart edited in memory or on disk after checkout would be captured as-is. |
| F2 | Capture | **High** | Only the monthly budget is re-checked at capture. If the user blocks a category, lowers the per-order limit or adds a category cap after checkout is created, the capture still goes through. |
| F3 | Capture | Medium | A capture with status `PENDING` (e.g. under PayPal review) is treated as failure, so the cart is unlocked and could be paid twice. Only `COMPLETED` is handled. |
| F4 | Authorization | **High** | No authorization record binds "what the user approved" to "what PayPal charges". No expiry, no single-use guarantee beyond cart status, no integrity protection on stored state. |
| F5 | Refunds | **High** | `refund_order` has no per-order lock. The agent loop runs tool calls in parallel (`Promise.all`), so two concurrent refunds of the same line both pass the "not yet refunded" check before either awaits PayPal. The simulator does not dedupe, so the ledger double-counts. |
| F6 | Refunds | Medium | The refund tax rate is hard-coded (`0.0825`) rather than using `TAX_RATE`. A refund with status `PENDING` is booked as completed. |
| F7 | Webhooks | Medium | No webhook handling, so asynchronous outcomes (refund completes later, capture reversed or denied) never reach the ledger. |
| F8 | PayPal mode | Medium | Any credentials are labelled "sandbox", even when `PAYPAL_API_BASE` points at the live API. The UI cannot tell users whether money is real. |
| F9 | Agent | Medium | `create_paypal_checkout` relies on the system prompt ("only when the user asked you to buy"). Nothing on the server stops a model from opening a checkout the user never asked for. |
| F10 | Agent | Low | Tool inputs are only loosely type-checked inside each executor. There is no schema validation of model-supplied arguments. |
| F11 | Risk | Medium | Risk is a single regex flag. There is no merchant reputation, price-anomaly, review-count or availability signal, no explanation, and no server-side block for high-risk listings beyond the generic rules. |
| F12 | HTTP | Medium | No security headers (CSP, `nosniff`, frame denial). There is no JSON error handler (malformed JSON returns Express's HTML error page), and mutating endpoints other than chat have no rate limiting. |
| F13 | Analytics | Low | Insights are computed in the browser from the full order list. There are no filters, no merchant breakdown, no pending or average-order metrics, and no export. |
| F14 | Dependencies | Medium | body-parser (GHSA-27r3-jxmh-p828) and qs (GHSA-6pq8-jhm2-2vcw) advisories. |

## Plan (ordered by judging impact × risk reduction)

1. **Purchase authorization engine** (F1, F2, F4, F3): an immutable, HMAC-signed snapshot created before the PayPal order. It is bound to the order and fully re-verified against the PayPal order and the current policy at capture. It is single-use and has an expiry.
2. **Refund hardening** (F5, F6): per-order lock, refunds computed from the authorized snapshot, pending-status handling.
3. **Webhooks** (F7): signature verification through PayPal's `verify-webhook-signature` API, event de-duplication, and monotonic state reconciliation.
4. **Risk engine** (F11): explainable score with observed vs inferred signals, enforced server-side.
5. **Agent** (F9, F10): server-enforced purchase intent, schema validation, a budget optimizer tool for multi-item plans.
6. **Financial control center** (F13): a server-side analytics API with filters, plus AG Grid ledger, detail view and CSV export.
7. **HTTP hardening** (F8, F12, F14).

## Resolution

Status after Phases 2–7. Tests went from 18 to 98, all passing, and `npm audit` reports 0 vulnerabilities.

| # | Status | How | Commit |
|---|---|---|---|
| F1 | Fixed | Capture fetches the PayPal order and compares amount, breakdown, items, currency, `custom_id` and payee with a signed snapshot; the captured amount is checked afterwards (a mismatch raises an integrity alert, never hidden). | 7dec787 |
| F2 | Fixed | The full policy is re-evaluated at capture; a tightened rule revokes the authorization. | 7dec787 |
| F3 | Fixed | `PENDING` captures are recorded as pending, count against the budget, can't be retried, and are settled or denied by webhooks. | 7dec787, 55d9456 |
| F4 | Fixed | Purchase authorization engine: HMAC-SHA256 over canonical JSON, deep-frozen, single-use, expiring, bound to one PayPal order and payee. | 7dec787 |
| F5 | Fixed | Per-order refund lock taken before the PayPal call; parallel duplicates are tested. | 690e0e7 |
| F6 | Fixed | `TAX_RATE` used; refunds computed from the authorized snapshot; `PENDING` refunds not credited until they complete. | 690e0e7 |
| F7 | Fixed | Verified webhooks with de-duplication, monotonic reconciliation and deferral of early events. | 55d9456 |
| F8 | Fixed | Live, sandbox and simulated modes are distinguished; live requires `PAYPAL_ALLOW_LIVE=1`; the UI and every record show the payment rail. | 7dec787, 9ef1149 |
| F9 | Fixed | Checkout requires the user's own purchase request (server-side), or an auto-approve threshold the user set. | d295ab4 |
| F10 | Fixed | JSON-schema validation of every tool call. | d295ab4 |
| F11 | Fixed | Explainable risk engine (observed vs inferred signals), enforced through the `blockHighRisk` policy rule. | 48e1cea |
| F12 | Fixed | CSP with a per-response nonce (PayPal SDK verified in the real sandbox), origin check, write limits, JSON errors, stronger session ids. | bd53229, eba7ac5 |
| F13 | Fixed | Server-side analytics API and the control center (AG Grid ledger, risk register, audit log; AG Charts). | e5f74e6, 4126b6c |
| F14 | Fixed | `npm audit fix`. | 409e83f |

### Verified against the real PayPal sandbox

- Order creation.
- The field-by-field comparison on real create and get responses.
- Capture refused while the order is `CREATED`.
- Smart Buttons rendering under the CSP with no violations.

### Not verified here

These need a human or a public URL:

- Clicking through the sandbox approval popup end to end.
- Receiving real webhook deliveries.

Both code paths are covered by the fake-PayPal tests.

### Remaining limitations

- Sessions are bearer ids held in the browser and a local JSON file, not user accounts or a database. On serverless hosts, instances don't share memory.
- Catalog, merchant registry and risk inputs are demo data; the risk score is a documented heuristic.
- PayPal Vault (pre-approved purchases without a popup) is not implemented.

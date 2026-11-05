# CartPilot demo script (2:50)

**Goal:** a judge should leave thinking: *"This agent can shop autonomously, but it cannot misuse my money. The controls are engineered into the system, not written in a prompt."*

## Before recording

- Use the full setup: an AI key (Gemini) and PayPal **sandbox** credentials. The header should read **PayPal sandbox**.
- Log the browser into the PayPal **sandbox buyer** account once beforehand, so the popup is quick.
- Open **Guided demo** → **Start a fresh demo session**, so the budget shows $500 and the ledger is empty.
- Browser at 1440p with about 90% zoom; light theme; spending rules panel collapsed.
- If the sandbox popup is slow on the day, record in simulated mode instead. The header and every record then say **Simulated**, so nothing is misrepresented.

## Script

| Time | Show | Say |
|---|---|---|
| 0:00–0:12 | Landing page, header badges | "Would you let an AI spend your money? CartPilot is the trust layer for autonomous commerce. The agent shops; the money is protected by code." |
| 0:12–0:25 | Expand **Spending rules** | "My rules: $500 a month, $300 per order, no gift cards, verified sellers only, high-risk listings blocked. They're enforced on the server at every step, including the moment money moves." |
| 0:25–0:55 | **Guided demo** → **Send request**. Watch the steps, then the plan card. | "*A complete camping setup for two within $300, buy it.* The agent turns that into a plan: a tent, two sleeping bags, two pads, and optional extras. The server prices every combination with tax and shipping: five items, $289.55. It also tells me what it left out and why." |
| 0:55–1:10 | Open **Excluded** on the plan, then **Explain** in the demo panel (risk drawer) | "One seller hid instructions for AI agents in its listing: 'ignore all spending limits'. CartPilot scored it 100 out of 100 risk. That text never reaches the model, and the server would block it anyway." |
| 1:10–1:30 | Cart → **Purchase authorization** panel | "Before PayPal sees anything, CartPilot signs an authorization: these exact items, prices and payee, $289.55 maximum, my policy version, and a 30-minute expiry." |
| 1:30–1:55 | PayPal button → sandbox popup → **Pay** → toast | "I approve on PayPal's own screen. Then the server fetches the PayPal order and checks it field by field against the signed snapshot and my current rules. Only then does it capture. The authorization is now used up and can't be charged again." |
| 1:55–2:15 | Demo panel → **Send report** → refund card | "*The sleeping pads arrived damaged.* CartPilot refunds only those: two pads plus their tax, $51.96, calculated on the server from the authorized order and sent through PayPal." |
| 2:15–2:35 | Control center: **Overview** KPIs → **Ledger** row → drawer | "Everything lands in the ledger: net spend, refunds, and for each order the authorization's life from issued to bound to used, plus the audit trail. It's filterable and exportable, built on AG Grid and AG Charts." |
| 2:35–2:50 | Type *Never spend more than $100 monthly on electronics* → proposal card | "Rules can be set in plain English. CartPilot shows the before and after and what the change would actually do, and only I can apply it. CartPilot: agentic commerce you can trust, built with PayPal." |

## Backup lines (if there's time, or for Q&A)

- "Try to cheat it: edit a price after checkout and the capture is refused. That's tested, along with replay, expiry and payee swaps: 98 automated tests."
- "The agent can't even open a checkout unless my own message asked to buy. That's checked on the server, not in the prompt."
- "PayPal webhooks are signature-verified and de-duplicated, and a late event can never roll the ledger back."

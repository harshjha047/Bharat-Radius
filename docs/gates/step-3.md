# Step 3 — Resellers, billing and payments

Built 6–8 Nov 2026 (PRs #24, #25, #26); staging fixes #27–#29. Defaults used where the owner's answers are still open (IMPLEMENTATION_PLAN §10, O-7/O-8/O-9).

## Work packages

| WP | Status | Notes |
|---|---|---|
| 3.0 Carry-overs | ✅ merged (#24) | `subscribers.delete` (ISP Admin only), readable validation messages, FUP/“1 day” wording |
| 3.1 Reseller tree | ✅ merged (#25) | Any depth (max 10), codes R-0001, move/suspend/delete, branch scoping |
| 3.2 Wallet prices | ✅ #26 | `reseller_rates`: parent sets the child's wallet price (default MRP) and what it may sell; the reseller sets its own customer price |
| 3.3 Wallets and ledger | ✅ #26 | Master per ISP + one per reseller (created with it; migration 007 backfills). Conditional `$inc` in a transaction + ledger entry (before/after) per movement; transfers idempotent; credit limit; frozen/inactive wallets move nothing |
| 3.4 Recharge, refund, low balance | ✅ #26 | Debit of the recharging level only; "Insufficient Wallet Balance" with nothing changed; low-balance warning at the threshold (default Rs. 5,000), blocked at zero; refund = REFUND entry + credit note + expiry rollback; dashboards |
| 3.5 Prepaid recharges | ✅ #26 | max(now, expiry) + validity to 23:59:59 IST; Radius sync + CoA (speed back without reconnecting); channels: reseller wallet, cash, complimentary, online |
| 3.6 GST invoicing | ✅ #26 | `PREFIX/2627/00001` (≤ 16 chars, consecutive per FY), CGST+SGST in state / IGST out of state, half-up rounding, rupee round-off, credit notes, PDF. ISP issues at the customer price (default) |
| 3.7 Postpaid billing | ✅ #26 | Invoice on the 1st for the previous month (pro rata for new joiners, idempotent), due 7th, grace 3 days (settings), then suspended + Disconnect; payment reactivates |
| 3.8 Payment gateways | ✅ #26 (needs O-8 keys) | Razorpay + Cashfree payment links; webhook signature on the raw body, status confirmed with the gateway, settled once; hourly check for lost webhooks; reseller customer: top up that reseller, then recharge |
| 3.9 Cash payments | ✅ #26 | Cash recharge (staff), cash against an invoice; idempotent |
| 3.10 SMS | ✅ #26 (needs O-7 DLT templates) | Queue with 3 attempts and backoff; provider URL template (RapidSMS HTTP API); DLT templates with `{#var#}`; reminders, expired, receipt, invoice, overdue |
| 3.11 Reconciliation | ✅ #26 | Nightly: balance = Σ ledger, chain, transfer legs, recharge entries; mismatch freezes; alerts `WalletFrozen`, `BillingJobFailing`, `SmsFailing` |
| 3.12 Reseller panel | ✅ #26 | Reseller sign-ins (reseller roles); same panel, menu by permission, branch-only data; wallet dashboard, send money to sub-resellers, recharge, prices, sub-resellers, customers |
| 3.13 Admin billing screens | ✅ #26 | Wallets, ledger, date-wise report, recharges, invoices, payments, billing settings, SMS log |
| 3.14 Money tests | ✅ #26 | `apps/api/test/money.int.test.ts`, `apps/workers/test/billing.int.test.ts`, `packages/db-mongo/src/billing/money.test.ts`, isolation harness |
| 3.15 Gate review | ⏳ | Owner on staging (below) |

## Gate checklist (PRD Step 3 — 14 items)

| # | Item | Automated proof (CI) | Staging check |
|---|---|---|---|
| 1 | Worked example gives exactly L1 30,000 / L2 65,000 | money: *accounts team worked example* | ✅ 10 Nov (owner's variant: L1 50,000 / L2 69,900; issued 1,20,000 = held + recharges) |
| 2 | Recharge/allocation above the balance refused, nothing deducted | money: *larger than the balance* | ◑ transfer above balance refused 10 Nov; recharge at zero ⏳ |
| 3 | Two simultaneous recharges cannot overspend; same key debits once | money: *simultaneous recharges* | ✅ 10 Nov (double-click → one recharge, one ledger debit) |
| 4 | Refund adds REFUND, restores balance, marks REVERSED, deletes nothing | money: *refund* | ◑ 10 Nov: REFUND entry, balance restored, invoice cancelled + CN; expiry rollback to confirm |
| 5 | Low-balance warning at threshold; blocked at zero | money: *larger than the balance*, *blocked at zero* | ◑ warning at threshold 10 Nov (at or below); blocked at zero ⏳ |
| 6 | Reseller sees/changes only its branch (API calls) | money: *scope*; resellers.int; isolation harness | ⏳ |
| 7 | Reseller creates sub-retailers and customers; ISP moves a branch | resellers.int | ✅ (7 Nov, WP 3.1 staging) |
| 8 | Prepaid renewal from the right date, speed back at once | money: *renewal* (CoA row) | ◑ dates ✅ 9 Nov (9 Nov → 8 Dec → 7 Jan); speed restore ⏳ CHR lab |
| 9 | Postpaid invoice on the 1st, right GST split in/out of state | money: *GST*, *postpaid* | ⏳ run job on VPS |
| 10 | Overdue blocked + disconnected after grace; payment reactivates | money: *postpaid* | ⏳ run job on VPS + CHR lab |
| 11 | Webhook twice → one payment; failed payment changes nothing | money: *Razorpay*, *failed payment*, *Cashfree* | ◑ dashboard test events acknowledged (#27); Razorpay resend + failed payment ⏳ |
| 12 | Razorpay and Cashfree test payments end to end | mock gateway in CI | ✅ 9 Nov: both ₹589 (499 + 18 %), channel Online, expiry extended |
| 13 | SMS for reminder, invoice, receipt; failures retried and logged | workers billing.int | ⏸ deferred until DLT templates (O-7) |
| 14 | Every wallet balance equals the sum of its ledger | money: *reconciliation*; nightly job | ⏳ run reconcile on VPS |

## Staging findings (9–10 Nov)

| Finding | Fix |
|---|---|
| Cashfree dashboard "Test" webhook → 500 (empty `$or`, no payment link) | #27: unknown/test events acknowledged and ignored |
| Wallet Recharges card/column showed gross after a refund | #28: net of refunds, refunded amount as hint |
| Adjust dialog defaulted to Credit, so an intended debit was credited | #29: direction must be chosen; button shows the effect and new balance |
| Subscriber edit cleared its reseller (once, 7 Nov) | ⏳ not reproduced; needs that subscriber's History |

Low balance is "at or below" the threshold (by design).

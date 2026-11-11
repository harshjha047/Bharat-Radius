# Step 4 — Customer portal, reports, compliance and go-live

Started 11 Nov 2026. Plan: IMPLEMENTATION_PLAN §6.

## Work packages

| WP | Status | Notes |
|---|---|---|
| Step 3 carry-over: reseller cleared on edit | 🔀 PR #31 | Root cause: clearing the reseller chip sent `resellerId: null`; now only an explicit change is sent, with a warning + undo |
| 4.1 Customer portal | 🔀 PR | Password sign-in (PPPoE password until a portal password is set), home/usage/bills/account, online pay + plan change (prepaid). OTP sign-in waits on O-7. Runbook `docs/runbooks/portal.md` |
| 4.2 Walled-garden pay page | ⏳ O-12, O-7 | `/pay` links to the portal meanwhile |
| 4.3 Tickets | ⏳ | |
| 4.4 Reports + GSTR export | ⏳ | |
| 4.5 KYC/CAF | ⏳ O-18 | |
| 4.6 Compliance logs | ⏳ O-12, O-11 | |
| 4.7 Importer | ⏳ O-10 | |
| 4.8 Backups/DR | ⏳ O-18 | |
| 4.9 Alerts | ⏳ | |
| 4.10–4.15 | ⏳ | |

## Staging checks — 4.1

1. Deploy, then open `https://new.bharatradius.com/portal/login`.
2. Sign in as `test.sub` with its PPPoE password (Subscriber → ⋯ → Show PPPoE password). Home shows *Test 100*, status, *Recharge ₹…*.
3. Sign in with the customer no. instead of the username — works.
4. Wrong password 5× → "Too many attempts".  Staff: Subscriber → ⋯ → *Reset portal password* → can sign in again.
5. Usage tab: chart + recent connections (use `test.lab` after a CHR dial for real data).
6. Bills tab: invoices list; *PDF* opens the invoice. Another customer's invoice id in the URL → not found.
7. Home → *Recharge* → Razorpay test page → pay with test card/UPI `success@razorpay` → back on the portal, *Valid until* moved by 30 days; Bills shows the payment as Paid.
8. Home → *Change plan* → another plan → Razorpay → after payment Home shows the new plan.
9. Account → set a portal password → the PPPoE password no longer signs in to the portal; the router still dials.
10. Phone width: bottom navigation, tables as cards.

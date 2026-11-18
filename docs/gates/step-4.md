# Step 4 — Customer portal, reports, compliance and go-live

Started 11 Nov 2026. Plan: IMPLEMENTATION_PLAN §6.

## Work packages

| WP | Status | Notes |
|---|---|---|
| Step 3 carry-over: reseller cleared on edit | 🔀 PR #31 | Root cause: clearing the reseller chip sent `resellerId: null`; now only an explicit change is sent, with a warning + undo |
| 4.1 Customer portal | 🔀 PR | Password sign-in (PPPoE password until a portal password is set), home/usage/bills/account, online pay + plan change (prepaid). OTP sign-in waits on O-7. Runbook `docs/runbooks/portal.md` |
| 4.2 Walled-garden pay page | ⏳ O-12, O-7 | `/pay` links to the portal meanwhile |
| 4.3 Tickets | 🔀 PR (stacked on 4.1) | Staff list/detail with assign, internal notes, status; portal Help; reseller branch scope; new Technician role. Runbook `docs/runbooks/tickets.md` |
| 4.4 Reports + GSTR export | 🔀 PR (stacked on 4.3) | Revenue, collections, subscribers, reseller sales, usage, tickets; Excel/PDF; GSTR-1 workbook (offline-tool layout). Runbook `docs/runbooks/reports.md`. Accountant to check the first GSTR-1 (O-9) |
| 4.5 KYC/CAF | ⏳ O-18 | |
| 4.6 Compliance logs | 🔀 PR | Archive (3 years, sealed daily), router syslog + NAT logs (opt-in per router, `mikrotik/logging.rsc`), NAT IP lookup in the panel (audited), access log, `radpostauth` 1,100 days. UDP 514 still to open. Runbook `docs/runbooks/compliance-logs.md` |
| 4.7 Importer | 🔀 PR | O-10 received 18 Nov (dump restored as `bharatradius_legacy` on the VPS: 7 sites, 22 plans, 4 routers, 136 subscribers, cleartext PPPoE passwords). `cli.js import-legacy` (dry run / `--apply` / `--sites`), re-runnable delta, reconciliation. Runbook `docs/runbooks/legacy-import.md` |
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

## Staging checks — 4.3

1. Portal as `test.sub` → Help → *Report a problem* → No internet → Send. Ticket `T000001` shows, status Open.
2. Panel → Tickets → *Active* shows it (High). Open it → Assigned to: yourself → *Assigned to me* lists it.
3. Add an **Internal note**, then a normal reply with status *Waiting for customer*.
4. Portal: the reply and status change are visible, the note is not.
5. Portal: reply → panel shows status back to Open. Panel: Resolved. Portal: *close ticket* → Closed; reply box gone.
6. Sign in as Test L2 (reseller): Tickets shows only its customers' tickets; New ticket requires a customer from its branch.
7. Staff & roles: a user with the *Technician* role sees Tickets and Subscribers (read) only, and cannot assign.

## Staging checks — 4.4

1. Reports → Revenue → *This month*: totals match Invoices for the same days (sum of the Total column).
2. Collections: matches Payments filtered to Paid for the same days.
3. Subscribers: Active + Expired + Suspended + Disabled = subscriber count.
4. Reseller sales → *Last 7 days*: Test L2's wallet debits match its wallet ledger RECHARGE entries.
5. Excel and PDF buttons download; the Excel opens with numbers (sum a column in Excel).
6. GSTR-1 → previous month → Download: open it; `b2cs` has one row per state/rate; `docs` shows the INV series. Accountant reviews.
7. Sign in as Test L2: Reports show only its branch; no Usage tab, no GSTR-1 card.

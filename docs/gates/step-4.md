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
| F-15 Expired handling | 🔀 PR | Per-ISP *When validity runs out*: Disconnect (default) or Slow speed + pay page. Reject reason `Subscriber account expired`; `expired-sweep` job disconnects expired online sessions every 5 min |
| F-10/16 Username case, Excel dates | 🔀 PR (stacked on F-15) | Usernames unique and matched ignoring case (PG `lower()` index + Mongo collation); accounting/auth log store the subscriber's own spelling. Excel `expires_on` day-first (`12/10/2026`, `12-10-2026`, `12.10.2026`) |
| F-5/12/13 Recharge quantity + period | 🔀 PR (stacked on F-10/16) | Recharge dialog: Periods 1–6, 12 (price × N, one invoice line), Starts / Valid until shown before confirming. History: Period start → end, × N, Recharged by |
| F-2/3 RADIUS log | 🔀 PR (stacked on F-5/12/13) | Network → RADIUS log: Auth log (search, Accept/Reject, reason, router, period, auto-refresh, *Why?* with fix + similar usernames) and Live (start/pause/stop, user/text/type filter, full screen, download); subscriber → Login log → *Live RADIUS log* |
| F-4/11 Dashboard config + live cards | 🔀 PR (stacked on F-2/3) | *Customise* on staff and reseller dashboards (per user, saved on the server). New cards: Pending recharge (expired), Login rejects (24 h), month recharge count. Expired rows tinted red in the subscriber list |

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

## Staging checks — F-15 expired handling

Deploy order: `sudo bash radius/scripts/install.sh staging` (migration 004 + functions) **before** `app-up.sh`.

1. Settings → *When validity runs out* shows **Disconnect (no internet)**.
2. Subscriber `test.lab`: set Valid until to yesterday while dialled in (CHR lab) → within 5 min the session drops; Activity shows *disconnect · expired*.
3. Redial → rejected; login history reason *Subscriber account expired*.
4. Switch the setting to *Slow speed + pay page* → redial → online at 256k, reason *Plan expired*. Switch back.
5. Recharge `test.lab` → dials normally.

## Staging checks — F-10/16

Deploy: `install.sh staging` (migration 005) then `app-up.sh` (Mongo 015). Either stops with the clashing names if two usernames differ only in case.

1. Add subscriber `Test.Lab` while `test.lab` exists → *This PPPoE username is already used*.
2. CHR lab: dial as `TEST.LAB` → accepted; Sessions shows `test.lab`; Kick works.
3. Portal sign-in as `TEST.LAB` → works.
4. Excel import with `expires_on` `12/10/2026` → Valid until 12 Oct 2026; `31/02/2026` → row error.

## Staging checks — F-5/12/13

1. Subscriber `test.sub` (active, valid until D) → Recharge → Periods **3 ×** → Starts = D, Valid until = D + 90 days, customer pays 3 × price incl. GST.
2. Confirm → invoice PDF: one line, qty 3, period D – D+90.
3. Recharges (and the subscriber's history): *Period* D → D+90 with “× 3”; *Recharged by* = your name.
4. Expired subscriber → Starts = now.
5. As Test L2 with a balance below 3 × its price → *Insufficient Wallet Balance*, nothing debited.

## Staging checks — F-2/3

Deploy: `install.sh staging` (migration 006: pg_trgm + indexes) then `app-up.sh`.

1. Network → RADIUS log → Auth log: today's attempts newest first; counts accepted / rejected.
2. Filter *Rejected* → reason list shows counts; pick *Wrong password* → only those rows.
3. CHR lab: dial `test.lab` with a wrong password → row appears within 30 s (auto-refresh) → *Why?* → *Wrong password* + fix; Technical details show router, MAC, *In the database: Yes*.
4. Dial `test.lob` → *Why?* → *No such username*, similar usernames lists `test.lab`.
5. Live tab → dial / hang up `test.lab` → ACCEPT, START, STOP lines within ~2 s. *This user only* = `test.lab` → only its lines. Pause / Stop / Start; Esc leaves full screen; download saves a .txt.
6. Subscriber `test.lab` → Login log → *Live RADIUS log* opens Live filtered to it.
7. Sign in as Test L2 (reseller): no RADIUS log menu.

## Staging checks — F-4/11

1. Dashboard → *Customise* → untick *Network charts* and *Plans* → Save → both gone; sign in on another browser → still gone. *Show all* → back.
2. Cards: *Pending recharge* = Expired count on Renewals → opens Subscribers filtered to Expired. *Login rejects* opens RADIUS log → Rejected. *Today’s recharges* hint shows today and this month.
3. Subscribers list: an expired active customer's row is tinted red with the date in red.
4. Sign in as Test L2: *Customise* lists only reseller cards; Renewals tiles show its branch only.

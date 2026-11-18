# Step 4 — Customer portal, reports, compliance and go-live

Started 11 Nov 2026. Plan: IMPLEMENTATION_PLAN §6.

## Work packages

| WP | Status | Notes |
|---|---|---|
| Step 3 carry-over: reseller cleared on edit | 🔀 PR #31 | Root cause: clearing the reseller chip sent `resellerId: null`; now only an explicit change is sent, with a warning + undo |
| 4.1 Customer portal | 🔀 PR | Password sign-in (PPPoE password until a portal password is set), home/usage/bills/account, online pay + plan change (prepaid). OTP sign-in waits on O-7. Runbook `docs/runbooks/portal.md` |
| 4.2 Walled-garden pay page | 🔀 PR | `:8089` → `/api/v1/pay/entry`: router found by its public address; the one expired customer online behind it is shown (masked) with *Pay ₹…* (renews the current plan); otherwise lookup by username / customer no. / mobile, accepted only if online behind that router. Signed 30-min token; no OTP needed (O-7 later for any-account lookup). Runbook `docs/runbooks/pay-page.md` |
| 4.3 Tickets | 🔀 PR (stacked on 4.1) | Staff list/detail with assign, internal notes, status; portal Help; reseller branch scope; new Technician role. Runbook `docs/runbooks/tickets.md` |
| 4.4 Reports + GSTR export | 🔀 PR (stacked on 4.3) | Revenue, collections, subscribers, reseller sales, usage, tickets; Excel/PDF; GSTR-1 workbook (offline-tool layout). Runbook `docs/runbooks/reports.md`. Accountant to check the first GSTR-1 (O-9) |
| 4.5 KYC/CAF | ⏳ O-18 | |
| 4.6 Compliance logs | 🔀 PR | Archive (3 years, sealed daily), router syslog + NAT logs (opt-in per router, `mikrotik/logging.rsc`), NAT IP lookup in the panel (audited), access log, `radpostauth` 1,100 days. UDP 514 still to open. Runbook `docs/runbooks/compliance-logs.md` |
| 4.7 Importer | 🔀 PR | O-10 received 18 Nov (dump restored as `bharatradius_legacy` on the VPS: 7 sites, 22 plans, 4 routers, 136 subscribers, cleartext PPPoE passwords). `cli.js import-legacy` (dry run / `--apply` / `--sites`), re-runnable delta, reconciliation. Runbook `docs/runbooks/legacy-import.md` |
| 4.8 Backups/DR | ✅ #36 + PR | Nightly age-encrypted backups (#36). O-18 = Backblaze B2 (owner, 18 Nov; no India region; lawyer to confirm under O-11). Follow-up PR: log archive days older than 60 days moved to B2 (gzip, not encrypted by owner's choice; SHA-1 verified; `fetch` brings days back), `LogOffloadStuck` alert. Setup: `docs/runbooks/backups.md` → Backblaze B2. Restore drill ⏳ |
| 4.9 Alerts | ✅ #35 + PR | #35 (11 Nov): synthetic RADIUS login every minute, `RadiusLoginProbeFailing`/`Slow`/`Stale`, `OutboxErrors`, `ReconcileStale`, `BackupMissing`/`NeverRan` (resolve with 4.8). Follow-up PR: `WalledGardenDown` (blackbox on `:8089` expects 302 → `/pay`), `WorkerJobFailing` (expired-sweep, imports, expiry-reminders, usage), `ExpiredSweepStale` |
| Disk guard | 🔀 PR | Every 5 min: ≥ 70 % drill (imports/rebuilds paused, cache + old logs/backups to B2 after verify), ≥ 85 % maintenance page (RADIUS, webhooks, pay page keep running), ≥ 95 % 5 GB reserve released. Runbook `docs/runbooks/disk-guard.md` |
| 4.10–4.15 | ⏳ | |
| F-15 Expired handling | 🔀 PR | Per-ISP *When validity runs out*: Disconnect (default) or Slow speed + pay page. Reject reason `Subscriber account expired`; `expired-sweep` job disconnects expired online sessions every 5 min |

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

## Staging checks — 4.2 pay page

Needs: Settings → *When validity runs out* = **Slow speed + pay page**; Razorpay test keys enabled; CHR lab.

1. From any outside machine: `curl -si http://154.49.142.251:8089/` → `302` to `https://new.bharatradius.com/pay`.
2. `test.lab`: set Valid until to yesterday; `sudo bash deploy/ubuntu/lab/chr-lab.sh dial` → online at the expired speed.
3. From behind the CHR (or by `curl -si --interface <CHR WAN>`), open `http://example.com` → pay page with *t•••.l••*,
   customer number, *Expired*, plan and *Pay ₹…* incl. GST.
4. *Pay* → Razorpay test page → pay → within a minute the recharge appears, the session redials at full speed.
5. *Not you?* → enter another username not online behind that router → *No connection with those details…*.
6. Open the pay link again after 30 minutes → *This page has expired*.


# Step 4 — Customer portal, reports, compliance and go-live

Started 11 Nov 2026. Plan: IMPLEMENTATION_PLAN §6.

## Work packages

| WP | Status | Notes |
|---|---|---|
| Step 3 carry-over: reseller cleared on edit | ✅ #31 | Root cause: clearing the reseller chip sent `resellerId: null`; now only an explicit change is sent, with a warning + undo |
| 4.1 Customer portal | ✅ #32 · OTP ⏳ O-7 | Password sign-in (PPPoE password until a portal password is set), home/usage/bills/account, online pay + plan change (prepaid). OTP sign-in waits on O-7. Runbook `docs/runbooks/portal.md` |
| 4.2 Walled-garden pay page | ✅ #64 · router redirect ⏳ O-12 | `:8089` → `/api/v1/pay/entry`: router found by its public address; the one expired customer online behind it is shown (masked) with *Pay ₹…* (renews the current plan); otherwise lookup by username / customer no. / mobile, accepted only if online behind that router. Signed 30-min token; no OTP needed (O-7 later for any-account lookup). Runbook `docs/runbooks/pay-page.md` |
| 4.3 Tickets | ✅ #33 | Staff list/detail with assign, internal notes, status; portal Help; reseller branch scope; new Technician role. Runbook `docs/runbooks/tickets.md` |
| 4.4 Reports + GSTR export | ✅ #34, F-14 | Revenue, collections, subscribers, reseller sales, usage, tickets; Excel/PDF; GSTR-1 workbook (offline-tool layout). Runbook `docs/runbooks/reports.md`. Accountant to check the first GSTR-1 (O-9) |
| 4.5 KYC/CAF | 🔀 PR | Files AES-256-GCM encrypted by the API, local disk or B2 (`files-setup.sh`); upload (staff, resellers, portal), audited viewing, verify/reject, CAF PDF with number, `import-kyc` for old files. Runbook `kyc.md` |
| 4.6 Compliance logs | ✅ #47 · UDP 514 ⏳ O-12 | Archive (3 years, sealed daily), router syslog + NAT logs (opt-in per router, `mikrotik/logging.rsc`), NAT IP lookup in the panel (audited), access log, `radpostauth` 1,100 days. UDP 514 still to open. Runbook `docs/runbooks/compliance-logs.md` |
| 4.7 Importer | ✅ #54, #55 | O-10 received 18 Nov (dump restored as `bharatradius_legacy` on the VPS: 7 sites, 22 plans, 4 routers, 136 subscribers, cleartext PPPoE passwords). `cli.js import-legacy` (dry run / `--apply` / `--sites`), re-runnable delta, reconciliation. Runbook `docs/runbooks/legacy-import.md` |
| 4.8 Backups/DR | ✅ #36, #66 · restore drill ⏳ | Nightly age-encrypted backups (#36). O-18 = Backblaze B2 (owner, 18 Nov; no India region; lawyer to confirm under O-11). Follow-up PR: log archive days older than 60 days moved to B2 (gzip, not encrypted by owner's choice; SHA-1 verified; `fetch` brings days back), `LogOffloadStuck` alert. Setup: `docs/runbooks/backups.md` → Backblaze B2. Restore drill ⏳ |
| 4.9 Alerts | ✅ #35, #65 | #35 (11 Nov): synthetic RADIUS login every minute, `RadiusLoginProbeFailing`/`Slow`/`Stale`, `OutboxErrors`, `ReconcileStale`, `BackupMissing`/`NeverRan` (resolve with 4.8). Follow-up PR: `WalledGardenDown` (blackbox on `:8089` expects 302 → `/pay`), `WorkerJobFailing` (expired-sweep, imports, expiry-reminders, usage), `ExpiredSweepStale` |
| Disk guard | ✅ #67 | Every 5 min: ≥ 70 % drill (imports/rebuilds paused, cache + old logs/backups to B2 after verify), ≥ 85 % maintenance page (RADIUS, webhooks, pay page keep running), ≥ 95 % 5 GB reserve released. Runbook `docs/runbooks/disk-guard.md` |
| F-1…F-14 | ✅ #68 | #57–#63 were merged into their stacked bases and never reached `main`; landed here together |
| F-7 Billing models, top-up requests, recharge edits | ✅ #69 | Per child reseller (set by its parent): *Prepaid top-up* (wallet price per plan) or *Revenue share* (debit % of plan price excl. GST). Resellers request top-ups from the wallet above (Master → Reseller → LCO); parent approves (a normal transfer, once) or rejects. Recharge popup: price (incl. GST, whole rupees) and valid-until editable with `recharges.override` (ISP Admin, Reseller Owner) and a reason; wallet debit unchanged; a reseller cannot extend past the paid period |
| F-8 Reseller name and logo | 🔀 PR (with 4.5) | Reseller → Branding or own My account; panel header and its customers' portal; inherited down the tree |
| 4.10–4.15 | ⏳ | |
| F-15 Expired handling | ✅ #56 | Per-ISP *When validity runs out*: Disconnect (default) or Slow speed + pay page. Reject reason `Subscriber account expired`; `expired-sweep` job disconnects expired online sessions every 5 min |
| F-10/16 Username case, Excel dates | ✅ #68 | Usernames unique and matched ignoring case (PG `lower()` index + Mongo collation); accounting/auth log store the subscriber's own spelling. Excel `expires_on` day-first (`12/10/2026`, `12-10-2026`, `12.10.2026`) |
| F-5/12/13 Recharge quantity + period | ✅ #68 | Recharge dialog: Periods 1–6, 12 (price × N, one invoice line), Starts / Valid until shown before confirming. History: Period start → end, × N, Recharged by |
| F-2/3 RADIUS log | ✅ #68 | Network → RADIUS log: Auth log (search, Accept/Reject, reason, router, period, auto-refresh, *Why?* with fix + similar usernames) and Live (start/pause/stop, user/text/type filter, full screen, download); subscriber → Login log → *Live RADIUS log* |
| F-4/11 Dashboard config + live cards | ✅ #68 | *Customise* on staff and reseller dashboards (per user, saved on the server). New cards: Pending recharge (expired), Login rejects (24 h), month recharge count. Expired rows tinted red in the subscriber list |
| F-14 Recharges and expiries report | ✅ #68 | Reports → *Recharges and expiries*: recharges, users recharged, expired in period (renewed later / still not), pending now, expiring 7 d, new; by day, by month, by package; recharge list with start/end (Excel/PDF). Presets add *Today* and *This year* |
| F-1 Live router monitoring | ✅ #68 | Routers → router: API login (encrypted), router health, live traffic per interface (2 s), latency (ping from router), PPPoE online router vs RADIUS, ports for the dashboard. Dashboard *NAS statistics*; subscriber *Live speed*. Own RouterOS API client: one session per router, ≤ 3 commands at once, identical polls shared, 15 s cap, offline reported in < 2 s |
| F-6 Login as site | ✅ #68 | Reseller page → *Open panel*: staff with *resellers.write*, or a parent reseller, works inside the child's panel (rights = own ∩ reseller rights); dark *Back to Admin* bar goes back one level; per browser tab; changes audited as “Name (as R-0004)” |

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

## Staging checks — F-14

1. Reports → *Recharges and expiries* → *This month*: Summary *Recharges* = Recharges page count for the month (excluding refunded); *Users recharged* ≤ that.
2. *Expired in the period* = *renewed later* + *still not renewed*; *still not renewed* matches Subscribers → *Expired this month*.
3. *By day* and *By month* tables; *By package* totals = Recharges.
4. Recharge list shows Start → End per recharge; Excel download opens with the same rows.
5. Presets: *Today*, *This year* present.
6. As Test L2: only its branch.

## Staging checks — F-1

On the router (once): `/user group add name=bharat-api policy=api,read,test` · `/user add name=bharat group=bharat-api password=…` · `/ip service set api address=154.49.142.251/32` (and keep it closed to everyone else: Abhay-RB4011 has API open to the internet today).

1. Routers → Abhay-RB4011 → API login: user `bharat`, password, *Save and connect* → Router card shows identity, RouterOS, uptime, CPU, memory, *PPPoE online* router vs RADIUS.
2. Wrong password → card shows *API login refused…*; port blocked → *did not answer … within 2 s*.
3. Traffic: pick `ether1` → graph moves every 2 s; RX/TX now, avg/peak. Switch to the uplink → new graph.
4. Latency: 8.8.8.8 → current/avg/min/max/loss; enter another address → restarts.
5. Ports on the dashboard: tick uplink, label “Uplink” → Save → Dashboard *NAS statistics* shows it live.
6. Subscriber online on that router → Sessions tab → *Live speed* ↓/↑ moves; offline subscriber → *Not online*.
7. Open the router page in 5 tabs → router `/user active print` shows one API session from the panel.

## Staging checks — F-6

1. Resellers → Test L2 → *Open panel* → reseller dashboard of Test L2; bar “Viewing Test L2 (R-0004) as <you>”.
2. Recharge `test.sub` there → Test L2's wallet is debited; Recharges shows *Recharged by* = you; Audit shows “<you> (as R-0004)”.
3. Routers / Staff menus are absent (reseller rights only).
4. Inside Test L1's panel → its Resellers → Test L2 → *Open panel* → *Back to Admin* returns to Test L1, again → your own panel.
5. Another browser tab stays in your own panel.
6. Sign in as Test L2 → Test L1 has no *Open panel* (parent not reachable); a Support user gets no access.

## Staging checks — F-7

Deploy: `app-up.sh` (Mongo 016 `topup_requests`; built-in roles gain *recharges.override*).

1. Sign in as Test L1 → Resellers → Test L2 → Prices: *Billing model* = **Revenue share**, 40 → *Save model*. Wallet price column shows 40 % of each plan's MRP, read-only.
2. Sign in as Test L2: Prices shows *Revenue share · 40%*, no model selector. Recharge `test.sub` → *From your wallet* = ₹… (40% of plan price); confirm → wallet debited exactly that; Recharges → Wallet debit shows *40% share*.
3. As Test L1: set Test L2 back to **Prepaid top-up** → next recharge debits the per-plan wallet price again.
4. As Test L2: Wallets → *Request top-up* ₹500, UPI, UTR → *My top-up requests* shows Waiting; *Withdraw* works on a second one.
5. As Test L1: Wallets → *Top-up requests* (1 waiting) → *Approve*, change to ₹300 → Test L1 −₹300, Test L2 +₹300; both ledgers show *Top-up request*. Approve again is not offered.
6. As Test L1: *Request top-up* → staff Wallets → *Top-up requests* → *Reject* with a reason → Test L1 sees *rejected* + the reason.
7. Test L2 wallet below a recharge price → Recharge popup → *Insufficient Wallet Balance* + *Request top-up* (amount pre-filled with the shortfall).
8. Staff: Recharge `test.sub` → change *Customer pays* to 500, *Valid until* to a date of choice, reason → Recharge → invoice total ₹500, cash payment ₹500, Valid until = that date 11:59 pm; Recharges row shows *Edited · ₹500 (was ₹…)*. `500.50` → *Whole rupees*.
9. Test L2: *Valid until* later than the plan gives → *At most …: add periods*; earlier → accepted, wallet debit unchanged.
10. Support role (no *recharges.override*): popup shows the read-only totals as before.

## Staging checks — 4.5 KYC / CAF and F-8 branding

Deploy: `git pull && sudo bash deploy/ubuntu/app/app-up.sh` (Mongo 017; creates `/var/lib/isp-files`). Bucket
later: `docs/runbooks/kyc.md`.

1. Staff: subscriber → **KYC** tab → *Missing: identity proof, address proof, photo, signed CAF*.
2. *Create CAF form* → PDF opens, number `CAF/C…` shows next to the status.
3. Upload Aadhaar (number `1234 5678 9012`) as a JPEG → row shows `XXXX-XXXX-9012`; eye icon opens it.
   Audit log shows `kyc.view` with your name.
4. Upload a `.txt` renamed to `.jpg` → *Only JPEG, PNG, WebP or PDF files*. A 6 MB file → *Files up to 5 MB*.
5. *Verify* is disabled until photo and signed CAF are uploaded; then Verify → status *verified*.
   Reject needs a reason.
6. Trash icon → reason → file gone from the list; History shows the upload and the removal.
7. Sign in as Test L2: customer → KYC → can upload, no eye icon, no Verify. Another branch's customer → not found.
8. Portal (`test.sub`) → *Account* → KYC documents → upload PAN → staff see it with *by portal*.
9. Test L1 → *My account* → Branding: name *Test Fibre*, upload a logo → sidebar shows it. Test L2 and `test.sub`'s
   portal header show *Test Fibre* + logo; staff panel still shows BharatRadius. Test L2 sets its own name → it
   wins for L2 and its customers.
10. On the VPS: `sudo ls /var/lib/isp-files/kyc/*/*` lists files; `sudo head -c 5 <file>` prints `ISPF1` (encrypted).

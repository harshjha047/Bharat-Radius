# Billing runbook (Step 3)

Money engine: `packages/db-mongo/src/billing/`. API: `apps/api/src/billing/`. Jobs: `apps/workers/src/billing.ts` + `packages/db-mongo/src/billing/jobs.ts`.

## Jobs (isp-workers, lease-based, one replica runs each)

| Job | Every | Does |
|---|---|---|
| `notifications` | 10 s | Sends queued SMS; 3 attempts (1 min, 5 min, 30 min), then `failed` |
| `postpaid-invoice` | 30 min | Invoices every postpaid subscriber for the previous IST month (one per period, pro rata for new joiners) |
| `postpaid-overdue` | 1 h | Unpaid after due → `overdue`; after due + grace → subscriber suspended (`suspendReason: overdue`, Disconnect) |
| `expiry-reminders` | 1 h (from 10:00 IST) | Prepaid reminders N days ahead, "expired" notice the next day; once per day each |
| `reconcile-wallets` | 24 h | Balance = Σ ledger, unbroken before/after chain, transfer legs, recharge entries; mismatch freezes the wallet |
| `gateway-reconcile` | 1 h | Asks Razorpay/Cashfree about open links (last 48 h) and settles paid ones; closes links older than 8 days |

Status: `docker exec isp-workers wget -qO- http://127.0.0.1:4101/metrics | grep -E 'isp_job_|isp_wallets_frozen|isp_sms_'`

## Alerts

### WalletFrozen
A wallet's stored balance no longer matches its ledger (or a transfer/recharge has missing legs). No money moves in or out of it.

1. Panel → Wallets → **Frozen** tab → open the wallet: the red line gives the reason.
2. Find the cause in the ledger (and Audit log for `wallet.*`). Never edit `wallets` or `wallet_txns` by hand.
3. Correct with an **Adjust** entry (reason mandatory) if the ledger is right and the balance was wrong, or the other way round after checking with accounts.
4. **Unfreeze** (ISP staff with wallet adjustment rights). The next nightly run checks again.

### BillingJobFailing
`isp_job_failing{job=…} == 1` for 15 min. Logs: `docker logs isp-workers --since 1h | grep -i <job>`. Jobs are idempotent: after fixing the cause the next run catches up (no manual replay).

### SmsFailing
More than 20 SMS failed after all retries in 24 h. Panel → ISP settings → Billing, gateways & SMS → **SMS log** shows the provider's answer per message. Usual causes: wrong API key, sender ID / template not approved on DLT, provider balance.

## Payment gateways

- Keys: ISP settings → Billing → Payment gateways. Secrets are stored encrypted and never shown again.
- Webhook URLs are shown there; set them in the Razorpay / Cashfree dashboards with the same secret.
- A webhook is only trusted after its signature checks out **and** the gateway API confirms the link is paid.
- Lost webhook: the hourly `gateway-reconcile` settles it. Duplicate webhook: answered 200, nothing happens.
- A reseller's customer paying online: the amount tops up that reseller's wallet, then the recharge debits the reseller's wallet price (PRD §15 item 1 default).

## SMS (RapidSMS)

Settings → SMS: the provider's HTTP GET URL with placeholders `{apiKey} {sender} {entityId} {templateId} {to} {message}`, API key, 6-letter sender ID, optional success pattern (e.g. `^OK`). Each template is pasted exactly as approved on DLT with `{#var#}` placeholders, in the order the settings page lists.

## Money rules (for support questions)

- Prepaid renewal: new expiry = max(now, current expiry) + validity days, ending 23:59:59 IST.
- A recharge debits only the wallet of the level that performs it (its wallet price, default MRP).
- Recharges are refused with "Insufficient Wallet Balance" when the balance (plus credit limit) is short; nothing is deducted.
- Refund: REFUND ledger entry, credit note, expiry rolled back if it was the latest recharge. Nothing is deleted.
- Invoice numbers: `PREFIX/2627/00001`, consecutive per financial year; CGST+SGST when the customer's state is the ISP's GST state, otherwise IGST.

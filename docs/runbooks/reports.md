# Reports and GSTR-1 export (WP 4.4)

Panel → **Reports** (`reports.view`: ISP Admin, Accountant, Reseller Owner). IST calendar days; default *this month*; at most 400 days per report. Every report downloads as Excel (numbers stay numbers: rupees with paise, data in GB) or PDF (A4 landscape). Downloads are audited (`report.export`, `report.gstr1_export`).

| Report | Source | Notes |
|---|---|---|
| Revenue | `invoices` by issue date, `credit_notes` by date | Taxable, CGST, SGST, IGST, invoiced, credit notes, net; by day and by type |
| Collections | `payments` captured, by capture time | Cash / Razorpay / Cashfree / bank transfer per day |
| Subscribers | `subscribers` now | Active (valid), expired (prepaid past expiry), suspended, disabled; by plan; by owner; new in period; expiring in 7 days |
| Reseller sales | `recharges` by recharge date | Per recharging level: count, refunds, wallet debit, customer value incl. GST |
| Usage | PostgreSQL `usage_daily` | ISP staff only: daily totals, top 50 users |
| Tickets | `tickets` opened in period | Per category: opened, resolved, average first response and resolution (hours) |

A reseller gets the same reports limited to its branch (usage and GSTR-1 are ISP-only).

## GSTR-1

Reports → **GSTR-1 export** → month → *Download*. One workbook in the GST offline tool's sheet layout:

| Sheet | Contains |
|---|---|
| b2b | Invoices to buyers with a GSTIN, one row per GST rate |
| b2cl | Unregistered, inter-state, invoice value > ₹1,00,000 |
| b2cs | All other unregistered supplies, summed per place of supply and rate, **net of their credit notes** |
| cdnr / cdnur | Credit notes to registered buyers / on B2CL invoices |
| hsn(b2b), hsn(b2c) | SAC summary (UQC `NA`), credit notes subtracted |
| docs | Invoice and credit-note series: first, last, count |

Built from the stored invoice snapshots (seller/buyer/place of supply at issue time), so later edits to a customer never change a filed month. Dates `dd-MMM-yyyy` IST; place of supply `07-Delhi`.

**Before filing:** the accountant compares the summary (invoices, taxable, IGST, CGST+SGST) with the books for the first month and confirms SAC/rate (O-9). Import the sheets into the GST offline tool (or copy into its template), validate there, then upload.

## Financial insights

**Insights** (sidebar) or `GET /api/v1/reports/insights?from&to`; a summary card sits on the dashboard (last 30 days). Excel/PDF: report `financial`. Needs `reports.view`; a reseller sees its branch (no wallet alerts). Results are cached per ISP/branch and range for 60 s.

| Figure | How it is worked out |
|---|---|
| Net revenue | Invoice taxable value − credit-note taxable value (before GST), compared with the previous period of the same length |
| Payments collected | Captured payments, excluding `wallet` |
| Revenue per paying subscriber | Net revenue ÷ distinct subscribers invoiced in the period |
| Renewal rate | Renewed ÷ (renewed + lapsed). Renewed: a successful recharge extended an expiry that fell in the period (renewals up to 62 days early count). Lapsed: active prepaid still on an expiry in the period that has passed |
| Refunded recharges | Reversed ÷ all recharges in the period |
| Postpaid collection rate | Paid ÷ (billed − credited) on postpaid invoices due in the period |
| Receivables ageing | Open invoices (`issued`, `partially_paid`, `overdue`) by days past the due date, as of now |
| Reseller margin | Customer price before GST − wallet price, for recharges by a reseller wallet |
| Next 30 days | Prepaid renewals due (plan price) × renewal rate (80% with no history) + postpaid monthly run-rate |
| Run-rate, active base | Valid subscribers × plan price × 30 ÷ validity days |

Alerts: revenue or collections down ≥15% (≥30% critical), refunds ≥5% (≥10% critical), renewal rate <70% (<50% critical) or down ≥10 points, any balance over 90 days (critical), overdue ≥20% of billing, unusual days (modified z-score ≥3.5 over ≥14 days), frozen or low reseller wallets, one reseller ≥50% of reseller sales, expiries in the next 7 days. Thresholds live in `apps/api/src/reports/insights-calc.ts`.

Indexes: migration `012_insight_indexes`.

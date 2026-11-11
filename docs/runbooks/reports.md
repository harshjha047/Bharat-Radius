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

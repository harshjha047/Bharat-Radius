# Customer portal (WP 4.1)

`https://new.bharatradius.com/portal` — customers of the ISP (direct and reseller customers).

## Sign-in

| | |
|---|---|
| Login | PPPoE username **or** customer no. (`C000123`) |
| Password | The PPPoE password until the customer sets a portal password (Account → Set a portal password). After that only the portal password works on the portal; the PPPoE password keeps working on the router |
| Tenant | From the host (`branding.domain`); `tenant` in the body overrides (API only) |
| Lockout | 5 wrong passwords / 15 min per customer, 20 per IP (same settings as staff: `LOGIN_*`) |
| Session | Random token in `isp_pt` (HttpOnly, Secure, SameSite=Strict, path `/api/v1/portal`); only its peppered HMAC is in `portal_sessions`. Idle 7 days, max 30 days. CSRF: `isp_pcsrf` cookie → `x-csrf-token` header, bound to the session |
| Isolation | Portal cookies work only on `/api/v1/portal/*`; staff cookies never work there (unit test over the route table). Every portal query filters on the signed-in subscriber |
| OTP sign-in | After DLT approval (O-7) |

**Customer locked out / forgot password:** staff → Subscriber → ⋯ → *Reset portal password* (audited `subscriber.portal_reset`). Signs them out everywhere; they sign in again with the PPPoE password.

## What customers see

- **Home:** plan, speed, status (active / expires in ≤ 3 days / expired / suspended), *Recharge ₹…* (prepaid), amount due with *Pay* per invoice, *Change plan* (prepaid: pay for another plan → the recharge switches the plan and adds its validity; postpaid: "contact your provider" until tickets, WP 4.3).
- **Usage:** 31-day download/upload, data-cap bar (FUP), last 10 connections.
- **Bills:** invoices (PDF) and payments.
- **Account:** details, set/change portal password.

## Payments

`POST /portal/pay` creates a Razorpay (first enabled) or Cashfree link through the same code as staff links (`PaymentsService.createLink`); the amount is always computed on the server (customer price incl. GST, or the invoice balance). An unpaid link for the same purpose from the last 30 min is reused; at most 10 new links per customer per hour. Settlement is unchanged (webhook + hourly check). A plan whose reseller rate is inactive cannot be paid for (refused before payment, for staff links too).

No gateway enabled → the portal shows "pay your provider" instead of buttons.

## Checks

```bash
# Sessions (count, newest)
docker compose -f deploy/ubuntu/app/docker-compose.yml exec isp-mongo mongosh --quiet isp \
  --eval 'db.portal_sessions.countDocuments(); db.portal_sessions.find({}, {tokenHash:0}).sort({_id:-1}).limit(5)'
```

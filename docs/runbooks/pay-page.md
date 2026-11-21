# Walled-garden pay page (WP 4.2)

For ISPs whose *When validity runs out* setting is **Slow speed + pay page**. Expired customers are accepted at the
expired speed with address list `expired`; the router (`mikrotik/setup.rsc`) dst-nats their web traffic (TCP 80,
any host) to `154.49.142.251:8089`.

## Flow

1. `isp-walled-garden` (Caddy, `:8089`) rewrites every request to `GET /api/v1/pay/entry`. Captive-portal probes
   (Android, iOS, Windows) get the same redirect, so phones show the sign-in sheet.
2. The API sees the router's public address (customer traffic is masqueraded, so not the customer's). It finds the
   router by that address and asks Radius which customers are online behind it with their validity over.
   Exactly one → the pay page opens already showing that customer. None or several → the customer types a
   username, customer number or mobile; it is accepted only if that connection is online behind the same router.
3. The pay page shows the masked name, customer number, expiry, current plan and its price incl. GST, and one
   button: **Pay ₹…**. It opens the gateway's payment link (Razorpay or Cashfree, the first enabled; an unpaid link
   from the last 30 minutes is reused).
4. When the gateway confirms, the recharge is recorded and the session is disconnected so the router dials back in
   at full speed (outbox + CoA, as for any recharge).

The link from step 1 carries a signed token (HMAC, 30 minutes) naming the ISP, the router and, once known, the
customer. Plan changes and invoices stay in the customer portal; the pay page renews the current plan only.
No OTP: the proof is being online behind that router. OTP lookup for any account follows O-7.

## Requirements

- NetForChoice: TCP 8089 inbound open (O-12 ✅ 18 Nov).
- The router's public address (what the VPS sees) equals its NAS IP in the panel. A router that masquerades from
  another address gets the plain page (sign in to the portal instead).
- Settings → *When validity runs out* = **Slow speed + pay page**.
- Billing settings: Razorpay or Cashfree enabled.
- Strict walled garden only (`setup.rsc` `strict=true`): the gateway domains must be in `payDomains`.

## Checks

```bash
curl -si http://154.49.142.251:8089/generate_204 | head -3     # from outside: 302 to https://new.bharatradius.com/pay
docker logs --since 10m isp-walled-garden
```

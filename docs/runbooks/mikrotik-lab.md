# MikroTik lab test (WP 1.6, Step 1 items "real PPPoE dial-in" and "CoA on v6 and v7")

## Setup

1. Add the lab router as a NAS in **staging** (until the panel exists, as `postgres` on Ubuntu):

```sql
-- psql -d radius_staging
INSERT INTO tenants (slug, name) VALUES ('lab', 'Lab ISP') ON CONFLICT (slug) DO NOTHING;
INSERT INTO plans (tenant_id, name, rate_limit, fup_rate) SELECT id, 'lab-20M', '20M/20M', '2M/2M' FROM tenants WHERE slug='lab';
INSERT INTO nas (tenant_id, nasname, shortname, secret)
  SELECT id, '<router public/source IP>', 'lab-v7', '<random 20+ chars>' FROM tenants WHERE slug='lab';
INSERT INTO subscribers (tenant_id, username, password_enc, plan_id, expires_at)
  SELECT t.id, 'labuser1', radius_encrypt_password('<pppoe password>', :'key'), p.id, now() + interval '30 days'
  FROM tenants t JOIN plans p ON p.tenant_id = t.id WHERE t.slug='lab';
```
Run with `-v key="$RADIUS_PW_KEY"` from `/etc/isp-radius/staging.env`. Within 30 s the NAS watcher restarts FreeRADIUS.

2. On the router: edit the variables at the top of `mikrotik/setup.rsc` (`radiusSecret`, `authPort 11812`, `acctPort 11813`; `radiusIp` and `appIp` are both `154.49.142.251` for staging), upload, `/import file-name=setup.rsc`.

## Tests to record in docs/gates/step-1.md

| # | Do | Expect |
|---|---|---|
| 1 | Dial PPPoE (PAP, then CHAP, then MS-CHAPv2 in the client) | Connected; `/queue simple print` shows 20M/20M |
| 2 | `select * from radacct where username='labuser1' order by radacctid desc limit 1` | open row, framed IP, interim every 5 min |
| 3 | On the Ubuntu VPS: `coa rate labuser1 5M/5M --tenant lab` | `ack`; queue shows 5M/5M without reconnect |
| 4 | `coa kick labuser1 --tenant lab` | `ack`; client redials |
| 5 | `UPDATE subscribers SET expires_at = now() - interval '1 minute' WHERE username='labuser1'`; kick | Redials at 256k; `/ip firewall address-list print where list=expired` shows the IP; HTTP to any site lands on `:8089` → pay URL |
| 6 | Reboot the router | `NAS-Reboot` stop on open sessions |
| 7 | Repeat 1, 3, 4 on the RouterOS v6 router | same |

## Rollback

`/import file-name=remove.rsc`

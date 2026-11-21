# Connection types: PPPoE, Hotspot, Static IP (WP 5.9)

Each subscriber has a **connection type** (Subscriber → Edit → Connection type; Excel column `connection_type`;
list filter *Connection*). Existing subscribers are PPPoE.

| Type | Router service | How RADIUS finds the customer | Credential | Reply |
|---|---|---|---|---|
| PPPoE | PPPoE server (`/ppp aaa`) | username | password | rate, IP (static IP or plan pool), address list, Session-Timeout |
| Hotspot | Hotspot profile `use-radius=yes` | username typed on the login page | password | as PPPoE, but no `Framed-Pool` (the Hotspot profile owns pools) |
| Static IP | DHCP server `use-radius` | client **MAC** (DHCP sends it as User-Name) | the MAC | static IP, rate, address list, Session-Timeout ≤ 1 h (lease time) |

## Rules RADIUS enforces (`radius_check`)

- PPPoE account on a Hotspot login → *PPPoE account: Hotspot login not allowed*.
- Hotspot account dialling PPPoE → *Hotspot account: PPPoE login not allowed*.
- Static IP account: only by MAC from a DHCP server. Its username, or its MAC typed into PPPoE / Hotspot, is refused.
- Static IP has no simultaneous-use limit (one MAC = one device; lease renewals re-ask while the session is open).

The RADIUS log (*Why?*) shows these as **Wrong connection type**.

## Static IP specifics

- **MAC and static IP are required**, and each is unique per ISP while the subscriber exists (deleting frees both).
- Sessions and usage are stored under the subscriber's username, not the MAC (RouterOS v7 DHCP accounting).
- **No CoA**: MikroTik does not take CoA / Disconnect for DHCP leases. Suspend, expiry, plan or IP changes apply at
  the next lease renewal (lease = Session-Timeout, at most 1 hour). Router actions show *Applies at next DHCP renewal*.
- Expired with *walled* mode: the lease comes with the slow rate and the `expired` address list, so the pay page works.
- The customer portal uses the account ID (username) and the portal password, as for PPPoE.

## Router setup (`mikrotik/setup.rsc`)

Set before `/import`:

```
:local hotspotProfiles {"hsprof1"}     # Hotspot profiles to switch to RADIUS
:local dhcpServers {"dhcp-static"}     # DHCP servers for Static IP customers
```

The script adds `hotspot` / `dhcp` to the RADIUS entry's services, sets the Hotspot profile to RADIUS with accounting
every 5 minutes, and sets the DHCP server to `use-radius=accounting` (v7) or `yes` (v6, no accounting → no sessions
shown for Static IP on v6). For Static IP also make sure a `/ip dhcp-server network` covers the static IPs you give.
Unknown MACs get no lease from a RADIUS-enabled DHCP server: run Static IP customers on their own DHCP server / VLAN.

## Deploy

1. `sudo bash radius/scripts/install.sh <instance>` — PG migration `009_connection_type` (new column, default `pppoe`),
   new `radius_check` (old 3-argument call keeps working until FreeRADIUS reloads), new query file.
2. App deploy as usual — Mongo migration `019_connection_types` adds the unique static-MAC index.
3. Check: `SELECT conn_type, count(*) FROM subscribers GROUP BY 1;` → all `pppoe` until someone changes a subscriber.

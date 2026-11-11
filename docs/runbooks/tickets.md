# Tickets (WP 4.3)

Panel: **Tickets** (`/admin/tickets`). Portal: **Help** (`/portal/support`).

## Who can do what

| Role | Read | Reply / status | Assign |
|---|---|---|---|
| ISP Admin | ✓ | ✓ | ✓ |
| Support | ✓ | ✓ | ✓ |
| Technician *(new built-in role)* | ✓ | ✓ | — |
| Accountant | ✓ | — | — |
| Reseller Owner / Staff | own branch | own branch | — |
| Customer (portal) | own | reply, close | — |

Permissions `tickets.read`, `tickets.write`, `tickets.assign` are added to the built-in roles on the next deploy (roles sync on migrate). Custom roles: add them under Staff & roles. A ticket can be assigned to any active staff member whose role has `tickets.write`.

## Flow

1. Customer opens a ticket in the portal (≤ 5/hour), or staff/reseller opens one for a customer (*New ticket*, or Subscriber → *Tickets*). ISP staff may open internal tickets without a customer. *No internet* from the portal starts as **High**.
2. Support assigns (Assigned to) → technician sees it under *Assigned to me*.
3. Replies go to the customer; **Internal note** never does (portal shows messages and status changes only).
4. Status: Open → In progress → Waiting for customer → Resolved → Closed. A customer reply to a waiting or resolved ticket reopens it; a closed ticket cannot be replied to (customer opens a new one).
5. Numbers `T000001…` per ISP. Timeline in `ticket_events`; `firstResponseAt` (first reply the customer sees) and `resolvedAt` feed reports (WP 4.4).

No SMS on ticket updates yet: needs a DLT template (add to O-7 if wanted).

Concurrent edits: every change carries the ticket version; a stale one answers "The ticket changed meanwhile. Reload and try again."

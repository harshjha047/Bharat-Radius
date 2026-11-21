# KYC, CAF and reseller branding (WP 4.5, F-8)

## Storage

Every file (KYC document, signed CAF, reseller logo) is encrypted by the API with AES-256-GCM using
`FIELD_ENCRYPTION_KEY` (the object key is bound in as associated data) before it is written. The store only ever
holds ciphertext.

| Mode | When | Where |
|---|---|---|
| Local | no `/etc/isp-app/files.env` | `/var/lib/isp-files` (Docker volume of `isp-api`, mode 0700); nightly backup kind `files` |
| Bucket | `files.env` present | Backblaze B2 through its S3 API, prefix `isp-files/`; B2 keeps its own copies |

Switch to B2 (once):

1. B2 → *Buckets* → create a **private** bucket (e.g. `bharat-isp-files`). Note its endpoint (`s3.<region>.backblazeb2.com`).
2. B2 → *Application keys* → new key restricted to that bucket, read + write + delete.
3. On the VPS:
   ```
   cd ~/isp-platform
   sudo bash deploy/ubuntu/app/files-setup.sh https://s3.<region>.backblazeb2.com <region> <bucket> isp-files --migrate
   sudo bash deploy/ubuntu/app/app-up.sh
   ```
   Key ID and application key are asked with hidden prompts. `--migrate` copies files already on local disk.
4. Open any subscriber → KYC → open a document: it must display.

Losing `FIELD_ENCRYPTION_KEY` makes every file unreadable: it is in the nightly `etc` backup (age-encrypted).
Data outside India (B2 has no Indian region) waits on the lawyer (O-11).

## Who can do what

| Permission | Built-in roles | Allows |
|---|---|---|
| `kyc.upload` | ISP Admin, Support, Reseller Owner, Reseller Staff | Upload for customers in reach (branch for resellers) |
| `kyc.view` | ISP Admin, Support | Open files; every opening is written to the audit log (`kyc.view`) |
| `kyc.verify` | ISP Admin | Verify (needs identity, address proof, photo, signed CAF), reject with reason, remove a wrong file |
| `branding.manage` | ISP Admin, Reseller Owner | Name and logo of a reseller (itself or below) |

Customers upload their own documents in the portal (*Account*), until KYC is verified; they cannot open files.

Rules: JPEG, PNG, WebP or PDF, checked by content; 5 MB; at most 30 documents per customer. Numbers are stored
masked (`XXXX-XXXX-1234`); full Aadhaar numbers are never stored. Removing a file deletes it from storage; the
upload and removal stay in the record and audit log.

## CAF

Subscriber → KYC → *Create CAF form*: a pre-filled PDF (ISP, customer, address, plan, username, declaration incl.
DPDP consent). The CAF number `CAF/<customer no.>` is assigned the first time. Print, sign, upload as *Signed CAF*.

## Old CAF files (22 on the Bharat Radius server)

1. Copy the folder from the old server to the VPS (via your PC, as with the dump), e.g. `/var/lib/isp-migration/caf`.
   Name folders or files with the customer's username, customer number, phone or old subscriber id; words in the
   name pick the kind (aadhaar, pan, voter, passport, licence, photo, caf/form, address/bill; else *other*).
2. Dry run, then apply:
   ```
   cd ~/isp-platform/deploy/ubuntu/app
   docker compose cp /var/lib/isp-migration/caf api:/tmp/caf
   docker compose exec api node dist/cli.js import-kyc --tenant bharat --dir /tmp/caf
   docker compose exec api node dist/cli.js import-kyc --tenant bharat --dir /tmp/caf --apply
   docker compose exec api rm -rf /tmp/caf
   ```
   The report lists files with no or several matching customers; rename those and run again (already imported
   files are skipped by checksum).
3. Delete the plain copy: `sudo rm -rf /var/lib/isp-migration/caf`.

## Reseller branding (F-8)

Reseller page → *Branding* (staff, or the parent), or the reseller's own *My account*: display name (60 chars) and
logo (PNG/JPEG/WebP, 512 KB). The panel header and that reseller's customers' portal show it; sub-resellers inherit
the nearest parent's branding unless they set their own. "Powered by" stays. Logos are served publicly at
`/api/v1/branding/<id>/logo?v=<hash>` (cached for a year; a new upload changes the URL).

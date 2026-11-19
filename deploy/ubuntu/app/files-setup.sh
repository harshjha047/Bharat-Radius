#!/usr/bin/env bash
# Private file bucket for KYC / CAF / logos (WP 4.5): Backblaze B2 through its S3 API. Run once, then app-up.sh.
#   sudo bash deploy/ubuntu/app/files-setup.sh <endpoint> <region> <bucket> [prefix]
#   e.g. https://s3.us-west-004.backblazeb2.com us-west-004 bharat-isp-files
# Key ID and application key are asked for with hidden prompts (never in shell history or chat).
# Use a B2 application key restricted to this one bucket, with read+write+delete only. The bucket must be private.
# Files are encrypted by the API (FIELD_ENCRYPTION_KEY) before upload; B2 only ever stores ciphertext.
# Existing files on local disk (/var/lib/isp-files) are copied to the bucket with --migrate.
set -Eeuo pipefail
ETC=/etc/isp-app
die() { printf '\033[1;31m[files-setup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[1;34m[files-setup]\033[0m %s\n' "$*"; }
[[ $EUID -eq 0 ]] || die "run as root"
MIGRATE=0; args=()
for a in "$@"; do [[ $a == --migrate ]] && MIGRATE=1 || args+=("$a"); done
[[ ${#args[@]} -ge 3 ]] || die "usage: $0 <endpoint> <region> <bucket> [prefix] [--migrate]"
ENDPOINT="${args[0]}"; REGION="${args[1]}"; BUCKET="${args[2]}"; PREFIX="${args[3]:-isp-files}"
[[ $ENDPOINT =~ ^https:// ]] || die "endpoint must start with https://"
read -rsp 'B2 key ID: ' KEY_ID; echo
read -rsp 'B2 application key: ' SECRET; echo
[[ -n $KEY_ID && -n $SECRET ]] || die "key ID and application key are required"
install -d -m 0700 "$ETC"
umask 077
printf 'FILES_S3_ENDPOINT=%s\nFILES_S3_REGION=%s\nFILES_S3_BUCKET=%s\nFILES_S3_PREFIX=%s\nFILES_S3_KEY_ID=%s\nFILES_S3_SECRET=%s\n' \
  "$ENDPOINT" "$REGION" "$BUCKET" "$PREFIX" "$KEY_ID" "$SECRET" >"$ETC/files.env.new"
mv "$ETC/files.env.new" "$ETC/files.env"
chmod 0600 "$ETC/files.env"
log "saved $ETC/files.env (root-only)"
if [[ $MIGRATE == 1 && -d /var/lib/isp-files ]] && [[ -n $(ls -A /var/lib/isp-files 2>/dev/null) ]]; then
  command -v rclone >/dev/null || apt-get install -y -qq rclone >/dev/null
  log "copying existing encrypted files to $BUCKET/$PREFIX"
  RCLONE_CONFIG_B2F_TYPE=s3 RCLONE_CONFIG_B2F_PROVIDER=Other RCLONE_CONFIG_B2F_ENDPOINT="$ENDPOINT" \
    RCLONE_CONFIG_B2F_REGION="$REGION" RCLONE_CONFIG_B2F_ACCESS_KEY_ID="$KEY_ID" \
    RCLONE_CONFIG_B2F_SECRET_ACCESS_KEY="$SECRET" \
    rclone copy --checksum /var/lib/isp-files "b2f:$BUCKET/$PREFIX"
  log "copied; local files stay until you remove them"
fi
log "next: sudo bash deploy/ubuntu/app/app-up.sh"

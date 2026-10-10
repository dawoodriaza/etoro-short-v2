#!/usr/bin/env bash
# Daily push of etoro-v2-short (the etoro-daytrade bot) to GitHub, run by cron
# on the server. GitHub: dawoodriaza/etoro-short-v2, branch main.
#
# Everything is pushed FROM THE SERVER, so GitHub always holds what is actually
# running:
#   1. CODE  — src/, test/, docs and package files copied from the live folder
#              ~/etoro-v2-short into the repository root (line endings
#              normalised to LF so a deploy from Windows does not rewrite
#              every file).
#   2. DATA  — data/ (journals, shadow-log, candles, trade history, ledger),
#              logs/ and the etoro-daytrade PM2 logs into server-backup/.
#              Never deletes there, so files the bot or log rotation remove
#              stay in the backup.
#
# Adapted from etoro-ai-short/scripts/daily-github-backup.sh, with the same
# protections: .env is never copied, any .env secret value found in a copied
# file is replaced with <redacted> (Telegram is told), files over GitHub's size
# limit are held back, and a failed push is kept and retried next run.
set -uo pipefail

BOT_DIR="${BOT_DIR:-/home/ubuntu/etoro-v2-short}"
REPO_DIR="${REPO_DIR:-/home/ubuntu/etoro-v2-short-repo}"
SUB="server-backup"
PM2_LOG_DIR="${PM2_LOG_DIR:-/home/ubuntu/.pm2/logs}"
ENV_FILE="${ENV_FILE:-$BOT_DIR/.env}"
MAX_FILE_MB=95

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S') UTC] $*"; }
env_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//' | tr -d "\"' \r"; }
alert() {
  log "ALERT: $1"
  local token chat
  token="$(env_value TELEGRAM_BOT_TOKEN)"; [ -n "$token" ] || token="$(env_value DT_TELEGRAM_BOT_TOKEN)"
  chat="$(env_value TELEGRAM_CHAT_ID)"; [ -n "$chat" ] || chat="$(env_value DT_TELEGRAM_CHAT_ID)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
    curl -s -m 20 -o /dev/null -K - --data-urlencode "chat_id=$chat" \
      --data-urlencode "text=⚠️ etoro-v2-short GitHub backup: $1" || true
}

exec 9>"/tmp/etoro-v2-short-backup.lock"
flock -n 9 || { log "another backup is still running; skipping"; exit 0; }
[ -d "$REPO_DIR/.git" ] || { alert "repository $REPO_DIR is missing"; exit 1; }
cd "$REPO_DIR" || exit 1

sync_with_origin() {
  timeout 300 git fetch -q origin main || return 1
  git rebase -q --autostash origin/main || { git rebase --abort 2>/dev/null; return 1; }
}
sync_with_origin || log "could not update from origin/main first; the push step will retry"

# 1. CODE — exactly what is running. No .env, no data, no node_modules.
copy_failed=""
rsync -a --exclude='.env' --exclude='.env.*' --exclude='data/' --exclude='logs/' \
  --exclude='node_modules/' --exclude='.git/' --exclude='*.log' \
  --include='src/***' --include='test/***' --include='scripts/***' \
  --include='*.md' --include='package.json' --include='package-lock.json' \
  --include='ecosystem*.js' --include='.gitignore' --include='*.js' --exclude='*' \
  "$BOT_DIR/" "$REPO_DIR/" || copy_failed="code "
find src test scripts -type f \( -name '*.js' -o -name '*.json' -o -name '*.md' -o -name '*.sh' \) -exec sed -i 's/\r$//' {} + 2>/dev/null
for f in *.md package.json package-lock.json *.js; do [ -f "$f" ] && sed -i 's/\r$//' "$f"; done

# 2. DATA — into server-backup/, never deleting.
mkdir -p "$SUB/data" "$SUB/logs" "$SUB/pm2-logs"
rsync -a --exclude='*.tmp' "$BOT_DIR/data/" "$SUB/data/" || copy_failed="${copy_failed}data "
rsync -a "$BOT_DIR/logs/" "$SUB/logs/" 2>/dev/null || true
rsync -a --include='etoro-daytrade*' --exclude='*' "$PM2_LOG_DIR/" "$SUB/pm2-logs/" || copy_failed="${copy_failed}pm2-logs"
[ -z "$copy_failed" ] || alert "copy failed for: $copy_failed (continuing with what was copied)"

git add -A -- src test scripts *.md package.json package-lock.json 2>/dev/null
git add -A -f -- "$SUB"

# 3. Redact any .env secret value in what is about to be committed.
secrets="$(mktemp)"; chmod 600 "$secrets"; trap 'rm -f "$secrets"' EXIT
while IFS= read -r line; do
  value="$(printf '%s' "${line#*=}" | sed -E 's/[[:space:]]+#.*$//' | tr -d "\"' \r")"
  [ "${#value}" -ge 12 ] || continue
  case "$value" in *[!0-9.]*) printf '%s\n' "$value" >> "$secrets" ;; esac
done < <(grep -E '^[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASS|PASSWORD|PRIVATE|AUTH|USER|USERNAME|EMAIL|CHAT_ID|ACCOUNT|COOKIE|SESSION)[A-Za-z0-9_]*=' "$ENV_FILE" 2>/dev/null)
# Only keys whose NAMES say they are secret: settings such as a timezone
# (America/New_York) were matching and corrupting code in the backup copy.
if [ -s "$secrets" ]; then
  mapfile -d '' changed < <(git diff --cached --name-only -z --no-renames --diff-filter=AM)
  if [ "${#changed[@]}" -gt 0 ]; then
    mapfile -t leaked < <(printf '%s\0' "${changed[@]}" | xargs -0 grep -lF -f "$secrets" -- 2>/dev/null)
    if [ "${#leaked[@]}" -gt 0 ]; then
      for file in "${leaked[@]}"; do
        SECRETS_FILE="$secrets" perl -pi -e 'BEGIN { open(my $f, "<", $ENV{SECRETS_FILE}) or die; chomp(@s = <$f>); @s = grep { length } @s } for my $x (@s) { s/\Q$x\E/<redacted>/g }' "$file"
      done
      git add -f -- "${leaked[@]}"
      if printf '%s\0' "${leaked[@]}" | xargs -0 grep -qF -f "$secrets" -- 2>/dev/null; then
        git reset -q -- "${leaked[@]}"
        alert "a secret could not be redacted from ${leaked[*]}; those files were NOT backed up"
      else
        alert "a secret from .env was found and redacted in ${leaked[*]} (backup copy only)"
      fi
    fi
  fi
fi

# 4. Hold back files GitHub would reject.
mapfile -d '' staged < <(git diff --cached --name-only -z --no-renames --diff-filter=AM)
for file in "${staged[@]}"; do
  size_mb=$(( $(stat -c %s -- "$file") / 1048576 ))
  if [ "$size_mb" -gt "$MAX_FILE_MB" ]; then
    git reset -q -- "$file"; alert "$file is ${size_mb} MB, over ${MAX_FILE_MB} MB; not backed up"
  fi
done

# 5. Commit and push (including earlier unpushed commits).
if git diff --cached --quiet; then
  log "no changes since the last backup"
else
  git commit -q -m "Server sync $(date -u '+%Y-%m-%d %H:%M') UTC — live code + data" || { alert "git commit failed"; exit 1; }
  log "committed:$(git show --stat --format= HEAD | tail -1)"
fi
if git rev-parse -q --verify origin/main >/dev/null && [ "$(git rev-list --count origin/main..main)" = "0" ]; then
  log "nothing to push"; exit 0
fi
for attempt in 1 2 3; do
  if timeout 600 git push -q origin main; then log "pushed to origin/main ($(git rev-parse --short HEAD))"; exit 0; fi
  [ "$attempt" -lt 3 ] && { sync_with_origin || true; sleep 5; }
done
alert "push to GitHub failed; the commit is kept on the server and the next run will retry"
exit 1

#!/usr/bin/env bash
# Test dev/vault/entrypoint.sh against a real server binary, outside Docker:
# its paths are rewritten into a temp directory, then it must
#   1. initialise and unseal Vault, and configure it (KV v2, AppRole, policies,
#      the audit device) with a root token it never writes down and revokes;
#   2. leave a seed bootstrap secret ID that works exactly once;
#   3. let the seed mint the app's secret ID, and the app log in with it;
#   4. after a restart, unseal again from the key on the data volume.
#
#   VAULT_BIN=/path/to/vault dev/vault/test-entrypoint.sh      (CI: the checks job)
# With the OpenBao binary (a stand-in where Vault can't be downloaded), the
# audit step is skipped: OpenBao refuses to create audit devices over the API.
set -euo pipefail
cd "$(dirname "$0")"
BIN="${VAULT_BIN:?set VAULT_BIN to the vault binary}"
T=$(mktemp -d)
PORT=$((18600 + RANDOM % 300))
mkdir -p "$T"/{file,logs,config,bin,etc}
ln -s "$(command -v "$BIN" || echo "$BIN")" "$T/bin/vault"
openbao=no; "$BIN" version 2>/dev/null | grep -qi openbao && openbao=yes

sed -e "s|/etc/vault/config.hcl|$T/etc/config.hcl|; s|/vault/file|$T/file|g; s|/vault/logs|$T/logs|g; s|/vault/config|$T/config|g; s|/lab/policies|$PWD/policies|g; s|127.0.0.1:8200|127.0.0.1:$PORT|" entrypoint.sh > "$T/ep.sh"
[ "$openbao" = yes ] && sed -i 's|^  v audit enable .*|  v audit enable file file_path=x \|\| true|' "$T/ep.sh"
sed -e "s|/vault/file|$T/file|; s|0.0.0.0:8200|127.0.0.1:$PORT|; s|http://vault:8200|http://127.0.0.1:$PORT|; s|http://vault:8201|http://127.0.0.1:$((PORT + 300))|" config.hcl > "$T/etc/config.hcl"

fails=0
ok()   { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; fails=$((fails + 1)); }
v() { env -i PATH="$T/bin:$PATH" VAULT_ADDR="http://127.0.0.1:$PORT" BAO_ADDR="http://127.0.0.1:$PORT" "$T/bin/vault" "$@"; }
vt() { local tok=$1; shift; env -i PATH="$T/bin:$PATH" VAULT_ADDR="http://127.0.0.1:$PORT" BAO_ADDR="http://127.0.0.1:$PORT" VAULT_TOKEN="$tok" BAO_TOKEN="$tok" "$T/bin/vault" "$@"; }
start() { env -i PATH="$T/bin:$PATH" sh "$T/ep.sh" > "$T/$1.log" 2>&1 & echo $! > "$T/ep.pid"; }
stop() { kill "$(cat "$T/ep.pid")" 2>/dev/null || true; for _ in $(seq 1 20); do v status >/dev/null 2>&1 || [ $? = 2 ] || break; sleep 0.5; done; sleep 1; }
trap 'stop; rm -rf "$T"' EXIT

echo "== first start ($( [ "$openbao" = yes ] && echo 'OpenBao stand-in' || echo Vault))"
start first
for _ in $(seq 1 60); do grep -q 'configured\|could not' "$T/first.log" && break; sleep 1; done
grep -q 'configured: KV v2' "$T/first.log" && ok "initialised, unsealed and configured by the entrypoint" || { fail "not configured"; cat "$T/first.log"; exit 1; }
[ "$(stat -c %a "$T/file/unseal.key")" = 600 ] && ok "the unseal key is on the data volume, mode 600" || fail "unseal key mode $(stat -c %a "$T/file/unseal.key")"
[ "$(stat -c %a "$T/config/seed-secret-id")" = 444 ] && ok "the seed's bootstrap secret ID file is mode 444 (read by another user)" || fail "bootstrap file mode"
if grep -rqsE '"root_token"|hvs\.[A-Za-z0-9]{20,}|\bs\.[A-Za-z0-9]{20,}' "$T/file" "$T/config" "$T/logs" "$T/first.log"; then
  fail "a root token was written to a file or the log"
else
  ok "no root token in any file or in the entrypoint's output"
fi
if [ "$openbao" = no ]; then
  grep -q '"path":"auth/token/revoke-self"' "$T/logs/audit.log" && ok "the audit log records the root token revoking itself" || fail "no revoke-self in the audit log"
fi

seed=$(v write -format=json auth/approle/login role_id=secure-notes-seed "secret_id=@$T/config/seed-secret-id" 2>/dev/null | sed -n 's/.*"client_token": *"\([^"]*\)".*/\1/p' || true)
[ -n "$seed" ] && ok "the bootstrap secret ID logs in as secure-notes-seed" || fail "bootstrap login failed"
if v write auth/approle/login role_id=secure-notes-seed "secret_id=@$T/config/seed-secret-id" >/dev/null 2>&1; then fail "the bootstrap secret ID works twice"; else ok "the bootstrap secret ID works once"; fi
sid=$(vt "$seed" write -format=json -f auth/approle/role/secure-notes-app/secret-id 2>/dev/null | sed -n 's/.*"secret_id": *"\([^"]*\)".*/\1/p' || true)
app=$(v write -format=json auth/approle/login role_id=secure-notes-app "secret_id=$sid" 2>/dev/null | sed -n 's/.*"client_token": *"\([^"]*\)".*/\1/p' || true)
[ -n "$app" ] && ok "the seed minted the app's secret ID and the app logged in" || fail "app login failed"
if vt "$app" read secret/data/other/app >/dev/null 2>&1; then fail "the app reads outside its paths"; else ok "the app's policy refuses another path"; fi

echo "== restart"
stop
start second
for _ in $(seq 1 30); do grep -q 'unsealed with the key' "$T/second.log" && break; sleep 1; done
v status >/dev/null 2>&1 && ok "unsealed again from the key on the data volume" || fail "sealed after a restart"
if v write auth/approle/login role_id=secure-notes-seed "secret_id=@$T/config/seed-secret-id" >/dev/null 2>&1; then fail "the bootstrap secret ID works after a restart"; else ok "the bootstrap secret ID is still spent"; fi

[ "$fails" = 0 ] && echo "test-entrypoint: all passed" || echo "test-entrypoint: $fails FAILED"
exit $((fails > 0))

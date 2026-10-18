#!/bin/sh
# LAB ONLY: start HashiCorp Vault for the Compose lab with no manual steps.
# Vault has no static seal and no self-init (OpenBao has both), so this script
# does by hand what OpenBao's config does:
#
# First start:
#   operator init with ONE key share. The unseal key goes to the data volume,
#   next to the data it protects (lab only, like OpenBao's static seal key).
#   The root token is kept only in this script's memory: it configures Vault
#   (KV v2, database engine, AppRole, an audit device, policies, roles, the seed
#   job's one-time secret ID) and is then revoked. It is never written anywhere.
# Every start: unseal with the key from the volume.
set -eu
umask 077
export VAULT_ADDR=http://127.0.0.1:8200
KEY=/vault/file/unseal.key

vault server -config=/etc/vault/config.hcl &
SRV=$!
trap 'kill $SRV 2>/dev/null' TERM INT

# vault status: 0 = unsealed, 2 = sealed (or not initialised), 1 = not answering
for _ in $(seq 1 60); do
  rc=0; vault status >/dev/null 2>&1 || rc=$?
  [ "$rc" != 1 ] && break
  sleep 1
done

if [ ! -s "$KEY" ]; then
  init=$(vault operator init -key-shares=1 -key-threshold=1 -format=json | tr -d '\n ')
  printf '%s' "$init" | sed -n 's/.*"unseal_keys_b64":\["\([^"]*\)".*/\1/p' > "$KEY"
  root=$(printf '%s' "$init" | sed -n 's/.*"root_token":"\([^"]*\)".*/\1/p')
  unset init
  [ -s "$KEY" ] && [ -n "$root" ] || { echo "[vault-lab] could not read the init output"; exit 1; }
  vault operator unseal "$(cat "$KEY")" >/dev/null
  echo "[vault-lab] initialised with one key share; unsealed"

  v() { VAULT_TOKEN="$root" vault "$@" >/dev/null; }
  for _ in $(seq 1 30); do v status && break; sleep 1; done
  v audit enable file file_path=/vault/logs/audit.log
  v secrets enable -path=secret -version=2 kv
  v secrets enable database
  v auth enable approle
  v policy write secure-notes-app /lab/policies/secure-notes-app.hcl
  v policy write secure-notes-seed /lab/policies/secure-notes-seed.hcl
  v write auth/approle/role/secure-notes-app token_policies=secure-notes-app token_ttl=15m token_max_ttl=4h secret_id_num_uses=0 secret_id_ttl=0
  v write auth/approle/role/secure-notes-app/role-id role_id=secure-notes-app
  v write auth/approle/role/secure-notes-seed token_policies=secure-notes-seed token_ttl=10m token_max_ttl=10m secret_id_num_uses=1 secret_id_ttl=24h
  v write auth/approle/role/secure-notes-seed/role-id role_id=secure-notes-seed
  # The seed job's one-time secret ID, on a volume it mounts read-only.
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > /vault/config/seed-secret-id
  chmod 0444 /vault/config/seed-secret-id
  v write auth/approle/role/secure-notes-seed/custom-secret-id secret_id=@/vault/config/seed-secret-id
  VAULT_TOKEN="$root" vault token revoke -self >/dev/null
  unset root
  echo "[vault-lab] configured: KV v2, database engine, AppRole, file audit device; the root token is revoked"
else
  vault operator unseal "$(cat "$KEY")" >/dev/null
  echo "[vault-lab] unsealed with the key from the data volume"
fi

wait $SRV

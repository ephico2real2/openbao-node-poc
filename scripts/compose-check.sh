#!/usr/bin/env bash
# Wait for the Docker Compose stack, then run the end-to-end smoke test.
#
#   docker compose up -d && scripts/compose-check.sh
#   COMPOSE_FILE=docker-compose.yml:docker-compose.agent.yml scripts/compose-check.sh   (agent mode)
#   COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml scripts/compose-check.sh   (OpenBao)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
BASE="${1:-http://localhost:3000}"

echo "== waiting for $BASE/api/health"
for i in $(seq 1 90); do
  if curl -fsS --max-time 3 "$BASE/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "  ready after ~$((i * 2)) s"; break
  fi
  [ "$i" = 90 ] && { echo "  not ready after 180 s"; docker compose ps; exit 1; }
  sleep 2
done
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.State}}'

echo "== the seed job burned the bootstrap passwords"
fails=0
ok()   { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; fails=$((fails + 1)); }
# redis-cli, or valkey-cli when step v2 runs Valkey
rcli() { docker compose exec -T redis sh -c 'if command -v valkey-cli >/dev/null 2>&1; then exec valkey-cli "$@"; else exec redis-cli "$@"; fi' rcli "$@"; }
if rcli --no-auth-warning --user default --pass bootstrap-only-change-me ping 2>&1 | grep -q PONG; then
  echo "  FAIL  Redis still accepts the bootstrap password"; fails=$((fails + 1))
else
  echo "  ok    Redis rejects the bootstrap password"
fi
if docker compose exec -T postgres env PGPASSWORD=bootstrap-only-change-me psql -h 127.0.0.1 -U postgres -d notes -tAc 'select 1' >/dev/null 2>&1; then
  echo "  FAIL  Postgres still accepts the bootstrap password"; fails=$((fails + 1))
else
  echo "  ok    Postgres rejects the bootstrap password"
fi

cfg=$(curl -fsS "$BASE/api/config")
mode=$(jq -r '.secretsMode // empty' <<< "$cfg")
provider=$(jq -r '.secretsProvider // empty' <<< "$cfg")
echo "== secrets provider: ${provider:-unknown}, mode: ${mode:-unknown}"
if [ "$provider" = openbao ]; then
  # The app logged in with its own AppRole identity, and holds no token anywhere it could leak from.
  if [ "$(jq -r '.bao.loggedIn' <<< "$cfg")" = true ]; then
    ok "the app is logged in to OpenBao as role '$(jq -r '.bao.roleId' <<< "$cfg")' (policies: $(jq -r '.bao.policies | join(",")' <<< "$cfg"))"
  else
    fail "the app is not logged in to OpenBao ($(jq -r '.bao.lastError // "no error recorded"' <<< "$cfg"))"
  fi
  if jq -e '.. | strings | select(test("^(s|hvs|b)\\.[A-Za-z0-9]{20,}"))' <<< "$cfg" >/dev/null; then
    fail "/api/config shows something shaped like a token"
  else
    ok "/api/config shows the login state, never the token"
  fi
  # The secret ID is a file the app can read and nothing else can write.
  perm=$(docker compose exec -T app stat -c '%a %u' /home/node/bao-secret-id 2>/dev/null)
  if [ "$perm" = "400 1000" ]; then ok "the app's secret ID file is mode 0400, owned by the app user"; else fail "the app's secret ID file is '$perm', expected '400 1000'"; fi
  if docker compose exec -T app sh -c 'env | grep -qE "^(BAO|VAULT)_(TOKEN|SECRET_ID)="'; then
    fail "the app's environment has a token or a secret ID"
  else
    ok "no token or secret ID in the app's environment"
  fi
  # Secret zero, part two: the seed job's bootstrap secret ID was single-use.
  if docker compose exec -T openbao bao write -address=http://127.0.0.1:8200 auth/approle/login \
       role_id=secure-notes-seed secret_id=@/openbao/config/seed-secret-id >/dev/null 2>&1; then
    fail "the seed's bootstrap secret ID still logs in"
  else
    ok "the seed's bootstrap secret ID is spent (single use)"
  fi
  # The app's identity reads only its own paths.
  code=$(docker compose exec -T app node --input-type=module -e "
    const { config: c } = await import('/app/backend/src/config.js');
    const { createBaoClient } = await import('/app/backend/src/secrets/bao/client.js');
    const b = createBaoClient({ addr: c.bao.addr, roleId: c.bao.roleId, secretIdFile: c.bao.secretIdFile, scheduleRenewal: false });
    try { await b.request('GET', 'secret/data/some/other/app'); console.log(200); } catch (e) { console.log(e.status ?? e.message); }" 2>/dev/null)
  if [ "$code" = 403 ]; then ok "the app's policy refuses a path outside its own (403)"; else fail "reading another app's path gave '$code', expected 403"; fi
  # Every read is in the audit log (with the values HMAC'd; the credential scan checks that).
  reads=$(docker compose exec -T openbao sh -c "grep -c '\"path\":\"secret/data/' /openbao/logs/audit.log" 2>/dev/null || true)
  if [ "${reads:-0}" -gt 0 ]; then ok "the audit log recorded $reads KV request/response entries"; else fail "the audit log has no KV entries"; fi
fi
if [ "$mode" = agent ]; then
  # The app read its secrets through the agent on its own localhost, not from Secrets Manager.
  n=$(docker compose logs --no-color agent 2>/dev/null | grep -c '\[aws-mock agent\] fetched')
  if [ "$n" -gt 0 ]; then echo "  ok    the agent served $n secret fetch(es) to the app"; else echo "  FAIL  the agent served no fetches"; fails=$((fails + 1)); fi
  # The SSRF token is only in the agent and the app, never in the Secrets Manager stand-in.
  if docker compose exec -T aws-mock test -e /var/run/awssm/token 2>/dev/null; then
    echo "  FAIL  the aws-mock container can see the agent token"; fails=$((fails + 1))
  else
    echo "  ok    the agent token is visible only to the agent and the app"
  fi
  # The agent refuses a request without the token (SSRF protection), even from the app's own localhost.
  code=$(docker compose exec -T app node -e "fetch('http://127.0.0.1:2773/secretsmanager/get?secretId=x').then(r=>console.log(r.status))" 2>/dev/null)
  if [ "$code" = 403 ]; then echo "  ok    the agent rejects a request without the SSRF token (403)"; else echo "  FAIL  token-less request got '$code', expected 403"; fails=$((fails + 1)); fi
fi

dynamic=$(curl -fsS "$BASE/api/secrets" | jq -r 'any(.secrets[]; .lease != null)')
if [ "$dynamic" = true ]; then
  echo "== step v2: dynamic database users with leases"
  pgq() { docker compose exec -T postgres psql -U postgres -d notes -tAc "$1" 2>/dev/null; }
  users=$(pgq "SELECT string_agg(DISTINCT usename, ' ') FROM pg_stat_activity WHERE application_name = 'secure-notes'")
  case "$users" in
    v-*) if grep -q notes_app <<< "$users"; then fail "the app still logs in as the stored user notes_app"; else ok "the app's Postgres sessions use a user OpenBao created for it (${users:0:20}…), not a stored one"; fi ;;
    *) fail "the app's Postgres sessions are not a leased user: '$users'" ;;
  esac
  # A renewal happens at 2/3 of the lease TTL (lab: 30 s).
  renewed=0
  for _ in $(seq 1 30); do
    renewed=$(curl -fsS "$BASE/api/secrets" | jq '[.secrets[].lease.renewals // 0] | min')
    [ "$renewed" -ge 1 ] && break
    sleep 2
  done
  if [ "$renewed" -ge 1 ]; then ok "the app renewed both leases (sys/leases/renew)"; else fail "no lease renewal within 60 s"; fi
fi

echo "== end-to-end smoke test"
node backend/scripts/smoke-test.js "$BASE" || fails=$((fails + 1))

if [ "$dynamic" = true ]; then
  echo "== step v2: revoked and replaced users are gone"
  sleep 20 # the replaced leases are revoked 15 s after the switch
  left=$(docker compose exec -T postgres psql -U postgres -d notes -tAc "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'v-%'" 2>/dev/null)
  if [ "${left:-99}" -le 2 ]; then ok "Postgres has $left leased user(s) left: the app's current one (and at most one draining)"; else fail "Postgres still has $left leased users: revocation is not cleaning up"; fi
  ev=$(curl -fsS "$BASE/api/events" | jq -r '[.events[] | select(.type == "new-lease")] | length')
  echo "  info  the app switched to a newly issued user $ev time(s) so far (revocations, and leases at their max TTL)"
fi

# After the smoke test: its rotations and its leak test have run, so the logs
# hold every place a password could have slipped into.
echo "== the actual credential values, searched for in every container, file and log"
scripts/credential-scan.sh compose || fails=$((fails + 1))

exit $((fails > 0))

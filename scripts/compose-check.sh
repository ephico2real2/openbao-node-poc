#!/usr/bin/env bash
# Wait for the Docker Compose stack, then run the end-to-end smoke test.
#
#   docker compose up -d && scripts/compose-check.sh
#   COMPOSE_FILE=docker-compose.yml:docker-compose.agent.yml scripts/compose-check.sh   (agent mode)
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
if docker compose exec -T redis redis-cli --no-auth-warning --user default --pass bootstrap-only-change-me ping 2>&1 | grep -q PONG; then
  echo "  FAIL  Redis still accepts the bootstrap password"; fails=$((fails + 1))
else
  echo "  ok    Redis rejects the bootstrap password"
fi
if docker compose exec -T postgres env PGPASSWORD=bootstrap-only-change-me psql -h 127.0.0.1 -U postgres -d notes -tAc 'select 1' >/dev/null 2>&1; then
  echo "  FAIL  Postgres still accepts the bootstrap password"; fails=$((fails + 1))
else
  echo "  ok    Postgres rejects the bootstrap password"
fi

mode=$(curl -fsS "$BASE/api/config" | sed -n 's/.*"secretsMode":"\([a-z]*\)".*/\1/p')
echo "== secrets mode: ${mode:-unknown}"
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

echo "== end-to-end smoke test"
node backend/scripts/smoke-test.js "$BASE" || fails=$((fails + 1))

echo "== alerts: the local SNS, the stack's unexpected-read rule, the app's notifications"

# After the smoke test: its rotations and its leak test have run, so the logs
# hold every place a password could have slipped into.
echo "== the actual credential values, searched for in every container, file and log"
scripts/credential-scan.sh compose || fails=$((fails + 1))

exit $((fails > 0))

#!/usr/bin/env bash
# End-to-end test of epic B7 without Docker: a real OpenBao (the lab's config),
# VictoriaLogs, vmalert with dev/detect/rules.yml, the audit shipper and the
# alert console. It proves:
#   1. the app reading its own secret raises NO alert;
#   2. the over-broad ops-admin role reading the same secret raises
#      SecretReadByUnexpectedIdentity, naming the role and the path;
#   3. the log store holds the audit lines, and no secret value.
#
#   BAO_BIN=… VLOGS_BIN=… VMALERT_BIN=… dev/detect/test-detection.sh   (CI: the checks job)
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${BAO_BIN:?}" "${VLOGS_BIN:?}" "${VMALERT_BIN:?}"
T=$(mktemp -d)
B=$((19000 + RANDOM % 400)); VL=$((B + 1000)); CON=$((B + 1100)); VMA=$((B + 1200))
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$T"; }
trap cleanup EXIT
fails=0
ok()   { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; fails=$((fails + 1)); [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=test-detection::$*"; return 0; }
# A command that stops the script (set -e) says where, and shows each part's log
# tail, as GitHub annotations too: CI job logs aren't always readable.
died() {
  local rc=$? line=$1 cmd=$2
  echo "  DIED  line $line (exit $rc): $cmd"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=test-detection::stopped at line $line (exit $rc): $cmd"
  for f in bao vl console vmalert ship; do
    [ -s "$T/$f.log" ] || continue
    echo "  -- $f.log"; tail -5 "$T/$f.log" | sed 's/^/     /'
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::warning title=test-detection $f.log::$(tail -3 "$T/$f.log" | tr '\n' ' ' | cut -c1-600)"
  done
}
trap 'died $LINENO "$BASH_COMMAND"' ERR

mkdir -p "$T"/{file,logs,config,vl}
sed -e "s|/openbao/|$T/|g" -e "s|0.0.0.0:8200|127.0.0.1:$B|" -e "s|http://openbao:8200|http://127.0.0.1:$B|" -e "s|http://openbao:8201|http://127.0.0.1:$((B + 1))|" dev/openbao/config.hcl > "$T/config.hcl"
head -c 32 /dev/urandom > "$T/file/unseal.key"
for f in seed-secret-id ops-secret-id; do head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$T/config/$f"; done

env -i PATH="$PATH" "$BAO_BIN" server -config="$T/config.hcl" > "$T/bao.log" 2>&1 & pids+=($!)
"$VLOGS_BIN" -storageDataPath="$T/vl" -httpListenAddr="127.0.0.1:$VL" -loggerLevel=ERROR > "$T/vl.log" 2>&1 & pids+=($!)
PORT=$CON node backend/scripts/alert-console.js > "$T/console.log" 2>&1 & pids+=($!)
"$VMALERT_BIN" -datasource.url="http://127.0.0.1:$VL" -rule.defaultRuleType=vlogs -rule=dev/detect/rules.yml \
  -rule.evalDelay=5s -notifier.url="http://127.0.0.1:$CON" -httpListenAddr="127.0.0.1:$VMA" -loggerLevel=ERROR > "$T/vmalert.log" 2>&1 & pids+=($!)
AUDIT_FILE="$T/logs/audit.log" LOGS_URL="http://127.0.0.1:$VL/insert/jsonline?_time_field=time&_msg_field=request.id&_stream_fields=type" SHIP_INTERVAL_MS=500 \
  node backend/scripts/audit-ship.js > "$T/ship.log" 2>&1 & pids+=($!)

for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$B/v1/sys/health" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$CON/health" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$VMA/-/healthy" >/dev/null 2>&1 && break; sleep 0.5; done

echo "== the app reads its own secret"
node --input-type=module -e "
import { createBaoClient } from './backend/src/secrets/bao/client.js';
import { createKvStore } from './backend/src/secrets/bao/kv.js';
import { writeFileSync } from 'node:fs';
const addr = 'http://127.0.0.1:$B';
const seed = createBaoClient({ addr, roleId: 'secure-notes-seed', secretIdFile: '$T/config/seed-secret-id', scheduleRenewal: false });
for (let i = 0; ; i++) { try { await seed.login(); break; } catch (e) { if (i > 40) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const store = createKvStore(seed);
await store.create('/rds/dev/notes-db/app', { username: 'notes_app', password: await store.randomPassword() });
const sid = await seed.mintSecretId('secure-notes-app');
writeFileSync('$T/app-sid', sid.secretId, { mode: 0o600 });
const app = createBaoClient({ addr, roleId: 'secure-notes-app', secretIdFile: '$T/app-sid', scheduleRenewal: false });
for (let i = 0; i < 3; i++) await app.request('GET', 'secret/data/rds/dev/notes-db/app');
console.log('  the app read secret/data/rds/dev/notes-db/app 3 times');
"
sleep 30 # > one evaluation (10 s interval, 5 s delay): the app's reads have been looked at
seen=$(curl -fsS "http://127.0.0.1:$VL/select/logsql/query" --data-urlencode 'query=type:=response request.operation:=read auth.metadata.role_name:="secure-notes-app" | stats count() as n' | jq -r '.n // 0')
[ "${seen:-0}" -ge 3 ] && ok "the log store has the app's $seen reads, so the rule has looked at them" || fail "the app's reads are not in the log store yet ($seen)"
n=$(curl -fsS "http://127.0.0.1:$CON/api/alerts" | jq '.alerts | length')
[ "$n" = 0 ] && ok "no alert: the app reading its own secret is normal" || fail "$n alert(s) for the app's own reads: $(curl -fsS "http://127.0.0.1:$CON/api/alerts")"

echo "== ops-admin reads the same secret"
BAO_ADDR="http://127.0.0.1:$B" BAO_SECRET_ID_FILE="$T/config/ops-secret-id" node backend/scripts/intruder.js | sed 's/^/  /'
got=""
t0=$(date +%s)
for _ in $(seq 1 45); do
  got=$(curl -fsS "http://127.0.0.1:$CON/api/alerts" | jq -c '[.alerts[] | select(.labels.alertname == "SecretReadByUnexpectedIdentity")][0] // empty')
  [ -n "$got" ] && break
  sleep 2
done
if [ -n "$got" ]; then
  ok "alert SecretReadByUnexpectedIdentity after $(( $(date +%s) - t0 )) s: role $(jq -r '.labels.auth_metadata_role_name' <<< "$got"), path $(jq -r '.labels.request_path' <<< "$got")"
  [ "$(jq -r '.labels.auth_metadata_role_name' <<< "$got")" = ops-admin ] && ok "the alert names the role that read it" || fail "wrong role in the alert: $got"
else
  fail "no alert within 90 s (vmalert: $(tail -2 "$T/vmalert.log" | tr '\n' ' ' | cut -c1-300); shipper: $(tail -2 "$T/ship.log" | tr '\n' ' ' | cut -c1-300))"
fi

echo "== the log store"
lines=$(curl -fsS "http://127.0.0.1:$VL/select/logsql/query" --data-urlencode 'query=type:=response | stats count() as n' | jq -r '.n')
[ "${lines:-0}" -gt 0 ] && ok "VictoriaLogs holds $lines audit response line(s)" || fail "no audit lines in VictoriaLogs"
pw=$(node --input-type=module -e "
import { createBaoClient } from './backend/src/secrets/bao/client.js';
const c = createBaoClient({ addr: 'http://127.0.0.1:$B', roleId: 'secure-notes-app', secretIdFile: '$T/app-sid', scheduleRenewal: false });
console.log((await c.request('GET', 'secret/data/rds/dev/notes-db/app')).data.data.password);")
hits=$(curl -fsS "http://127.0.0.1:$VL/select/logsql/query" --data-urlencode "query=\"$pw\"" | grep -c . || true)
[ "$hits" = 0 ] && ok "the password is in no log line in VictoriaLogs (the audit log HMACs it)" || fail "the password was found in $hits log line(s)"

[ "$fails" = 0 ] && echo "test-detection: all passed" || echo "test-detection: $fails FAILED"
exit $((fails > 0))

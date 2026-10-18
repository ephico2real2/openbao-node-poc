#!/usr/bin/env bash
# Evidence and assertions for a running Kubernetes deployment, then the same
# end-to-end smoke test Docker Compose runs. Needs the app on BASE:
#
#   scripts/k8s-check.sh                         # kind: deploy/kind/cluster.yaml maps localhost:3000
#   kubectl -n secure-notes port-forward svc/secure-notes 3000:80 &   # any other cluster
#   KUBECTL=oc scripts/k8s-check.sh http://localhost:3000
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck disable=SC1091
. scripts/versions.env
BASE="${1:-http://localhost:3000}"
K="${KUBECTL:-kubectl}"
NS="$NAMESPACE"
BOOT='bootstrap-only-change-me'
fails=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }

echo "== who each container runs as (OpenShift-style arbitrary UIDs show up here)"
for d in $("$K" -n "$NS" get deploy -o jsonpath='{.items[*].metadata.name}'); do
  printf '  %-13s %s\n' "$d" "$("$K" -n "$NS" exec "deploy/$d" -- id 2>&1 | head -1)"
done
root=$("$K" -n "$NS" get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.securityContext.runAsUser}{"\n"}{end}' | awk '$2=="0"')
[ -z "$root" ] && pass "no pod asks for UID 0" || fail "pods running as root: $root"

echo "== the app never restarted (startup and rotation recover in-process)"
restarts=$("$K" -n "$NS" get pods -l app.kubernetes.io/name=secure-notes -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' | awk '{s+=$1} END {print s+0}')
[ "$restarts" = 0 ] && pass "restartCount 0" || fail "the app container restarted $restarts time(s); see secure-notes.previous.log"

echo "== Pod Security admission on the namespace"
psa=$("$K" get ns "$NS" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')
if [ "$psa" = restricted ]; then
  pass "enforce=restricted: the API server rejects non-compliant pods"
elif [ -z "$psa" ] && "$K" api-resources --api-group=security.openshift.io 2>/dev/null | grep -q securitycontextconstraints; then
  echo "  info  no PSA enforce label: on OpenShift the restricted-v2 SCC enforces the same rules"
else
  fail "PSA enforce label is '${psa:-unset}'"
fi

echo "== Kubernetes Secrets in the namespace (Opaque ones; names and keys only)"
# OpenShift adds its own dockercfg and token Secrets to every project; only Opaque ones hold app data.
"$K" -n "$NS" get secrets -o go-template='{{range .items}}{{if eq .type "Opaque"}}  {{.metadata.name}}: {{range $k, $v := .data}}{{$k}} {{end}}{{"\n"}}{{end}}{{end}}'
others=$("$K" -n "$NS" get secrets -o go-template='{{range .items}}{{if eq .type "Opaque"}}{{.metadata.name}}{{"\n"}}{{end}}{{end}}' | grep -v '^local-bootstrap-' | grep . || true)
[ -z "$others" ] && pass "the only Secret is the one-time bootstrap; the app's credentials are not stored in Kubernetes" || fail "unexpected Secrets: $others"

echo "== the bootstrap passwords were burned by the seed job"
# redis-cli, or valkey-cli on the OpenBao steps
if "$K" -n "$NS" exec deploy/redis -- sh -c 'c=redis-cli; command -v valkey-cli >/dev/null 2>&1 && c=valkey-cli; exec $c --no-auth-warning --user default --pass "$1" ping' sh "$BOOT" 2>&1 | grep -q PONG; then
  fail "Redis still accepts the bootstrap password"
else
  pass "Redis rejects the bootstrap password"
fi
if "$K" -n "$NS" exec deploy/postgres -- env PGPASSWORD="$BOOT" psql -h 127.0.0.1 -U postgres -d notes -tAc 'select 1' >/dev/null 2>&1; then
  fail "Postgres still accepts the bootstrap password"
else
  pass "Postgres rejects the bootstrap password"
fi

echo "== the app's environment holds IDs and hostnames, no credentials"
names=$("$K" -n "$NS" exec deploy/secure-notes -- sh -c 'env | cut -d= -f1 | sort' 2>&1)
echo "$names" | tr '\n' ' ' | fold -w 110 | sed 's/^/  /'; echo
if echo "$names" | grep -Eiq 'PASSWORD|PGPASS|DATABASE_URL|REDIS_URL'; then fail "a credential-named variable is set"; else pass "no credential-named variables"; fi

echo "== Postgres statement log: new passwords arrived as SCRAM verifiers"
alter=$("$K" -n "$NS" logs deploy/postgres 2>/dev/null | grep -o "ALTER ROLE [^ ]* WITH[^']*PASSWORD '[^']\{0,24\}" | head -3)
echo "$alter" | sed 's/^/  /'
if [ -n "$alter" ] && ! echo "$alter" | grep -v "PASSWORD 'SCRAM-SHA-256" | grep -q .; then
  pass "every ALTER ROLE in the log carries a SCRAM verifier"
else
  fail "no SCRAM-only ALTER ROLE lines found"
fi

if "$K" get crd routes.route.openshift.io >/dev/null 2>&1; then
  echo "== OpenShift Route (accepted by the API server against OpenShift's Route schema)"
  "$K" -n "$NS" get route secure-notes -o custom-columns='NAME:.metadata.name,SERVICE:.spec.to.name,PORT:.spec.port.targetPort,TLS:.spec.tls.termination,INSECURE:.spec.tls.insecureEdgeTerminationPolicy' 2>&1 | sed 's/^/  /'
  "$K" -n "$NS" get route secure-notes >/dev/null 2>&1 && pass "Route secure-notes exists" || fail "Route secure-notes missing"
fi

echo "== NetworkPolicies"
"$K" -n "$NS" get networkpolicy --no-headers | awk '{print "  " $1}'

provider=$(curl -fsS "$BASE/api/config" | jq -r '.secretsProvider // "aws"')
if [ "$provider" = openbao ]; then
  echo "== step v3: OpenBao in the cluster, Kubernetes auth, users with leases"
  st=$("$K" -n openbao exec openbao-0 -- bao status -format=json 2>/dev/null)
  if [ "$(jq -r '.initialized and (.sealed | not)' <<< "$st")" = true ]; then
    pass "OpenBao $(jq -r .version <<< "$st") (Helm, $(jq -r .storage_type <<< "$st") storage): initialized and unsealed by itself (static seal, self-init)"
  else
    fail "OpenBao is not initialized and unsealed: $st"
  fi
  cfg=$(curl -fsS "$BASE/api/config")
  if [ "$(jq -r '.bao.loggedIn' <<< "$cfg")" = true ] && jq -r '.bao.authMethod' <<< "$cfg" | grep -q '^kubernetes'; then
    pass "the app logged in with Kubernetes auth, role '$(jq -r .bao.roleId <<< "$cfg")' (policies: $(jq -r '.bao.policies | join(",")' <<< "$cfg"))"
  else
    fail "the app is not logged in with Kubernetes auth: $(jq -c .bao <<< "$cfg")"
  fi
  # Only a projected token for OpenBao is in the pod; no token for the Kubernetes API.
  if "$K" -n "$NS" exec deploy/secure-notes -- test -e /var/run/secrets/kubernetes.io/serviceaccount/token 2>/dev/null; then
    fail "the app pod has a Kubernetes API token mounted"
  else
    pass "no Kubernetes API token in the app pod (automountServiceAccountToken: false)"
  fi
  claims=$("$K" -n "$NS" exec deploy/secure-notes -- node -e "const t=require('fs').readFileSync('/var/run/secrets/openbao/token','utf8').split('.')[1];const c=JSON.parse(Buffer.from(t,'base64url'));console.log(JSON.stringify({aud:c.aud,life:c.exp-c.iat,sa:c['kubernetes.io']?.serviceaccount?.name}))" 2>/dev/null)
  if [ "$(jq -r '(.aud | index("openbao")) != null and .life <= 3600' <<< "$claims" 2>/dev/null)" = true ]; then
    pass "the app's OpenBao token is projected: audience openbao, valid $(( $(jq .life <<< "$claims") / 60 )) min, service account $(jq -r .sa <<< "$claims")"
  else
    fail "unexpected projected token claims: $claims"
  fi
  users=$("$K" -n "$NS" exec deploy/postgres -- psql -U postgres -d notes -tAc "SELECT string_agg(DISTINCT usename, ' ') FROM pg_stat_activity WHERE application_name = 'secure-notes'" 2>/dev/null)
  case "$users" in
    v-*) pass "the app's Postgres sessions use a user OpenBao created for it (${users:0:20}…)" ;;
    *) fail "the app's Postgres sessions are not a leased user: '$users'" ;;
  esac
fi

echo "== end-to-end smoke test against $BASE"
node backend/scripts/smoke-test.js "$BASE" || fails=$((fails + 1))

# After the smoke test: its rotations and its leak test have run.
echo "== the actual credential values, searched for in every pod, object, file and log"
KUBECTL="$K" NAMESPACE="$NS" scripts/credential-scan.sh k8s || fails=$((fails + 1))


echo
if [ "$fails" -eq 0 ]; then echo "k8s-check: all checks passed"; else echo "k8s-check: $fails check(s) failed"; fi
exit $((fails > 0))

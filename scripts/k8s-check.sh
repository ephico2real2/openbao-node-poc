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
mode=$(curl -fsS "$BASE/api/config" | jq -r '.secretsMode // empty')
if [ "$mode" = file ] && [ "$others" = secure-notes-credentials ]; then
  owner=$("$K" -n "$NS" get secret secure-notes-credentials -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}')
  echo "  info  file mode: secure-notes-credentials holds the app's credentials BY DESIGN (owner $owner): RBAC on Secrets and etcd encryption now matter"
  pass "no other Secret: only the one-time bootstrap and the one External Secrets Operator manages"
else
  [ -z "$others" ] && pass "the only Secret is the one-time bootstrap; the app's credentials are not stored in Kubernetes" || fail "unexpected Secrets: $others"
fi

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
if [ "$provider" = openbao ] && [ "$mode" = file ]; then
  echo "== step v3, file mode: External Secrets Operator, a mounted Secret, a watched directory"
  es=$("$K" -n "$NS" get externalsecret secure-notes-credentials -o jsonpath='{.status.conditions[?(@.type=="Ready")].status} {.status.conditions[?(@.type=="Ready")].reason}' 2>/dev/null)
  case "$es" in True*) pass "ExternalSecret secure-notes-credentials is Ready (${es#True })" ;; *) fail "ExternalSecret not ready: '$es'" ;; esac
  keys=$("$K" -n "$NS" get secret secure-notes-credentials -o go-template='{{range $k, $v := .data}}{{$k}} {{end}}' 2>/dev/null)
  [ "$keys" = "db redis " ] && pass "its Secret has the keys db and redis (names only shown)" || fail "unexpected Secret keys: '$keys'"
  spec=$("$K" -n "$NS" get deploy secure-notes -o json)
  if jq -e '[.spec.template.spec.containers[] | (.env // [])[] | select(.valueFrom.secretKeyRef)] + [.spec.template.spec.containers[] | (.envFrom // [])[] | select(.secretRef)] | length == 0' <<< "$spec" >/dev/null \
     && jq -e '[.spec.template.spec.containers[].volumeMounts[]? | select(.name == "credentials" and (.subPath == null))] | length == 1' <<< "$spec" >/dev/null; then
    pass "the Secret is mounted as a volume: no env, no envFrom, no subPath (a subPath file never updates)"
  else
    fail "the credentials reach the app another way than a whole-volume mount"
  fi
  if "$K" -n "$NS" exec deploy/secure-notes -- test -e /var/run/secrets/openbao/token 2>/dev/null; then
    fail "the app pod has an OpenBao token mounted in file mode"
  else
    pass "the app pod has no OpenBao token: it has no identity in OpenBao at all"
  fi
  before=$(curl -fsS "$BASE/api/secrets" | jq -r '.secrets[] | select(.alias == "db") | .versionId')
  echo "  info  the app holds db version $before (when the kubelet wrote that content)"
  echo "== rotate in OpenBao from OUTSIDE the app (a Job as the seed job's service account)"
  "$K" -n "$NS" delete job rotate-db --ignore-not-found --wait=true >/dev/null 2>&1
  "$K" apply -f deploy/k8s/jobs/rotate-db.yaml >/dev/null
  if "$K" -n "$NS" wait --for=condition=complete job/rotate-db --timeout=180s >/dev/null; then
    "$K" -n "$NS" logs job/rotate-db | sed 's/^/  /'
    t0=$(date +%s); after="$before"
    while [ "$after" = "$before" ] && [ $(( $(date +%s) - t0 )) -lt 240 ]; do
      sleep 5
      after=$(curl -fsS "$BASE/api/secrets" | jq -r '.secrets[] | select(.alias == "db") | .versionId')
    done
    reason=$(curl -fsS "$BASE/api/secrets" | jq -r '.secrets[] | select(.alias == "db") | .lastReason')
    if [ "$after" != "$before" ]; then
      pass "the new version reached the app in $(( $(date +%s) - t0 )) s without a restart: $before -> $after ($reason)"
    else
      fail "the app still holds $before 240 s after the rotation"
    fi
    if curl -fsS -X POST -H 'Content-Type: application/json' -d '{"body":"written after the rotation arrived as a file"}' "$BASE/api/notes" >/dev/null; then
      pass "the app writes to Postgres after the rotation"
    else
      fail "writing a note failed after the rotation"
    fi
  else
    fail "the rotation job did not complete"; "$K" -n "$NS" logs job/rotate-db 2>&1 | tail -5 | sed 's/^/  /'
  fi
elif [ "$provider" = openbao ]; then
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
  # Idle connections close after 30 s: make the app query first, then look (see compose-check.sh).
  users=
  for _ in 1 2 3 4 5; do
    curl -fsS "$BASE/api/health" >/dev/null 2>&1 || true
    users=$("$K" -n "$NS" exec deploy/postgres -- psql -U postgres -d notes -tAc "SELECT string_agg(DISTINCT usename, ' ') FROM pg_stat_activity WHERE application_name = 'secure-notes'" 2>/dev/null)
    [ -n "$users" ] && break
    sleep 1
  done
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

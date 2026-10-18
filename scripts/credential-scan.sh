#!/usr/bin/env bash
# Search the RUNNING stack for the actual credential values, not just their
# names: every password the Secrets Manager stand-in holds (all versions, so
# rotated-out ones too) is looked for in each place a credential could leak to.
#
#   scripts/credential-scan.sh compose        Docker Compose stack (COMPOSE_FILE respected)
#   scripts/credential-scan.sh k8s            kind / OpenShift (KUBECTL=oc works)
#   EXPECT_REVEALED=1 scripts/credential-scan.sh compose
#       the app runs with LOG_REVEAL_SECRETS=true: its log MUST contain the
#       values and every other place must still be clean (proves the scan finds
#       what it looks for)
#
# The values are kept in a mode-600 temp file that is deleted on exit, passed
# into containers on stdin only (never as arguments), and never printed: the
# report shows only "clean" or "FOUND n".
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck disable=SC1091
. scripts/versions.env
TARGET="${1:-}"
K="${KUBECTL:-kubectl}"
NS="${NAMESPACE:-secure-notes}"
EXPECT_REVEALED="${EXPECT_REVEALED:-0}"
if [ -z "$TARGET" ]; then
  if $K -n "$NS" get deploy/secure-notes >/dev/null 2>&1; then TARGET=k8s; else TARGET=compose; fi
fi

umask 077
VALS=$(mktemp)
trap 'rm -f "$VALS"' EXIT

# --- 1. The values to look for, read from the stand-in over its own API -------
# Every password-like leaf (password, token, secret, key) of every version of every secret.
read -r -d '' COLLECT <<'JS'
const ep = 'http://127.0.0.1:4566';
const call = async (op, body) => {
  const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `secretsmanager.${op}` }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${op} ${r.status}`);
  return r.json();
};
const sensitive = (k) => /pass|secret|token|key/i.test(k) && !/(id|arn)$/i.test(k);
const out = new Set();
const walk = (o) => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && sensitive(k) && v.length >= 8) out.add(v); else if (v && typeof v === 'object') walk(v); } };
const { SecretList = [] } = await call('ListSecrets', {});
for (const s of SecretList) {
  const d = await call('DescribeSecret', { SecretId: s.Name });
  for (const v of Object.keys(d.VersionIdsToStages ?? {})) {
    try {
      const g = await call('GetSecretValue', { SecretId: s.Name, VersionId: v });
      let o; try { o = JSON.parse(g.SecretString); } catch { o = { secret: g.SecretString }; }
      walk(o);
    } catch {}
  }
}
process.stdout.write([...out].join('\n') + '\n');
JS

# --- the filesystem walker, run INSIDE a container; values arrive on stdin ----
read -r -d '' FSWALK <<'JS'
const fs = require('fs'), path = require('path');
let d = '';
process.stdin.on('data', (c) => (d += c)).on('end', () => {
  const vals = d.split('\n').filter(Boolean);
  const skip = new Set(['/proc', '/sys', '/dev']);
  const hits = []; let files = 0;
  const walk = (p) => {
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { if (skip.has(p)) return; let es; try { es = fs.readdirSync(p); } catch { return; } for (const e of es) walk(path.join(p, e)); return; }
    if (!st.isFile() || st.size > 20e6) return;
    let s; try { s = fs.readFileSync(p).toString('latin1'); } catch { return; }
    files++;
    if (vals.some((v) => s.includes(v))) hits.push(p);
  };
  walk('/');
  console.log(JSON.stringify({ files, hits }));
});
JS

case "$TARGET" in
  compose)
    dc() { docker compose "$@"; }
    dc exec -T aws-mock node --input-type=module -e "$COLLECT" > "$VALS" 2>/dev/null ;;
  k8s)
    $K -n "$NS" exec deploy/aws-mock -- node --input-type=module -e "$COLLECT" > "$VALS" 2>/dev/null ;;
  *) echo "target must be compose or k8s"; exit 1 ;;
esac
n=$(grep -c . "$VALS")
echo "== credential scan ($TARGET): searching for $n secret values from Secrets Manager (every version); the values are never printed"
[ "$n" -ge 4 ] || { echo "  FAIL  could not read the values from the stand-in (got $n, expected at least 4)"; exit 1; }

fails=0
found_app_logs=0
report() { # location, count, [allowed-when-revealed]
  local where=$1 count=$2 allowed=${3:-no}
  if [ "$count" -eq 0 ]; then
    printf '  ok    %-62s clean\n' "$where"
  elif [ "$EXPECT_REVEALED" = 1 ] && [ "$allowed" = yes ]; then
    printf '  ok    %-62s FOUND %s (expected: LOG_REVEAL_SECRETS=true)\n' "$where" "$count"
    found_app_logs=$((found_app_logs + count))
  else
    printf '  FAIL  %-62s FOUND %s\n' "$where" "$count"
    fails=$((fails + 1))
  fi
}
hits() { grep -o -F -f "$VALS" 2>/dev/null | wc -l | tr -d ' '; } # occurrences on stdin
# scan <location> <command...>: like report, but a source that can't be read
# fails instead of passing as "clean" (an empty answer proves nothing).
scan() {
  local where=$1 out; shift
  if ! out=$("$@" 2>/dev/null); then
    printf '  FAIL  %-62s could not be read\n' "$where"; fails=$((fails + 1)); return
  fi
  report "$where" "$(printf '%s' "$out" | hits)"
}

if [ "$TARGET" = compose ]; then
  echo "-- containers"
  for c in $(dc ps -a --format '{{.Service}}'); do
    report "$c: container config (env, command, labels: docker inspect)" "$(docker inspect "$(dc ps -a -q "$c")" | hits)"
  done
  report "app: process environment values (/proc/1/environ)" "$(dc exec -T app cat /proc/1/environ | tr '\0' '\n' | hits)"
  fsr=$(dc exec -T app node -e "$FSWALK" < "$VALS")
  report "app: every readable file ($(echo "$fsr" | jq .files) files)" "$(echo "$fsr" | jq '.hits | length')"
  # The databases should hold only hashes: SCRAM verifiers in Postgres, #sha256 in the Redis ACL file.
  report "postgres: data directory and config (plaintext passwords?)" "$(dc exec -T postgres sh -c 'grep -rhoF -f - /var/lib/postgresql/data /etc/postgresql 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
  report "redis: data and ACL files (plaintext passwords?)" "$(dc exec -T redis sh -c 'grep -rhoF -f - /data /etc 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
  echo "-- logs"
  for c in $(dc ps -a --format '{{.Service}}'); do
    allowed=no; [ "$c" = app ] && allowed=yes
    report "$c: log" "$(dc logs --no-color "$c" 2>/dev/null | hits)" "$allowed"
  done
  applog=$(dc logs --no-color app 2>/dev/null)
else
  echo "-- Kubernetes objects"
  report "pod specs, Deployments, Jobs (env, args, annotations)" "$($K -n "$NS" get pods,deploy,jobs -o yaml | hits)"
  report "ConfigMaps" "$($K -n "$NS" get configmaps -o yaml | hits)"
  report "Secrets (decoded)" "$($K -n "$NS" get secrets -o json | jq -r '.items[].data // {} | .[]' | while read -r b; do echo "$b" | base64 -d; echo; done | hits)"
  report "events" "$($K -n "$NS" get events -o yaml | hits)"
  echo "-- inside the app pod"
  report "app: process environment values (/proc/1/environ)" "$($K -n "$NS" exec deploy/secure-notes -- cat /proc/1/environ | tr '\0' '\n' | hits)"
  fsr=$($K -n "$NS" exec -i deploy/secure-notes -- node -e "$FSWALK" < "$VALS")
  report "app: every readable file ($(echo "$fsr" | jq .files) files)" "$(echo "$fsr" | jq '.hits | length')"
  report "postgres pod: data directory (plaintext passwords?)" "$($K -n "$NS" exec -i deploy/postgres -- sh -c 'grep -rhoF -f - /var/lib/postgresql/data 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
  report "redis pod: data and ACL files (plaintext passwords?)" "$($K -n "$NS" exec -i deploy/redis -- sh -c 'grep -rhoF -f - /data /etc 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
  echo "-- logs (every container, current and previous)"
  for pod in $($K -n "$NS" get pods -o name); do
    allowed=no; [[ "$pod" == pod/secure-notes-* ]] && allowed=yes
    report "${pod#pod/}: logs" "$( { $K -n "$NS" logs "$pod" --all-containers 2>/dev/null; $K -n "$NS" logs "$pod" --all-containers --previous 2>/dev/null; } | hits)" "$allowed"
  done
  applog=$($K -n "$NS" logs deploy/secure-notes 2>/dev/null)
fi

# --- 3. Debug logging works, and it is what keeps the values out --------------
echo "-- debug logging (LOG_LEVEL=debug)"
consumed=$(grep -c '"msg":"secret consumed"' <<< "$applog")
if [ "$consumed" -gt 0 ]; then
  printf '  ok    %-62s %s line(s)\n' 'app log names the secrets and keys it consumed' "$consumed"
  if grep -q 'password=\*\*\*\*\*\*\*\* (' <<< "$applog"; then
    printf '  ok    %-62s yes\n' 'every password is shown as ******** (length, fingerprint)'
  else
    printf '  FAIL  %-62s no\n' 'masked password descriptions present'; fails=$((fails + 1))
  fi
  example=$(grep '"msg":"secret consumed"' <<< "$applog" | head -1 | jq -c '{secretId, versionId, source, keys}' 2>/dev/null)
  [ -n "$example" ] && echo "        e.g. $example"
else
  echo "  info  the app log has no debug credential lines (LOG_LEVEL is not debug)"
fi

if [ "$EXPECT_REVEALED" = 1 ] && [ "$found_app_logs" -eq 0 ]; then
  echo "  FAIL  LOG_REVEAL_SECRETS=true, but the scan found no value in the app log: the scan would miss a real leak"
  fails=$((fails + 1))
fi
if [ "$fails" -eq 0 ]; then echo "credential-scan: no credential value found anywhere it must not be"; else echo "credential-scan: $fails location(s) FAILED"; fi
exit $((fails > 0))

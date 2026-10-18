#!/usr/bin/env bash
# Search the RUNNING stack for the actual credential values, not just their
# names: every password the secrets manager holds (all versions, so rotated-out
# ones too) is looked for in each place a credential could leak to.
#   SECRETS_PROVIDER=aws      the values come from the Secrets Manager stand-in
#   SECRETS_PROVIDER=openbao  the values come from OpenBao, read by the app's own
#                             AppRole identity (every KV version); the OpenBao
#                             container, its audit log and raft storage are scanned too
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
PROVIDER="${SECRETS_PROVIDER:-}"
if [ -z "$TARGET" ]; then
  if $K -n "$NS" get deploy/secure-notes >/dev/null 2>&1; then TARGET=k8s; else TARGET=compose; fi
fi

umask 077
VALS=$(mktemp)
SIDS=$(mktemp)
trap 'rm -f "$VALS" "$SIDS"' EXIT

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

# The same values from OpenBao, read INSIDE the app container with the app's
# own AppRole identity (its role ID and its secret ID file): every KV version of
# the app's and the demo admin secrets, plus any pending copy a rotation left.
read -r -d '' COLLECT_BAO <<'JS'
const { config } = await import('/app/backend/src/config.js');
const { createBaoClient } = await import('/app/backend/src/secrets/bao/client.js');
const b = config.bao;
const c = createBaoClient({ ...b, scheduleRenewal: false });
const sensitive = (k) => /pass|secret|token|key/i.test(k) && !/(id|arn)$/i.test(k);
const out = new Set();
const walk = (o) => { for (const [k, v] of Object.entries(o)) { if (typeof v === 'string' && sensitive(k) && v.length >= 8) out.add(v); else if (v && typeof v === 'object') walk(v); } };
const { resolveStoredSecretIds } = await import('/app/backend/src/secrets/naming.js');
// Every stored (KV) secret of the naming convention (a dynamic ID has no stored value).
const named = resolveStoredSecretIds(process.env).ids;
const ids = [...new Set(Object.values(named).filter(Boolean))];
for (const id of ids) {
  for (const p of [id.replace(/^\/+/, ''), `${id.replace(/^\/+/, '')}/pending`]) {
    const m = await c.request('GET', `${b.kvMount}/metadata/${p}`, { allow404: true });
    for (const v of Object.keys(m?.data?.versions ?? {})) {
      const g = await c.request('GET', `${b.kvMount}/data/${p}?version=${v}`, { allow404: true });
      if (g?.data?.data) walk(g.data.data);
    }
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
  // SKIP_DIR: file mode's mounted Secret, which holds the values by design (reported separately).
  // realpath: on Alpine /var/run is a symlink to /run, and the walk does not follow symlinks.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const skip = new Set(['/proc', '/sys', '/dev', ...(process.env.SKIP_DIR ? [real(process.env.SKIP_DIR)] : [])]);
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

dc() { docker compose "$@"; }
if [ -z "$PROVIDER" ] && [ "$TARGET" = compose ]; then
  PROVIDER=$(dc exec -T app printenv SECRETS_PROVIDER 2>/dev/null || true)
elif [ -z "$PROVIDER" ]; then
  PROVIDER=$($K -n "$NS" exec deploy/secure-notes -- printenv SECRETS_PROVIDER 2>/dev/null || true)
fi
PROVIDER="${PROVIDER:-aws}"
# OpenBao or Vault: the same API; only the server's service, paths and name differ.
case "$PROVIDER" in
  vault) SM=vault; SMDIR=/vault; SMNAME=Vault ;;
  *)     SM=openbao; SMDIR=/openbao; SMNAME=OpenBao ;;
esac
case "$TARGET:$PROVIDER" in
  compose:openbao|compose:vault)
    dc exec -T app node --input-type=module -e "$COLLECT_BAO" > "$VALS" 2>/dev/null
    # The AppRole secret IDs: the app's (in its file) and the seed's spent bootstrap one.
    { dc exec -T app cat /home/node/bao-secret-id; echo; dc exec -T "$SM" cat "$SMDIR/config/seed-secret-id"; echo; dc exec -T "$SM" cat "$SMDIR/config/ops-secret-id"; echo; } 2>/dev/null | grep . > "$SIDS" ;;
  compose:aws)
    dc exec -T aws-mock node --input-type=module -e "$COLLECT" > "$VALS" 2>/dev/null ;;
  compose:*) echo "SECRETS_PROVIDER must be aws, openbao or vault (got '$PROVIDER')"; exit 1 ;;
  k8s:openbao)
    FILEDIR=$($K -n "$NS" exec deploy/secure-notes -- printenv SECRETS_DIR 2>/dev/null || true)
    if [ "$($K -n "$NS" exec deploy/secure-notes -- printenv SECRETS_MODE 2>/dev/null)" = file ]; then
      # File mode: the app has no OpenBao identity, so the values come from the
      # mounted files (their current versions; rotated-out ones are not kept there).
      for f in db redis; do $K -n "$NS" exec deploy/secure-notes -- cat "$FILEDIR/$f" 2>/dev/null | jq -r '.. | objects | to_entries[] | select((.key | test("pass|secret|token|key"; "i")) and (.value | type == "string") and (.value | length >= 8)) | .value'; done > "$VALS"
      MIN=2
    else
      FILEDIR=""
      $K -n "$NS" exec deploy/secure-notes -- node --input-type=module -e "$COLLECT_BAO" > "$VALS" 2>/dev/null
    fi ;;
  k8s:*)
    $K -n "$NS" exec deploy/aws-mock -- node --input-type=module -e "$COLLECT" > "$VALS" 2>/dev/null ;;
  *) echo "target must be compose or k8s"; exit 1 ;;
esac
# Step v2: dynamic users. Their passwords exist only in the app's memory (and
# in OpenBao, encrypted), so nothing can read them back to search for, except
# when the app runs with LOG_REVEAL_SECRETS=true: then they are taken from its
# own log, and every OTHER place must still be clean of them.
DYNAMIC=no
if [ "$TARGET:$PROVIDER" = k8s:openbao ] && $K -n "$NS" exec deploy/secure-notes -- printenv DB_SECRET_ID 2>/dev/null | grep -q '/creds/'; then
  DYNAMIC=yes
elif { [ "$TARGET:$PROVIDER" = compose:openbao ] || [ "$TARGET:$PROVIDER" = compose:vault ]; } && dc exec -T app printenv DB_SECRET_ID 2>/dev/null | grep -q '/creds/'; then
  DYNAMIC=yes
  if [ "$EXPECT_REVEALED" = 1 ]; then
    dc logs --no-color app 2>/dev/null | sed 's/^[^{]*//' | jq -r 'select(.msg? == "secret consumed (values revealed)") | .keys[]? | select(startswith("password=")) | sub("^.* value="; "")' 2>/dev/null | sort -u >> "$VALS"
  fi
fi
n=$(grep -c . "$VALS")
src="Secrets Manager"; [ "$PROVIDER" != aws ] && src="$SMNAME, read as the app's own identity"
[ "$DYNAMIC" = yes ] && [ "$EXPECT_REVEALED" = 1 ] && src="$src, plus the leased users' passwords from the app's revealed log"
echo "== credential scan ($TARGET): searching for $n secret values from $src (every version); the values are never printed"
export FILEDIR="${FILEDIR:-}"
[ -n "${FILEDIR:-}" ] && src="the app's mounted Secret files (file mode: the app has no OpenBao identity)"
[ "$n" -ge "${MIN:-4}" ] || { echo "  FAIL  could not read the values from $src (got $n, expected at least ${MIN:-4})"; exit 1; }
if [ "$DYNAMIC" = yes ] && [ "$EXPECT_REVEALED" != 1 ]; then
  echo "  info  dynamic users: their passwords are only in the app's memory; the LOG_REVEAL_SECRETS run searches for them"
fi

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
  echo "$fsr" | jq -r '.hits[:3][] | "        in " + .' # where (paths only, never values)
  # The databases should hold only hashes: SCRAM verifiers in Postgres, #sha256 in the Redis ACL file.
  report "postgres: data directory and config (plaintext passwords?)" "$(dc exec -T postgres sh -c 'grep -rhoF -f - /var/lib/postgresql/data /etc/postgresql 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
  report "redis: data and ACL files (plaintext passwords?)" "$(dc exec -T redis sh -c 'grep -rhoF -f - /data /etc 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
  if [ "$PROVIDER" != aws ]; then
    # OpenBao (and Vault) encrypt its storage with the barrier key, and its audit device
    # writes HMAC-SHA256 of request and response values, never the values.
    scan "$SM: audit log (values must be HMAC'd)" dc exec -T "$SM" cat "$SMDIR/logs/audit.log"
    report "$SM: raft storage, seal/unseal key, config, /tmp (plaintext?)" "$(dc exec -T "$SM" sh -c "grep -rhoF -f - $SMDIR /etc/$SM /tmp 2>/dev/null" < "$VALS" | wc -l | tr -d ' ')"
  fi
  echo "-- logs"
  for c in $(dc ps -a --format '{{.Service}}'); do
    allowed=no; [ "$c" = app ] && allowed=yes
    report "$c: log" "$(dc logs --no-color "$c" 2>/dev/null | hits)" "$allowed"
  done
  applog=$(dc logs --no-color app 2>/dev/null)
  if [ "$PROVIDER" != aws ]; then
    # Secret zero: the AppRole secret IDs are credentials too. They live only in
    # their files; never in env, a container's config, a log or the audit log.
    m=$(grep -c . "$SIDS")
    echo "-- the AppRole secret IDs ($m: the app's, the seed's spent bootstrap one, and the lab's ops-admin one if present)"
    if [ "$m" -lt 2 ]; then
      echo "  FAIL  could not read both secret ID files"; fails=$((fails + 1))
    else
      sid() { grep -o -F -f "$SIDS" 2>/dev/null | wc -l | tr -d ' '; }
      n_cfg=0; n_log=0
      for c in $(dc ps -a --format '{{.Service}}'); do
        n_cfg=$((n_cfg + $(docker inspect "$(dc ps -a -q "$c")" | sid)))
        n_log=$((n_log + $(dc logs --no-color "$c" 2>/dev/null | sid)))
      done
      report "every container's config (env, command, labels)" "$n_cfg"
      report "every container's log (the app log too, even when revealing)" "$n_log"
      report "app: process environment values (/proc/1/environ)" "$(dc exec -T app cat /proc/1/environ | tr '\0' '\n' | sid)"
      report "$SM: audit log" "$(dc exec -T "$SM" cat "$SMDIR/logs/audit.log" 2>/dev/null | sid)"
    fi
  fi
else
  echo "-- Kubernetes objects"
  report "pod specs, Deployments, Jobs (env, args, annotations)" "$($K -n "$NS" get pods,deploy,jobs -o yaml | hits)"
  report "ConfigMaps" "$($K -n "$NS" get configmaps -o yaml | hits)"
  report "Secrets (decoded)$([ -n "${FILEDIR:-}" ] && echo ', except the one ESO manages')" "$($K -n "$NS" get secrets -o json | jq -r '.items[] | select(.metadata.name != "secure-notes-credentials" or env.FILEDIR == "") | .data // {} | .[]' | while read -r b; do echo "$b" | base64 -d; echo; done | hits)"
  [ -n "${FILEDIR:-}" ] && echo "  info  secure-notes-credentials (managed by External Secrets Operator) holds the values by design in file mode"
  report "events" "$($K -n "$NS" get events -o yaml | hits)"
  echo "-- inside the app pod"
  report "app: process environment values (/proc/1/environ)" "$($K -n "$NS" exec deploy/secure-notes -- cat /proc/1/environ | tr '\0' '\n' | hits)"
  fsr=$($K -n "$NS" exec -i deploy/secure-notes -- env SKIP_DIR="${FILEDIR:-}" node -e "$FSWALK" < "$VALS")
  [ -n "${FILEDIR:-}" ] && echo "  info  $FILEDIR (the mounted Secret) holds the values by design in file mode; every other file is searched"
  report "app: every readable file ($(echo "$fsr" | jq .files) files)" "$(echo "$fsr" | jq '.hits | length')"
  echo "$fsr" | jq -r '.hits[:3][] | "        in " + .' # where (paths only, never values)
  report "postgres pod: data directory (plaintext passwords?)" "$($K -n "$NS" exec -i deploy/postgres -- sh -c 'grep -rhoF -f - /var/lib/postgresql/data 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
  report "redis pod: data and ACL files (plaintext passwords?)" "$($K -n "$NS" exec -i deploy/redis -- sh -c 'grep -rhoF -f - /data /etc 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
  echo "-- logs (every container, current and previous)"
  for pod in $($K -n "$NS" get pods -o name); do
    allowed=no; [[ "$pod" == pod/secure-notes-* ]] && allowed=yes
    report "${pod#pod/}: logs" "$( { $K -n "$NS" logs "$pod" --all-containers 2>/dev/null; $K -n "$NS" logs "$pod" --all-containers --previous 2>/dev/null; } | hits)" "$allowed"
  done
  applog=$($K -n "$NS" logs deploy/secure-notes 2>/dev/null)
  if [ "$PROVIDER" = openbao ]; then
    echo "-- OpenBao (namespace openbao): its audit device writes to the pod log"
    report "openbao-0: log, with the audit log (values must be HMAC'd)" "$( { $K -n openbao logs openbao-0 2>/dev/null; $K -n openbao logs openbao-0 --previous 2>/dev/null; } | hits)"
    report "openbao-0: raft storage and config (plaintext?)" "$($K -n openbao exec -i openbao-0 -- sh -c 'grep -rhoF -f - /openbao 2>/dev/null' < "$VALS" | wc -l | tr -d ' ')"
    report "openbao namespace: Secrets (decoded; the seal key is binary)" "$($K -n openbao get secrets -o json | jq -r '.items[].data // {} | .[]' | while read -r b; do echo "$b" | base64 -d 2>/dev/null; echo; done | hits)"
  fi
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

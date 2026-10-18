#!/usr/bin/env bash
# Show who can read credentials passed to a container in a .env file, then run
# the same lookups on the Secure Notes image, which is given secret IDs only.
#
#   scripts/env-file-demo.sh                 # Podman
#   ENGINE=docker scripts/env-file-demo.sh   # Docker
#
# Uses demo/env-file-demo/generic-app.env, which holds EXAMPLE values only.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
E="${ENGINE:-podman}"
IMAGE="${DEMO_IMAGE:-docker.io/library/alpine:3.20}"
APP_IMAGE="${APP_IMAGE:-secure-notes-app:dev}"
GENERIC=demo/env-file-demo/generic-app.env
NOTES=demo/env-file-demo/secure-notes.env

run() { echo "\$ $*"; "$@"; echo; }   # print the command, then its output
ENVFMT='{{range .Config.Env}}{{println .}}{{end}}'
step() { printf '\n## %s\n\n' "$*"; }
cleanup() { $E rm -f envdemo sndemo >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "# Part 1: a generic app started with --env-file ($E $($E --version | awk '{print $NF}'))"
step "The .env file"
run cat "$GENERIC"

step "1. Start it headless (-d), removed when it stops (--rm)"
run $E run -q -d --rm --name envdemo --env-file "$GENERIC" "$IMAGE" sleep 600

step "2. Anyone who can exec into the container reads every value"
run $E exec envdemo env

step "3. The same values sit in the process's environment block"
echo "\$ $E exec envdemo sh -c 'tr \"\\0\" \"\\n\" < /proc/1/environ'"
$E exec envdemo sh -c 'tr "\0" "\n" < /proc/1/environ'; echo

step "4. No shell needed at all: the container runtime hands them out"
echo "\$ $E inspect envdemo --format '$ENVFMT'"; $E inspect envdemo --format "$ENVFMT"

step "5. Every child process inherits them (a crash reporter, a debug shell, a subprocess)"
echo "\$ $E exec envdemo sh -c 'sh -c env | grep -E \"PASSWORD|API_KEY\"'   # a process started by another process"
$E exec envdemo sh -c 'sh -c env | grep -E "PASSWORD|API_KEY"'; echo

step "6. On the host, the container's process is an ordinary process"
pid=$($E inspect envdemo --format '{{.State.Pid}}')
echo "\$ pid=\$($E inspect envdemo --format '{{.State.Pid}}')   # $pid"
echo "\$ sudo cat /proc/\$pid/environ | tr '\\0' '\\n' | grep PASSWORD"
{ cat "/proc/$pid/environ" 2>/dev/null || sudo -n cat "/proc/$pid/environ" 2>/dev/null; } | tr '\0' '\n' | grep PASSWORD || echo "(needs root or the same user on this host)"
echo
run $E kill envdemo

echo
echo "# Part 2: Secure Notes, given only where its secrets are"
step "Its env file: secret IDs and hostnames, no credentials"
run cat "$NOTES"
step "The same lookups (command overridden to sleep: no AWS needed to look)"
run $E run -q -d --rm --name sndemo --env-file "$NOTES" "$APP_IMAGE" sleep 600
echo "\$ $E exec sndemo env | grep -Ei 'pass|secret|token|key|url'"
$E exec sndemo env | grep -Ei 'pass|secret|token|key|url'; echo
echo "\$ $E inspect sndemo --format '$ENVFMT'"; $E inspect sndemo --format "$ENVFMT"
echo "Nothing to steal: the passwords are fetched at runtime from Secrets Manager, kept in"
echo "memory only, and the app refuses to start if DB_PASSWORD, DATABASE_URL, REDIS_URL… are set."
run $E kill sndemo

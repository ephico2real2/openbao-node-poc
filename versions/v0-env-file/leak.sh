#!/usr/bin/env bash
# Where do v0's passwords end up? Run with the v0 stack up (docker compose up -d).
# Each check prints how many times the example passwords appear; the values
# themselves are shown only as "Example-Only-…" (they are fake, but the habit matters).
#
#   ./leak.sh            # Docker
#   ENGINE=podman ./leak.sh
set -uo pipefail
cd "$(dirname "$0")" || exit 1
E="${ENGINE:-docker}"
C="$E compose"
PASSWORDS='Example-Only-Pa55w0rd|Example-Only-R3dis'
found=0
look() { # look <where> <command...>
  local where=$1; shift
  local n
  n=$("$@" 2>/dev/null | grep -Eo "$PASSWORDS" | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then printf '  LEAK  %-58s %s occurrence(s)\n' "$where" "$n"; found=$((found + 1))
  else printf '  -     %-58s none\n' "$where"; fi
}

echo "== v0: where the passwords can be read (anyone with access to the host or the runtime)"
look "the .env file itself"                                   cat v0.env
look "docker compose config (the whole resolved deployment)"  $C config
look "app: exec env"                                          $C exec -T app env
look "app: /proc/1/environ (the process environment)"         $C exec -T app sh -c 'tr "\0" "\n" < /proc/1/environ'
look "app: inspect (no shell needed)"                         $E inspect "$($C ps -q app)"
look "app: its own log (connection strings)"                  $C logs --no-color app
look "redis: inspect (password on the command line)"          $E inspect "$($C ps -q redis)"
look "redis: ps inside the container"                         $C exec -T redis ps -o args
look "postgres: exec env"                                     $C exec -T postgres env
echo
echo "$found of 9 places expose a password. In the redesign the same checks find none:"
echo "see scripts/credential-scan.sh and docs/learn/02-the-env-file-problem.md."
[ "$found" -ge 8 ] # CI: the demo must keep demonstrating the problem

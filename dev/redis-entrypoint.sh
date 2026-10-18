#!/bin/sh
# LOCAL DEV ONLY. Start Redis with an ACL file so users created by the seed
# job (and passwords changed by the demo rotator) survive restarts.
# On first start the default user gets the bootstrap password, which the seed
# job replaces with a random value straight away.
set -eu
ACL=/data/users.acl
if [ ! -s "$ACL" ]; then
  echo "user default on >${REDIS_BOOTSTRAP_PASSWORD} ~* &* +@all" > "$ACL"
  chmod 600 "$ACL"
fi
exec redis-server --aclfile "$ACL" --appendonly no --save ""

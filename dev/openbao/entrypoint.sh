#!/bin/sh
# LAB ONLY: start the OpenBao server for the Compose lab with no manual steps.
# Runs as the image's unprivileged `openbao` user.
#
# On the first start it creates, on the server's own volumes:
#   /openbao/file/unseal.key        32 random bytes for the static seal (config.hcl)
#   /openbao/config/seed-secret-id  the seed job's ONE-TIME AppRole secret ID; self-init
#                                   registers it, the seed job reads it (read-only mount),
#                                   and after its one login it no longer works
# Nothing here is a default value or lives in the repository.
set -eu
umask 077
if [ ! -s /openbao/file/unseal.key ]; then
  head -c 32 /dev/urandom > /openbao/file/unseal.key
  echo "[openbao-lab] generated the static seal key (lab only: it sits next to the data)"
fi
if [ ! -s /openbao/config/seed-secret-id ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > /openbao/config/seed-secret-id
  chmod 0444 /openbao/config/seed-secret-id # the seed job runs as another user; it is single-use
  echo "[openbao-lab] generated the seed job's one-time bootstrap secret ID"
fi
exec bao server -config=/etc/openbao/config.hcl

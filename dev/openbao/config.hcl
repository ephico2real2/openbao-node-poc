# DEV/LAB ONLY: an OpenBao server for the Secure Notes lab, ready with no manual
# steps. It starts unsealed (static seal: a key file generated on first start by
# entrypoint.sh, kept on the data volume) and initialises itself (self-init: the
# requests below run once, with a root token that is revoked afterwards, so no
# root token ever exists outside the server).
#
# What self-init creates:
#   - KV v2 at secret/                       the app's credentials
#   - AppRole auth at approle/               how the seed job and the app log in
#   - a file audit device                    every request, values HMAC'd (never plaintext)
#   - policies and two roles:
#       secure-notes-seed  one-shot bootstrap: its only secret ID is read from a
#                          file that entrypoint.sh generated on first start
#                          (/openbao/config/seed-secret-id, shared read-only with
#                          the seed job) and works ONCE (secret_id_num_uses = 1),
#                          then it is spent, like the bootstrap passwords
#                          Postgres and Redis start with
#       secure-notes-app   the app: reads its secrets; logs in with a secret ID the
#                          seed job mints and hands over in a file (mode 0400)
# Role IDs are fixed names: like a username, a role ID is not a secret.

ui            = false
disable_mlock = true
api_addr      = "http://openbao:8200"
cluster_addr  = "http://openbao:8201"

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true # lab only: plain HTTP on the Compose network (TLS: epic B5)
}

storage "raft" {
  path    = "/openbao/file"
  node_id = "openbao-0"
}

# Static seal: a 32-byte key in a file, so the server unseals itself. LAB ONLY:
# the key sits on the same volume as the data it protects. In production the key
# comes from a KMS, an HSM or another OpenBao (transit), never from next door.
seal "static" {
  current_key_id = "lab-1"
  current_key    = "file:///openbao/file/unseal.key"
}

# Audit devices are declared in the config: OpenBao does not allow creating them
# through the API unless that is unsafely enabled.
audit "file" "file" {
  options {
    file_path = "/openbao/logs/audit.log"
  }
}

initialize "engines" {
  request "enable-kv" {
    operation = "update"
    path      = "sys/mounts/secret"
    data      = { type = "kv", options = { version = "2" } }
  }
  request "enable-approle" {
    operation = "update"
    path      = "sys/auth/approle"
    data      = { type = "approle" }
  }
}

initialize "policies" {
  # The app: read its own secrets and their metadata. In this LAB the app also
  # runs the demo rotator, so it may read the admin secrets and write new
  # versions of its own; a real deployment gives rotation its own role.
  request "app-policy" {
    operation = "update"
    path      = "sys/policies/acl/secure-notes-app"
    data = {
      policy = <<-EOT
        path "secret/data/rds/+/notes-db/*"          { capabilities = ["read", "create", "update"] }
        path "secret/data/elasticache/+/notes-cache/*" { capabilities = ["read", "create", "update"] }
        path "secret/metadata/rds/+/notes-db/*"      { capabilities = ["read"] }
        path "secret/metadata/elasticache/+/notes-cache/*" { capabilities = ["read"] }
        path "secret/metadata/rds/+/notes-db/+/pending"      { capabilities = ["read", "delete"] } # the most specific rule wins: repeat read
        path "secret/metadata/elasticache/+/notes-cache/+/pending" { capabilities = ["read", "delete"] }
        path "sys/tools/random/*"                    { capabilities = ["update"] }
      EOT
    }
  }
  # The seed job: write the four secrets once, generate passwords, and mint the
  # app's first secret ID. Nothing else.
  request "seed-policy" {
    operation = "update"
    path      = "sys/policies/acl/secure-notes-seed"
    data = {
      policy = <<-EOT
        path "secret/data/rds/+/notes-db/*"          { capabilities = ["read", "create", "update"] }
        path "secret/data/elasticache/+/notes-cache/*" { capabilities = ["read", "create", "update"] }
        path "secret/metadata/*"                     { capabilities = ["read", "list"] }
        path "sys/tools/random/*"                    { capabilities = ["update"] }
        path "auth/approle/role/secure-notes-app/secret-id" { capabilities = ["update"] }
      EOT
    }
  }
}

initialize "roles" {
  request "app-role" {
    operation = "update"
    path      = "auth/approle/role/secure-notes-app"
    data = {
      token_policies     = ["secure-notes-app"]
      token_ttl          = "15m" # short, so the lab shows renew-self
      token_max_ttl      = "4h"  # then the app logs in again with its secret ID
      secret_id_num_uses = 0
      secret_id_ttl      = "0"
    }
  }
  request "app-role-id" {
    operation = "update"
    path      = "auth/approle/role/secure-notes-app/role-id"
    data      = { role_id = "secure-notes-app" }
  }
  request "seed-role" {
    operation = "update"
    path      = "auth/approle/role/secure-notes-seed"
    data = {
      token_policies     = ["secure-notes-seed"]
      token_ttl          = "10m"
      token_max_ttl      = "10m"
      secret_id_num_uses = 1
      secret_id_ttl      = "24h"
    }
  }
  request "seed-role-id" {
    operation = "update"
    path      = "auth/approle/role/secure-notes-seed/role-id"
    data      = { role_id = "secure-notes-seed" }
  }
  request "seed-bootstrap-secret-id" {
    operation = "update"
    path      = "auth/approle/role/secure-notes-seed/custom-secret-id"
    data = {
      secret_id = {
        eval_type   = "string"
        eval_source = "file"
        path        = "/openbao/config/seed-secret-id"
      }
    }
  }
}

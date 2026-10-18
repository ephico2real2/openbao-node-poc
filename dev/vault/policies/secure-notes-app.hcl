# The app (same as OpenBao's in dev/openbao/config.hcl): its secrets, the demo's
# writes, its dynamic users, renewing and revoking only its own leases.
path "secret/data/rds/+/notes-db/*"          { capabilities = ["read", "create", "update"] }
path "secret/data/elasticache/+/notes-cache/*" { capabilities = ["read", "create", "update"] }
path "secret/metadata/rds/+/notes-db/*"      { capabilities = ["read"] }
path "secret/metadata/elasticache/+/notes-cache/*" { capabilities = ["read"] }
path "secret/metadata/rds/+/notes-db/+/pending"      { capabilities = ["read", "delete"] }
path "secret/metadata/elasticache/+/notes-cache/+/pending" { capabilities = ["read", "delete"] }
path "sys/tools/random/*"                    { capabilities = ["update"] }
path "database/creds/notes-app"              { capabilities = ["read"] }
path "database/creds/notes-cache"            { capabilities = ["read"] }
path "sys/leases/renew"                      { capabilities = ["update"] }
path "sys/leases/revoke" {
  capabilities       = ["update"]
  allowed_parameters = { "lease_id" = ["database/creds/notes-app/*", "database/creds/notes-cache/*"] }
}

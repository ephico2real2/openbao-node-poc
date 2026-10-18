# The seed job (same as OpenBao's): write the stored secrets once, mint the
# app's secret ID, connect the database engine and hand its admins over.
path "secret/data/rds/+/notes-db/*"          { capabilities = ["read", "create", "update"] }
path "secret/data/elasticache/+/notes-cache/*" { capabilities = ["read", "create", "update"] }
path "secret/metadata/*"                     { capabilities = ["read", "list"] }
path "sys/tools/random/*"                    { capabilities = ["update"] }
path "auth/approle/role/secure-notes-app/secret-id" { capabilities = ["update"] }
path "database/config/notes-db"              { capabilities = ["create", "update"] }
path "database/config/notes-cache"           { capabilities = ["create", "update"] }
path "database/roles/notes-app"              { capabilities = ["create", "update"] }
path "database/roles/notes-cache"            { capabilities = ["create", "update"] }
path "database/rotate-root/notes-db"         { capabilities = ["update"] }
path "database/rotate-root/notes-cache"      { capabilities = ["update"] }

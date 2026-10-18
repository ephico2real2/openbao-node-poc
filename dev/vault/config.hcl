# DEV/LAB ONLY: a HashiCorp Vault server for Secure Notes (step v4). The same
# shape as dev/openbao/config.hcl, minus what Vault doesn't have: no static
# seal and no self-init. entrypoint.sh initialises and unseals it instead, and
# runs the setup requests that OpenBao's self-init runs.
ui            = false
disable_mlock = true
api_addr      = "http://vault:8200"
cluster_addr  = "http://vault:8201"

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true # lab only: plain HTTP on the Compose network
}

storage "raft" {
  path    = "/vault/file"
  node_id = "vault-0"
}

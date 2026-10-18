# Baseline: Secure Notes on AWS Secrets Manager

**The starting point.** Secure Notes copied from
[aws-secrets-manager-node-poc@67ec055](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/67ec055)
with the AWS path kept: the app reads its Postgres and Redis credentials from AWS Secrets
Manager (a bundled stand-in locally) at runtime. No credential is in an env var, file,
image, log or Kubernetes object. Rotation needs no restart, and debug logs mask values.

Left out on purpose: the AWS-only alerting (SNS, CloudTrail, EventBridge), CloudFormation
and the EC2 scripts. Every later step is a visible diff against this tag.

## Run it

```bash
docker compose up --build -d && scripts/compose-check.sh
```

## Evidence

Every job green in [CI run 39155150999](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39155150999), a push to main, on commit `98018d1`.

## Read more

- [Demo pages 1–12](https://github.com/ephico2real2/openbao-node-poc/tree/v1-aws-baseline/demo/README.md)
- Demo pages with this repo's CI screenshots: [demo/README.md](https://github.com/ephico2real2/openbao-node-poc/blob/main/demo/README.md) (on main)

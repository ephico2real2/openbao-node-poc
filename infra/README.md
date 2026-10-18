# infra/

[← Project README](../README.md)

Only the two IAM examples that the EKS / ROSA path needs ([GUIDE B3](../docs/GUIDE.md#b3--eks-or-rosa-against-real-aws)):

| File | What it is |
| --- | --- |
| [`iam-policy.example.json`](iam-policy.example.json) | The app's least-privilege policy: read two secrets, only through the VPC endpoint |
| [`irsa-trust-policy.example.json`](irsa-trust-policy.example.json) | The trust policy that lets the `secure-notes` service account assume the role (IRSA) |

The EC2 stack (CloudFormation, the Redis rotation function, the systemd unit and the alert
topics) stays in the sibling repo:
[`aws-secrets-manager-node-poc/infra`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/main/infra).
The OpenBao and Vault server configuration lives in `dev/` (labs) and `deploy/` (Kubernetes).

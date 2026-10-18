# Secret naming convention

[README](../../README.md) · [Learning path](../learn/README.md) · Backlog: [F2.8](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/modernization/backlog.md#e2--application-changes-consume-secrets-at-runtime)

**What you'll learn:** how to name secrets so that the name says *what* and *where*, how
Secure Notes builds those names from a few settings, and how to set them from a
`config.yaml`, a `config.env`, a Kubernetes ConfigMap or Helm `values.yaml`.

## Why a convention

A hand-typed secret ID per environment drifts: `prod-db-pass`, `db/prod`, `notes_rds_prd`.
With one pattern:

- config differs between environments by **one value** (`env`), not by a list of paths;
- IAM can grant a whole environment or service with one wildcard
  (`secret:/rds/prod/*`), and deny the rest;
- anyone can tell from a name what it unlocks, and CloudTrail and alarms read clearly.

## The pattern

```
/{service}/{env}/{resource}/{name}        default
 /rds/prod/notes-db/app                   the app's database login (DB_SECRET_RESOURCE=notes-db)
 /elasticache/prod/notes-cache/app        the app's Redis user (REDIS_SECRET_RESOURCE=notes-cache)
```

| Token | Meaning | Default | Set with (env var · config file key) |
| --- | --- | --- | --- |
| `{env}` | The environment; must be one of `dev`, `uat`, `qa`, `prod` | — (required) | `SECRETS_ENV` · `secrets.env` |
| `{service}` | The kind of backing service | `rds` (db), `elasticache` (redis) | `DB_SECRET_SERVICE`, `REDIS_SECRET_SERVICE` · `secrets.db.service` |
| `{resource}` | Which instance: the RDS instance, cache or stack name | the `{app}` value | `DB_SECRET_RESOURCE`, `REDIS_SECRET_RESOURCE` · `secrets.db.resource` |
| `{name}` | Which credential on that resource | `app` (`admin` for the demo rotator) | `DB_SECRET_NAME`, `REDIS_SECRET_NAME` · `secrets.db.name` |
| `{app}` | The application | `secure-notes` | `SECRETS_APP` · `secrets.app` |
| `{region}` | The AWS region | `AWS_REGION` | — |

Choose the order with `SECRETS_NAME_PATTERN` (`secrets.pattern`): a preset name or your own.

| Preset | Pattern | Example | Grant with one wildcard… |
| --- | --- | --- | --- |
| `service-env-resource` (default) | `/{service}/{env}/{resource}/{name}` | `/rds/prod/notes-db/app` | every prod RDS secret: `/rds/prod/*` |
| `service-resource-env` | `/{service}/{resource}/{env}/{name}` | `/rds/notes-db/prod/app` | every environment of one database: `/rds/notes-db/*` |
| `env-service-resource` | `/{env}/{service}/{resource}/{name}` | `/prod/rds/notes-db/app` | everything in prod: `/prod/*` |
| `app-env-service` | `/{app}/{env}/{service}/{name}` | `/secure-notes/prod/rds/app` | one app's secrets: `/secure-notes/prod/*` |

Put first the part you most often grant or deny by. Most teams pick the default or
`env-service-resource`, because the hardest boundary to cross should be between
environments.

**Rules the app enforces at startup** (it exits 78 with the reason):

- the pattern contains `{env}`, and `env` is an allowed value (the environment variable
  `SECRETS_ALLOWED_ENVS` changes the list, for example `dev,staging,prod`; the
  CloudFormation `Environment` parameter has its own list);
- every value is one path segment: letters, digits and `_+=.@-`, never `/`;
- the result is a valid Secrets Manager name: at most 512 characters, no `//`;
- it **warns** if a name ends in `-` plus six characters (`app-secret`): that looks like
  the random suffix AWS adds to secret ARNs and makes partial-ARN matching ambiguous.

## Which wins

1. An **explicit ID**: `DB_SECRET_ID` / `REDIS_SECRET_ID`, or `secrets.db.id`. Use this for
   secrets whose name you don't choose. **RDS names its own master-password secret
   `rds!db-…`**, so that one is always given by ARN.
2. Otherwise, the name built from the parts. Each part comes from its environment
   variable if set, else the config file, else the default.

The app logs the result at startup (`secret IDs resolved`, with the source of each) and
shows it in `/api/config`. Names are not secret; values never appear.

## Where to set it

**`config.yaml`** (read with `APP_CONFIG_FILE=/etc/secure-notes/config.yaml`):

```yaml
secrets:
  env: prod
  pattern: /{service}/{env}/{resource}/{name}
  db:
    id: arn:aws:secretsmanager:us-east-1:111122223333:secret:rds!db-0a1b2c3d-AbCdEf
  redis:
    resource: secure-notes            # -> /elasticache/prod/secure-notes/app
```

The app reads a small, strict YAML subset (nested keys, plain or quoted values) so it
needs no extra dependency; a list, an anchor or a multi-line value is refused with its
line number. `.json` works the same. A config file that contains a key like `password`
or a URL with a password in it is refused: config files hold names only.
Full example: [`deploy/config/config.example.yaml`](../../deploy/config/config.example.yaml).

**`config.env`**, the same settings as variables, for `podman --env-file`, systemd
`EnvironmentFile=` or `APP_CONFIG_FILE=…/config.env`
([`deploy/config/config.example.env`](../../deploy/config/config.example.env)):

```bash
SECRETS_ENV=prod
DB_SECRET_ID=arn:aws:secretsmanager:us-east-1:111122223333:secret:rds!db-0a1b2c3d-AbCdEf
REDIS_SECRET_RESOURCE=secure-notes
```

**Kustomize** (what this repo uses): `configMapGenerator` literals. The `local-backing-services` component (used by the kind and OpenShift overlays) sets
`SECRETS_ENV=dev`, `DB_SECRET_RESOURCE=notes-db`, `REDIS_SECRET_RESOURCE=notes-cache`
([`deploy/k8s/components/local-backing-services/kustomization.yaml`](../../deploy/k8s/components/local-backing-services/kustomization.yaml)).

**Helm `values.yaml`**: one value per environment file, rendered into the ConfigMap:

```yaml
# values-prod.yaml
secrets:
  env: prod
  pattern: /{service}/{env}/{resource}/{name}
  redis: { resource: secure-notes }
```

```yaml
# templates/configmap.yaml
data:
  SECRETS_ENV: {{ .Values.secrets.env | quote }}
  SECRETS_NAME_PATTERN: {{ .Values.secrets.pattern | quote }}
  REDIS_SECRET_RESOURCE: {{ .Values.secrets.redis.resource | quote }}
```

## Create the secrets with the same names

The provisioning side must build names the same way.

| Tool | Example |
| --- | --- |
| CloudFormation (this repo) | `Name: !Sub /elasticache/${Environment}/${AWS::StackName}/app` in `infra/cloudformation.yaml`; the instance gets `SECRETS_ENV` and `REDIS_SECRET_RESOURCE`, never the name itself |
| Terraform | `name = "/${var.service}/${var.env}/${var.resource}/app"` on `aws_secretsmanager_secret` |
| Local (Compose, kind) | the seed job calls the same `resolveSecretIds()` as the app, so the two can't disagree |

## Least privilege by path

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:111122223333:secret:/elasticache/prod/secure-notes/*"
}
```

Secrets Manager adds a random 6-character suffix to every ARN, so a policy for one named
secret ends in `-??????` (or `*`). Secure Notes' role still lists exact ARNs; a path
wildcard is for a team role or a break-glass role that should reach one environment only.

## Sources

- [`CreateSecret`: name rules](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_CreateSecret.html) · [IAM policy examples](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html) · [quotas (name length)](https://docs.aws.amazon.com/secretsmanager/latest/userguide/reference_limits.html)
- [AWS whitepaper: tagging and naming best practices](https://docs.aws.amazon.com/whitepapers/latest/tagging-best-practices/tagging-best-practices.html)

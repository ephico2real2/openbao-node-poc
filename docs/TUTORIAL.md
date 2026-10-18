# Tutorial — see every feature work, and prove it yourself

About 20 minutes, on your laptop. You need Docker with Compose v2, `jq`, and for the check scripts Node.js 22 and `curl`; step 9 also needs kind and `kubectl`. You will watch the app load
its credentials, rotate them from the dashboard, try to leak them, read the
app's own log (with every password masked), then search the running containers
for the real passwords and find nothing. Every screenshot below is taken by CI
on every push, so they always match the current app.

For the list of every automated test behind these steps, see
[TEST-CASES.md](TEST-CASES.md). To demo one feature at a time, with the CI
output for each, see the [demo folder](../demo/README.md). For deploying to Kubernetes, OpenShift or AWS,
see [GUIDE.md](GUIDE.md).

## 1. Start the stack

```bash
git clone https://github.com/ephico2real2/openbao-node-poc.git
cd openbao-node-poc
docker compose up --build -d
docker compose logs -f app        # in a second terminal: follow the app's log
```

Wait for `secure-notes listening` in the log, then open <http://localhost:3000>.
The Compose stack runs with `LOG_LEVEL=debug` by default, so the log also shows
which credential keys the app uses (with the values masked; step 5).

![The dashboard after startup](../demo/images/01-dashboard.png)

What you're looking at:

- **Secrets in memory**: the two credentials the app holds. You see the secret
  name, version and a *fingerprint* (an HMAC under a per-process key: it changes
  when the value changes, and reveals nothing about it). Never the value.
- **Credential timeline**: what happened to the credentials, in plain words.
- **Security posture**: thirteen checks the app runs on itself, such as no keys in
  the environment, not running as root, core dumps off.
- **Application log** (bottom of the page): the app's log, as written, after
  redaction.

## 2. Rotate the Postgres password from the dashboard

In **Rotation lab**, click **Rotate Postgres secret**. The four steps of an AWS
rotation function run: a new password is generated (`createSecret`), applied to
Postgres (`setSecret`), tested (`testSecret`) and made current
(`finishSecret`). The app is not told.

Now click **Drop connections**. The app's next database login uses the cached,
now-wrong password; Postgres rejects it, the app re-reads the secret, logs in
with the new one and retries the query. Watch the **Credential timeline**:

> `auth-failed` → `new-version` → `recovered`, all within the same second, with
> no error for the user.

![A Postgres rotation and the app recovering](../demo/images/02-rotation-and-recovery.png)

## 3. Rotate the Redis password

Click **Rotate Redis secret**, then **Drop connections**. Same story for the
cache. Redis has an extra step, `revokeOld`: for a moment both passwords work,
then the old one is removed.

![A Redis rotation](../demo/images/03-redis-rotation.png)

## 4. Try to leak a password

Click **Run leak attempts**. The app takes its real database password and tries
the six most common ways a password ends up somewhere it shouldn't: `JSON.stringify`,
`console.log`, a template string, an error message with a connection string,
a log field named `dbPassword`, and the password pasted into a log message.

![The leak test: 0 of 6 leaked](../demo/images/04-leak-test.png)

Every one comes out as `[REDACTED]`.

## 5. Read the Application log

Scroll to the bottom of the dashboard and tick **Credential lines only**. With `LOG_LEVEL=debug`, every time the
app loads a secret or a client logs in, it writes **which secret, which version
and which keys** it used, with every value masked:

![The Application log at debug level](../demo/images/06-debug-log.png)

The same lines are in the container's log. From a second terminal:

```bash
docker compose logs app | grep '"secret consumed"' | tail -1 | sed 's/^[^{]*//' | jq '{secretId, versionId, source, fingerprint, keys}'
docker compose logs app | grep -E 'connecting with|authenticating with' | tail -2 | sed 's/^[^{]*//' | jq '{msg, secretId, fingerprint, host, port, using}'
```

How each value is shown:

| Key | Shown as | Why |
| --- | --- | --- |
| `password` (and `token`, `secret`, …) | `******** (32 chars, fp=1a2b3c4d)` | nothing of the value; the fingerprint shows when it changes |
| `username` | `no*****pp` | partly masked |
| `host`, `port`, `engine` | in full | not secret, and what you need to debug a connection |

After the rotation in step 2, the `fingerprint` field reads `old -> new`, so you
can see the app picked up a new password without seeing either one.

## 6. Search the running containers for the real passwords

This is the proof that matters: take the **actual** passwords and look for them
everywhere they could have leaked to.

```bash
scripts/credential-scan.sh compose
```

It reads every password from the Secrets Manager stand-in (the current and
previous version of each secret), then searches the configuration of every
container, the app's process environment, every file in the app container, the
Postgres and Redis data (they must hold only hashes), and the log of every
container. It never prints a value.

```
== credential scan (compose): searching for 6 secret values from Secrets Manager (every version); the values are never printed
-- containers
  ok    app: container config (env, command, labels: docker inspect)   clean
  ok    aws-mock: container config (env, command, labels: docker inspect) clean
  ok    postgres: container config (env, command, labels: docker inspect) clean
  ok    redis: container config (env, command, labels: docker inspect) clean
  ok    seed: container config (env, command, labels: docker inspect)  clean
  ok    app: process environment values (/proc/1/environ)              clean
  ok    app: every readable file (5828 files)                          clean
  ok    postgres: data directory and config (plaintext passwords?)     clean
  ok    redis: data and ACL files (plaintext passwords?)               clean
-- logs
  ok    app: log                                                       clean
  ok    aws-mock: log                                                  clean
  ok    postgres: log                                                  clean
  ok    redis: log                                                     clean
  ok    seed: log                                                      clean
-- debug logging (LOG_LEVEL=debug)
  ok    app log names the secrets and keys it consumed                 6 line(s)
  ok    every password is shown as ******** (length, fingerprint)      yes
credential-scan: no credential value found anywhere it must not be
```

The full check, which runs this scan after the end-to-end test, is
`scripts/compose-check.sh`.

## 7. Agent mode

On EC2 the app can read its secrets through a local AWS agent instead of
calling Secrets Manager itself. To try it here:

```bash
docker compose down -v
export COMPOSE_FILE=docker-compose.yml:docker-compose.agent.yml   # every compose command now uses both files
docker compose up --build -d
```

The dashboard shows `mode: agent` and **Workload Credentials Provider**, and
the log gains a line per request showing where the agent's token came from,
masked:

```bash
docker compose logs app | grep 'agent request' | tail -1 | sed 's/^[^{]*//' | jq '{secretId, tokenFile, ssrfTokenMasked}'
```

With `COMPOSE_FILE` still set, `scripts/compose-check.sh` runs the scan (agent container
included) and also proves the agent rejects a request without its token. Then go back to
the normal stack for step 8:

```bash
docker compose down -v && unset COMPOSE_FILE && docker compose up -d
```

## 8. In a lab only: reveal the real values

Sometimes you need to see the password the app actually used, for example when
a login fails and you suspect the secret itself. `LOG_REVEAL_SECRETS=true`
makes the debug credential lines print the real values next to the masked ones.

```bash
LOG_REVEAL_SECRETS=true docker compose up -d --no-deps app
docker compose logs app | grep 'values revealed' | tail -1 | sed 's/^[^{]*//' | jq '{msg, keys, warning}'
```

If you're following `docker compose logs -f app`, the real passwords scroll past there
too: that is what the flag does, and why it is for a lab only.

It is impossible to miss while it's on:

![The banner while LOG_REVEAL_SECRETS is on](../demo/images/07-reveal-banner.png)

![The posture check fails while it's on](../demo/images/08-reveal-posture.png)

Revealed lines go only to the container's log: the dashboard's Application log
never shows them.

![The dashboard's log panel still shows no value](../demo/images/09-reveal-log-panel.png)

Run the scan now and it finds the passwords, in the app's log and nowhere else.
That is how CI proves the scan would catch a real leak:

```bash
EXPECT_REVEALED=1 scripts/credential-scan.sh compose
```

```
== credential scan (compose): searching for 6 secret values from Secrets Manager (every version); the values are never printed
-- containers
  ok    app: container config (env, command, labels: docker inspect)   clean
  ok    aws-mock: container config (env, command, labels: docker inspect) clean
  ok    postgres: container config (env, command, labels: docker inspect) clean
  ok    redis: container config (env, command, labels: docker inspect) clean
  ok    seed: container config (env, command, labels: docker inspect)  clean
  ok    app: process environment values (/proc/1/environ)              clean
  ok    app: every readable file (5828 files)                          clean
  ok    postgres: data directory and config (plaintext passwords?)     clean
  ok    redis: data and ACL files (plaintext passwords?)               clean
-- logs
  ok    app: log                                                       FOUND 4 (expected: LOG_REVEAL_SECRETS=true)
  ok    aws-mock: log                                                  clean
  ok    postgres: log                                                  clean
  ok    redis: log                                                     clean
  ok    seed: log                                                      clean
-- debug logging (LOG_LEVEL=debug)
  ok    app log names the secrets and keys it consumed                 2 line(s)
  ok    every password is shown as ******** (length, fingerprint)      yes
credential-scan: no credential value found anywhere it must not be
```

Turn it off:

```bash
docker compose up -d --no-deps app
```

**The app refuses this setting in production.** Try it:

```bash
docker run --rm -e NODE_ENV=production -e LOG_REVEAL_SECRETS=true \
  -e DB_SECRET_ID=x -e REDIS_SECRET_ID=y secure-notes-app:dev
```

```
{"time":"…","level":"error","app":"secure-notes","msg":"Refusing to start:\n  - LOG_REVEAL_SECRETS must not be enabled in production: it writes secret values to the log"}
```

It exits with code 78, so on EC2 systemd does not keep restarting it.

## 9. The same on Kubernetes

With the kind cluster from the [guide](GUIDE.md) (Part B1), the log level is
debug in the local overlay too:

```bash
kubectl -n secure-notes logs deploy/secure-notes | grep '"secret consumed"' | tail -1 | jq '{secretId, versionId, keys}'
scripts/credential-scan.sh k8s
```

On Kubernetes the scan also checks the pod specs, ConfigMaps, the decoded
Kubernetes Secrets (only the burned one-time bootstrap Secret may exist) and the
namespace's events. `scripts/k8s-check.sh` runs it after the end-to-end test.

## 10. Clean up

```bash
docker compose down -v
```

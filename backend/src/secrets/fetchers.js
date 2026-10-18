// Two interchangeable ways to read a secret. Both return the same shape, so the
// caching provider on top does not care which one is in use.
//
//   sdk   : the app calls Secrets Manager itself with the EC2 instance role
//           (credentials come from IMDSv2 via the SDK's default chain).
//   agent : the app calls the AWS Workload Credentials Provider (formerly the
//           Secrets Manager Agent) on localhost:2773. The agent holds the AWS
//           credentials and its own cache; the app proves it is a local
//           process by sending the SSRF token from /var/run/awssmatoken.

import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fullyMask } from './mask.js';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';

function normalize(r) {
  if (typeof r.SecretString !== 'string') {
    throw new Error(`secret ${r.Name ?? ''} has no SecretString (binary secrets are not supported)`);
  }
  return {
    name: r.Name,
    arn: r.ARN,
    versionId: r.VersionId,
    versionStages: r.VersionStages ?? [],
    createdDate: r.CreatedDate ? new Date(r.CreatedDate) : undefined,
    secretString: r.SecretString,
  };
}

export function createSdkFetcher({ region, endpoint }) {
  const client = new SecretsManagerClient({
    region,
    endpoint, // undefined in AWS: the SDK resolves the regional (or VPC endpoint private DNS) URL
    maxAttempts: 3,
  });

  return {
    kind: 'sdk',
    client,
    async fetch(secretId, { versionStage = 'AWSCURRENT' } = {}) {
      const r = await client.send(new GetSecretValueCommand({ SecretId: secretId, VersionStage: versionStage }));
      return normalize(r);
    },
    // Metadata only (no secret value): lets the UI show "a newer version exists"
    // without pulling the new value into memory.
    async describe(secretId) {
      const r = await client.send(new DescribeSecretCommand({ SecretId: secretId }));
      const stages = r.VersionIdsToStages ?? {};
      const current = Object.entries(stages).find(([, s]) => s.includes('AWSCURRENT'))?.[0];
      return {
        currentVersionId: current,
        rotationEnabled: Boolean(r.RotationEnabled),
        lastRotatedDate: r.LastRotatedDate ? new Date(r.LastRotatedDate) : undefined,
        nextRotationDate: r.NextRotationDate ? new Date(r.NextRotationDate) : undefined,
        kmsKeyId: r.KmsKeyId,
      };
    },
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function createAgentFetcher({ url, tokenFile, timeoutMs = 3000, logger }) {
  const log = logger?.child({ component: 'agent' });
  const fpKey = randomBytes(32);
  const base = new URL(url);
  // The SSRF token must never be sent anywhere but the local agent.
  if (!LOOPBACK.has(base.hostname) || base.protocol !== 'http:') {
    throw new Error(`AWCP_URL must be http://localhost:<port> (got ${base.origin})`);
  }

  return {
    kind: 'agent',
    async fetch(secretId, { force = false, versionStage } = {}) {
      // Read the token on every call: the agent regenerates it when it restarts.
      const token = (await readFile(tokenFile, 'utf8')).trim();
      const u = new URL('/secretsmanager/get', base);
      u.searchParams.set('secretId', secretId);
      if (versionStage) u.searchParams.set('versionStage', versionStage);
      if (force) u.searchParams.set('refreshNow', 'true'); // bypass the agent's own cache
      if (log?.isDebug) {
        log.debug(
          { secretId, agent: base.origin, tokenFile, ssrfTokenMasked: fullyMask(token, fpKey), refreshNow: force },
          'agent request: SSRF token from file, masked',
        );
        log.revealUnsafe?.({ secretId, tokenFile, token }, 'agent request (token revealed)');
      }

      const res = await fetch(u, {
        headers: { 'X-Aws-Parameters-Secrets-Token': token },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      if (!res.ok) {
        await res.body?.cancel();
        const err = new Error(`Workload Credentials Provider returned HTTP ${res.status} for ${secretId}`);
        err.code = `AGENT_HTTP_${res.status}`;
        throw err;
      }
      return normalize(await res.json());
    },
  };
}

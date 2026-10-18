// One switch, SECRETS_PROVIDER, chooses the secrets manager. Everything above
// the fetcher (the cache, rotation recovery, masking, the reveal flag) is the
// same whichever one is chosen.
//
//   aws      AWS Secrets Manager   SECRETS_MODE=sdk (default) | agent
//   openbao  OpenBao               SECRETS_MODE=api (default): KV v2 over HTTP, AppRole login
//   vault    HashiCorp Vault       the same API and client as openbao

import { SecretsProvider } from './provider.js';
import { createAgentFetcher, createSdkFetcher } from './fetchers.js';
import { createBaoClient } from './bao/client.js';
import { createKvFetcher, createKvStore } from './bao/kv.js';
import { createLeaseKeeper } from './bao/leases.js';

export { SecretValue } from './SecretValue.js';
export { Redactor } from './redactor.js';

/** The client for openbao/vault, or undefined on aws. Shared by the fetcher and the store. */
export function createBaoClientFromConfig({ config, redactor, logger }) {
  if (config.secretsProvider === 'aws') return undefined;
  return createBaoClient({ ...config.bao, redactor, logger });
}

/** Step v2: the lease keeper for dynamic database users (openbao/vault only). */
export function createLeaseKeeperFromConfig({ baoClient, logger }) {
  return baoClient ? createLeaseKeeper(baoClient, { logger }) : undefined;
}

export function createSecretsProvider({ config, redactor, logger, baoClient, leases }) {
  let fetcher;
  if (config.secretsProvider === 'aws') {
    fetcher =
      config.secretsMode === 'agent'
        ? createAgentFetcher({ ...config.agent, logger })
        : createSdkFetcher({ region: config.region, endpoint: config.awsEndpoint });
  } else {
    fetcher = createKvFetcher(baoClient ?? createBaoClientFromConfig({ config, redactor, logger }), { mount: config.bao.kvMount, dbMount: config.bao.dbMount, leases });
  }

  // In agent mode the agent already caches (default 300s), so keep the
  // in-process cache short; forced refreshes pass refreshNow=true through.
  const ttlSeconds = config.secretsMode === 'agent' ? Math.min(config.cache.ttlSeconds, 30) : config.cache.ttlSeconds;

  return new SecretsProvider({
    fetcher,
    ttlSeconds,
    maxStaleSeconds: config.cache.maxStaleSeconds,
    redactor,
    logger,
  });
}

/** The write side (seed job, demo rotator). */
export async function createSecretsStore({ config, baoClient }) {
  if (config.secretsProvider === 'aws') {
    const { createAwsStore } = await import('./aws-store.js');
    return createAwsStore({ region: config.region, endpoint: config.awsEndpoint });
  }
  return createKvStore(baoClient, { mount: config.bao.kvMount });
}

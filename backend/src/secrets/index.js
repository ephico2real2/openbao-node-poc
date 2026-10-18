import { SecretsProvider } from './provider.js';
import { createAgentFetcher, createSdkFetcher } from './fetchers.js';

export { SecretValue } from './SecretValue.js';
export { Redactor } from './redactor.js';

export function createSecretsProvider({ config, redactor, logger }) {
  const fetcher =
    config.secretsMode === 'agent'
      ? createAgentFetcher({ ...config.agent, logger })
      : createSdkFetcher({ region: config.region, endpoint: config.awsEndpoint });

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

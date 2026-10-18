// AWS Secrets Manager behind the write interface the seed job and the demo
// rotator use (the same interface as bao/kv.js), with its own version stages:
// a new value is stored as AWSPENDING, then AWSCURRENT moves to it.

import {
  SecretsManagerClient,
  CreateSecretCommand,
  DescribeSecretCommand,
  GetRandomPasswordCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
import { randomUUID } from 'node:crypto';

export function createAwsStore({ region, endpoint, credentials } = {}) {
  const sm = new SecretsManagerClient({ region, endpoint, ...(credentials ? { credentials } : {}) });
  const pendingTokens = new Map(); // secretId -> the AWSPENDING version this process wrote
  return {
    kind: 'aws',
    client: sm,
    labels: {
      pending: 'a new version labelled AWSPENDING',
      current: 'AWSCURRENT',
      previous: 'AWSPREVIOUS',
    },
    async exists(id) {
      try {
        await sm.send(new DescribeSecretCommand({ SecretId: id }));
        return true;
      } catch (err) {
        if (err.name === 'ResourceNotFoundException') return false;
        throw err;
      }
    },
    async create(id, value, description) {
      await sm.send(new CreateSecretCommand({ Name: id, Description: description, SecretString: JSON.stringify(value) }));
    },
    async read(id) {
      const r = await sm.send(new GetSecretValueCommand({ SecretId: id, VersionStage: 'AWSCURRENT' }));
      return { value: JSON.parse(r.SecretString), versionId: r.VersionId };
    },
    async randomPassword() {
      const r = await sm.send(new GetRandomPasswordCommand({ PasswordLength: 32, ExcludePunctuation: true, IncludeSpace: false }));
      return r.RandomPassword;
    },
    async putPending(id, value) {
      const token = randomUUID();
      await sm.send(new PutSecretValueCommand({ SecretId: id, ClientRequestToken: token, SecretString: JSON.stringify(value), VersionStages: ['AWSPENDING'] }));
      pendingTokens.set(id, token);
      return token;
    },
    async promote(id, _value, fromVersion) {
      const token = pendingTokens.get(id);
      await sm.send(new UpdateSecretVersionStageCommand({ SecretId: id, VersionStage: 'AWSCURRENT', MoveToVersionId: token, RemoveFromVersionId: fromVersion }));
      await sm.send(new UpdateSecretVersionStageCommand({ SecretId: id, VersionStage: 'AWSPENDING', RemoveFromVersionId: token }));
      pendingTokens.delete(id);
      return token;
    },
    async discardPending(id) {
      const token = pendingTokens.get(id);
      if (!token) return;
      await sm.send(new UpdateSecretVersionStageCommand({ SecretId: id, VersionStage: 'AWSPENDING', RemoveFromVersionId: token })).catch(() => {});
      pendingTokens.delete(id);
    },
  };
}

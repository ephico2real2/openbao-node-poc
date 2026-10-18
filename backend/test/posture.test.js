// The posture check "No credentials in environment variables": a variable is
// flagged by its NAME only when it looks like a credential and is not a
// setting (an ID, a path, a directory, a switch...). Values the app has loaded
// are flagged separately, by the redactor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCredential } from '../src/security/checks.js';

test('settings with "secret" in their name are not credentials; real-looking ones are', () => {
  // Every setting the labs use (CI run 39169060746 flagged SECRETS_DIR in file mode).
  for (const [k, v] of Object.entries({
    SECRETS_DIR: '/var/run/secrets/secure-notes',
    SECRETS_MODE: 'file',
    SECRETS_PROVIDER: 'openbao',
    SECRETS_ENV: 'dev',
    DB_SECRET_ID: 'database/creds/notes-app',
    DB_SECRET_RESOURCE: 'notes-db',
    BAO_SECRET_ID_FILE: '/home/node/bao-secret-id',
    BAO_K8S_TOKEN_FILE: '/var/run/secrets/openbao/token',
    LOG_REVEAL_SECRETS: 'false',
    SECRET_CACHE_TTL_SECONDS: '60',
  })) assert.equal(looksLikeCredential(k, v), false, k);
  for (const [k, v] of Object.entries({ DB_PASSWORD: 'example-only', API_TOKEN: 'abc123def456', CLIENT_SECRET: 'xyz', PRIVATE_KEY: '-----BEGIN' })) {
    assert.equal(looksLikeCredential(k, v), true, k);
  }
});

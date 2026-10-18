// Helpers so that new passwords are sent to the database and Redis as hashes,
// not plaintext. That keeps them out of server logs (e.g. Postgres with
// log_statement = 'ddl') and out of Redis MONITOR / SLOWLOG output.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * Postgres SCRAM-SHA-256 verifier, the same format `psql \password` sends.
 * `ALTER ROLE x PASSWORD 'SCRAM-SHA-256$...'` stores it as-is.
 * Assumes ASCII passwords (ours come from GetRandomPassword); SASLprep is a no-op for those.
 */
export function scramSha256Verifier(password, iterations = 4096) {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Redis ACL accepts `#<sha256 hex>` to add and `!<sha256 hex>` to remove a password. */
export const redisPasswordHash = (password) => createHash('sha256').update(password, 'utf8').digest('hex');

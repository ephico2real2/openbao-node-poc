// Two layers of redaction for anything that leaves the process (logs, API
// error bodies):
//
// 1. Key-based: fields named like credentials are replaced wholesale.
// 2. Value-based ("last mile"): every secret value this process has loaded is
//    registered here, and any occurrence of it in an outgoing string is
//    replaced, no matter which field, error message or stack trace it ended
//    up in. This is what catches `new Error(`connect to postgres://u:${pw}@...`)`.

const MIN_SECRET_LENGTH = 6;
const MAX_REMEMBERED = 200; // keep old values too: they may still show up after rotation

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'pwd', 'pass', 'secret', 'secretstring', 'secret_string',
  'token', 'authtoken', 'auth_token', 'accesstoken', 'access_token', 'refreshtoken',
  'authorization', 'cookie', 'apikey', 'api_key', 'privatekey', 'private_key',
  'clientsecret', 'client_secret', 'secretaccesskey', 'aws_secret_access_key', 'sessiontoken',
  'x-aws-parameters-secrets-token',
]);

// scheme://user:password@host  ->  scheme://user:[REDACTED]@host
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isSensitiveKey(key) {
  const k = String(key).toLowerCase();
  return SENSITIVE_KEYS.has(k) || k.includes('password');
}

export class Redactor {
  #values = new Map(); // value -> insertion order
  #regex = null;

  /** Register a secret value (and its common encodings) for value-based redaction. */
  register(value) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    const variants = new Set([
      value,
      JSON.stringify(value).slice(1, -1), // as it appears inside a JSON string
      encodeURIComponent(value), // as it appears inside a URL
    ]);
    for (const v of variants) {
      this.#values.delete(v);
      this.#values.set(v, true);
    }
    while (this.#values.size > MAX_REMEMBERED) {
      this.#values.delete(this.#values.keys().next().value);
    }
    const alternatives = [...this.#values.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
    this.#regex = new RegExp(alternatives.join('|'), 'g');
  }

  /** Register every credential-looking leaf of a parsed secret object. */
  registerSecretObject(obj, rawString) {
    if (typeof rawString === 'string') this.register(rawString);
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && isSensitiveKey(k)) this.register(v);
        else if (typeof v === 'object') walk(v);
      }
    };
    walk(obj);
  }

  get size() {
    return this.#values.size;
  }

  contains(str) {
    if (typeof str !== 'string' || !this.#regex) return false;
    this.#regex.lastIndex = 0;
    return this.#regex.test(str);
  }

  scrubString(str) {
    if (typeof str !== 'string') return str;
    let out = str;
    if (this.#regex) out = out.replace(this.#regex, '[REDACTED]');
    return out.replace(URL_CREDENTIALS, '$1[REDACTED]@');
  }

  /** Deep-copy `value`, redacting sensitive keys and registered values. */
  scrub(value, depth = 0) {
    if (depth > 8) return '[Truncated]';
    if (typeof value === 'string') return this.scrubString(value);
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.toJSON === 'function' && !(value instanceof Date)) {
      // SecretValue and friends serialize themselves safely.
      return this.scrub(value.toJSON(), depth + 1);
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      // Allow-list error fields: libraries attach things like the full command
      // (with arguments) or connection options to their errors.
      return this.scrub(
        { type: value.name, message: value.message, code: value.code, stack: value.stack },
        depth + 1,
      );
    }
    if (Array.isArray(value)) return value.map((v) => this.scrub(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) && v != null && v !== '' ? '[REDACTED]' : this.scrub(v, depth + 1);
    }
    return out;
  }
}

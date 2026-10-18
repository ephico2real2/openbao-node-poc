// How a credential is described in DEBUG logs: every key name in full, every
// value masked.
//
//   password, token, ... -> ******** (40 chars, fp=1a2b3c4d)   nothing of the value
//   host, port, engine   -> shown in full                       not secret, needed to debug
//   anything else        -> partly masked: no*****pp            e.g. the username
//
// The fingerprint is an HMAC under a per-process random key: two lines with the
// same fp saw the same value, a changed fp means the value changed, and the
// value cannot be recovered or guessed from it.
//
// Entries are "key=description" strings rather than an object keyed by the
// secret's own key names: the logger's redactor blanks any field NAMED like a
// credential ("password"), which would hide the masked description too.

import { createHmac } from 'node:crypto';
import { isSensitiveKey } from './redactor.js';

const SHOWN_IN_FULL = new Set(['host', 'port', 'engine', 'dbinstanceidentifier', 'dbclusteridentifier', 'proxyendpoint']);

export function fingerprint(value, key) {
  return createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 8);
}

export function fullyMask(value, key) {
  return `******** (${String(value).length} chars, fp=${fingerprint(value, key)})`;
}

export function partlyMask(value) {
  const s = String(value);
  if (s.length <= 2) return '*'.repeat(s.length);
  if (s.length <= 6) return s[0] + '*'.repeat(s.length - 1);
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}

export function maskValue(name, value, key) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'object') return `{${Object.keys(value).join(', ')}}`;
  if (isSensitiveKey(name)) return fullyMask(value, key);
  if (typeof value !== 'string') return String(value); // numbers, booleans
  if (SHOWN_IN_FULL.has(name.toLowerCase())) return value;
  return partlyMask(value);
}

/** ["username=no*****pp", "password=******** (40 chars, fp=1a2b3c4d)", "host=postgres", ...] */
export function describeKeys(obj, key) {
  return Object.entries(obj ?? {}).map(([k, v]) => `${k}=${maskValue(k, v, key)}`);
}

/** Which secret keys feed which client settings: ["user<-username=no*****pp", ...]. */
export function describeUse(obj, mapping, key) {
  return Object.entries(mapping).map(([setting, k]) => `${setting}<-${k}=${maskValue(k, obj?.[k], key)}`);
}

/**
 * LOG_REVEAL_SECRETS only: the masked description AND the real value.
 * ["password=******** (40 chars, fp=1a2b3c4d) value=<the real password>", ...]
 */
export function revealKeys(obj, key) {
  return Object.entries(obj ?? {}).map(([k, v]) => `${k}=${maskValue(k, v, key)} value=${typeof v === 'object' ? JSON.stringify(v) : v}`);
}

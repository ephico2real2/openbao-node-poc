import { inspect } from 'node:util';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Wraps a secret so the common accidental-exposure paths print "[REDACTED]":
 * JSON.stringify (API responses, structured logs), util.inspect / console.log,
 * string interpolation, and Express-style res.json(). The real value is only
 * available through an explicit .reveal() call at the point of use, which
 * also makes every use easy to find with grep during code review.
 */
export class SecretValue {
  #value;

  constructor(value) {
    this.#value = deepFreeze(value);
    Object.freeze(this);
  }

  reveal() {
    return this.#value;
  }

  toString() {
    return '[REDACTED]';
  }

  toJSON() {
    return '[REDACTED]';
  }

  [inspect.custom]() {
    return 'SecretValue([REDACTED])';
  }

  [Symbol.toPrimitive]() {
    return '[REDACTED]';
  }
}

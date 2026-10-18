// Secret naming convention: build each secret's name from a pattern, so config
// says *which environment and which resource*, never a hand-typed path.
//
//   pattern  /{service}/{env}/{resource}/{name}     (the default)
//   db       service=rds          resource=notes-db     name=app  -> /rds/prod/notes-db/app
//   redis    service=elasticache  resource=notes-cache  name=app  -> /elasticache/prod/notes-cache/app
//
// Where the settings come from, highest first:
//   1. an explicit ID: DB_SECRET_ID / REDIS_SECRET_ID (env), or secrets.db.id in the
//      config file. Needed for secrets whose name you don't choose, such as the
//      rds!db-… secret RDS creates for its master password.
//   2. the parts, each from an env var if set, else the config file, else the default.
// See docs/reference/secret-naming.md.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseEnv } from 'node:util';

export const PRESETS = Object.freeze({
  'service-env-resource': '/{service}/{env}/{resource}/{name}',
  'service-resource-env': '/{service}/{resource}/{env}/{name}',
  'env-service-resource': '/{env}/{service}/{resource}/{name}',
  'app-env-service': '/{app}/{env}/{service}/{name}',
});
export const DEFAULT_PATTERN = PRESETS['service-env-resource'];
export const DEFAULT_ENVIRONMENTS = Object.freeze(['dev', 'uat', 'qa', 'prod']);
const TOKENS = new Set(['app', 'env', 'service', 'resource', 'name', 'region']);

// One path segment: Secrets Manager's characters, minus '/', so a value can't
// add or remove levels of the hierarchy.
const SEGMENT = /^[A-Za-z0-9_+=.@-]+$/;
const NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
// A name ending in '-' + 6 characters looks like the random ARN suffix AWS adds,
// and makes partial-ARN lookups and IAM wildcards ambiguous.
const LOOKS_LIKE_ARN_SUFFIX = /-[A-Za-z0-9]{6}$/;

// Each slot: its env vars, config-file key and defaults. Admin slots are demo-only.
const SLOTS = {
  db: { prefix: 'DB', file: 'db', service: 'rds', name: 'app' },
  redis: { prefix: 'REDIS', file: 'redis', service: 'elasticache', name: 'app' },
  dbAdmin: { prefix: 'DB_ADMIN', file: 'dbAdmin', parent: 'db', name: 'admin' },
  redisAdmin: { prefix: 'REDIS_ADMIN', file: 'redisAdmin', parent: 'redis', name: 'admin' },
};

/** Render a pattern. Throws a plain-language Error on any problem. */
export function renderSecretName(pattern, values) {
  const used = new Set();
  const name = pattern.replace(/\{([^}]*)\}/g, (_, token) => {
    if (!TOKENS.has(token)) throw new Error(`unknown token {${token}} in secret name pattern "${pattern}" (known: ${[...TOKENS].map((t) => `{${t}}`).join(' ')})`);
    const v = values[token];
    if (v === undefined || v === '') throw new Error(`secret name pattern "${pattern}" needs {${token}}, which is not set`);
    if (!SEGMENT.test(v)) throw new Error(`{${token}}="${v}" may contain only letters, digits and _+=.@- (no "/")`);
    used.add(token);
    return v;
  });
  if (/[{}]/.test(name)) throw new Error(`unbalanced braces in secret name pattern "${pattern}"`);
  if (!used.has('env')) throw new Error(`secret name pattern "${pattern}" must contain {env}, or dev and prod would share a secret`);
  if (!NAME.test(name) || name.includes('//')) throw new Error(`"${name}" is not a valid secret name (letters, digits, /_+=.@-, at most 512 characters, no "//")`);
  return name;
}

/**
 * Read a config file: .json, .yaml/.yml (a small, strict subset: nested keys and
 * scalar values) or .env (KEY=VALUE, the same names as the environment variables).
 * Returns { secrets: {...} } for JSON/YAML, or { env: {...} } for .env.
 */
export function loadConfigFile(path, read = readFileSync) {
  const text = read(path, 'utf8');
  const ext = extname(path).toLowerCase();
  let data;
  if (ext === '.json') data = JSON.parse(text);
  else if (ext === '.yaml' || ext === '.yml') data = parseSimpleYaml(text, path);
  else if (ext === '.env' || path.endsWith('config.env')) {
    const vars = parseEnv(text);
    assertNoCredentials(vars, path);
    return { env: vars };
  }
  else throw new Error(`${path}: unsupported config file type (use .json, .yaml, .yml or .env)`);
  assertNoCredentials(data, path);
  return data ?? {};
}

// A config file says where secrets are, never what they are.
function assertNoCredentials(node, path, at = '') {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const here = at ? `${at}.${k}` : k;
    if (/pass(word|wd)?$|token|secret_?string|private_?key|api_?key|credential/i.test(k)) {
      throw new Error(`${path}: "${here}" looks like a credential; config files hold secret names only`);
    }
    if (typeof v === 'string' && /:\/\/[^/\s:@]*:[^/\s@]+@/.test(v)) {
      throw new Error(`${path}: "${here}" contains a URL with a password; config files hold secret names only`);
    }
    assertNoCredentials(v, path, here);
  }
}

/** Nested `key: value` maps with scalar values. Rejects anything else with a line number. */
export function parseSimpleYaml(text, path = 'config') {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  text.split(/\r?\n/).forEach((raw, i) => {
    const where = `${path}:${i + 1}`;
    if (/^\s*(#|$)/.test(raw)) return;
    if (raw.includes('\t')) throw new Error(`${where}: tabs are not allowed; indent with spaces`);
    const m = raw.match(/^( *)([A-Za-z0-9_.-]+):(?:\s+(.*))?$/);
    if (!m) throw new Error(`${where}: expected "key: value" (lists, anchors and multi-line values are not supported)`);
    const [, sp, key, rest = ''] = m;
    const indent = sp.length;
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).obj;
    if (Object.hasOwn(parent, key)) throw new Error(`${where}: "${key}" appears twice`);
    const value = scalar(rest, where);
    if (value === undefined) {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else parent[key] = value;
  });
  return root;
}

function scalar(rest, where) {
  let s = rest.trim();
  if (s === '' || s.startsWith('#')) return undefined;
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end < 0) throw new Error(`${where}: unterminated quote`);
    const after = s.slice(end + 1).trim();
    if (after && !after.startsWith('#')) throw new Error(`${where}: unexpected text after the quoted value`);
    return s.slice(1, end);
  }
  s = s.replace(/\s+#.*$/, '');
  if (/^[[{&*!|>-]/.test(s)) throw new Error(`${where}: only plain scalar values are supported`);
  return s;
}

/**
 * Resolve every secret ID from the environment and an optional config file.
 * Returns { ids: {db, redis, dbAdmin, redisAdmin}, sources, pattern, env, warnings, error }.
 * Never throws: a problem is returned as `error`, so startup can report it with the others.
 */
export function resolveSecretIds(env = process.env, { read } = {}) {
  const out = { ids: {}, sources: {}, pattern: undefined, env: undefined, warnings: [], error: undefined };
  try {
    let file = {};
    if (env.APP_CONFIG_FILE) {
      const loaded = loadConfigFile(env.APP_CONFIG_FILE, read);
      // A .env config file supplies the same names as environment variables; real env wins.
      if (loaded.env) env = { ...loaded.env, ...env };
      else file = loaded.secrets ?? {};
    }
    const pick = (envName, fileValue, dflt) => (env[envName] ? env[envName] : fileValue !== undefined && fileValue !== '' ? String(fileValue) : dflt);

    const environment = pick('SECRETS_ENV', file.env);
    const allowed = (env.SECRETS_ALLOWED_ENVS ? env.SECRETS_ALLOWED_ENVS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ENVIRONMENTS);
    let pattern = pick('SECRETS_NAME_PATTERN', file.pattern, DEFAULT_PATTERN);
    pattern = PRESETS[pattern] ?? pattern;
    const common = { app: pick('SECRETS_APP', file.app, 'secure-notes'), env: environment, region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION };
    out.env = environment;

    for (const [slot, def] of Object.entries(SLOTS)) {
      const f = file[def.file] ?? {};
      const explicit = pick(`${def.prefix}_SECRET_ID`, f.id);
      if (explicit) {
        out.ids[slot] = explicit;
        out.sources[slot] = 'explicit';
        continue;
      }
      if (!environment) continue; // the convention is off; the required-ID check reports it
      if (!allowed.includes(environment)) throw new Error(`SECRETS_ENV="${environment}" is not one of ${allowed.join(', ')}`);
      out.pattern = pattern;
      const parent = def.parent ? SLOTS[def.parent] : def;
      const pf = def.parent ? file[parent.file] ?? {} : f;
      const name = renderSecretName(pattern, {
        ...common,
        service: pick(`${def.prefix}_SECRET_SERVICE`, f.service, pick(`${parent.prefix}_SECRET_SERVICE`, pf.service, parent.service)),
        resource: pick(`${def.prefix}_SECRET_RESOURCE`, f.resource, pick(`${parent.prefix}_SECRET_RESOURCE`, pf.resource, common.app)),
        name: pick(`${def.prefix}_SECRET_NAME`, f.name, def.name),
      });
      if (LOOKS_LIKE_ARN_SUFFIX.test(name)) {
        out.warnings.push(`${name} ends in "-" plus 6 characters, like the suffix AWS adds to secret ARNs; prefer a name without it`);
      }
      out.ids[slot] = name;
      out.sources[slot] = 'pattern';
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

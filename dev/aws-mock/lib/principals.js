// Who is calling? Locally every client signs with a dummy access key; the key
// says which identity the mock should pretend the caller is, so CloudTrail
// records and STS answers look like AWS (an assumed role for the app, an IAM
// user for the intruder demo).
//
//   local-app            assumed role secure-notes-app            (the app; the dashboard's rotation lab)
//   local-rotation       assumed role secure-notes-redis-rotation (rotation functions)
//   local-seed           assumed role secure-notes-deployer       (the bootstrap job, like CloudFormation)
//   local-events         service events.amazonaws.com            (EventBridge delivering to SNS)
//   local-alertmanager   assumed role alertmanager                (Alertmanager publishing to SNS)
//   local-intruder-user  IAM user mallory                         (detection lab)
//   local-intruder-role  assumed role ops-admin                   (detection lab)
//   (unsigned)           service local-tooling                    (health checks, the credential scan)
//   anything else        assumed role secure-notes-app            (older setups that used "local-mock")

export const ACCOUNT = '000000000000';
export const ROLE_NAMES = Object.freeze({
  app: 'secure-notes-app',
  rotation: 'secure-notes-redis-rotation',
  deployer: 'secure-notes-deployer',
  opsAdmin: 'ops-admin',
});

export const roleArn = (name) => `arn:aws:iam::${ACCOUNT}:role/${name}`;

function assumedRole(name, idSuffix, session) {
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    type: 'AssumedRole',
    principalId: `AROA${idSuffix}:${session}`,
    arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${name}/${session}`,
    accountId: ACCOUNT,
    accessKeyId: `ASIA${idSuffix}`,
    sessionContext: {
      sessionIssuer: { type: 'Role', principalId: `AROA${idSuffix}`, arn: roleArn(name), accountId: ACCOUNT, userName: name },
      attributes: { creationDate: created, mfaAuthenticated: 'false' },
    },
  };
}

const KEYS = {
  'local-app': () => assumedRole(ROLE_NAMES.app, 'LOCALAPP', 'i-0local'),
  'local-rotation': () => assumedRole(ROLE_NAMES.rotation, 'LOCALROTATION', 'rotation'),
  'local-seed': () => assumedRole(ROLE_NAMES.deployer, 'LOCALDEPLOYER', 'bootstrap'),
  'local-intruder-role': () => assumedRole(ROLE_NAMES.opsAdmin, 'LOCALOPSADMIN', 'console-session'),
  'local-intruder-user': () => ({
    type: 'IAMUser',
    principalId: 'AIDALOCALMALLORY',
    arn: `arn:aws:iam::${ACCOUNT}:user/mallory`,
    accountId: ACCOUNT,
    accessKeyId: 'AKIALOCALMALLORY',
    userName: 'mallory',
  }),
  'local-events': () => ({ type: 'AWSService', invokedBy: 'events.amazonaws.com' }),
  'local-alertmanager': () => assumedRole('alertmanager', 'LOCALALERTMANAGER', 'alertmanager'),
};

/** The access key ID from a SigV4 Authorization header, or undefined. */
export function accessKeyOf(headers) {
  const auth = headers.authorization ?? '';
  return /Credential=([^/,\s]+)\//.exec(auth)?.[1];
}

/** CloudTrail-style userIdentity for a request. */
export function principalOf(headers) {
  const key = accessKeyOf(headers);
  if (!key) return { type: 'AWSService', invokedBy: 'local-tooling' };
  return (KEYS[key] ?? KEYS['local-app'])();
}

/** What STS GetCallerIdentity answers for a userIdentity. */
export function callerIdentity(p) {
  if (p.type === 'AssumedRole') return { Arn: p.arn, UserId: p.principalId, Account: ACCOUNT };
  if (p.type === 'IAMUser') return { Arn: p.arn, UserId: p.principalId, Account: ACCOUNT };
  return { Arn: `arn:aws:iam::${ACCOUNT}:root`, UserId: ACCOUNT, Account: ACCOUNT };
}

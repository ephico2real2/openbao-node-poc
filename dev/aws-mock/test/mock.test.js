// The AWS stand-in's identities: the dummy access key names the caller, and
// STS answers as that caller. (The SNS, CloudTrail and EventBridge stand-ins
// live in aws-secrets-manager-node-poc; this repo's alert path starts from
// OpenBao's audit log, epic B7.)
// Run: node --test dev/aws-mock/test/*.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { principalOf, callerIdentity, roleArn } from '../lib/principals.js';

const signedAs = (key) => ({ authorization: `AWS4-HMAC-SHA256 Credential=${key}/20261018/us-east-1/sts/aws4_request` });

test('STS answers as the caller the access key names', () => {
  assert.match(callerIdentity(principalOf(signedAs('local-app'))).Arn, /:assumed-role\/secure-notes-app\//);
  assert.match(callerIdentity(principalOf(signedAs('local-intruder-user'))).Arn, /:user\/mallory$/);
  assert.equal(roleArn('secure-notes-app'), 'arn:aws:iam::000000000000:role/secure-notes-app');
});

test('an unsigned request is local tooling, not the app', () => {
  const p = principalOf({});
  assert.notEqual(callerIdentity(p).Arn, callerIdentity(principalOf(signedAs('local-app'))).Arn);
});

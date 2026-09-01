import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep, REDACTED } from '../src/security/secret-redactor.js';

test('redacts Anthropic API keys', () => {
  const out = redact('key is sk-ant-api03-AbCdEf123456_XYZ done');
  assert.equal(out, `key is ${REDACTED} done`);
});

test('redacts OpenAI-style keys but leaves short sk- strings alone', () => {
  assert.match(redact('sk-abcdefghijklmnopqrstuv'), /\[REDACTED\]/);
  assert.equal(redact('sk-short'), 'sk-short');
});

test('redacts bearer tokens while keeping the header name', () => {
  assert.equal(
    redact('Authorization: Bearer abc123def456ghi'),
    `Authorization: Bearer ${REDACTED}`,
  );
});

test('redacts cookie headers entirely', () => {
  assert.equal(redact('Cookie: session=abc; other=def'), `Cookie: ${REDACTED}`);
});

test('redacts JWTs', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const out = redact(`the value is ${jwt} ok`);
  assert.ok(!out.includes(jwt), out);
  assert.ok(out.includes(REDACTED), out);
});

test('redacts credential-shaped JSON fields', () => {
  const out = redact('{"accessToken": "abc123", "refreshToken": "def456"}');
  assert.ok(!out.includes('abc123'), out);
  assert.ok(!out.includes('def456'), out);
});

test('does not redact ordinary run identifiers', () => {
  const text = '{"runId": "2026-09-01-001", "iteration": 3, "id": "worker-01"}';
  assert.equal(redact(text), text);
});

test('redactDeep walks nested structures and leaves non-strings intact', () => {
  const input = {
    runId: '2026-09-01-001',
    iteration: 2,
    nested: { list: ['sk-ant-api03-SECRETVALUE123', 'plain'] },
    flag: true,
  };
  const out = redactDeep(input);
  assert.equal(out.runId, '2026-09-01-001');
  assert.equal(out.iteration, 2);
  assert.equal(out.flag, true);
  assert.equal(out.nested.list[0], REDACTED);
  assert.equal(out.nested.list[1], 'plain');
});

test('redact is a no-op on empty input', () => {
  assert.equal(redact(''), '');
});

/**
 * The GitHub client against a GitHub that runs on localhost.
 *
 * The device flow is followed as documented - a code, a wait, a token - with
 * every branch the documentation names: pending, slow_down, expiry, refusal,
 * cancellation. The REST calls are checked for what they send (the bearer
 * header, the documented accept header) and what they read back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubClient,
  GitHubError,
  gitAuthEnvironment,
  isGitHubHttpsRemote,
  parseGitHubRemote,
} from '../src/github/github-client.js';
import { startFakeGitHub } from './helpers/fake-github.js';

const fast = { sleep: async () => {} };

test('the device flow: a code is asked for, the token arrives after the person finishes', async () => {
  const gh = await startFakeGitHub({ pendingPolls: 2 });
  try {
    const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
    const code = await client.requestDeviceCode('Iv1.testclientid');
    assert.equal(code.userCode, 'WDJB-MJHT');
    assert.equal(code.verificationUri, `${gh.endpoints.oauthBase}/login/device`);

    const token = await client.pollForToken('Iv1.testclientid', code);
    assert.equal(token.accessToken, 'gho_testtoken1234567890abcdef');
    assert.equal(gh.polls, 3, 'two pending answers, then the token');

    // Exactly the documented request shapes.
    const start = gh.requests[0]!;
    assert.equal(start.path, '/login/device/code');
    assert.match(start.headers['content-type'] as string, /x-www-form-urlencoded/);
    assert.equal(start.headers.accept, 'application/json');
    assert.match(start.body, /client_id=Iv1\.testclientid/);
    assert.match(start.body, /scope=repo/);
    const poll = gh.requests[1]!;
    assert.match(poll.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
    assert.match(poll.body, /device_code=device-code-xyz/);
  } finally {
    await gh.close();
  }
});

test('slow_down widens the interval; a denial and an expiry end the flow with their own reasons', async () => {
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  const slow = await startFakeGitHub({ slowDownFirst: true });
  try {
    const client = new GitHubClient({ endpoints: slow.endpoints, sleep });
    const code = await client.requestDeviceCode('Iv1.testclientid');
    await client.pollForToken('Iv1.testclientid', code);
    assert.deepEqual(slept, [1000, 6000], 'five seconds more after slow_down');
  } finally {
    await slow.close();
  }

  for (const [finalError, kind] of [
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ] as const) {
    const gh = await startFakeGitHub({ finalError });
    try {
      const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
      const code = await client.requestDeviceCode('Iv1.testclientid');
      await assert.rejects(client.pollForToken('Iv1.testclientid', code), (error: unknown) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.kind, kind);
        return true;
      });
    } finally {
      await gh.close();
    }
  }
});

test('cancelling the wait stops the polling', async () => {
  const gh = await startFakeGitHub({ pendingPolls: 1000 });
  try {
    const controller = new AbortController();
    const client = new GitHubClient({
      endpoints: gh.endpoints,
      sleep: async () => {
        if (gh.polls >= 2) controller.abort();
      },
    });
    const code = await client.requestDeviceCode('Iv1.testclientid');
    await assert.rejects(client.pollForToken('Iv1.testclientid', code, controller.signal), /cancelled/);
    assert.ok(gh.polls <= 3);
  } finally {
    await gh.close();
  }
});

test('a wrong client id is a clear refusal, not a hang', async () => {
  const gh = await startFakeGitHub();
  try {
    const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
    await assert.rejects(client.requestDeviceCode('Iv1.wrong'), /O GitHub/);
  } finally {
    await gh.close();
  }
});

test('the REST calls send the bearer token and read the documented fields', async () => {
  const gh = await startFakeGitHub({
    repos: [
      {
        full_name: 'octocat/private-thing',
        name: 'private-thing',
        owner: { login: 'octocat' },
        private: true,
        description: 'secret',
        default_branch: 'main',
        html_url: 'https://github.com/octocat/private-thing',
        clone_url: 'https://github.com/octocat/private-thing.git',
        updated_at: '2026-09-01T00:00:00Z',
        permissions: { push: true, admin: true },
      },
      {
        full_name: 'org/shared',
        name: 'shared',
        owner: { login: 'org' },
        private: false,
        default_branch: 'develop',
        html_url: 'https://github.com/org/shared',
        clone_url: 'https://github.com/org/shared.git',
        updated_at: '2026-08-01T00:00:00Z',
        permissions: { push: false, admin: false },
      },
    ],
    checkRuns: [
      { name: 'ci', status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/1' },
      { name: 'lint', status: 'in_progress', conclusion: null, html_url: null },
    ],
  });
  try {
    const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
    const token = 'gho_testtoken1234567890abcdef';

    const user = await client.user(token);
    assert.equal(user.login, 'octocat');
    assert.equal(gh.requests.at(-1)!.headers.authorization, `Bearer ${token}`);
    assert.equal(gh.requests.at(-1)!.headers.accept, 'application/vnd.github+json');

    const repos = await client.repositories(token);
    assert.deepEqual(
      repos.map((r) => [r.fullName, r.private, r.defaultBranch, r.permissions.push]),
      [
        ['octocat/private-thing', true, 'main', true],
        ['org/shared', false, 'develop', false],
      ],
    );
    assert.match(gh.requests.at(-1)!.path, /affiliation=owner,collaborator,organization_member/);
    assert.ok(!repos.some((r) => r.cloneUrl.includes('@')), 'clone URLs carry no credential');

    const pr = await client.createPullRequest(token, {
      owner: 'octocat',
      repo: 'private-thing',
      title: 'Add hello',
      body: '',
      head: 'feature',
      base: 'main',
    });
    assert.equal(pr.number, 42);
    assert.equal(JSON.parse(gh.requests.at(-1)!.body).head, 'feature');

    const checks = await client.checks(token, 'octocat', 'private-thing', 'feature');
    assert.equal(checks.total, 2);
    assert.equal(checks.completed, 1);
    assert.equal(checks.success, 1);
    assert.equal(checks.failure, 0);

    await assert.rejects(client.user('gho_wrong'), (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.kind, 'auth');
      return true;
    });
  } finally {
    await gh.close();
  }
});

test('remotes are recognised and the git environment carries the token as a header, not in argv or a URL', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/Arcanjog1/Orquestrador.git'), {
    owner: 'Arcanjog1',
    repo: 'Orquestrador',
  });
  assert.deepEqual(parseGitHubRemote('git@github.com:Arcanjog1/Orquestrador.git'), {
    owner: 'Arcanjog1',
    repo: 'Orquestrador',
  });
  assert.equal(parseGitHubRemote('https://gitlab.com/a/b.git'), null);
  assert.equal(isGitHubHttpsRemote('https://github.com/a/b'), true);
  assert.equal(isGitHubHttpsRemote('git@github.com:a/b.git'), false, 'ssh carries its own key');
  assert.equal(isGitHubHttpsRemote('https://evil.example/github.com/a/b'), false);

  const env = gitAuthEnvironment('gho_secret');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('x-access-token:gho_secret').toString('base64')}`);
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!Object.values(env).some((v) => v.includes('gho_secret')), 'the token is not in the clear');
});

/* ------------------------------------------------------------------ *
 * The Windows incident: "O GitHub não iniciou o login: resposta inesperada".
 * Every answer the device endpoint can give now has its own sentence and a
 * scrubbed record, and the body is read by its content type.
 * ------------------------------------------------------------------ */

import { parseAnswerBody, safeExcerpt } from '../src/github/github-client.js';

test('a Client ID GitHub does not know (404 Not Found) is named as such, with the answer on record', async () => {
  const gh = await startFakeGitHub();
  try {
    const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
    await assert.rejects(client.requestDeviceCode('Iv1.wrong'), (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.kind, 'config');
      assert.equal(error.status, 404);
      assert.match(error.message, /não reconhece este Client ID/);
      assert.match(error.message, /não é o App ID/);
      assert.doesNotMatch(error.message, /resposta inesperada/);
      assert.match(error.detail ?? '', /HTTP 404 · content-type: application\/json · error: Not Found/);
      return true;
    });
  } finally {
    await gh.close();
  }
});

test('a GitHub App with the device flow switched off is told to switch it on', async () => {
  const gh = await startFakeGitHub({
    deviceStart: {
      status: 400,
      body: { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled for this App', error_uri: 'https://docs.github.com/x' },
    },
  });
  try {
    const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
    await assert.rejects(client.requestDeviceCode('Iv1.testclientid'), (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.kind, 'config');
      assert.match(error.message, /Enable Device Flow/);
      assert.match(error.detail ?? '', /error: device_flow_disabled · error_description: Device Flow must be explicitly enabled/);
      return true;
    });
  } finally {
    await gh.close();
  }
});

test('a form-encoded answer (GitHub without Accept: application/json) is read all the same', async () => {
  const gh = await startFakeGitHub({ deviceCodeAsForm: true });
  try {
    const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
    const code = await client.requestDeviceCode('Iv1.testclientid');
    assert.equal(code.userCode, 'WDJB-MJHT');
    assert.equal(code.deviceCode, 'device-code-xyz');
    assert.equal(code.intervalSeconds, 1);
    // And the request itself still asks for JSON, as documented.
    const start = gh.requests.find((r) => r.path === '/login/device/code')!;
    assert.equal(start.headers.accept, 'application/json');
    assert.equal(start.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.match(start.body, /client_id=Iv1\.testclientid/);
  } finally {
    await gh.close();
  }
});

test('an HTML page, a rate limit and an empty body each get their own sentence, never "resposta inesperada"', async () => {
  for (const [start, pattern, kind] of [
    [{ status: 503, text: '<html><body>Service unavailable</body></html>' }, /devolveu uma página .*HTTP 503.*proxy, firewall ou antivírus/, 'network'],
    [{ status: 429, body: { message: 'API rate limit exceeded' } }, /limitou as tentativas/, 'api'],
    [{ status: 200, body: {} }, /não trouxe o código do dispositivo \(HTTP 200\)/, 'api'],
    [{ status: 400, body: { error: 'unauthorized_client' } }, /não reconhece este Client ID/, 'config'],
  ] as const) {
    const gh = await startFakeGitHub({ deviceStart: start as { status: number; body?: unknown; text?: string } });
    try {
      const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
      await assert.rejects(client.requestDeviceCode('Iv1.testclientid'), (error: unknown) => {
        assert.ok(error instanceof GitHubError);
        assert.match(error.message, pattern);
        assert.equal(error.kind, kind);
        assert.doesNotMatch(error.message, /resposta inesperada/);
        assert.ok(error.detail && error.detail.startsWith(`HTTP ${start.status}`), error.detail ?? '');
        return true;
      });
    } finally {
      await gh.close();
    }
  }
});

test('during polling, a refused client id and a disabled flow end with their own reasons', async () => {
  for (const [finalError, pattern] of [
    ['incorrect_client_credentials', /não aceitou o Client ID/],
    ['device_flow_disabled', /Enable Device Flow/],
  ] as const) {
    const gh = await startFakeGitHub({ finalError });
    try {
      const client = new GitHubClient({ endpoints: gh.endpoints, ...fast });
      const code = await client.requestDeviceCode('Iv1.testclientid');
      await assert.rejects(client.pollForToken('Iv1.testclientid', code), (error: unknown) => {
        assert.ok(error instanceof GitHubError);
        assert.match(error.message, pattern);
        assert.equal(error.kind, 'config');
        return true;
      });
    } finally {
      await gh.close();
    }
  }
});

test('the record never carries a device code or a token, and bodies are read by content type', () => {
  assert.equal(
    safeExcerpt('{"device_code":"dc-secret-123","user_code":"WDJB-MJHT","access_token":"gho_abcdef123456"}'),
    '{"device_code":"[redacted]","user_code":"WDJB-MJHT","access_token":"[redacted]"}',
  );
  assert.equal(safeExcerpt('device_code=dc-secret&user_code=ABCD&refresh_token=ghr_xyz123456'), 'device_code=[redacted]&user_code=ABCD&refresh_token=[redacted]');
  assert.deepEqual(parseAnswerBody('{"a":1}', 'application/json; charset=utf-8'), { a: 1 });
  assert.deepEqual(parseAnswerBody('a=1&b=x%20y', 'application/x-www-form-urlencoded'), { a: '1', b: 'x y' });
  assert.deepEqual(parseAnswerBody('error=Not+Found', ''), { error: 'Not Found' }, 'form shape without a content type');
  assert.deepEqual(parseAnswerBody('<html>oops</html>', 'text/html'), {});
  assert.deepEqual(parseAnswerBody('', 'application/json'), {});
});

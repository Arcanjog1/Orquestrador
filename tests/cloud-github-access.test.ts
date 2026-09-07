/**
 * Repository access for remote workspaces.
 *
 * What is worth pinning is the *narrowing*: an installation token that came
 * back scoped to every repository the App can see, or with write permission a
 * clone never needed, would be a quiet and permanent over-grant. So the
 * request itself is asserted, not just the happy path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  GitHubAppAccessError,
  GitHubAppRepositoryAccess,
} from '../src/cloud/github-app-access.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface Call {
  url: string;
  method: string;
  body: unknown;
  authorization: string;
}

function fakeGitHub(
  answers: (path: string) => { status: number; body?: unknown },
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: headers.get('authorization') ?? '',
    });
    const answer = answers(new URL(url).pathname);
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const happy = (path: string) => {
  if (path.endsWith('/installation')) return { status: 200, body: { id: 4242 } };
  if (path.includes('/access_tokens')) {
    return {
      status: 201,
      body: { token: 'ghs_short_lived', expires_at: new Date(Date.now() + 3600_000).toISOString() },
    };
  }
  return { status: 404 };
};

test('an installation token is narrowed to one repository and the permissions it needs', async () => {
  const { fetchImpl, calls } = fakeGitHub(happy);
  const access = new GitHubAppRepositoryAccess({ appId: 'Iv23liABC', privateKeyPem: PEM, fetchImpl });

  const read = await access.token('Arcanjog1/Orquestrador', 'read');
  assert.equal(read.value, 'ghs_short_lived');
  assert.equal(read.identity, 'installation:4242');
  // Short-lived by construction, not by promise.
  assert.ok(Date.parse(read.expiresAt) - Date.now() <= 3600_000 + 1000);

  const minted = calls.find((c) => c.url.includes('/access_tokens'))!;
  const body = minted.body as { repositories: string[]; permissions: Record<string, string> };
  assert.deepEqual(body.repositories, ['Orquestrador'], 'the token must not span the installation');
  assert.deepEqual(body.permissions, { contents: 'read' }, 'a clone needs nothing more than read');

  // Write is asked for only when it is asked for.
  const write = new GitHubAppRepositoryAccess({ appId: 'Iv23liABC', privateKeyPem: PEM, fetchImpl });
  await write.token('Arcanjog1/Orquestrador', 'write');
  const forWrite = calls.filter((c) => c.url.includes('/access_tokens')).at(-1)!;
  assert.deepEqual((forWrite.body as { permissions: unknown }).permissions, {
    contents: 'write',
    pull_requests: 'write',
  });
});

test('the App authenticates with a JWT its own key really signed', async () => {
  const { fetchImpl, calls } = fakeGitHub(happy);
  const access = new GitHubAppRepositoryAccess({ appId: 'Iv23liABC', privateKeyPem: PEM, fetchImpl });
  await access.token('o/r', 'read');

  const jwt = calls[0]!.authorization.replace(/^Bearer\s+/, '');
  const [header, payload, signature] = jwt.split('.');
  assert.ok(header && payload && signature);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), 'the JWT is not ours');

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    iss: string;
    iat: number;
    exp: number;
  };
  assert.equal(claims.iss, 'Iv23liABC');
  // GitHub's documented ceiling is ten minutes; iat is backdated so a server
  // clock a few seconds fast is not rejected outright.
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(claims.iat <= Math.floor(Date.now() / 1000));
});

test('a fresh token is re-used, and the installation is looked up once', async () => {
  const { fetchImpl, calls } = fakeGitHub(happy);
  const access = new GitHubAppRepositoryAccess({ appId: 'a', privateKeyPem: PEM, fetchImpl });
  const first = await access.token('o/r', 'read');
  const second = await access.token('o/r', 'read');
  assert.equal(first.value, second.value);
  assert.equal(calls.filter((c) => c.url.endsWith('/installation')).length, 1);
  assert.equal(calls.filter((c) => c.url.includes('/access_tokens')).length, 1);
});

test('a token close to expiry is minted again rather than handed out', async () => {
  let issued = 0;
  const { fetchImpl } = fakeGitHub((path) => {
    if (path.endsWith('/installation')) return { status: 200, body: { id: 1 } };
    issued += 1;
    // Two minutes left: inside the renewal margin, so it must not be re-used.
    return {
      status: 201,
      body: { token: `ghs_${issued}`, expires_at: new Date(Date.now() + 120_000).toISOString() },
    };
  });
  const access = new GitHubAppRepositoryAccess({ appId: 'a', privateKeyPem: PEM, fetchImpl });
  assert.equal((await access.token('o/r', 'read')).value, 'ghs_1');
  assert.equal((await access.token('o/r', 'read')).value, 'ghs_2');
});

test('a repository the App is not installed on says exactly that', async () => {
  const { fetchImpl } = fakeGitHub(() => ({ status: 404 }));
  const access = new GitHubAppRepositoryAccess({ appId: 'a', privateKeyPem: PEM, fetchImpl });
  await assert.rejects(access.token('o/r', 'read'), (error: unknown) => {
    assert.ok(error instanceof GitHubAppAccessError);
    assert.equal(error.reason, 'NOT_INSTALLED');
    assert.match(error.userMessage, /instale o GitHub App/i);
    return true;
  });
});

test('an organisation that has not authorised the installation is named, not guessed at', async () => {
  const { fetchImpl } = fakeGitHub(() => ({ status: 403 }));
  const access = new GitHubAppRepositoryAccess({ appId: 'a', privateKeyPem: PEM, fetchImpl });
  await assert.rejects(access.token('o/r', 'read'), (error: unknown) => {
    assert.ok(error instanceof GitHubAppAccessError);
    assert.equal(error.reason, 'UNAUTHORIZED');
    assert.match(error.userMessage, /SSO/);
    return true;
  });
});

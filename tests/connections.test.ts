/**
 * Connections: what is stored, what is never stored, and what is never returned.
 *
 * These are the tests that keep a promise rather than a behaviour. The promise
 * is that a person's API key goes into the encrypted store and comes back out
 * in exactly one place - the request that uses it - and that a key which was
 * saved but not switched on costs nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopFixture, fakeSecretStore } from './helpers/desktop-fixture.js';
import type { HttpResponse, HttpTransport } from '../src/providers/provider-http.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function failure(result: IpcResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected this call to be refused');
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

interface Sent {
  url: string;
  headers: Record<string, string>;
}

function transportOf(responder: (url: string) => HttpResponse): {
  transport: HttpTransport;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const transport: HttpTransport = async (url, init) => {
    sent.push({ url, headers: init.headers });
    return responder(url);
  };
  return { transport, sent };
}

const OK_MODELS: HttpResponse = {
  status: 200,
  ok: true,
  text: async () => JSON.stringify({ data: [{ id: 'model-one', display_name: 'Model One' }] }),
  headers: { get: () => null },
};

function fixtureWith(responder: (url: string) => HttpResponse = () => OK_MODELS) {
  const { transport, sent } = transportOf(responder);
  const fixture = createDesktopFixture({ secrets: fakeSecretStore(), providerTransport: transport });
  return { fixture, sent };
}

const KEY = 'sk-test-abcdefghijklmnop-WXYZ';

test('a key is stored encrypted, and what comes back is four characters', async () => {
  const { fixture } = fixtureWith();
  try {
    const created = value<{ id: string; keyHint: string | null; apiEnabled: boolean }>(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude Trabalho 1',
        apiKey: KEY,
      }),
    );
    assert.equal(created.keyHint, '…WXYZ');
    assert.equal(created.apiEnabled, false, 'a saved key must not switch itself on');

    // The plaintext is nowhere in the database, under any column of any table.
    const driver = fixture.services.database.driver;
    const tables = driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    for (const { name } of tables) {
      for (const row of driver.all(`SELECT * FROM ${name}`)) {
        for (const [column, cell] of Object.entries(row)) {
          if (typeof cell !== 'string') continue;
          assert.ok(!cell.includes(KEY), `the key must not appear in ${name}.${column}`);
        }
      }
    }

    // The stored ciphertext is real ciphertext, and it is in its own table.
    const stored = fixture.services.database.providerSecrets.get(created.id);
    assert.ok(stored && stored.startsWith('enc:'), 'the secret is stored encrypted');

    // And nothing the interface can ask for carries it back.
    const listed = value<Array<Record<string, unknown>>>(
      await fixture.router.handle('connections.list', null),
    );
    assert.ok(!JSON.stringify(listed).includes(KEY), 'no listed field may carry the key');
  } finally {
    await fixture.cleanup();
  }
});

test('a key is only sent to the provider, in the header that vendor documents', async () => {
  const { fixture, sent } = fixtureWith();
  try {
    const created = value<{ id: string }>(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude Trabalho 1',
        apiKey: KEY,
      }),
    );
    const status = value<{ authenticated: boolean }>(
      await fixture.router.handle('connections.test', { connectionId: created.id }),
    );
    assert.equal(status.authenticated, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
    assert.equal(sent[0]!.headers['x-api-key'], KEY);
    assert.equal(sent[0]!.headers['anthropic-version'], '2023-06-01');
    // The key never appears in the URL, where it would reach a log or a proxy.
    assert.ok(!sent[0]!.url.includes(KEY));
  } finally {
    await fixture.cleanup();
  }
});

test('an OpenAI connection uses the bearer header and the documented host', async () => {
  const { fixture, sent } = fixtureWith();
  try {
    const created = value<{ id: string }>(
      await fixture.router.handle('connections.addApi', {
        providerId: 'openai',
        displayName: 'OpenAI Trabalho',
        apiKey: KEY,
      }),
    );
    value(await fixture.router.handle('connections.models', { connectionId: created.id }));
    assert.match(sent[0]!.url, /^https:\/\/api\.openai\.com\/v1\/models/);
    assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
  } finally {
    await fixture.cleanup();
  }
});

test('the model list comes from the provider, so nothing is offered that the account lacks', async () => {
  const { fixture } = fixtureWith();
  try {
    const created = value<{ id: string }>(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude',
        apiKey: KEY,
      }),
    );
    const models = value<Array<{ id: string; displayName: string }>>(
      await fixture.router.handle('connections.models', { connectionId: created.id }),
    );
    assert.deepEqual(models, [{ id: 'model-one', displayName: 'Model One', createdAt: null }]);
  } finally {
    await fixture.cleanup();
  }
});

test('two connections on the same provider are two credentials and two rows', async () => {
  const { fixture, sent } = fixtureWith();
  try {
    const one = value<{ id: string }>(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude Trabalho 1',
        apiKey: 'sk-ant-key-one-AAAA',
      }),
    );
    const two = value<{ id: string }>(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude Trabalho 2',
        apiKey: 'sk-ant-key-two-BBBB',
      }),
    );
    assert.notEqual(one.id, two.id);

    value(await fixture.router.handle('connections.test', { connectionId: one.id }));
    value(await fixture.router.handle('connections.test', { connectionId: two.id }));
    assert.equal(sent[0]!.headers['x-api-key'], 'sk-ant-key-one-AAAA');
    assert.equal(sent[1]!.headers['x-api-key'], 'sk-ant-key-two-BBBB');
  } finally {
    await fixture.cleanup();
  }
});

test('a name already used on the same provider is refused', async () => {
  const { fixture } = fixtureWith();
  try {
    value(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude Trabalho 1',
        apiKey: KEY,
      }),
    );
    const error = failure(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude Trabalho 1',
        apiKey: 'sk-other-key-CCCC',
      }),
    );
    assert.match(error.message, /Já existe uma conexão com esse nome/);
  } finally {
    await fixture.cleanup();
  }
});

test('a metered connection can be enabled only once it has a key, and disabling is not deleting', async () => {
  const { fixture } = fixtureWith();
  try {
    const created = value<{ id: string; apiEnabled: boolean }>(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude',
        apiKey: KEY,
      }),
    );
    assert.equal(created.apiEnabled, false);

    const enabled = value<{ apiEnabled: boolean }>(
      await fixture.router.handle('connections.setEnabled', {
        connectionId: created.id,
        enabled: true,
      }),
    );
    assert.equal(enabled.apiEnabled, true);

    // Disconnecting forgets the credential and switches the connection off,
    // but the connection - and everything pointing at it - survives.
    const off = value<{ hasCredential: boolean; apiEnabled: boolean; keyHint: string | null }>(
      await fixture.router.handle('connections.disconnect', { connectionId: created.id }),
    );
    assert.equal(off.hasCredential, false);
    assert.equal(off.apiEnabled, false);
    assert.equal(off.keyHint, null);
    assert.equal(fixture.services.database.accounts.find(created.id)?.display_name, 'Claude');

    // And it cannot be switched back on without a key.
    const error = failure(
      await fixture.router.handle('connections.setEnabled', {
        connectionId: created.id,
        enabled: true,
      }),
    );
    assert.match(error.message, /Adicione a chave de API/);
  } finally {
    await fixture.cleanup();
  }
});

test('a rejected key is reported as an authentication problem with a remedy', async () => {
  const { fixture } = fixtureWith(() => ({
    status: 401,
    ok: false,
    text: async () => JSON.stringify({ error: { type: 'authentication_error', message: 'bad key' } }),
    headers: { get: () => null },
  }));
  try {
    const created = value<{ id: string }>(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude',
        apiKey: KEY,
      }),
    );
    const status = value<{ authenticated: boolean; problem?: string; remedy?: string }>(
      await fixture.router.handle('connections.test', { connectionId: created.id }),
    );
    assert.equal(status.authenticated, false);
    assert.match(status.problem ?? '', /não foi aceita/);
    assert.equal(status.remedy, 'Trocar a chave');
    // The failed check is recorded, so the list shows the truth.
    assert.equal(fixture.services.database.accounts.find(created.id)?.auth_state, 'disconnected');
  } finally {
    await fixture.cleanup();
  }
});

test('without secure storage a key is refused rather than kept somewhere else', async () => {
  const { transport } = transportOf(() => OK_MODELS);
  // No `secrets` option: the shell offers no store.
  const fixture = createDesktopFixture({ providerTransport: transport });
  try {
    const error = failure(
      await fixture.router.handle('connections.addApi', {
        providerId: 'anthropic',
        displayName: 'Claude',
        apiKey: KEY,
      }),
    );
    assert.match(error.message, /armazenamento seguro/);
    assert.equal(fixture.services.database.accounts.list().length, 0, 'nothing half-made is left');
  } finally {
    await fixture.cleanup();
  }
});

test('an existing CLI account keeps working and is listed as a subscription connection', async () => {
  const { fixture } = fixtureWith();
  try {
    // The account kind every installation already has.
    value(await fixture.router.handle('accounts.create', { name: 'Claude Trabalho', provider: 'anthropic' }));
    const listed = value<
      Array<{ displayName: string; connectionKind: string; billing: string; apiEnabled: boolean }>
    >(await fixture.router.handle('connections.list', null));
    const cli = listed.find((c) => c.displayName === 'Claude Trabalho')!;
    assert.equal(cli.connectionKind, 'cli');
    assert.equal(cli.billing, 'subscription');
    assert.equal(cli.apiEnabled, false, 'a CLI connection never touches the metered path');

    // And it is not an API connection, so the API-only operations refuse it.
    const account = fixture.services.database.accounts
      .list()
      .find((a) => a.display_name === 'Claude Trabalho')!;
    const error = failure(
      await fixture.router.handle('connections.replaceKey', {
        connectionId: account.id,
        apiKey: KEY,
      }),
    );
    assert.match(error.message, /ferramenta oficial do provider/);
  } finally {
    await fixture.cleanup();
  }
});

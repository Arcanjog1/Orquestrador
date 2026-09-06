/**
 * GitHub, through the application: one login, encrypted at rest, never in
 * the window; git on the project with that login when the remote is GitHub.
 *
 * The GitHub is a fake on localhost; the git is real, against a bare
 * repository on disk - so clone, branch, commit, push and fetch are the real
 * commands with the real environment, minus the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopFixture, fakeSecretStore } from './helpers/desktop-fixture.js';
import { createGitFixture } from './helpers/git-fixture.js';
import { startFakeGitHub } from './helpers/fake-github.js';
import type { IpcResult } from '../apps/desktop/src/shared/ipc-contract.js';

function value<T>(result: IpcResult<unknown>): T {
  assert.equal(result.ok, true, result.ok === false ? result.error.message : '');
  return (result as { ok: true; value: T }).value;
}

function failure(result: IpcResult<unknown>): { code: string; message: string } {
  assert.equal(result.ok, false, 'expected the call to be refused');
  return (result as { ok: false; error: { code: string; message: string } }).error;
}

const TOKEN = 'gho_testtoken1234567890abcdef';

test('the GitHub login: client id, device code shown, token kept encrypted, status by name', async () => {
  const gh = await startFakeGitHub({ pendingPolls: 1 });
  const fixture = createDesktopFixture({
    github: { endpoints: gh.endpoints, sleep: async () => {} },
    secrets: fakeSecretStore(),
  });
  try {
    type Status = { configured: boolean; connected: boolean; login: string | null; storageAvailable: boolean; clientId: string | null };
    let status = value<Status>(await fixture.router.handle('github.status', null));
    assert.deepEqual([status.configured, status.connected, status.storageAvailable], [false, false, true]);

    // Without a Client ID there is nothing to connect with, and it says so.
    assert.match(failure(await fixture.router.handle('github.connect', null)).message, /Client ID/);
    const odd = failure(await fixture.router.handle('github.configure', { clientId: 'no spaces here' }));
    assert.equal(odd.code, 'GITHUB_ERROR');
    assert.match(odd.message, /não parece um Client ID/);

    status = value<Status>(await fixture.router.handle('github.configure', { clientId: 'Iv1.testclientid' }));
    assert.equal(status.configured, true);
    assert.equal(status.clientId, 'Iv1.testclientid', 'the client id is not a secret and is shown back');

    status = value<Status>(await fixture.router.handle('github.connect', null));
    assert.equal(status.connected, true);
    assert.equal(status.login, 'octocat');

    // The progress the dialog draws: the code, the page, then connected.
    const progress = fixture.events
      .filter((e) => e.channel === 'account:progress')
      .map((e) => e.payload as { accountId: string; stage: string; code?: string; url?: string });
    assert.ok(progress.every((p) => p.accountId === 'github'));
    const shown = progress.find((p) => p.stage === 'awaiting-browser')!;
    assert.equal(shown.code, 'WDJB-MJHT');
    assert.equal(shown.url, `${gh.endpoints.oauthBase}/login/device`);
    assert.equal(progress.at(-1)!.stage, 'connected');
    assert.deepEqual(fixture.openedUrls, [`${gh.endpoints.oauthBase}/login/device`]);

    // At rest: encrypted, and never in what the interface reads.
    const rows = fixture.services.database.settings.all();
    assert.ok(rows['github.token.enc']!.startsWith('enc:'), 'stored through the secret store');
    assert.ok(!Object.values(rows).some((v) => v.includes(TOKEN)), 'the token is nowhere in the clear');
    const forWindow = value<Record<string, string>>(await fixture.router.handle('settings.all', null));
    assert.ok(!('github.token.enc' in forWindow), 'the encrypted blob does not cross to the renderer either');
    assert.equal(forWindow['github.login'], 'octocat');
    assert.equal(
      failure(await fixture.router.handle('settings.set', { key: 'github.token.enc', value: 'x' })).code,
      'INVALID_ARGUMENT',
      'and the renderer cannot overwrite it',
    );
    assert.ok(!JSON.stringify(status).includes(TOKEN));

    // The list of repositories, private ones included, comes with the token.
    const repos = value<Array<{ fullName: string }>>(await fixture.router.handle('github.repositories', null));
    assert.deepEqual(repos, []);
    assert.equal(gh.requests.at(-1)!.headers.authorization, `Bearer ${TOKEN}`);

    // Disconnect forgets the token, keeps the client id.
    status = value<Status>(await fixture.router.handle('github.disconnect', null));
    assert.deepEqual([status.connected, status.login, status.configured], [false, null, true]);
    assert.equal(fixture.services.database.settings.get('github.token.enc'), null);
    assert.equal(failure(await fixture.router.handle('github.repositories', null)).code, 'GITHUB_NOT_CONNECTED');
  } finally {
    await fixture.cleanup();
    await gh.close();
  }
});

test('a denied login ends as failed with the reason, and without a protected store nothing is kept', async () => {
  const gh = await startFakeGitHub({ finalError: 'access_denied' });
  const fixture = createDesktopFixture({
    github: { endpoints: gh.endpoints, sleep: async () => {} },
    secrets: fakeSecretStore(),
  });
  try {
    value(await fixture.router.handle('github.configure', { clientId: 'Iv1.testclientid' }));
    const status = value<{ connected: boolean }>(await fixture.router.handle('github.connect', null));
    assert.equal(status.connected, false);
    const last = fixture.events.filter((e) => e.channel === 'account:progress').at(-1)!.payload as { stage: string; label: string };
    assert.equal(last.stage, 'failed');
    assert.match(last.label, /recusado/);
  } finally {
    await fixture.cleanup();
    await gh.close();
  }

  const unprotected = createDesktopFixture({ github: { endpoints: gh.endpoints } });
  try {
    value(await unprotected.router.handle('github.configure', { clientId: 'Iv1.testclientid' }));
    const status = value<{ storageAvailable: boolean }>(await unprotected.router.handle('github.status', null));
    assert.equal(status.storageAvailable, false);
    assert.match(failure(await unprotected.router.handle('github.connect', null)).message, /armazenamento protegido/);
  } finally {
    await unprotected.cleanup();
  }
});

test('git on the project: branch, commit, push and fetch against a real remote, with a real identity', async () => {
  // A bare "origin" on disk plays the remote. Not GitHub: so no token is
  // added, which is the other half of the rule.
  const bareDir = mkdtempSync(join(tmpdir(), 'lao-bare-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bareDir]);
  const repo = createGitFixture('lao-push-');
  repo.write('README.md', 'hello\n');
  repo.commitAll('init');
  repo.git('remote', 'add', 'origin', bareDir);
  repo.git('push', '-q', '-u', 'origin', 'main');
  // The identity is the repository's own here (the fixture sets one), which
  // must win over anything the application would add.

  const fixture = createDesktopFixture({ secrets: fakeSecretStore() });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'P', localPath: repo.dir }),
    );
    type Op = { ok: boolean; summary: string; output: string; workspace: { branch: string | null } };

    const branch = value<Op>(await fixture.router.handle('workspace.createBranch', { workspaceId: workspace.id, name: 'feature/hello' }));
    if (!branch.ok && /não está configurado/.test(branch.summary)) return; // no git reachable
    assert.equal(branch.ok, true, branch.summary);
    assert.equal(branch.workspace.branch, 'feature/hello');

    writeFileSync(join(repo.dir, 'hello.txt'), 'Olá\n', 'utf8');
    const commit = value<Op>(await fixture.router.handle('workspace.commit', { workspaceId: workspace.id, message: 'Add hello' }));
    assert.equal(commit.ok, true, commit.output);
    const log = repo.git('log', '-1', '--format=%s|%an|%ae').trim();
    assert.equal(log, 'Add hello|Test|test@example.invalid', "the repository's identity, untouched");

    const push = value<Op>(await fixture.router.handle('workspace.push', { workspaceId: workspace.id }));
    assert.equal(push.ok, true, push.output);
    const onRemote = execFileSync('git', ['--git-dir', bareDir, 'branch', '--list', 'feature/hello'], { encoding: 'utf8' });
    assert.match(onRemote, /feature\/hello/);
    assert.equal(repo.git('rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/feature/hello');

    const fetch = value<Op>(await fixture.router.handle('workspace.fetch', { workspaceId: workspace.id }));
    assert.equal(fetch.ok, true, fetch.output);

    // Nothing to commit is a clear answer, not a crash.
    const empty = value<Op>(await fixture.router.handle('workspace.commit', { workspaceId: workspace.id, message: 'again' }));
    assert.equal(empty.ok, false);
    assert.match(empty.summary, /commit não foi criado/);

    // A bad branch name never reaches git.
    assert.equal(
      failure(await fixture.router.handle('workspace.createBranch', { workspaceId: workspace.id, name: '--force' })).code,
      'INVALID_ARGUMENT',
    );

    // The pull-request status knows this is not a GitHub remote.
    const pr = value<{ repository: string | null; branch: string | null; pullRequests: unknown[]; checks: null }>(
      await fixture.router.handle('github.pullRequestStatus', { workspaceId: workspace.id }),
    );
    assert.equal(pr.repository, null);
    assert.equal(pr.branch, 'feature/hello');
    assert.match(
      failure(await fixture.router.handle('github.createPullRequest', { workspaceId: workspace.id, title: 'x' })).message,
      /não é um repositório do GitHub/,
    );
  } finally {
    await fixture.cleanup();
    repo.cleanup();
    rmSync(bareDir, { recursive: true, force: true });
  }
});

test('a commit with no identity anywhere is refused in words; with the GitHub login it is authored by it', async () => {
  // Global and system git config are hidden from the child, the way a fresh
  // machine has none - this is what made the same flow fail on CI.
  const emptyConfig = join(mkdtempSync(join(tmpdir(), 'lao-noconfig-')), 'gitconfig');
  writeFileSync(emptyConfig, '', 'utf8');
  const previous = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig });
  const gh = await startFakeGitHub();
  const repo = createGitFixture('lao-identity-');
  repo.write('a.txt', 'a\n');
  repo.commitAll('init');
  repo.git('config', '--unset', 'user.name');
  repo.git('config', '--unset', 'user.email');
  const fixture = createDesktopFixture({
    github: { endpoints: gh.endpoints, sleep: async () => {} },
    secrets: fakeSecretStore(),
  });
  try {
    const workspace = value<{ id: string }>(
      await fixture.router.handle('workspace.create', { name: 'P', localPath: repo.dir }),
    );
    type Op = { ok: boolean; summary: string };
    writeFileSync(join(repo.dir, 'b.txt'), 'b\n', 'utf8');

    const refused = value<Op>(await fixture.router.handle('workspace.commit', { workspaceId: workspace.id, message: 'x' }));
    if (refused.ok === false && /não está configurado/.test(refused.summary)) return; // no git reachable
    assert.equal(refused.ok, false);
    assert.match(refused.summary, /não sabe quem você é/);
    assert.match(refused.summary, /Conecte o GitHub/);
    assert.equal(repo.git('log', '--oneline').trim().split('\n').length, 1, 'nothing was committed');

    value(await fixture.router.handle('github.configure', { clientId: 'Iv1.testclientid' }));
    value(await fixture.router.handle('github.connect', null));
    const committed = value<Op>(await fixture.router.handle('workspace.commit', { workspaceId: workspace.id, message: 'x' }));
    assert.equal(committed.ok, true, committed.summary);
    assert.equal(repo.git('log', '-1', '--format=%an|%ae').trim(), 'octocat|octocat@users.noreply.github.com');
  } finally {
    await fixture.cleanup();
    repo.cleanup();
    await gh.close();
    for (const [key, val] of Object.entries(previous)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
});

test('a github.com remote gets the login as a header in the environment, and nothing else does', async () => {
  const gh = await startFakeGitHub();
  const fixture = createDesktopFixture({
    github: { endpoints: gh.endpoints, sleep: async () => {} },
    secrets: fakeSecretStore(),
  });
  try {
    value(await fixture.router.handle('github.configure', { clientId: 'Iv1.testclientid' }));
    value(await fixture.router.handle('github.connect', null));
    const env = fixture.services.github.gitEnvironmentFor('https://github.com/octocat/private-thing.git');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraheader');
    assert.match(env.GIT_CONFIG_VALUE_0!, /^Authorization: Basic /);
    assert.ok(!JSON.stringify(env).includes(TOKEN), 'base64 of user:token, never the token itself');
    assert.deepEqual(fixture.services.github.gitEnvironmentFor('https://gitlab.com/a/b.git'), {});
    assert.deepEqual(fixture.services.github.gitEnvironmentFor('/local/path'), {});

    // The pull-request status and creation, through the fake API.
    const repo = createGitFixture('lao-ghremote-');
    try {
      repo.write('a.txt', 'a\n');
      repo.commitAll('init');
      repo.git('remote', 'add', 'origin', 'https://github.com/octocat/private-thing.git');
      repo.git('switch', '-q', '-c', 'feature');
      const workspace = value<{ id: string }>(
        await fixture.router.handle('workspace.create', { name: 'GH', localPath: repo.dir }),
      );
      const status = value<{ repository: string | null; branch: string | null; pullRequests: Array<{ number: number }> }>(
        await fixture.router.handle('github.pullRequestStatus', { workspaceId: workspace.id }),
      );
      if (status.branch === null) return; // no git reachable
      assert.equal(status.repository, 'octocat/private-thing');
      assert.equal(status.branch, 'feature');
      assert.deepEqual(status.pullRequests.map((p) => p.number), [7]);

      const created = value<{ number: number; htmlUrl: string }>(
        await fixture.router.handle('github.createPullRequest', {
          workspaceId: workspace.id,
          title: 'Feature',
          body: 'desc',
          base: 'main',
        }),
      );
      assert.equal(created.number, 42);
      const sent = JSON.parse(gh.requests.at(-1)!.body) as { head: string; base: string };
      assert.deepEqual([sent.head, sent.base], ['feature', 'main']);
      // .git/config holds the plain remote and no credential.
      const config = readFileSync(join(repo.dir, '.git', 'config'), 'utf8');
      assert.ok(!config.includes(TOKEN) && !config.includes('extraheader'));
    } finally {
      repo.cleanup();
    }
  } finally {
    await fixture.cleanup();
    await gh.close();
  }
});

test('the Client ID field refuses the App ID, the help example and a token, each in its own words', async () => {
  const fixture = createDesktopFixture({ secrets: fakeSecretStore() });
  try {
    for (const [input, pattern] of [
      ['123456', /parece o App ID/],
      ['Iv1.abc123', /exemplo da ajuda/],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', /parece um token/],
      ['', /Informe o Client ID/],
    ] as const) {
      const refused = await fixture.router.handle('github.configure', { clientId: input });
      assert.equal(refused.ok, false, `"${input}" must be refused`);
      assert.match((refused as { ok: false; error: { message: string } }).error.message, pattern);
    }
    const accepted = await fixture.router.handle('github.configure', { clientId: 'Iv1.0123456789abcdef' });
    assert.equal(accepted.ok, true);
  } finally {
    await fixture.cleanup();
  }
});

test('a login GitHub refuses at the first step reports the reason and a scrubbed record, and stores nothing', async () => {
  const gh = await startFakeGitHub({ clientId: 'Iv1.known' });
  const fixture = createDesktopFixture({ github: { endpoints: gh.endpoints }, secrets: fakeSecretStore() });
  try {
    value(await fixture.router.handle('github.configure', { clientId: 'Iv1.unknownclient' }));
    value(await fixture.router.handle('github.connect', null));
    const failed = fixture.events
      .filter((e) => e.channel === 'account:progress')
      .map((e) => e.payload as { accountId: string; stage: string; label: string; detail?: string | null })
      .find((p) => p.accountId === 'github' && p.stage === 'failed');
    assert.ok(failed, 'the dialog is told');
    assert.match(failed!.label, /não reconhece este Client ID/);
    assert.match(failed!.detail ?? '', /^HTTP 404/);
    assert.doesNotMatch(failed!.detail ?? '', /device_code|gho_/);
    const status = value<{ connected: boolean }>(await fixture.router.handle('github.status', null));
    assert.equal(status.connected, false);
  } finally {
    await fixture.cleanup();
    await gh.close();
  }
});

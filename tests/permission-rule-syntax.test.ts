/**
 * "Claude requested permissions to use WebFetch, but you haven't granted it yet."
 *
 * O pedido foi autorizado. O banco registrou `approved`. A regra foi enviada
 * na linha de comando. E o runtime continuou recusando, porque a regra era
 * `WebFetch(https://github.com/Arcanjog1/Orquestrador)` — e a sintaxe
 * documentada não casa o campo principal da ferramenta:
 *
 *   "You can't match a tool's primary content field this way: […] `url` for
 *    WebFetch. […] Use `Bash(rm *)`, `Read(./path)`, or `WebFetch(domain:host)`
 *    instead."
 *   "An allow rule with an unusable pattern doesn't approve anything."
 *   — https://code.claude.com/docs/en/permissions
 *
 * Estes testes fixam a sintaxe, não a intenção: cada regra aqui é uma forma
 * que a documentação publica.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScopes,
  commandPrefix,
  escapePattern,
  hostOf,
  relativeInside,
} from '../src/permissions/rule-syntax.js';

test('a fetch is authorised by domain, never by URL', () => {
  const scopes = buildScopes({
    toolName: 'WebFetch',
    command: 'https://github.com/Arcanjog1/Orquestrador',
  });
  const rules = scopes.map((scope) => scope.rule);
  assert.deepEqual(rules, ['WebFetch(domain:github.com)', 'WebFetch']);
  // The regression itself: no rule may carry the URL.
  assert.ok(!rules.some((rule) => rule.includes('https://')));
});

test('a fetch whose URL the CLI did not report offers only the wide scope, and says so', () => {
  const scopes = buildScopes({ toolName: 'WebFetch', command: null });
  assert.deepEqual(scopes.map((s) => s.rule), ['WebFetch']);
  assert.match(scopes[0]!.detail, /não informou um endereço/);
});

test('a host is read from a URL written without a scheme, and refused when it is not a host', () => {
  assert.equal(hostOf('github.com/owner/repo'), 'github.com');
  assert.equal(hostOf('HTTPS://API.GitHub.com./x'), 'api.github.com');
  assert.equal(hostOf('localhost:8080'), 'localhost');
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf(''), null);
  // A bare word is not a domain, and a rule built from one would match nothing.
  assert.equal(hostOf('github'), null);
});

test('a shell is never offered bare, and offers nothing when no command was reported', () => {
  const scopes = buildScopes({ toolName: 'Bash', command: 'git status --short' });
  assert.deepEqual(scopes.map((s) => s.rule), ['Bash(git status --short)', 'Bash(git status *)']);
  assert.ok(!scopes.some((s) => s.rule === 'Bash'));
  assert.deepEqual(buildScopes({ toolName: 'Bash', command: null }), []);
  assert.deepEqual(buildScopes({ toolName: 'PowerShell' }), []);
});

test('a file path is written relative to the working directory', () => {
  const scopes = buildScopes({
    toolName: 'Read',
    command: '/home/user/project/src/app.ts',
    workingDirectory: '/home/user/project',
  });
  assert.deepEqual(scopes.map((s) => s.rule), ['Read(src/app.ts)', 'Read']);
});

test('a Write refusal is authorised as Edit, because a Write path rule is never consulted', () => {
  const scopes = buildScopes({
    toolName: 'Write',
    command: 'C:\\Users\\twitc\\Desktop\\proj\\index.html',
    workingDirectory: 'C:\\Users\\twitc\\Desktop\\proj',
  });
  assert.deepEqual(scopes.map((s) => s.rule), ['Edit(index.html)', 'Edit']);
  assert.ok(!scopes.some((s) => s.rule.startsWith('Write')));
});

test('a path outside the project offers no path rule, and explains instead of pretending', () => {
  const scopes = buildScopes({
    toolName: 'Read',
    command: '/etc/shadow',
    workingDirectory: '/home/user/project',
  });
  assert.deepEqual(scopes.map((s) => s.rule), ['Read']);
  assert.match(scopes[0]!.detail, /fora da pasta do projeto/);
});

test('a path is compared case-insensitively on Windows and exactly on POSIX', () => {
  assert.equal(relativeInside('C:/Users/Twitc/App/a.ts', 'c:\\users\\twitc\\app'), 'a.ts');
  assert.equal(relativeInside('/home/User/app/a.ts', '/home/user/app'), null);
  assert.equal(relativeInside('src/app.ts', '/home/user/app'), 'src/app.ts');
  assert.equal(relativeInside('./src/app.ts', '/home/user/app'), 'src/app.ts');
  // A sibling folder whose name merely starts the same is not inside.
  assert.equal(relativeInside('/home/user/app-2/a.ts', '/home/user/app'), null);
});

test('gitignore metacharacters in a literal path are escaped', () => {
  assert.equal(escapePattern('[2024] Reports/a*.md'), '\\[2024\\] Reports/a\\*.md');
  assert.equal(escapePattern('!important.md'), '\\!important.md');
  assert.equal(escapePattern('src/app.ts'), 'src/app.ts');
});

test('an MCP tool is authorised whole, because a rule with parentheses is dropped', () => {
  const scopes = buildScopes({ toolName: 'mcp__github__get_file_contents', command: 'owner/repo' });
  assert.deepEqual(scopes.map((s) => s.rule), ['mcp__github__get_file_contents']);
});

test('a search has no documented specifier, so only the tool is offered', () => {
  assert.deepEqual(buildScopes({ toolName: 'WebSearch', command: 'orquestrador' }).map((s) => s.rule), [
    'WebSearch',
  ]);
});

test('the prefix stops at the subcommand, and never starts with an option', () => {
  assert.equal(commandPrefix('git log --oneline main'), 'git log');
  assert.equal(commandPrefix('npm run build'), 'npm run');
  assert.equal(commandPrefix('ls'), 'ls');
  assert.equal(commandPrefix('--help'), null);
  assert.equal(commandPrefix('git --version'), 'git');
});

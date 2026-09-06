/**
 * The decision parser against what the strict schema makes Codex produce.
 *
 * Under strict structured output every property is present and an absent
 * value is `null`; the parser must read that exactly as it reads a missing
 * key, or the very first real decision would be refused for its shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision } from '../src/orchestrator/decision-parser.js';

test('a strict-mode decision with null optionals parses as the same decision', () => {
  const parsed = parseDecision(
    JSON.stringify({
      action: 'delegate',
      task: 'Create hello.txt containing exactly: Olá AI Orchestrator',
      acceptanceCriteria: ['hello.txt exists'],
      verificationCommands: [],
      summary: null,
      reason: null,
      relevantFiles: [],
    }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.decision.task, 'Create hello.txt containing exactly: Olá AI Orchestrator');
  assert.equal(parsed.decision.summary, undefined);
  assert.equal(parsed.decision.reason, undefined);
  assert.equal(parsed.decision.relevantFiles, undefined);
});

test('a null task on delegate, or a null reason on blocked, is still refused', () => {
  const delegate = parseDecision(JSON.stringify({ action: 'delegate', task: null, summary: null, reason: null }));
  assert.equal(delegate.ok, false);
  const blocked = parseDecision(JSON.stringify({ action: 'blocked', task: null, summary: null, reason: null }));
  assert.equal(blocked.ok, false);
});

test('the pre-strict shape (keys simply absent) still parses', () => {
  const parsed = parseDecision('{"action":"done","summary":"pronto"}');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.decision.summary, 'pronto');
});

/**
 * Decision parsing and validation (spec 10).
 *
 * The orchestrator agent's answer is a contract, not prose: free text is never
 * accepted as a decision. Output that does not validate produces a repair
 * request that asks only for the format to be fixed - the run is not abandoned
 * on the first malformed reply, and it is not guessed at either.
 */

import type { Decision, DecisionAction } from '../core/types.js';

export const ALLOWED_ACTIONS: readonly DecisionAction[] = ['delegate', 'verify', 'done', 'blocked'];

export type ParseResult =
  | { ok: true; decision: Decision }
  | { ok: false; error: string; /** What the agent is asked to fix. */ repairPrompt: string };

/**
 * Extracts and validates a decision from an agent's raw stdout.
 *
 * Agents habitually wrap JSON in prose or a code fence, so the JSON object is
 * located rather than assumed to be the whole output.
 */
export function parseDecision(raw: string): ParseResult {
  const candidate = extractJsonObject(raw);
  if (candidate === null) {
    return fail('No JSON object was found in the response.', raw);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return fail(`The JSON object could not be parsed: ${(err as Error).message}`, raw);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('The top-level JSON value must be an object.', raw);
  }

  const obj = parsed as Record<string, unknown>;
  const action = obj.action;
  if (typeof action !== 'string') {
    return fail('The "action" field is missing or is not a string.', raw);
  }
  if (!ALLOWED_ACTIONS.includes(action as DecisionAction)) {
    return fail(
      `"${action}" is not an allowed action. Use one of: ${ALLOWED_ACTIONS.join(', ')}.`,
      raw,
    );
  }

  const decision: Decision = {
    action: action as DecisionAction,
    acceptanceCriteria: [],
    verificationCommands: [],
  };

  const criteria = readStringArray(obj.acceptanceCriteria, 'acceptanceCriteria');
  if (criteria.error) return fail(criteria.error, raw);
  decision.acceptanceCriteria = criteria.value;

  const commands = readStringArray(obj.verificationCommands, 'verificationCommands');
  if (commands.error) return fail(commands.error, raw);
  decision.verificationCommands = commands.value;

  const files = readStringArray(obj.relevantFiles, 'relevantFiles');
  if (files.error) return fail(files.error, raw);
  if (files.value.length) decision.relevantFiles = files.value;

  // Under the strict schema every field is present, and an absent value is
  // `null`; the parser reads null exactly as it reads a missing key.
  if (obj.summary !== undefined && obj.summary !== null) {
    if (typeof obj.summary !== 'string') return fail('"summary" must be a string.', raw);
    decision.summary = obj.summary.trim();
  }

  if (action === 'delegate') {
    if (typeof obj.task !== 'string' || obj.task.trim() === '') {
      return fail('"delegate" requires a non-empty "task" string describing the work.', raw);
    }
    decision.task = obj.task.trim();
  }

  if (action === 'blocked') {
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (!reason) {
      return fail('"blocked" requires a non-empty "reason" explaining what is blocking.', raw);
    }
    decision.reason = reason;
  }

  if (action === 'verify' && decision.verificationCommands.length === 0) {
    return fail('"verify" requires at least one entry in "verificationCommands".', raw);
  }

  return { ok: true, decision };
}

function readStringArray(
  value: unknown,
  field: string,
): { value: string[]; error?: string } {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { value: [], error: `"${field}" must be an array of strings.` };
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { value: [], error: `"${field}" must contain only strings.` };
    }
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return { value: out };
}

function fail(error: string, raw: string): ParseResult {
  return { ok: false, error, repairPrompt: buildRepairPrompt(error, raw) };
}

/**
 * Asks for the format to be corrected and nothing else.
 *
 * Deliberately does not restate the objective or the project state: repeating
 * the whole context invites the agent to change its mind about the work, when
 * all that is wrong is the shape of the answer.
 */
export function buildRepairPrompt(error: string, raw: string): string {
  return [
    'Your previous response could not be used because it was not in the required format.',
    '',
    `Problem: ${error}`,
    '',
    'Reply with a single JSON object and nothing else - no prose, no code fence, no explanation.',
    '',
    'Schema:',
    '{',
    '  "action": "delegate" | "verify" | "done" | "blocked",',
    '  "task": "string, required when action is delegate; null otherwise",',
    '  "reason": "string, required when action is blocked; null otherwise",',
    '  "acceptanceCriteria": ["string", ...],',
    '  "verificationCommands": ["string", ...],',
    '  "relevantFiles": ["string", ...],',
    '  "summary": "one short line, or null"',
    '}',
    '',
    'Do not change your decision. Repeat the same decision in the correct format.',
    '',
    'This was your previous response:',
    '---',
    truncate(raw, 4000),
    '---',
  ].join('\n');
}

/**
 * Finds the first balanced JSON object in `text`.
 *
 * A fenced ```json block wins when present; otherwise braces are counted while
 * skipping over string literals, so a `{` inside a task description does not
 * throw off the boundaries.
 */
export function extractJsonObject(text: string): string | null {
  const fence = /```(?:json)?\s*\r?\n([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) {
    const inner = findBalancedObject(fence[1]);
    if (inner) return inner;
  }
  return findBalancedObject(text);
}

function findBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

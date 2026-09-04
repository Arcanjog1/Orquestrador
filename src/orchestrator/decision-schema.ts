/**
 * The JSON Schema for an orchestrator decision.
 *
 * Lives next to the parser that validates decisions, because the two describe
 * the same contract and must not drift: `ALLOWED_ACTIONS` is the single source
 * of the action list, and a test asserts the schema still matches it.
 *
 * Handed to Codex as `--output-schema`, which constrains the model's final
 * message rather than leaving the shape to a prompt and hoping. The parser
 * still validates afterwards - a schema tells the model what to produce, it
 * does not prove what arrived.
 */

import { ALLOWED_ACTIONS } from './decision-parser.js';

export const DECISION_SCHEMA_VERSION = 1;

export const DECISION_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'OrchestratorDecision',
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: [...ALLOWED_ACTIONS],
      description: 'What the orchestrator wants to happen next.',
    },
    task: {
      type: 'string',
      description: 'What the coding agent must do. Required when action is "delegate".',
    },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
      description: 'Objective, checkable statements that must hold when the work is done.',
    },
    verificationCommands: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Verification ids registered for this workspace. Never a command line: an id that is ' +
        'not registered is reported as a failure and never executed.',
    },
    summary: {
      type: 'string',
      description: 'One line for the user. Not reasoning.',
    },
    reason: {
      type: 'string',
      description: 'Why the run cannot continue. Required when action is "blocked".',
    },
    relevantFiles: {
      type: 'array',
      items: { type: 'string' },
    },
  },
} as const;

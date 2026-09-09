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
 *
 * **Strict mode.** `codex exec` (codex-rs 0.153.4, `session/turn.rs`) sends
 * the schema as `text.format = {type: "json_schema", strict: true, ...}`, and
 * the Responses API validates a strict schema before the model sees it: every
 * object must carry `additionalProperties: false` and list *every* property
 * in `required`; an optional field is expressed as a nullable type. A schema
 * that merely lists `action` as required is rejected with HTTP 400 before any
 * decision is produced - so the shape below follows those rules, and
 * `strictSchemaProblems` is the check that keeps it that way.
 */

import { ALLOWED_ACTIONS } from './decision-parser.js';
import { CAPABILITY_TIERS, REASONING_TIERS } from '../routing/tiers.js';

export const DECISION_SCHEMA_VERSION = 8;

/** The tiers as the decision JSON spells them (lowercase). */
export const WIRE_CAPABILITIES = CAPABILITY_TIERS.map((tier) => tier.toLowerCase());
export const WIRE_REASONING = REASONING_TIERS.map((tier) => tier.toLowerCase());

export const DECISION_JSON_SCHEMA = {
  title: 'OrchestratorDecision',
  type: 'object',
  additionalProperties: false,
  required: [
    'action',
    'task',
    'acceptanceCriteria',
    'verificationCommands',
    'fileChecks',
    'fileReads',
    'listFiles',
    'summary',
    'reason',
    'relevantFiles',
    'workerRequirements',
    'workerId',
    'requiresTools',
    'satisfiedCriteria',
    'queryProof',
    'delegations',
  ],
  properties: {
    delegations: { type: ['array', 'null'], description: 'Optional explicit DAG, maximum 8 tasks. Independent tasks run concurrently only with isolated workers. Dependencies name task ids within this batch. Never omit a real dependency.', items: {
      type: 'object', additionalProperties: false, required: ['taskId','workerId','task','dependsOn','requiresTools'],
      properties: { taskId: {type:'string'}, workerId:{type:'string'}, task:{type:'string'}, dependsOn:{type:'array',items:{type:'string'}}, requiresTools:{type:'boolean'} },
    } },
    queryProof: {
      type: ['object', 'null'], additionalProperties: false, required: ['criteria', 'citations'],
      description: 'Read obligations: exact quotes from delivered files for content questions. Access, metadata, tree and commit queries may use empty citations when backed by MEASURED QUERY EVIDENCE. Never proves code changes or execution. Mixed requests retain all proof requirements.',
      properties: {
        criteria: { type: 'array', items: { type: 'string' } },
        citations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'quote'], properties: { path: { type: 'string' }, quote: { type: 'string' } } } },
      },
    },
    action: {
      type: 'string',
      enum: [...ALLOWED_ACTIONS],
      description: 'What the orchestrator wants to happen next.',
    },
    task: {
      type: ['string', 'null'],
      description: 'What the coding agent must do. Required when action is "delegate"; null otherwise.',
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
    fileChecks: {
      type: 'array',
      description:
        'Files for the application to open and compare itself. Data, never a command: no ' +
        'shell runs, and a path outside the project is refused rather than read. This is ' +
        'the way to prove a file\'s contents in a workspace with no registered ' +
        'verifications - "verify" accepts either these or a registered id, and needs at ' +
        'least one of the two.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'path',
          'mustExist',
          'expectBytesHex',
          'expectText',
          'expectSizeBytes',
          'forbidBom',
          'forbidTrailingNewline',
          'criteria',
        ],
        properties: {
          path: {
            type: 'string',
            description:
              'Path relative to the project folder. Absolute paths, "..", and links ' +
              'leading out of the project are refused.',
          },
          mustExist: {
            type: ['boolean', 'null'],
            description:
              'Null or true: the file must exist. False asserts the opposite - the check ' +
              'passes only when the file is absent.',
          },
          expectBytesHex: {
            type: ['string', 'null'],
            description:
              'The exact bytes, in hex, e.g. "70726F6E746F". Null when not asserted. ' +
              'Cannot be combined with expectText.',
          },
          expectText: {
            type: ['string', 'null'],
            description:
              'The exact UTF-8 text. Null when not asserted. Cannot be combined with ' +
              'expectBytesHex.',
          },
          expectSizeBytes: {
            type: ['integer', 'null'],
            description: 'The exact size in bytes. Null when not asserted.',
          },
          forbidBom: {
            type: ['boolean', 'null'],
            description: 'True to fail the check when the file starts with a UTF-8 BOM.',
          },
          forbidTrailingNewline: {
            type: ['boolean', 'null'],
            description: 'True to fail the check when the file ends with a newline.',
          },
          criteria: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The acceptance criteria this check proves, verbatim. A check settles ' +
              'exactly the criteria it names and no others; one that names none is ' +
              'recorded and settles nothing.',
          },
        },
      },
    },
    listFiles: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['prefix', 'contains', 'limit'],
      description:
        'Ask the application for the repository\'s file paths. Only meaningful for a project ' +
        'that works directly on GitHub, where there is no folder to look in and you cannot ' +
        'know a path until you are told one. The listing you were given at the top may have ' +
        'been capped; this is how you get the rest, or narrow it. Null when you are not asking.',
      properties: {
        prefix: {
          type: ['string', 'null'],
          description: 'Only paths starting with this, e.g. "src/". Null for the whole tree.',
        },
        contains: {
          type: ['string', 'null'],
          description: 'Only paths containing this text, matched case-insensitively. Null for all.',
        },
        limit: {
          type: ['integer', 'null'],
          // `minimum`/`maximum` are not part of the strict subset the API
          // accepts, so the bound lives in the parser, which caps at 2000 and
          // refuses anything below 1 - and is said here so the model knows it.
          description:
            'How many paths to return, from 1 to 2000. Null for the default.',
        },
      },
    },
    fileReads: {
      type: 'array',
      description:
        'Files for the application to open and show you. It returns the size, a sha256 and ' +
        'the content, truncated to a budget and marked when truncated. Use this instead of ' +
        'asking a worker to copy a file into its answer: the application can read the file ' +
        'and a copied answer is neither complete nor evidence. Reading proves nothing on ' +
        'its own - a "fileChecks" entry is what settles a criterion.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'maxBytes', 'offsetBytes'],
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to the project folder. Same limits as a file check.',
          },
          offsetBytes: { type: ['integer', 'null'], description: 'Non-negative byte offset for the next range. Null starts at zero.' },
          maxBytes: {
            type: ['integer', 'null'],
            description: 'Bytes to return for this file. Null for the default budget.',
          },
        },
      },
    },
    summary: {
      type: ['string', 'null'],
      description: 'One line for the user. Not reasoning.',
    },
    reason: {
      type: ['string', 'null'],
      description: 'Why the run cannot continue. Required when action is "blocked"; null otherwise.',
    },
    relevantFiles: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files the coding agent should look at first. Empty when there are none.',
    },
    workerId: {
      type: ['string', 'null'],
      description:
        'Which worker on the team this delegation is for, by the id listed in the prompt. ' +
        'Null means the first worker. An id the team does not have is refused and reported ' +
        'back to you; it is never redirected to a different connection.',
    },
    requiresTools: {
      type: ['boolean', 'null'],
      description:
        'True when this delegation must read, edit or run things in the workspace. A worker ' +
        'that cannot execute tools is refused such a delegation rather than asked to ' +
        'describe an edit it cannot make. Null means false.',
    },
    satisfiedCriteria: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Acceptance criteria your review of the answer found satisfied. Used only in a ' +
        'conversation run, where no command can be run and your independent review is the ' +
        'check. In a run that changes code this is ignored: evidence decides there.',
    },
    workerRequirements: {
      type: 'object',
      additionalProperties: false,
      required: ['capability', 'reasoning', 'rationale'],
      description:
        'What the coding agent needs for THIS task, as tiers - never a model name. ' +
        'capability: fast = trivial or mechanical edits, a single file, git chores; ' +
        'balanced = ordinary feature or fix within one module; strong = debugging across ' +
        'modules, subtle bugs, larger refactors; max = critical architecture, data, ' +
        'security or irreversible changes. reasoning: how much deliberation the task ' +
        'deserves, on the same scale.',
      properties: {
        capability: { type: 'string', enum: WIRE_CAPABILITIES },
        reasoning: { type: 'string', enum: WIRE_REASONING },
        rationale: {
          type: ['string', 'null'],
          description: 'One short line on why these tiers. Not reasoning.',
        },
      },
    },
  },
} as const;

/**
 * Problems a strict structured-output validator would raise for `schema`.
 *
 * Mirrors the documented rules of OpenAI strict mode, which is what the
 * Codex CLI asks for on every `exec` turn: objects close themselves with
 * `additionalProperties: false`, list every property in `required`, and use
 * only the supported keywords. Empty means the schema will be accepted.
 */
export function strictSchemaProblems(schema: unknown, path = '$'): string[] {
  const problems: string[] = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${path}: a schema must be an object`];
  }
  const node = schema as Record<string, unknown>;
  const types = Array.isArray(node.type) ? (node.type as unknown[]) : [node.type];
  if (types.includes('object')) {
    if (node.additionalProperties !== false) {
      problems.push(`${path}: objects must set additionalProperties to false`);
    }
    const properties =
      node.properties && typeof node.properties === 'object'
        ? (node.properties as Record<string, unknown>)
        : {};
    const keys = Object.keys(properties);
    const required = Array.isArray(node.required) ? (node.required as unknown[]) : [];
    for (const key of keys) {
      if (!required.includes(key)) problems.push(`${path}.${key}: every property must be listed in required`);
    }
    for (const key of required) {
      if (typeof key !== 'string' || !keys.includes(key)) {
        problems.push(`${path}: required names "${String(key)}", which is not a property`);
      }
    }
    for (const key of keys) problems.push(...strictSchemaProblems(properties[key], `${path}.${key}`));
  }
  if (types.includes('array')) {
    if (node.items === undefined) problems.push(`${path}: arrays must declare items`);
    else problems.push(...strictSchemaProblems(node.items, `${path}[]`));
  }
  for (const keyword of Object.keys(node)) {
    if (!STRICT_KEYWORDS.has(keyword)) problems.push(`${path}: "${keyword}" is not a supported keyword`);
  }
  return problems;
}

/** Keywords strict mode accepts; anything else is refused by the API. */
const STRICT_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'anyOf',
  '$defs',
  '$ref',
]);

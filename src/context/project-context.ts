/**
 * What a project tells its agents, and how much of it.
 *
 * The requirement is two sentences that pull against each other:
 *
 * > Implemente ou melhore um contexto compartilhado por projeto […]
 * > Não despeje todas as conversas no prompt de cada agente. Use recuperação
 * > seletiva e resumos com referência às fontes.
 *
 * So: a project accumulates what it knows — its objective, the decisions
 * taken, the shape of its architecture, the rules that do not bend, its
 * current state, the evidence that was actually verified — and a run sends a
 * **selection** of it, never the pile.
 *
 * ## What is always sent, and what competes
 *
 * | kind | always? | why |
 * |---|---|---|
 * | `rule` | yes | a constraint that is dropped is a constraint that is broken |
 * | `objective` | yes | the project's own goal frames every task in it |
 * | pinned anything | yes | somebody said this matters, and they outrank a score |
 * | `decision` `architecture` `state` `evidence` | competes | relevant to *this* objective, most recent first |
 *
 * The competing entries are ranked by how many of the objective's own words
 * they contain. It is a plain term overlap, deliberately: a person can read
 * the ranking, predict it, and fix a bad one by rewording the entry. Nothing
 * here calls a model to decide what a model gets told.
 *
 * ## What this is not
 *
 * **Not evidence.** Every entry is a claim, including the ones the application
 * wrote itself. The DoneGate never reads this, and a `state` entry saying a
 * file was created can never stand in for the diff that shows it was. That is
 * why `sourceRef` is rendered next to every entry: a claim with a run id or a
 * commit behind it can be checked, and one without says so by having nothing.
 *
 * **Not the conversation.** Messages live in the conversation and are sent as
 * the conversation. This is the project's standing knowledge, which outlives
 * any one of them.
 */

/** One entry, as it is stored. Mirrors the `project_context` row. */
export interface ContextEntry {
  readonly id: string;
  readonly kind: 'objective' | 'decision' | 'architecture' | 'rule' | 'state' | 'evidence';
  readonly title: string;
  readonly body: string;
  /** The run, commit or file this came from. Null when a person wrote it. */
  readonly sourceRef: string | null;
  readonly pinned: boolean;
  readonly updatedAt: string;
}

/** Kinds that are never dropped: losing one changes what the task means. */
const ALWAYS: ReadonlySet<ContextEntry['kind']> = new Set(['rule', 'objective']);

/** Order the sections appear in, so a prompt reads the same way every time. */
const ORDER: ReadonlyArray<ContextEntry['kind']> = [
  'objective',
  'rule',
  'architecture',
  'decision',
  'state',
  'evidence',
];

const LABEL: Record<ContextEntry['kind'], string> = {
  objective: 'PROJECT OBJECTIVE',
  rule: 'RULES AND CONSTRAINTS',
  architecture: 'ARCHITECTURE',
  decision: 'DECISIONS',
  state: 'CURRENT STATE',
  evidence: 'LAST VERIFIED EVIDENCE',
};

export interface SelectionOptions {
  /** Total characters the rendered block may take. Default 6000. */
  readonly maxChars?: number;
  /** Entries that compete, at most. Default 12. */
  readonly maxOptional?: number;
}

export interface Selection {
  readonly entries: readonly ContextEntry[];
  /** How many entries existed but were not sent, so the prompt can say so. */
  readonly omitted: number;
}

/**
 * The entries to send for this objective.
 *
 * Deterministic: the same project and the same objective always select the
 * same entries, in the same order. A selection that shifted between runs would
 * make a run that behaved differently impossible to explain.
 */
export function selectContext(
  entries: readonly ContextEntry[],
  objective: string,
  options: SelectionOptions = {},
): Selection {
  const maxChars = options.maxChars ?? 6000;
  const maxOptional = options.maxOptional ?? 12;

  const required: ContextEntry[] = [];
  const optional: ContextEntry[] = [];
  for (const entry of entries) {
    if (entry.pinned || ALWAYS.has(entry.kind)) required.push(entry);
    else optional.push(entry);
  }

  const terms = termsOf(objective);
  const ranked = optional
    .map((entry, index) => ({ entry, index, score: scoreOf(entry, terms) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Same score: the more recently touched one, then the stored order, so
      // the result never depends on the sort's stability.
      if (a.entry.updatedAt !== b.entry.updatedAt) {
        return a.entry.updatedAt < b.entry.updatedAt ? 1 : -1;
      }
      return a.index - b.index;
    })
    .map((row) => row.entry);

  const chosen: ContextEntry[] = [...required];
  let budget = maxChars - required.reduce((total, entry) => total + sizeOf(entry), 0);
  let taken = 0;
  for (const entry of ranked) {
    if (taken >= maxOptional) break;
    const size = sizeOf(entry);
    if (size > budget) continue;
    chosen.push(entry);
    budget -= size;
    taken += 1;
  }

  // Back into the reading order. The sections decide the layout - a rules
  // section scattered through the prompt is a rules section nobody reads - and
  // *within* a section the most relevant entry goes first, because that is
  // what the ranking already worked out and what a reader sees first.
  // Required entries all score zero, so they fall back to most recent first,
  // which is the only order that means anything for them.
  const ordered = ORDER.flatMap((kind) =>
    chosen
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => {
        const byScore = scoreOf(b, terms) - scoreOf(a, terms);
        if (byScore !== 0) return byScore;
        return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
      }),
  );

  return { entries: ordered, omitted: entries.length - ordered.length };
}

/**
 * The selection as prompt text.
 *
 * Two things this format insists on, both for the same reason — an agent must
 * be able to tell a fact from a claim:
 *
 * 1. every entry carries its source, or says it has none;
 * 2. the block says outright that none of it is evidence, and that a
 *    contradiction between it and the repository is resolved by the
 *    repository.
 */
export function renderContext(selection: Selection): string {
  if (selection.entries.length === 0) return '';

  // English, like the rest of the orchestrator prompt. The interface speaks
  // Portuguese to the person; this block speaks to a model, and mixing the two
  // inside one prompt buys nothing and costs consistency.
  const lines: string[] = [
    'PROJECT CONTEXT',
    'This is what the project knows about itself. It is background, not proof:',
    'every line below is somebody\'s claim, including the ones this application',
    'wrote. If it disagrees with what you find in the repository, the repository',
    'is right. Never cite this section as evidence that a file changed.',
    '',
  ];

  let currentKind: ContextEntry['kind'] | null = null;
  for (const entry of selection.entries) {
    if (entry.kind !== currentKind) {
      // A blank line before each heading but the first: the sections are the
      // structure a reader navigates by, and run together they are not.
      if (currentKind !== null) lines.push('');
      currentKind = entry.kind;
      lines.push(`## ${LABEL[entry.kind]}`);
    }
    const source = entry.sourceRef ? ` [source: ${entry.sourceRef}]` : ' [no source recorded]';
    lines.push(`- **${entry.title}**${source}`);
    for (const line of entry.body.split('\n')) lines.push(`  ${line}`);
  }

  if (selection.omitted > 0) {
    lines.push('');
    lines.push(
      `(${selection.omitted} further project note(s) were left out as less relevant to this ` +
        'task. Ask if you need something that is not here.)',
    );
  }

  return lines.join('\n');
}

function sizeOf(entry: ContextEntry): number {
  return entry.title.length + entry.body.length + 32;
}

/** Words worth matching on: four letters or more, lower-cased, deduplicated. */
function termsOf(text: string): ReadonlySet<string> {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length >= 4);
  return new Set(words);
}

/**
 * How much this entry has to do with the objective.
 *
 * A title match counts double: somebody chose those words to name the thing,
 * so they carry more than the same word buried in a paragraph.
 */
function scoreOf(entry: ContextEntry, terms: ReadonlySet<string>): number {
  if (terms.size === 0) return 0;
  let score = 0;
  for (const term of termsOf(entry.title)) if (terms.has(term)) score += 2;
  for (const term of termsOf(entry.body)) if (terms.has(term)) score += 1;
  return score;
}

/**
 * What an agent is doing right now (spec 15).
 *
 * The user's report was not that a run failed. It was that the window said
 * *"executando automaticamente"* and stayed there, with nothing to look at and
 * nothing to decide. That is a design gap, not a bug in the loop: the
 * application knew a child process existed and knew nothing else about it, so
 * "working hard" and "hung forever" rendered identically.
 *
 * This is the smallest thing that closes the gap. It holds, per invocation:
 *
 * - when the invocation started, so elapsed time is a fact rather than a guess;
 * - when it last did anything at all, which is the number that distinguishes
 *   a long run from a stuck one;
 * - what it is doing, when the tool says so;
 * - and the last few things it did, so "stuck on what?" has an answer.
 *
 * The idea is Buzz's: its ACP harness resets an idle deadline on *any* agent
 * activity and keeps a separate absolute cap as a safety valve, rather than
 * relying on one wall-clock timeout to mean both things. The mechanism here is
 * much smaller — one process, one turn — but the distinction is the same one,
 * and it is the distinction that matters.
 *
 * Nothing here decides anything. It observes, and it is read by the interface
 * and by the failure classifier. A monitor that could cancel a run would be a
 * second controller, and there is exactly one.
 */

/** A thing the agent was observed doing. */
export interface ActivityNote {
  readonly at: string;
  /**
   * What kind of activity this was.
   *
   * `tool` is the useful one: it is the difference between "no idea" and
   * "waiting on Bash". The rest exist so that an adapter which cannot see
   * tool calls still reports *something*, because raw output arriving is
   * itself evidence of life.
   */
  readonly kind: 'started' | 'output' | 'tool' | 'thinking' | 'result' | 'error';
  /**
   * A short, safe label.
   *
   * Tool *names* only, never arguments: an argument can carry the person's own
   * text, a path, or a secret, and this string reaches the renderer and the
   * logs. The same rule the envelope reader already follows for refused tools.
   */
  readonly detail: string;
}

/** What the interface renders. Everything a person needs to decide to wait. */
export interface ActivitySnapshot {
  readonly startedAt: string;
  /** Milliseconds since the invocation began. */
  readonly elapsedMs: number;
  /** When anything last happened. Equal to `startedAt` until something does. */
  readonly lastActivityAt: string;
  /** Milliseconds of silence. This is the number that says "stuck". */
  readonly idleMs: number;
  /** The tool the agent is inside, when the runtime reports one. */
  readonly currentTool: string | null;
  /** The most recent notes, oldest first. */
  readonly recent: readonly ActivityNote[];
  /** How long silence may last before the invocation is stopped, if capped. */
  readonly idleTimeoutMs: number | null;
}

const MAX_NOTES = 20;
/** Labels are truncated: this is a status line, not a log. */
const MAX_DETAIL = 120;

export class ActivityMonitor {
  private readonly notes: ActivityNote[] = [];
  private lastActivity: Date;
  private tool: string | null = null;

  constructor(
    private readonly startedAt: Date = new Date(),
    private readonly options: {
      idleTimeoutMs?: number | null;
      now?: () => Date;
      /** Called after every note, so the interface updates as things happen. */
      onChange?: (snapshot: ActivitySnapshot) => void;
    } = {},
  ) {
    this.lastActivity = startedAt;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Records something the agent did, and resets the silence clock. */
  note(kind: ActivityNote['kind'], detail = ''): void {
    const at = this.now();
    this.lastActivity = at;
    if (kind === 'tool') this.tool = detail || null;
    // A result or an error ends whatever tool was running; leaving the old
    // name up would say the agent is inside a tool it has already left.
    if (kind === 'result' || kind === 'error') this.tool = null;
    this.notes.push({ at: at.toISOString(), kind, detail: detail.slice(0, MAX_DETAIL) });
    if (this.notes.length > MAX_NOTES) this.notes.shift();
    try {
      this.options.onChange?.(this.snapshot());
    } catch {
      // A watcher that throws must never disturb the run it is watching.
    }
  }

  /**
   * Reads a chunk of a runtime's output and notes what it shows.
   *
   * Deliberately forgiving. The line formats these CLIs emit are theirs to
   * change, and a format this does not recognise must still count as activity:
   * bytes arriving *are* the evidence of life, and the label is a bonus. So an
   * unrecognised chunk is an `output` note, never nothing.
   */
  observe(chunk: string): void {
    const events = readStreamEvents(chunk);
    if (events.length === 0) {
      if (chunk.trim().length > 0) this.note('output', firstLine(chunk));
      return;
    }
    for (const event of events) this.note(event.kind, event.detail);
  }

  snapshot(): ActivitySnapshot {
    const now = this.now().getTime();
    return {
      startedAt: this.startedAt.toISOString(),
      elapsedMs: Math.max(0, now - this.startedAt.getTime()),
      lastActivityAt: this.lastActivity.toISOString(),
      idleMs: Math.max(0, now - this.lastActivity.getTime()),
      currentTool: this.tool,
      recent: [...this.notes],
      idleTimeoutMs: this.options.idleTimeoutMs ?? null,
    };
  }

  /** True when nothing has happened for longer than the configured limit. */
  get stalled(): boolean {
    const limit = this.options.idleTimeoutMs;
    if (!limit || limit <= 0) return false;
    return this.now().getTime() - this.lastActivity.getTime() >= limit;
  }
}

/**
 * Turns a chunk of streamed CLI output into activity notes.
 *
 * Reads the line-delimited JSON that `claude --output-format stream-json`
 * emits. Only three things are taken from it — that an event happened, its
 * kind, and a tool's *name* — because that is all the interface needs and all
 * that is safe to display. Tool inputs are never read: they carry whatever was
 * being written, which can be the person's own text.
 *
 * Anything that is not recognisable JSON is not an error. It is output, which
 * is itself the fact worth knowing.
 */
export function readStreamEvents(chunk: string): ActivityNote[] {
  const notes: ActivityNote[] = [];
  const at = new Date().toISOString();
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const note = describeEvent(parsed, at);
    if (note) notes.push(note);
  }
  return notes;
}

function describeEvent(event: Record<string, unknown>, at: string): ActivityNote | null {
  const type = typeof event.type === 'string' ? event.type : null;
  if (!type) return null;

  if (type === 'system') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    return { at, kind: 'started', detail: subtype === 'init' ? 'sessão iniciada' : subtype };
  }
  if (type === 'result') {
    return {
      at,
      kind: event.is_error === true ? 'error' : 'result',
      detail: event.is_error === true ? 'a execução terminou em erro' : 'execução concluída',
    };
  }
  if (type === 'assistant' || type === 'user') {
    const tool = toolNameIn(event);
    if (tool) return { at, kind: 'tool', detail: tool };
    return { at, kind: 'thinking', detail: type === 'assistant' ? 'o agente respondeu' : 'resultado de ferramenta' };
  }
  // Stream deltas: activity, with nothing worth naming.
  if (type.startsWith('stream') || type === 'content_block_delta') {
    return { at, kind: 'output', detail: '' };
  }
  return { at, kind: 'output', detail: type };
}

/**
 * The name of the tool an event refers to, if any.
 *
 * Only `name`. The `input` sibling is never touched: it holds the file being
 * written and the command being run, which is exactly the content that must
 * not be echoed into a status line.
 */
function toolNameIn(event: Record<string, unknown>): string | null {
  const message = event.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const kind = (block as { type?: unknown }).type;
    if (kind !== 'tool_use') continue;
    const name = (block as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name.slice(0, MAX_DETAIL);
  }
  return null;
}

function firstLine(chunk: string): string {
  const line = chunk.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? '';
  return line.trim().slice(0, MAX_DETAIL);
}

/**
 * A sentence naming what the run is doing, in the words the interface uses.
 *
 * The whole point of the exercise: instead of "executando automaticamente" for
 * forty minutes, the person reads how long it has been working, when it last
 * did anything, and — when the runtime says so — what it is inside.
 */
export function describeActivity(snapshot: ActivitySnapshot): string {
  const running = formatDuration(snapshot.elapsedMs);
  const parts = [`executando há ${running}`];
  if (snapshot.currentTool) parts.push(`ferramenta: ${snapshot.currentTool}`);
  // Only worth saying once the silence is long enough to mean something; below
  // that it is noise that makes a healthy run look suspicious.
  if (snapshot.idleMs >= 15_000) {
    parts.push(`sem atividade há ${formatDuration(snapshot.idleMs)}`);
  }
  return parts.join(' · ');
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

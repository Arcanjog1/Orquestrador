/**
 * "pare tudo q esteja fazendo" is not a task.
 *
 * ## What happened
 *
 * A person watching a run go in circles typed *"pare tudo q esteja fazendo"*
 * and then *"pare oq o claude esta fazendo"*. Both became **new runs**: the
 * supervisor was asked to plan how to stop, and the worker was delegated the
 * job of confirming that it had stopped. The run the person wanted stopped
 * kept going.
 *
 * Cancelling is a control operation. It belongs to the process manager, not to
 * a model, and no model needs to agree to it.
 *
 * ## What this decides
 *
 * Whether a message is a *request to stop the current run*. It is deliberately
 * narrow in one direction and deliberately generous in the other:
 *
 *  - **generous** about the ways a person says stop, including typos and the
 *    clipped Portuguese of somebody in a hurry ("pare tudo q esteja fazendo");
 *  - **narrow** about anything that merely mentions stopping. *"Como eu
 *    cancelo uma tarefa?"* is a question, *"não pare"* is the opposite, and
 *    *"pare de usar tabs e use espaços"* is an instruction about code. None of
 *    them may cancel anything.
 *
 * When it is not sure, it says no. A missed stop costs one more click; a
 * wrongly cancelled run costs the work.
 */

export type StopIntent =
  /** An unambiguous request to stop what is running now. */
  | 'stop'
  /** Anything else, including questions about stopping. */
  | 'none';

/** Verbs that mean stop, as they are actually typed. */
const STOP_VERB =
  '(par[ea]r?|parar?|pare|pára|para|cancel(?:e|ar?|a)?|abort(?:e|ar?|a)?|interromp(?:a|er)|stop|cancel|abort|halt)';

/**
 * A message whose *whole point* is stopping.
 *
 * Anchored to the start on purpose: a stop request is the first thing somebody
 * types, and a sentence that merely contains "pare" somewhere in the middle is
 * far more likely to be about something else.
 */
const STOP_LINE = new RegExp(
  `^\\s*(?:por favor[,\\s]+|pf[,\\s]+|please[,\\s]+)?${STOP_VERB}\\b`,
  'i',
);

/** Words that flip the meaning, wherever they appear before the verb. */
const NEGATED = new RegExp(`^\\s*(?:n[ãa]o|nao|never|don'?t|do not)\\s+${STOP_VERB}`, 'i');

/** A question about cancelling is a question, not a cancellation. */
const QUESTION = /[?？]\s*$|^\s*(?:como|quando|onde|por que|porque|qual|o que|what|how|when|why|can i|posso|d[áa] para|tem como)\b/i;

/**
 * Things that follow the verb and prove the message is about something else.
 *
 * "pare de usar tabs" is an instruction about the code; "pare o servidor" is a
 * task. Only an object that names the run, the agents, or nothing at all is
 * read as a cancellation.
 */
const ABOUT_THE_RUN = new RegExp(
  '^[\\s,.!]*(?:$|(?:' +
    [
      'tudo',
      'isso',
      'isto',
      'agora',
      'j[áa]',
      'imediatamente',
      'oq',
      'o\\s*q(?:ue)?',
      '(?:a|essa|esta|the)\\s+(?:tarefa|execu[çc][ãa]o|run|task|job)',
      'execu[çc][ãa]o',
      'o\\s+(?:claude|codex|worker|agente)',
      'os\\s+agentes',
      'everything',
      'all',
      'it',
      'this',
    ].join('|') +
    ')\\b)',
  'i',
);

/**
 * Reads a chat message as a stop request, or as anything else.
 *
 * `text` is the message exactly as typed. Nothing here is case- or
 * accent-sensitive, and nothing is inferred from length or punctuation alone.
 */
export function readStopIntent(text: string): StopIntent {
  const raw = text.trim();
  if (raw.length === 0 || raw.length > 200) return 'none';
  // A long message is a task with the word "pare" in it, not a stop request.

  if (NEGATED.test(raw)) return 'none';
  if (QUESTION.test(raw)) return 'none';

  const match = STOP_LINE.exec(raw);
  if (!match) return 'none';

  const rest = raw.slice(match[0].length);
  return ABOUT_THE_RUN.test(rest) ? 'stop' : 'none';
}

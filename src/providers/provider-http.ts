/**
 * The one HTTP path to a provider API.
 *
 * Both API adapters go through here so that timeouts, cancellation and - above
 * all - **failure classification** are written once. A 429 and a 403 billing
 * error look alike as strings and must never be treated alike: one may be
 * retried, the other must stop the run before it spends anything else.
 *
 * The transport is injected. In production it is the platform `fetch`; in the
 * tests it is a function that answers from a script, so every failure mode
 * below - auth, rate limit, insufficient credit, malformed body - is exercised
 * deterministically and without a network or a cent.
 */

import { ProviderError, type ProviderFailureKind } from './provider-types.js';

/** The subset of `fetch` this module uses. Keeps the tests free of globals. */
export type HttpTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
  readonly headers: { get(name: string): string | null };
}

export interface PostJsonOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  transport: HttpTransport;
  /** Names the provider in user-facing messages ("a OpenAI", "a Anthropic"). */
  providerLabel: string;
}

/**
 * POSTs JSON and returns the parsed body, or throws a classified
 * `ProviderError`.
 *
 * The timeout is ours, not the transport's: a provider that accepts the
 * connection and then says nothing would otherwise hold an invocation open
 * until the agent timeout, which is fifteen minutes of a person watching a
 * spinner.
 */
export async function postJson<T>(options: PostJsonOptions): Promise<T> {
  const timer = new AbortController();
  const onOuterAbort = () => timer.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const timeout = setTimeout(() => timer.abort(), options.timeoutMs);

  let response: HttpResponse;
  try {
    response = await options.transport(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal: timer.signal,
    });
  } catch (error) {
    // Distinguishing these three matters: a cancelled run must not be reported
    // as a provider outage, and a timeout must not be retried as if the
    // network had blinked.
    if (options.signal?.aborted) {
      throw new ProviderError('cancelled', 'A chamada foi cancelada.');
    }
    if (timer.signal.aborted) {
      throw new ProviderError(
        'timeout',
        `${options.providerLabel} não respondeu dentro do tempo previsto.`,
        `${Math.round(options.timeoutMs / 1000)}s`,
      );
    }
    throw new ProviderError(
      'network',
      `Não foi possível falar com ${options.providerLabel}.`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw classify(response.status, text, response.headers.get('retry-after'), options.providerLabel);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(
      'schema',
      `${options.providerLabel} respondeu algo que não é JSON.`,
      excerpt(text),
      response.status,
    );
  }
}

/** GETs JSON. Same classification; used for the model catalogue. */
export async function getJson<T>(
  options: Omit<PostJsonOptions, 'body'> & { body?: never },
): Promise<T> {
  const timer = new AbortController();
  const onOuterAbort = () => timer.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const timeout = setTimeout(() => timer.abort(), options.timeoutMs);
  let response: HttpResponse;
  try {
    response = await options.transport(options.url, {
      method: 'GET',
      headers: options.headers,
      body: '',
      signal: timer.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ProviderError('cancelled', 'A chamada foi cancelada.');
    if (timer.signal.aborted) {
      throw new ProviderError(
        'timeout',
        `${options.providerLabel} não respondeu dentro do tempo previsto.`,
      );
    }
    throw new ProviderError(
      'network',
      `Não foi possível falar com ${options.providerLabel}.`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw classify(response.status, text, response.headers.get('retry-after'), options.providerLabel);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError('schema', `${options.providerLabel} respondeu algo que não é JSON.`, excerpt(text));
  }
}

/**
 * Turns an HTTP failure into something the loop can act on.
 *
 * The rules that carry money:
 *
 *  - A 429 is a rate limit: wait, do not escalate to a costlier model.
 *  - A 402, or a 400/403 whose body says the balance or quota is gone, is
 *    `insufficient-credit`: **stop**. Retrying it is how a loop burns an
 *    afternoon against a wall, and escalating it would try to spend money that
 *    is not there.
 *  - A 401 is authentication: a retry cannot fix it either.
 *
 * Both vendors put the machine-readable reason in different places, so both
 * shapes are read, and the raw text is the last resort.
 */
export function classify(
  status: number,
  body: string,
  retryAfter: string | null,
  providerLabel: string,
): ProviderError {
  const parsed = parseErrorBody(body);
  const code = `${parsed.type ?? ''} ${parsed.code ?? ''}`.toLowerCase();
  const message = parsed.message ?? excerpt(body);
  const lower = `${code} ${message}`.toLowerCase();
  const retrySeconds = parseRetryAfter(retryAfter);

  const saysNoCredit =
    /insufficient[_ ]?quota|insufficient[_ ]?credit|credit balance|billing_?(hard_limit|error)|quota[_ ]exceeded|exceeded your current quota|payment required|saldo/.test(
      lower,
    );

  let kind: ProviderFailureKind;
  let userMessage: string;

  if (status === 402 || saysNoCredit) {
    kind = 'insufficient-credit';
    userMessage = `A conta em ${providerLabel} está sem saldo ou fora da cota. A execução foi interrompida para não insistir em uma chamada que será recusada.`;
  } else if (status === 401) {
    kind = 'authentication';
    userMessage = `A credencial desta conexão com ${providerLabel} não foi aceita.`;
  } else if (status === 403) {
    kind = 'permission';
    userMessage = `Esta conexão com ${providerLabel} não tem permissão para o que foi pedido.`;
  } else if (status === 429) {
    kind = 'rate-limit';
    userMessage = `${providerLabel} pediu para esperar antes da próxima chamada.`;
  } else if (status === 404 || /model[_ ]not[_ ]found|does not exist|unknown model/.test(lower)) {
    kind = 'model-unavailable';
    userMessage = `O modelo pedido não está disponível para esta conta em ${providerLabel}.`;
  } else if (status === 400 || status === 413 || status === 422) {
    kind = 'invalid-request';
    userMessage = `${providerLabel} recusou o formato da chamada.`;
  } else if (status >= 500) {
    kind = 'provider-error';
    userMessage = `${providerLabel} está com problema no momento.`;
  } else {
    kind = 'provider-error';
    userMessage = `${providerLabel} respondeu com um erro (${status}).`;
  }

  return new ProviderError(kind, userMessage, message ? excerpt(message, 300) : null, status, retrySeconds);
}

interface ParsedError {
  type?: string;
  code?: string;
  message?: string;
}

/**
 * Reads the error out of either vendor's envelope.
 *
 * Anthropic: `{"type":"error","error":{"type":"...","message":"..."}}`
 * OpenAI:    `{"error":{"message":"...","type":"...","code":"..."}}`
 */
function parseErrorBody(body: string): ParsedError {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const error = (json.error ?? json) as Record<string, unknown>;
    return {
      ...(typeof error.type === 'string' ? { type: error.type } : {}),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(typeof error.message === 'string' ? { message: error.message } : {}),
    };
  } catch {
    return {};
  }
}

/** `retry-after` is seconds or an HTTP date; both are turned into seconds. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

function excerpt(text: string, max = 400): string {
  const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** The platform `fetch`, adapted to `HttpTransport`. */
export const fetchTransport: HttpTransport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.method === 'GET' ? {} : { body: init.body }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return {
    status: response.status,
    ok: response.ok,
    text: () => response.text(),
    headers: { get: (name: string) => response.headers.get(name) },
  };
};

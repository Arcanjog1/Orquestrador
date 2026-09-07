/**
 * The desktop's side of the coordinator.
 *
 * Two things this deliberately is not:
 *
 *  - a *driver*. The desktop does not step a remote run; it submits one and
 *    then reads what happened. If it drove, closing the application would stop
 *    the work, which is the one thing cloud mode exists to prevent;
 *  - a *source of truth*. Everything here is a read of the coordinator's
 *    durable log, resumed from a cursor the desktop stores. Reconnecting after
 *    an hour and reconnecting after a second take the same path.
 *
 * The desktop's own session token is the only authorisation. Nothing it sends
 * in a body decides what it may see.
 */

export interface CloudRunView {
  readonly id: string;
  readonly repository: string;
  readonly branch: string;
  readonly objective: string;
  readonly status: string;
  readonly failureReason: string | null;
  readonly clientRunId: string | null;
  readonly clientSessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface CloudEvent {
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface CloudClientOptions {
  /** The coordinator's base URL, without a trailing slash. */
  endpoint: string;
  /** Reads the desktop session token. A function, so a re-login is picked up. */
  token: () => string | null;
  fetchImpl?: typeof fetch;
  /** How long any single request may take. */
  timeoutMs?: number;
}

export class CloudError extends Error {
  readonly userMessage: string;
  constructor(
    readonly reason: 'OFFLINE' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'REFUSED' | 'UNEXPECTED',
    userMessage: string,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${userMessage} (${detail})` : userMessage);
    this.name = 'CloudError';
    this.userMessage = detail ? `${userMessage} Detalhe: ${detail}.` : userMessage;
  }
}

export class CloudClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.raw('GET', '/v1/health');
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Submits a run.
   *
   * `idempotencyKey` is required rather than optional, and the caller derives
   * it from something stable - the local run's id. A submission that timed out
   * on the network but arrived is then re-sent safely: the coordinator returns
   * the run it already has, and the person does not get two runs, two commits
   * and two pull requests for one press of a button.
   */
  async submit(input: {
    repository: string;
    branch: string;
    objective: string;
    idempotencyKey: string;
    clientRunId?: string;
    clientSessionId?: string;
    team?: unknown;
  }): Promise<{ run: CloudRunView; created: boolean }> {
    const body = await this.json<{ run: CloudRunView; created: boolean }>('POST', '/v1/runs', {
      repository: input.repository,
      branch: input.branch,
      objective: input.objective,
      clientRunId: input.clientRunId ?? null,
      clientSessionId: input.clientSessionId ?? null,
      team: input.team ?? {},
    }, { 'idempotency-key': input.idempotencyKey });
    return body;
  }

  async run(remoteRunId: string): Promise<CloudRunView> {
    const body = await this.json<{ run: CloudRunView }>('GET', `/v1/runs/${encodeURIComponent(remoteRunId)}`);
    return body.run;
  }

  async runs(): Promise<CloudRunView[]> {
    return (await this.json<{ runs: CloudRunView[] }>('GET', '/v1/runs')).runs;
  }

  /**
   * Everything that happened after `afterSeq`.
   *
   * The cursor is what makes catching up exact. Asking twice with the same
   * cursor returns the same events, so an interrupted sync is retried rather
   * than reconciled - and a step is never applied twice.
   */
  async events(
    remoteRunId: string,
    afterSeq: number,
    limit = 500,
  ): Promise<{ events: CloudEvent[]; cursor: number; status: string }> {
    return this.json<{ events: CloudEvent[]; cursor: number; status: string }>(
      'GET',
      `/v1/runs/${encodeURIComponent(remoteRunId)}/events?after=${afterSeq}&limit=${limit}`,
    );
  }

  async cancel(remoteRunId: string): Promise<boolean> {
    const body = await this.json<{ cancelled: boolean }>(
      'POST',
      `/v1/runs/${encodeURIComponent(remoteRunId)}/cancel`,
    );
    return body.cancelled;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.raw(method, path, body, extraHeaders);
    if (response.status === 401) {
      throw new CloudError('UNAUTHORIZED', 'A nuvem não aceitou este dispositivo. Conecte novamente.');
    }
    if (response.status === 404) {
      throw new CloudError('NOT_FOUND', 'Esta execução não existe mais na nuvem.');
    }
    if (!response.ok) {
      let detail: string | null = null;
      try {
        const parsed = (await response.json()) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === 'string') detail = parsed.error.message;
      } catch {
        // The status is enough.
      }
      throw new CloudError('REFUSED', `A nuvem respondeu ${response.status}.`, detail);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new CloudError('UNEXPECTED', 'A nuvem respondeu de uma forma inesperada.');
    }
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const token = this.options.token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      return await this.fetchImpl(`${this.options.endpoint.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw new CloudError(
        'OFFLINE',
        'Sem conexão com a nuvem. O trabalho continua lá; esta janela é que não conseguiu falar com ela.',
        (error as Error).message,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The coordinator's HTTP API.
 *
 * Small on purpose. There is no generic "run this command" endpoint and there
 * never will be: the only things a client can ask for are a run, its state,
 * its events and its cancellation. A remote shell reachable with a bearer
 * token is the difference between a build service and a botnet.
 *
 * Authorisation comes from the token and nothing else. A body may *say*
 * whose run it is; that is a hint to be matched against the token's principal,
 * never a claim to be believed. Every lookup takes the principal, so a handler
 * cannot forget to scope a query - `findRun(id, principal)` is the only way to
 * ask for a run at all.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RunRefusedError, type Coordinator } from './coordinator.js';
import type { PrincipalRecord } from '../../../src/cloud/coordinator/store.js';

/** Bodies are small - an objective and a few ids. Anything larger is refused. */
const MAX_BODY_BYTES = 64 * 1024;

export interface HttpOptions {
  coordinator: Coordinator;
  /** Where to listen. 127.0.0.1 by default: exposing it is a deployment choice. */
  host?: string;
  port?: number;
}

export function createCoordinatorServer(options: HttpOptions): Server {
  const { coordinator } = options;
  return createServer((request, response) => {
    handle(coordinator, request, response).catch((error: unknown) => {
      send(response, 500, { error: { code: 'internal', message: describe(error) } });
    });
  });
}

async function handle(
  coordinator: Coordinator,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://coordinator.invalid');
  const path = url.pathname;

  // Liveness is the only unauthenticated route, and it says nothing about
  // anyone's data.
  if (path === '/v1/health' && request.method === 'GET') {
    return send(response, 200, { ok: true });
  }

  const principal = authenticate(coordinator, request);
  if (!principal) {
    // No hint about whether the token was unknown, expired or revoked: that
    // difference is only useful to someone guessing.
    return send(response, 401, { error: { code: 'unauthorized', message: 'Token inválido.' } });
  }

  if (path === '/v1/runs' && request.method === 'POST') {
    const body = await readJson(request, response);
    if (body === undefined) return;
    const repository = string(body.repository);
    const branch = string(body.branch);
    const objective = string(body.objective);
    if (!repository || !branch || !objective) {
      return send(response, 400, {
        error: { code: 'invalid', message: 'repository, branch e objective são obrigatórios.' },
      });
    }
    let submitted: Awaited<ReturnType<Coordinator['submit']>>;
    try {
      submitted = await coordinator.submit({
        principal,
        repository,
        branch,
        objective,
        idempotencyKey: header(request, 'idempotency-key') ?? string(body.idempotencyKey),
        clientRunId: string(body.clientRunId),
        clientSessionId: string(body.clientSessionId),
        team: body.team,
      });
    } catch (error) {
      if (error instanceof RunRefusedError) {
        // 429, not 400 or 500: the request was well formed and the caller is
        // allowed to make it - just not right now. A client can tell that
        // apart and act on it; a 500 would look like our fault to retry into.
        return send(response, 429, { error: { code: error.reason, message: error.userMessage } });
      }
      throw error;
    }
    const { run, created } = submitted;
    // 200 rather than 201 when the key had already made this run, so a client
    // can tell a retry that was absorbed from a new run it just caused.
    return send(response, created ? 201 : 200, { run: toView(run), created });
  }

  if (path === '/v1/runs' && request.method === 'GET') {
    return send(response, 200, { runs: coordinator.store.listRuns(principal).map(toView) });
  }

  const runMatch = /^\/v1\/runs\/([A-Za-z0-9_-]{1,80})(\/events|\/cancel)?$/.exec(path);
  if (runMatch) {
    const runId = runMatch[1]!;
    const suffix = runMatch[2];
    // Scoped by principal: another tenant's run is "not found", not "forbidden".
    const run = coordinator.store.findRun(runId, principal);
    if (!run) {
      return send(response, 404, { error: { code: 'not_found', message: 'Execução não encontrada.' } });
    }

    if (!suffix && request.method === 'GET') {
      return send(response, 200, { run: toView(run) });
    }
    if (suffix === '/events' && request.method === 'GET') {
      // The cursor is what makes reconnecting exact: everything after the last
      // sequence this desktop applied, never a replay from the start.
      const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 1), 1000);
      const events = coordinator.store.events(runId, Number.isFinite(after) && after > 0 ? after : 0, limit);
      return send(response, 200, {
        events,
        cursor: events.length > 0 ? events[events.length - 1]!.seq : after,
        status: run.status,
      });
    }
    if (suffix === '/cancel' && request.method === 'POST') {
      const cancelled = coordinator.cancel(runId, principal);
      return send(response, 200, { cancelled });
    }
  }

  send(response, 404, { error: { code: 'not_found', message: 'Rota desconhecida.' } });
}

function authenticate(coordinator: Coordinator, request: IncomingMessage): PrincipalRecord | null {
  const authorization = header(request, 'authorization');
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return null;
  return coordinator.store.authenticate(match[1]!);
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Reads a bounded JSON body, answering the client itself on a problem. */
async function readJson(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      send(response, 413, { error: { code: 'too_large', message: 'Corpo grande demais.' } });
      request.destroy();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      send(response, 400, { error: { code: 'invalid', message: 'Corpo inválido.' } });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    send(response, 400, { error: { code: 'invalid', message: 'JSON inválido.' } });
    return undefined;
  }
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** What a client is told about a run. The principal and tenant stay here. */
function toView(run: {
  id: string;
  repository: string;
  branch: string;
  objective: string;
  status: string;
  failure_reason: string | null;
  client_run_id: string | null;
  client_session_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}): Record<string, unknown> {
  return {
    id: run.id,
    repository: run.repository,
    branch: run.branch,
    objective: run.objective,
    status: run.status,
    failureReason: run.failure_reason,
    clientRunId: run.client_run_id,
    clientSessionId: run.client_session_id,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    finishedAt: run.finished_at,
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Nothing here is meant for a browser to read cross-origin, or to cache.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

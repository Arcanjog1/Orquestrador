/**
 * A GitHub that runs on localhost.
 *
 * Speaks exactly the parts of github.com and api.github.com the product uses:
 * the device-flow endpoints, `/user`, `/user/repos`, pull requests and check
 * runs. Its behaviour is scripted per test - how many polls stay pending,
 * whether the person denies - and it records every request it received,
 * headers included, so a test can prove what was and was not sent.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GitHubEndpoints } from '../../src/github/github-client.js';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeGitHubOptions {
  clientId?: string;
  /** How many token polls answer `authorization_pending` before the token. */
  pendingPolls?: number;
  /** Answer `slow_down` on the first poll. */
  slowDownFirst?: boolean;
  /** End the flow with this error instead of a token. */
  finalError?: 'access_denied' | 'expired_token' | 'incorrect_client_credentials' | 'device_flow_disabled';
  /** Answer the device-code request with exactly this, whatever the client id. */
  deviceStart?: { status: number; body?: unknown; text?: string; contentType?: string };
  /** Answer the device-code request form-encoded, as GitHub does without Accept: application/json. */
  deviceCodeAsForm?: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  user?: { login: string; name: string | null; avatar_url: string };
  repos?: Array<Record<string, unknown>>;
  checkRuns?: Array<Record<string, unknown>>;
}

export interface FakeGitHub {
  endpoints: GitHubEndpoints;
  requests: RecordedRequest[];
  polls: number;
  close(): Promise<void>;
}

export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const clientId = options.clientId ?? 'Iv1.testclientid';
  const accessToken = options.accessToken ?? 'gho_testtoken1234567890abcdef';
  const requests: RecordedRequest[] = [];
  const state = { polls: 0 };
  const user = options.user ?? { login: 'octocat', name: 'The Octocat', avatar_url: 'https://example.invalid/octocat.png' };
  const repos = options.repos ?? [];

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      handle(req, res, body);
    });
  });

  function json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const form = new URLSearchParams(body);

    if (req.method === 'POST' && url.pathname === '/login/device/code') {
      if (options.deviceStart) {
        const start = options.deviceStart;
        if (start.text !== undefined) {
          res.writeHead(start.status, { 'Content-Type': start.contentType ?? 'text/html; charset=utf-8' });
          res.end(start.text);
          return;
        }
        return json(res, start.status, start.body ?? {});
      }
      if (form.get('client_id') !== clientId) {
        return json(res, 404, { error: 'Not Found' });
      }
      const payload = {
        device_code: 'device-code-xyz',
        user_code: 'WDJB-MJHT',
        verification_uri: `${endpoints.oauthBase}/login/device`,
        expires_in: 900,
        interval: 1,
      };
      if (options.deviceCodeAsForm) {
        res.writeHead(200, { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' });
        const pairs: Array<[string, string]> = Object.entries(payload).map(([k, v]) => [k, String(v)]);
        res.end(new URLSearchParams(pairs).toString());
        return;
      }
      return json(res, 200, payload);
    }

    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== options.refreshToken) return json(res, 200, { error: 'bad_refresh_token' });
        return json(res, 200, {
          access_token: `${accessToken}-refreshed`,
          token_type: 'bearer',
          scope: '',
          refresh_token: `${options.refreshToken}-next`,
          expires_in: options.expiresIn ?? 28800,
        });
      }
      if (form.get('device_code') !== 'device-code-xyz' || form.get('client_id') !== clientId) {
        return json(res, 200, { error: 'incorrect_device_code' });
      }
      state.polls += 1;
      if (options.slowDownFirst && state.polls === 1) return json(res, 200, { error: 'slow_down', interval: 6 });
      if (state.polls <= (options.pendingPolls ?? 0)) return json(res, 200, { error: 'authorization_pending' });
      if (options.finalError) return json(res, 200, { error: options.finalError });
      return json(res, 200, {
        access_token: accessToken,
        token_type: 'bearer',
        scope: 'repo read:org',
        ...(options.refreshToken ? { refresh_token: options.refreshToken } : {}),
        ...(options.expiresIn ? { expires_in: options.expiresIn } : {}),
      });
    }

    // Everything below is the REST API and needs the bearer token.
    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (bearer !== accessToken && bearer !== `${accessToken}-refreshed`) {
      return json(res, 401, { message: 'Bad credentials' });
    }

    if (req.method === 'GET' && url.pathname === '/user') {
      return json(res, 200, { ...user, html_url: `https://github.com/${user.login}` });
    }
    if (req.method === 'GET' && url.pathname === '/user/repos') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const size = Number(url.searchParams.get('per_page') ?? '100');
      return json(res, 200, repos.slice((page - 1) * size, page * size));
    }
    const pulls = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (pulls && req.method === 'POST') {
      const input = JSON.parse(body) as { title: string; head: string; base: string };
      return json(res, 201, {
        number: 42,
        html_url: `https://github.com/${pulls[1]}/${pulls[2]}/pull/42`,
        title: input.title,
        state: 'open',
        head: { ref: input.head },
        base: { ref: input.base },
      });
    }
    if (pulls && req.method === 'GET') {
      return json(res, 200, [
        { number: 7, html_url: `https://github.com/${pulls[1]}/${pulls[2]}/pull/7`, title: 'Existing', state: 'open' },
      ]);
    }
    if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.test(url.pathname)) {
      const runs = options.checkRuns ?? [];
      return json(res, 200, { total_count: runs.length, check_runs: runs });
    }
    return json(res, 404, { message: `no route for ${req.method} ${url.pathname}` });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const endpoints: GitHubEndpoints = { oauthBase: base, apiBase: base };

  return {
    endpoints,
    requests,
    get polls() {
      return state.polls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

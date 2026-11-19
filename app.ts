// The server: one Node http server routing the four surfaces (git smart HTTP,
// REST v3, GraphQL, MCP) onto one in-memory store. main.ts owns the lifecycle;
// this file owns routing, auth, body reading and error rendering.
//
// Auth: every API surface except the API root, /meta and the git routes
// requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`. A missing or wrong
// token is a 401. When the token env var is unset (local smoke tests only),
// requests are accepted without auth.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './api-graphql.ts';
import { handleMcp } from './api-mcp.ts';
import { handleRest } from './api-rest.ts';
import { nextRequestId } from './determinism.ts';
import { handleGitHttp } from './git-http.ts';
import { ApiError, sendJson, type ApiContext } from './http-util.ts';
import { Store } from './store.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The bearer token check: exact match against the trial token. */
function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${SHOP_TOKEN}`;
}

/** Read the whole request body (packs and JSON bodies are small here). */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * Read the request body, synchronously when it is already fully buffered
 * (the usual case for small loopback POSTs: headers and body arrive together).
 * Falls back to the async stream read otherwise, keeping any bytes the
 * synchronous read already consumed.
 */
async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > 0 && req.readableLength >= length) {
    const chunks: Buffer[] = [];
    let chunk: Buffer | null;
    while ((chunk = req.read() as Buffer | null) !== null) chunks.push(chunk);
    const buffered = Buffer.concat(chunks);
    if (buffered.length >= length) return buffered.subarray(0, length);
    const rest = await readBody(req);
    return Buffer.concat([buffered, rest]);
  }
  return readBody(req);
}

/** Split a pathname into decoded, non-empty segments. */
function pathSegments(pathname: string): string[] {
  const out: string[] = [];
  for (const part of pathname.split('/')) {
    if (part === '') continue;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      const host = req.headers.host ?? 'localhost';
      const baseUrl = `http://${host}`;
      let url: URL;
      try {
        url = new URL(req.url ?? '/', baseUrl);
      } catch {
        url = new URL('/', baseUrl);
      }
      const method = req.method ?? 'GET';
      const segments = pathSegments(url.pathname);

      const sendError = (status: number, message: string): void => {
        if (res.writableEnded) return;
        const headers: Record<string, string> = {};
        if (segments[0] === 'api' && segments[1] === 'v3') {
          headers['x-github-request-id'] = requestId;
        }
        sendJson(res, status, { message }, headers);
      };

      try {
        // GET and HEAD carry no body, and a Content-Length of 0 means the same:
        // skip the stream read entirely for those (the read workload is GETs).
        // resume() drains any unexpected body so the connection stays reusable.
        const contentLength = req.headers['content-length'];
        const hasBody = method !== 'GET' && method !== 'HEAD' && contentLength !== '0';
        if (!hasBody) req.resume();
        const body = hasBody ? await readRequestBody(req) : Buffer.alloc(0);

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes.
        if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
          sendJson(
            res,
            200,
            { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
            { 'x-oauth-scopes': 'repo, read:org', 'x-github-request-id': requestId },
          );
          return;
        }

        const ctx: ApiContext = {
          store,
          method,
          segments,
          query: url.searchParams,
          url,
          headers: req.headers,
          body,
          requestId,
          baseUrl,
          res,
        };

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
        const gitMatch = GIT_ROUTE.exec(url.pathname);
        if (gitMatch !== null) {
          let owner = gitMatch[1];
          let repoName = gitMatch[2];
          try {
            owner = decodeURIComponent(owner);
            repoName = decodeURIComponent(repoName);
          } catch {
            // Keep the raw segments when they do not decode.
          }
          handleGitHttp({
            store,
            method,
            owner,
            repoName,
            action: gitMatch[3] as 'info/refs' | 'git-upload-pack' | 'git-receive-pack',
            query: url.searchParams,
            headers: req.headers,
            body,
            res,
          });
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const isPublicMeta = method === 'GET' && segments.length === 3 && segments[2] === 'meta';
          if (!isPublicMeta && !authorized(req)) {
            sendError(401, 'Bad credentials');
            return;
          }
          handleRest({ ...ctx, segments: segments.slice(2) });
          return;
        }

        // GraphQL.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (!authorized(req)) {
            sendError(401, 'Bad credentials');
            return;
          }
          if (method !== 'POST') {
            sendError(405, 'Method Not Allowed');
            return;
          }
          handleGraphQL(ctx);
          return;
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (!authorized(req)) {
            sendJson(res, 401, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32001, message: 'Unauthorized' },
            });
            return;
          }
          handleMcp(ctx);
          return;
        }

        sendError(404, 'Not Found');
      } catch (err) {
        if (res.writableEnded) return;
        if (err instanceof ApiError) {
          sendError(err.status, err.message);
          return;
        }
        process.stderr.write(`[entry] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        sendError(500, 'Internal Server Error');
      }
    })().catch((err: unknown) => {
      // The request handler must never take the process down.
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.writableEnded) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is gone; nothing left to do.
        }
      }
    });
  });
}

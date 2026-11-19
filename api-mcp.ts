// MCP: JSON-RPC 2.0 over Streamable HTTP at POST /mcp, the modern era
// (2026-07-28) via server/discover, with the legacy initialize handshake as a
// fallback. No sessions: no Mcp-Session-Id is ever issued. Tools act on the
// same store as REST, so reads and mutations stay consistent across surfaces.

import { VIEWER_LOGIN } from './determinism.ts';
import {
  ApiError,
  jsonValue,
  sendJson,
  type ApiContext,
} from './http-util.ts';
import { issueJson, pullJson, repoJson, type RepoState } from './store.ts';

const SERVER_NAME = 'gitforge';
const SERVER_VERSION = '1.0.0';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// One constant list, built once: two tools/list calls answer byte for byte.
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository under the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user repositories.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner whose repositories to list.' },
      },
      required: [],
    },
  },
];

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function resultResponse(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireRepo(ctx: ApiContext, args: Record<string, unknown>): RepoState | null {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  if (owner === undefined || repoName === undefined) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, repoName) ?? null;
}

/**
 * Run one tool call. Returns the JSON-RPC result object, or throws an ApiError
 * carrying a JSON-RPC error code for protocol-level failures (unknown tool,
 * missing arguments). Domain failures (repo not found) are isError results.
 */
function callTool(ctx: ApiContext, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new ApiError(-32601, `Method not found: ${name}`);
  const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null);
  if (missing.length > 0) {
    throw new ApiError(-32602, `Invalid params: missing required argument ${missing.join(', ')}`);
  }

  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name) as string;
      const description = asString(args.description) ?? '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const repo = ctx.store.createRepo(VIEWER_LOGIN, repoName, isPrivate, description);
      if (repo === null) return errorResult(`Repository ${repoName} already exists`);
      return textResult(repoJson(repo, ctx.baseUrl));
    }
    case 'get_repo': {
      const repo = requireRepo(ctx, args);
      if (repo === null) return errorResult('Not Found');
      return textResult(repoJson(repo, ctx.baseUrl));
    }
    case 'create_issue': {
      const repo = requireRepo(ctx, args);
      if (repo === null) return errorResult('Not Found');
      const title = asString(args.title) as string;
      const body = asString(args.body) ?? null;
      const result = ctx.store.createIssue(repo, title, body, []);
      if ('error' in result) return errorResult(result.error);
      return textResult(issueJson(repo, result.issue, ctx.baseUrl));
    }
    case 'list_issues': {
      const repo = requireRepo(ctx, args);
      if (repo === null) return errorResult('Not Found');
      const stateParam = asString(args.state) ?? 'open';
      const state = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
      const issues = ctx.store.listIssues(repo, state, 'desc');
      return textResult(issues.map((issue) => issueJson(repo, issue, ctx.baseUrl)));
    }
    case 'create_pull_request': {
      const repo = requireRepo(ctx, args);
      if (repo === null) return errorResult('Not Found');
      const title = asString(args.title) as string;
      const head = asString(args.head) as string;
      const base = asString(args.base) as string;
      const body = asString(args.body) ?? null;
      const result = ctx.store.createPull(repo, title, body, head, base);
      if ('error' in result) return errorResult(result.error);
      return textResult(pullJson(repo, result.pull, ctx.store, ctx.baseUrl));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(ctx, args);
      if (repo === null) return errorResult('Not Found');
      const number = asNumber(args.pull_number);
      if (number === undefined) return errorResult('Invalid params: pull_number must be a number');
      const result = ctx.store.mergePull(repo, Math.floor(number));
      if ('error' in result) return errorResult(result.error);
      return textResult({ sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    case 'get_issue': {
      const repo = requireRepo(ctx, args);
      if (repo === null) return errorResult('Not Found');
      const number = asNumber(args.issue_number);
      if (number === undefined) return errorResult('Invalid params: issue_number must be a number');
      const issue = ctx.store.getIssue(repo, Math.floor(number));
      if (issue === undefined) return errorResult('Not Found');
      return textResult(issueJson(repo, issue, ctx.baseUrl));
    }
    case 'list_repos': {
      const repos = ctx.store.listRepos(VIEWER_LOGIN);
      return textResult(repos.map((repo) => repoJson(repo, ctx.baseUrl)));
    }
    default:
      throw new ApiError(-32601, `Method not found: ${name}`);
  }
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Handle one JSON-RPC request object; returns the response object or null for a notification. */
function handleRequest(ctx: ApiContext, request: JsonRpcRequest): Record<string, unknown> | null {
  const id: JsonRpcId = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';

  if (method.startsWith('notifications/')) return null;

  if (isNotification) return null;

  if (method === 'server/discover') {
    return resultResponse(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }

  if (method === 'initialize') {
    const params = asRecord(request.params);
    const requested = asString(params.protocolVersion) ?? '2025-11-25';
    return resultResponse(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }

  if (method === 'tools/list') {
    return resultResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = asRecord(request.params);
    const name = asString(params.name);
    if (name === undefined) return errorResponse(id, -32602, 'Invalid params: name is required');
    const args = asRecord(params.arguments);
    try {
      return resultResponse(id, callTool(ctx, name, args));
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(id, err.status, err.message);
      throw err;
    }
  }

  return errorResponse(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle POST /mcp. A body that is not JSON is a 400 with JSON-RPC code
 * -32700. Notifications answer 202 with an empty body.
 */
export function handleMcp(ctx: ApiContext): void {
  if (ctx.method !== 'POST') {
    sendJson(ctx.res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method Not Allowed' } });
    return;
  }
  let payload: unknown;
  try {
    payload = jsonValue(ctx);
  } catch {
    sendJson(ctx.res, 400, errorResponse(null, -32700, 'Parse error'));
    return;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(ctx.res, 400, errorResponse(null, -32600, 'Invalid Request'));
    return;
  }
  const response = handleRequest(ctx, payload as JsonRpcRequest);
  if (response === null) {
    ctx.res.writeHead(202);
    ctx.res.end();
    return;
  }
  sendJson(ctx.res, 200, response);
}

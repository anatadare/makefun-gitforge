// Shared HTTP plumbing for the JSON surfaces (REST v3, GraphQL, MCP): the
// request context, JSON answers, JSON body parsing, and pagination links.

import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** An error that maps directly onto an HTTP status and a JSON message body. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiContext {
  store: Store;
  method: string;
  /** Decoded, non-empty path segments. */
  segments: string[];
  query: URLSearchParams;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
  requestId: string;
  /** The request's origin (scheme + host), for absolute URLs. */
  baseUrl: string;
  res: ServerResponse;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer with an empty body and no content type (204). */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

/** The X-GitHub-Request-Id header every REST reply carries. */
export function requestIdHeader(ctx: ApiContext): Record<string, string> {
  return { 'x-github-request-id': ctx.requestId };
}

/**
 * Parse the request body as JSON. An empty body parses as an empty object; a
 * malformed body is a 400. A non-object JSON value parses as an empty object
 * and lets the endpoint's own validation answer.
 */
export function jsonBody(ctx: ApiContext): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/** Parse the body as JSON without the object requirement (GraphQL/MCP need arrays too). */
export function jsonValue(ctx: ApiContext): unknown {
  if (ctx.body.length === 0) return undefined;
  try {
    return JSON.parse(ctx.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

/** Parse a positive integer path segment (an issue or pull number). */
export function asPositiveInt(segment: string): number | null {
  if (!/^[0-9]+$/.test(segment)) return null;
  const value = Number(segment);
  return value >= 1 && Number.isSafeInteger(value) ? value : null;
}

export interface Page {
  perPage: number;
  page: number;
}

/** per_page (default 30, clamped 1..100) and page (default 1) from the query. */
export function pageParams(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw >= 1 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

/**
 * Slice `items` to the requested page and build a GitHub-style Link header
 * (absolute URLs, rel="next" and rel="last") when more pages exist.
 */
export function paginate<T>(
  ctx: ApiContext,
  items: readonly T[],
): { items: T[]; link: string | null } {
  const { perPage, page } = pageParams(ctx.query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  if (page >= totalPages) return { items: sliced, link: null };
  const linkFor = (targetPage: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(targetPage));
    return `<${ctx.url.origin}${ctx.url.pathname}?${params.toString()}>`;
  };
  const links = [`${linkFor(page + 1)}; rel="next"`, `${linkFor(totalPages)}; rel="last"`];
  return { items: sliced, link: links.join(', ') };
}

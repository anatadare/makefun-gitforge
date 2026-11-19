// MCP conformance test: drive the forge with the kit's own McpClient.
// Run: MAKEFUN_SHOP_TOKEN=... node --experimental-strip-types mcp-test.ts
import { createApp } from './app.ts';
import { McpClient } from '/home/hatch/workspace/makefun/github-core-clone-01-kit/program/env/src/mcp-client.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'shpat_testtoken0123456789abcdef0123456789abcdef';
const server = createApp();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address() as { port: number };
const BASE = `http://127.0.0.1:${address.port}`;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
async function rest(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json };
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const textOf = (outcome: any): string => (outcome.toolResult?.content ?? []).map((c: any) => c.text ?? '').join('');

try {
  const client = new McpClient({ baseUrl: BASE, token: TOKEN });

  // Modern connect via server/discover.
  const info = await client.connect();
  check('mcp modern connect', info.era === 'modern' && (info.supportedVersions ?? []).includes('2026-07-28'), JSON.stringify(info));

  // tools/list twice: identical, and the six canonical tools present with schemas.
  const list1 = await client.listTools();
  const list2 = await client.listTools();
  check('tools/list stable', JSON.stringify(list1) === JSON.stringify(list2));
  const names = list1.map((t) => t.name);
  check('six canonical tools', ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => names.includes(n)), names.join(','));
  check('every tool has description + object schema', list1.every((t) => typeof t.description === 'string' && t.description.length > 0 && (t.inputSchema as any)?.type === 'object' && Array.isArray((t.inputSchema as any)?.required)));

  // Full tool flow.
  const created = await client.callTool('create_repo', { name: 'mcp-demo', description: 'via mcp', private: false });
  const repoJson = created.toolResult?.structuredContent as any;
  check('create_repo structuredContent', repoJson?.full_name === 'adaiversen/mcp-demo' && typeof repoJson?.id === 'number', textOf(created).slice(0, 200));
  const got = await client.callTool('get_repo', { owner: 'adaiversen', repo: 'mcp-demo' });
  check('get_repo text names repo', textOf(got).includes('mcp-demo'));
  const issue = await client.callTool('create_issue', { owner: 'adaiversen', repo: 'mcp-demo', title: 'mcp issue', body: 'mcp body' });
  const issueJson = issue.toolResult?.structuredContent as any;
  check('create_issue number', typeof issueJson?.number === 'number', textOf(issue).slice(0, 200));
  const listed = await client.callTool('list_issues', { owner: 'adaiversen', repo: 'mcp-demo', state: 'open' });
  check('list_issues contains title', textOf(listed).includes('mcp issue'));

  // REST parity: the MCP-created repo and issue read back over REST.
  const restRepo = await rest('GET', '/api/v3/repos/adaiversen/mcp-demo');
  check('mcp repo visible via REST', restRepo.status === 200 && restRepo.json.id === repoJson.id);
  const restIssues = await rest('GET', '/api/v3/repos/adaiversen/mcp-demo/issues');
  check('mcp issue visible via REST', (restIssues.json as any[]).some((i: any) => i.number === issueJson.number));

  // PR flow: seed main + a branch via REST, then create + merge via MCP.
  const first = await rest('PUT', '/api/v3/repos/adaiversen/mcp-demo/contents/base.txt', { message: 'base', content: b64('base\n') });
  await rest('POST', '/api/v3/repos/adaiversen/mcp-demo/git/refs', { ref: 'refs/heads/mcp-head', sha: first.json.commit.sha });
  await rest('PUT', '/api/v3/repos/adaiversen/mcp-demo/contents/mcp.txt', { message: 'mcp change', content: b64('mcp\n'), branch: 'mcp-head' });
  const pr = await client.callTool('create_pull_request', { owner: 'adaiversen', repo: 'mcp-demo', title: 'mcp pr', head: 'mcp-head', base: 'main', body: 'pr body' });
  const prJson = pr.toolResult?.structuredContent as any;
  check('create_pull_request number', typeof prJson?.number === 'number', textOf(pr).slice(0, 300));
  const merged = await client.callTool('merge_pull_request', { owner: 'adaiversen', repo: 'mcp-demo', pull_number: prJson.number });
  const mergedJson = merged.toolResult?.structuredContent as any;
  check('merge_pull_request merged', mergedJson?.merged === true && typeof mergedJson?.sha === 'string', textOf(merged).slice(0, 200));
  const restPr = await rest('GET', `/api/v3/repos/adaiversen/mcp-demo/pulls/${prJson.number}`);
  check('merged pr visible via REST', restPr.json.merged === true);

  // Unknown tool: JSON-RPC error, never HTTP 500.
  const unknown = await client.callTool('no_such_tool', {});
  check('unknown tool -32601', unknown.error?.code === -32601, JSON.stringify(unknown.error));

  // Missing required arguments: -32602 or isError.
  const missing = await client.callTool('create_issue', {});
  check('missing args -32602 or isError', missing.error?.code === -32602 || missing.toolError === true, JSON.stringify(missing.error ?? missing.toolResult));

  // Domain error (missing repo) is an isError result, not a throw.
  const notFound = await client.callTool('get_repo', { owner: 'adaiversen', repo: 'missing' });
  check('missing repo isError', notFound.toolError === true, textOf(notFound).slice(0, 120));

  // Concurrent calls keep their own ids and answers.
  const [c1, c2] = await Promise.all([
    client.callTool('get_repo', { owner: 'adaiversen', repo: 'mcp-demo' }),
    client.callTool('list_issues', { owner: 'adaiversen', repo: 'mcp-demo', state: 'open' }),
  ]);
  check('concurrent calls distinct', textOf(c1).includes('mcp-demo') && textOf(c2).includes('mcp issue'));

  // Unauthenticated: HTTP 401.
  {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    check('mcp unauthenticated 401', res.status === 401, `status ${res.status}`);
  }

  // Malformed body: HTTP 400 with -32700.
  {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: auth, body: '{not json' });
    const body = await res.json().catch(() => null);
    check('mcp malformed body 400 -32700', res.status === 400 && body?.error?.code === -32700, `status ${res.status} ${JSON.stringify(body)}`);
  }

  // Unknown method: -32601.
  {
    const outcome = (await client.request('no/such/method', {})) as unknown as { error?: { code?: number } };
    check('unknown method -32601', outcome.error?.code === -32601, JSON.stringify(outcome.error));
  }

  // Legacy initialize still works.
  {
    const legacy = new McpClient({ baseUrl: BASE, token: TOKEN });
    const outcome = await legacy.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
    const result = outcome.result as any;
    check('legacy initialize echoes revision', result?.protocolVersion === '2025-06-18' && result?.serverInfo?.name === 'gitforge', JSON.stringify(result));
    const notif = await fetch(`${BASE}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    check('notifications/initialized 202', notif.status === 202, `status ${notif.status}`);
  }

  await client.close();
} catch (err: unknown) {
  console.log('UNCAUGHT', err instanceof Error ? err.stack ?? err.message : String(err));
  failures += 1;
}

console.log(failures === 0 ? 'ALL MCP CHECKS PASSED' : `${failures} MCP CHECKS FAILED`);
server.close();
process.exit(failures === 0 ? 0 : 1);

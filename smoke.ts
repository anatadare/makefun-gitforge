// Smoke test: boot the forge on a local port and exercise every surface with
// plain fetch calls. Run with the token set on the command line:
//   MAKEFUN_SHOP_TOKEN=shpat_test... MAKEFUN_TRIAL_NOW=2026-03-15T12:00:00Z \
//     MAKEFUN_TRIAL_SEED=12345 node --experimental-strip-types smoke.ts
import { createApp } from './app.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'shpat_testtoken0123456789abcdef0123456789abcdef';

const server = createApp();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address() as { port: number };
const BASE = `http://127.0.0.1:${address.port}`;
console.log('listening on', BASE);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...auth, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const j = (v: unknown): Record<string, any> => v as Record<string, any>;

// health + root + meta
let r = await call('GET', '/healthz', undefined, {});
check('healthz 200', r.status === 200);
r = await call('GET', '/api/v3/', undefined, {});
check('root 200 + scopes', r.status === 200 && r.headers.get('x-oauth-scopes') === 'repo, read:org');
r = await call('GET', '/api/v3/meta', undefined, {});
check('meta installed_version', r.status === 200 && typeof j(r.json).installed_version === 'string');

// auth
{
  const res = await fetch(`${BASE}/api/v3/user`);
  check('user without token 401', res.status === 401);
}
r = await call('GET', '/api/v3/user');
check('user login adaiversen', r.status === 200 && j(r.json).login === 'adaiversen', JSON.stringify(r.json));

// repos
r = await call('POST', '/api/v3/user/repos', { name: 'demo', private: false, description: 'demo repo' });
check('create repo 201', r.status === 201 && j(r.json).name === 'demo', r.text.slice(0, 200));
r = await call('POST', '/api/v3/user/repos', { name: 'demo' });
check('duplicate repo 422 already exists', r.status === 422 && /already exists/i.test(j(r.json).message ?? ''));
r = await call('GET', '/api/v3/repos/adaiversen/demo');
check('get repo 200', r.status === 200 && j(r.json).full_name === 'adaiversen/demo');
r = await call('GET', '/api/v3/repos/olgabauer/demo');
check('foreign owner 404', r.status === 404);
r = await call('PATCH', '/api/v3/repos/adaiversen/demo', { description: 'updated' });
check('patch repo description', r.status === 200 && j(r.json).description === 'updated');
r = await call('GET', '/api/v3/user/repos?per_page=10');
check('list repos + request id', r.status === 200 && Array.isArray(r.json) && (r.json as unknown[]).length === 1 && (r.headers.get('x-github-request-id') ?? '').length > 0);

// contents (creates the first commit)
const hello = Buffer.from('hello world\n').toString('base64');
r = await call('PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', { message: 'add readme', content: hello });
check('put contents 201', r.status === 201 && j(r.json).content?.sha?.length === 40, r.text.slice(0, 200));
const blobSha = j(r.json).content?.sha as string;
const commitSha = j(r.json).commit?.sha as string;
r = await call('GET', '/api/v3/repos/adaiversen/demo/contents/README.md');
check('get contents file', r.status === 200 && j(r.json).content === hello && j(r.json).sha === blobSha);
r = await call('GET', '/api/v3/repos/adaiversen/demo/contents/');
check('get contents root dir', r.status === 200 && Array.isArray(r.json) && (r.json as any[])[0]?.name === 'README.md');
r = await call('GET', '/api/v3/repos/adaiversen/demo/contents/nope.txt');
check('get contents missing 404', r.status === 404);
r = await call('PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', { message: 'stale', content: hello, sha: '0'.repeat(40) });
check('put contents stale sha 409', r.status === 409);
const hello2 = Buffer.from('hello world v2\n').toString('base64');
r = await call('PUT', '/api/v3/repos/adaiversen/demo/contents/README.md', { message: 'update', content: hello2, sha: blobSha });
check('put contents update 200', r.status === 200);

// branches + commits + refs
r = await call('GET', '/api/v3/repos/adaiversen/demo/branches');
check('list branches has main', r.status === 200 && (r.json as any[]).some((b: any) => b.name === 'main'));
r = await call('GET', '/api/v3/repos/adaiversen/demo/commits');
check('list commits 2', r.status === 200 && (r.json as unknown[]).length === 2 && j((r.json as any[])[0]).commit.message.includes('update'), r.text.slice(0, 300));
r = await call('POST', '/api/v3/repos/adaiversen/demo/git/refs', { ref: 'refs/heads/feature', sha: commitSha });
check('create ref 201', r.status === 201 && j(r.json).ref === 'refs/heads/feature');
r = await call('GET', '/api/v3/repos/adaiversen/demo/git/refs/heads/feature');
check('get ref 200', r.status === 200 && j(r.json).object.sha === commitSha);
r = await call('GET', '/api/v3/repos/adaiversen/demo/branches/feature');
check('get branch feature', r.status === 200 && j(r.json).commit.sha === commitSha);

// labels + issues
r = await call('POST', '/api/v3/repos/adaiversen/demo/labels', { name: 'bug', color: 'ff0000' });
check('create label 201', r.status === 201 && j(r.json).name === 'bug');
r = await call('POST', '/api/v3/repos/adaiversen/demo/issues', { title: 'first issue', body: 'body text', labels: ['bug'] });
check('create issue 201', r.status === 201 && j(r.json).number === 1 && j(r.json).state === 'open', r.text.slice(0, 200));
r = await call('POST', '/api/v3/repos/adaiversen/demo/issues', { title: 'bad label', labels: ['nope'] });
check('issue unknown label 422', r.status === 422);
r = await call('GET', '/api/v3/repos/adaiversen/demo/issues?state=open&sort=created&direction=asc');
check('list issues', r.status === 200 && (r.json as unknown[]).length === 1);
r = await call('POST', '/api/v3/repos/adaiversen/demo/issues/1/comments', { body: 'a comment' });
check('create comment 201', r.status === 201 && j(r.json).id >= 1);
r = await call('GET', '/api/v3/repos/adaiversen/demo/issues/1/comments');
check('list comments', r.status === 200 && (r.json as unknown[]).length === 1);
r = await call('PATCH', '/api/v3/repos/adaiversen/demo/issues/1', { state: 'closed' });
check('close issue', r.status === 200 && j(r.json).state === 'closed');
r = await call('GET', '/api/v3/repos/adaiversen/demo/issues?state=open');
check('closed issue hidden from open list', r.status === 200 && (r.json as unknown[]).length === 0);

// pulls: branch feature is at commitSha (README v1); main is at v2. Make a
// change on feature via contents, then open a PR feature -> main.
const feat = Buffer.from('feature file\n').toString('base64');
r = await call('PUT', '/api/v3/repos/adaiversen/demo/contents/feat.txt', { message: 'add feat', content: feat, branch: 'feature' });
check('contents on feature branch', r.status === 201, r.text.slice(0, 200));
r = await call('POST', '/api/v3/repos/adaiversen/demo/pulls', { title: 'add feat', head: 'feature', base: 'main', body: 'pr body' });
check('create pull 201', r.status === 201 && j(r.json).number === 2 && j(r.json).state === 'open', r.text.slice(0, 300));
const prNumber = j(r.json).number as number;
r = await call('GET', `/api/v3/repos/adaiversen/demo/pulls/${prNumber}/files`);
check('pull files added feat.txt', r.status === 200 && (r.json as any[]).some((f: any) => f.filename === 'feat.txt' && f.status === 'added' && f.additions >= 1), r.text.slice(0, 300));
r = await call('PUT', `/api/v3/repos/adaiversen/demo/pulls/${prNumber}/merge`, { merge_method: 'squash' });
check('merge pull 200', r.status === 200 && j(r.json).merged === true && j(r.json).sha?.length === 40, r.text.slice(0, 200));
r = await call('GET', `/api/v3/repos/adaiversen/demo/pulls/${prNumber}`);
check('pull merged state', r.status === 200 && j(r.json).merged === true && j(r.json).state === 'closed' && typeof j(r.json).merged_at === 'string');
r = await call('GET', '/api/v3/repos/adaiversen/demo/contents/feat.txt?ref=main');
check('merged content on main', r.status === 200 && j(r.json).content === feat);

// graphql
r = await call('POST', '/api/graphql', { query: 'query { viewer { login } }' });
check('graphql viewer', r.status === 200 && j(j(r.json).data).viewer.login === 'adaiversen', r.text.slice(0, 200));
r = await call('POST', '/api/graphql', { query: 'query { repository(owner: "adaiversen", name: "demo") { name nameWithOwner defaultBranchRef { name } viewerPermission hasIssuesEnabled } }' });
check('graphql repository', r.status === 200 && j(j(j(r.json).data).repository).nameWithOwner === 'adaiversen/demo', r.text.slice(0, 300));
r = await call('POST', '/api/graphql', { query: 'query { viewer { login noSuchFieldOnViewer } }' });
check('graphql invalid field 200 + errors', r.status === 200 && Array.isArray(j(r.json).errors) && (j(r.json).errors as any[]).some((e: any) => e.message.includes('noSuchFieldOnViewer')), r.text.slice(0, 200));
r = await call('POST', '/api/graphql', { query: 'query { repository(owner: "adaiversen", name: "missing") { name } }' });
check('graphql unknown repo null', r.status === 200 && j(j(r.json).data).repository === null && !j(r.json).errors);
r = await call('POST', '/api/graphql', { query: 'query { __type(name: "Issue") { fields { name } } }' });
{
  const fields = ((j(j(r.json).data).__type as any).fields as any[]).map((f: any) => f.name);
  check('graphql __type Issue fields', ['id', 'number', 'title', 'state', 'body'].every((f) => fields.includes(f)), fields.join(','));
}

// mcp
r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
check('mcp discover', r.status === 200 && (j(j(r.json).result).supportedVersions as any[]).includes('2026-07-28'), r.text.slice(0, 200));
r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 'x', method: 'tools/list' });
{
  const tools = (j(j(r.json).result).tools as any[]).map((t: any) => t.name);
  check('mcp tools/list has six', ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((t) => tools.includes(t)), tools.join(','));
}
r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo' } } });
check('mcp create_repo', r.status === 200 && j(j(j(r.json).result).structuredContent).full_name === 'adaiversen/mcp-repo', r.text.slice(0, 300));
r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
check('mcp unknown tool -32601', r.status === 200 && j(j(r.json).error).code === -32601);
r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_issue', arguments: {} } });
check('mcp missing args -32602', r.status === 200 && j(j(r.json).error).code === -32602, r.text.slice(0, 200));

// protocol errors
{
  const res = await fetch(`${BASE}/api/v3/user/repos`, { method: 'POST', headers: auth, body: '{"name":' });
  check('malformed json 400', res.status === 400);
}
r = await call('GET', '/api/v3/nope');
check('unknown route 404 json', r.status === 404 && typeof j(r.json).message === 'string');

// delete repo
r = await call('DELETE', '/api/v3/repos/adaiversen/demo');
check('delete repo 204', r.status === 204);
r = await call('GET', '/api/v3/repos/adaiversen/demo');
check('deleted repo 404', r.status === 404);

console.log(failures === 0 ? 'ALL SMOKE CHECKS PASSED' : `${failures} SMOKE CHECKS FAILED`);
server.close();
process.exit(failures === 0 ? 0 : 1);

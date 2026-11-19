// GraphQL conformance test: run the suite's 18 documents verbatim against a
// fixture repo. Run: MAKEFUN_SHOP_TOKEN=... node --experimental-strip-types graphql-test.ts
import { createApp } from './app.ts';

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
async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/api/graphql`, { method: 'POST', headers: auth, body: JSON.stringify({ query, variables }) });
  return res.json();
}
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

// ---- fixture: repo with commits, a branch, 4 issues (1 closed), 1 PR ----
await rest('POST', '/api/v3/user/repos', { name: 'gql-demo' });
const first = await rest('PUT', '/api/v3/repos/adaiversen/gql-demo/contents/base.txt', { message: 'base', content: b64('base\n') });
const baseSha = first.json.commit.sha as string;
await rest('POST', '/api/v3/repos/adaiversen/gql-demo/git/refs', { ref: 'refs/heads/feature-x', sha: baseSha });
await rest('PUT', '/api/v3/repos/adaiversen/gql-demo/contents/feat.txt', { message: 'feat', content: b64('feat\n'), branch: 'feature-x' });
await rest('POST', '/api/v3/repos/adaiversen/gql-demo/git/refs', { ref: 'refs/heads/feature-y', sha: baseSha });
await rest('PUT', '/api/v3/repos/adaiversen/gql-demo/contents/feat2.txt', { message: 'feat2', content: b64('feat2\n'), branch: 'feature-y' });
const issueNumbers: number[] = [];
for (let i = 1; i <= 4; i += 1) {
  const created = await rest('POST', '/api/v3/repos/adaiversen/gql-demo/issues', { title: `issue ${i}`, body: `body ${i}` });
  issueNumbers.push(created.json.number as number);
}
await rest('PATCH', `/api/v3/repos/adaiversen/gql-demo/issues/${issueNumbers[3]}`, { state: 'closed' });
const pr = await rest('POST', '/api/v3/repos/adaiversen/gql-demo/pulls', { title: 'pr one', head: 'feature-x', base: 'main', body: 'pr body' });
const prNumber = pr.json.number as number;

// pages repo with 7 issues
await rest('POST', '/api/v3/user/repos', { name: 'gql-pages' });
for (let i = 1; i <= 7; i += 1) {
  await rest('POST', '/api/v3/repos/adaiversen/gql-pages/issues', { title: `page issue ${i}` });
}

const OWNER = 'adaiversen';
const NAME = 'gql-demo';

try {
  // 1. viewer login
  let r = await gql(`query ViewerLogin { viewer { login } }`);
  check('viewer login', r.data?.viewer?.login === 'adaiversen' && !r.errors, JSON.stringify(r));

  // 2. repository fields
  r = await gql(`query RepositoryFields($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled
    } }`, { owner: OWNER, name: NAME });
  const repo = r.data?.repository;
  check('repository fields', repo?.name === NAME && repo?.owner?.login === OWNER && repo?.defaultBranchRef?.name === 'main' && repo?.viewerPermission === 'ADMIN' && repo?.hasIssuesEnabled === true && typeof repo?.id === 'string' && typeof repo?.databaseId === 'number' && !r.errors, JSON.stringify(r));
  const repoId = repo?.id as string;

  // 3. issue __type fields
  r = await gql(`query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }`);
  {
    const fields = (r.data?.Issue?.fields as any[]).map((f: any) => f.name);
    check('__type Issue fields', ['id', 'number', 'title', 'state', 'body'].every((f) => fields.includes(f)) && !r.errors, fields.join(','));
  }

  // 4. PR + Repository __type fields
  r = await gql(`query PullRequestAndRepositoryFields {
    PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } }
    Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } } }`);
  {
    const prFields = (r.data?.PullRequest?.fields as any[]).map((f: any) => f.name);
    const repoFields = (r.data?.Repository?.fields as any[]).map((f: any) => f.name);
    check('__type PullRequest fields', ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((f) => prFields.includes(f)), prFields.join(','));
    check('__type Repository fields', ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((f) => repoFields.includes(f)), repoFields.join(','));
  }

  // 5. SearchType enum values
  r = await gql(`query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }`);
  {
    const values = (r.data?.SearchType?.enumValues as any[]).map((v: any) => v.name);
    check('SearchType enum includes ISSUE', values.includes('ISSUE') && !r.errors, values.join(','));
  }

  // 6. open issues, DESC
  r = await gql(`query OpenIssues($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { number title state id } } } }`, { owner: OWNER, name: NAME, first: 10 });
  {
    const nodes = r.data?.repository?.issues?.nodes as any[];
    const numbers = nodes.map((n: any) => n.number);
    check('open issues desc, closed excluded', nodes.length === 3 && nodes.every((n: any) => n.state === 'OPEN') && numbers[0] > numbers[1] && numbers[1] > numbers[2] && !numbers.includes(issueNumbers[3]) && !r.errors, JSON.stringify(nodes));
  }

  // 7. issue by number
  r = await gql(`query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { issue(number: $number) { number title state id body } } }`,
    { owner: OWNER, name: NAME, number: issueNumbers[0] });
  check('issue by number', r.data?.repository?.issue?.title === 'issue 1' && r.data?.repository?.issue?.state === 'OPEN' && r.data?.repository?.issue?.body === 'body 1' && !r.errors, JSON.stringify(r));

  // 8. create issue
  r = await gql(`mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }`,
    { input: { repositoryId: repoId, title: 'gql issue', body: 'gql body' } });
  const newIssueNumber = r.data?.createIssue?.issue?.number as number;
  const newIssueId = r.data?.createIssue?.issue?.id as string;
  check('create issue mutation', typeof newIssueNumber === 'number' && typeof newIssueId === 'string' && !r.errors, JSON.stringify(r));
  const restIssue = await rest('GET', `/api/v3/repos/adaiversen/gql-demo/issues/${newIssueNumber}`);
  check('created issue visible via REST', restIssue.status === 200 && restIssue.json.title === 'gql issue');

  // 9. close issue
  r = await gql(`mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }`,
    { input: { issueId: newIssueId } });
  check('close issue mutation', r.data?.closeIssue?.issue?.state === 'CLOSED' && r.data?.closeIssue?.issue?.number === newIssueNumber && !r.errors, JSON.stringify(r));

  // 10. pull requests list
  r = await gql(`query PullRequests($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) { pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } } } }`,
    { owner: OWNER, name: NAME, first: 10 });
  {
    const nodes = r.data?.repository?.pullRequests?.nodes as any[];
    check('pull requests list', nodes.length === 1 && nodes[0].number === prNumber && nodes[0].headRefName === 'feature-x' && nodes[0].baseRefName === 'main' && nodes[0].state === 'OPEN' && ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(nodes[0].mergeable) && !r.errors, JSON.stringify(nodes));
  }

  // 11. pull request files
  r = await gql(`query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { number files(first: 10) { nodes { path } } } } }`,
    { owner: OWNER, name: NAME, number: prNumber });
  {
    const paths = (r.data?.repository?.pullRequest?.files?.nodes as any[]).map((n: any) => n.path);
    check('pull request files', paths.includes('feat.txt') && !r.errors, JSON.stringify(paths));
  }

  // 12. pull request id
  r = await gql(`query PullRequestId($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { id number } } }`,
    { owner: OWNER, name: NAME, number: prNumber });
  const prId = r.data?.repository?.pullRequest?.id as string;
  check('pull request id', typeof prId === 'string' && prId !== String(prNumber) && !r.errors, JSON.stringify(r));

  // 13. create pull request
  r = await gql(`mutation PullRequestCreate($input: CreatePullRequestInput!) {
    createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }`,
    { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'feature-y', title: 'gql pr' } });
  const newPrNumber = r.data?.createPullRequest?.pullRequest?.number as number;
  const newPrId = r.data?.createPullRequest?.pullRequest?.id as string;
  check('create pull request mutation', typeof newPrNumber === 'number' && r.data?.createPullRequest?.pullRequest?.state === 'OPEN' && r.data?.createPullRequest?.pullRequest?.headRefName === 'feature-y' && !r.errors, JSON.stringify(r));

  // 14. merge pull request
  r = await gql(`mutation MergePullRequest($input: MergePullRequestInput!) {
    mergePullRequest(input: $input) { pullRequest { number merged state } } }`,
    { input: { pullRequestId: newPrId, mergeMethod: 'SQUASH' } });
  check('merge pull request mutation', r.data?.mergePullRequest?.pullRequest?.merged === true && r.data?.mergePullRequest?.pullRequest?.state === 'MERGED' && !r.errors, JSON.stringify(r));
  const restPr = await rest('GET', `/api/v3/repos/adaiversen/gql-demo/pulls/${newPrNumber}`);
  check('merged pr visible via REST', restPr.json.merged === true && restPr.json.state === 'closed');

  // 15. add comment
  r = await gql(`mutation AddComment($input: AddCommentInput!) {
    addComment(input: $input) { commentEdge { node { id body } } } }`,
    { input: { subjectId: newIssueId, body: 'gql comment' } });
  check('add comment mutation', r.data?.addComment?.commentEdge?.node?.body === 'gql comment' && typeof r.data?.addComment?.commentEdge?.node?.id === 'string' && !r.errors, JSON.stringify(r));
  const comments = await rest('GET', `/api/v3/repos/adaiversen/gql-demo/issues/${newIssueNumber}/comments`);
  check('comment visible via REST', (comments.json as any[]).some((c: any) => c.body === 'gql comment'));

  // 16. invalid field
  r = await gql(`query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }`);
  check('invalid field errors name it', Array.isArray(r.errors) && r.errors.some((e: any) => e.message.includes('noSuchFieldOnViewer')), JSON.stringify(r));

  // 17. node repository
  r = await gql(`query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }`, { id: repoId });
  check('node repository fragment', r.data?.node?.name === NAME && r.data?.node?.nameWithOwner === 'adaiversen/gql-demo' && !r.errors, JSON.stringify(r));

  // 18. issues pagination (7 issues, page size 5)
  r = await gql(`query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }`,
    { owner: OWNER, name: 'gql-pages', first: 5, after: null });
  {
    const nodes = r.data?.repository?.issues?.nodes as any[];
    const pageInfo = r.data?.repository?.issues?.pageInfo;
    check('issues page 1', nodes.length === 5 && pageInfo.hasNextPage === true && typeof pageInfo.endCursor === 'string' && pageInfo.endCursor.length > 0 && !r.errors, JSON.stringify(r.data?.repository?.issues));
    const r2 = await gql(`query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
      repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } } }`,
      { owner: OWNER, name: 'gql-pages', first: 5, after: pageInfo.endCursor });
    const nodes2 = r2.data?.repository?.issues?.nodes as any[];
    const pageInfo2 = r2.data?.repository?.issues?.pageInfo;
    const all = [...nodes.map((n: any) => n.number), ...nodes2.map((n: any) => n.number)];
    check('issues page 2 completes 7, no dupes', nodes2.length === 2 && pageInfo2.hasNextPage === false && new Set(all).size === 7 && !r2.errors, JSON.stringify(r2.data?.repository?.issues));
  }

  // batching
  {
    const res = await fetch(`${BASE}/api/graphql`, { method: 'POST', headers: auth, body: JSON.stringify([{ query: 'query { viewer { login } }' }, { query: 'query { viewer { login } }' }]) });
    const batch = await res.json();
    check('graphql batch array', Array.isArray(batch) && batch.length === 2 && batch[0].data?.viewer?.login === 'adaiversen');
  }
} catch (err: unknown) {
  console.log('UNCAUGHT', err instanceof Error ? err.stack ?? err.message : String(err));
  failures += 1;
}

console.log(failures === 0 ? 'ALL GRAPHQL CHECKS PASSED' : `${failures} GRAPHQL CHECKS FAILED`);
server.close();
process.exit(failures === 0 ? 0 : 1);

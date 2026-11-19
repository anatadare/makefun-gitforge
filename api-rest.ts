// REST v3: repos, branches, commits, refs, contents, labels, issues, pulls.
// Every reply is JSON with an X-GitHub-Request-Id header; errors carry a
// string `message`. A repo under any owner but the viewer is a 404, never a 403.

import { VIEWER_ID, VIEWER_LOGIN, trialNowIso } from './determinism.ts';
import {
  ApiError,
  asBoolean,
  asPositiveInt,
  asString,
  asStringArray,
  jsonBody,
  paginate,
  requestIdHeader,
  sendEmpty,
  sendJson,
  type ApiContext,
} from './http-util.ts';
import {
  commentJson,
  globalId,
  issueJson,
  pullJson,
  repoJson,
  type IssueState,
  type RepoState,
} from './store.ts';

function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message);
}

/** The repo a route names, or a 404 (wrong owner and missing repo alike). */
function requireRepo(ctx: ApiContext, owner: string, name: string): RepoState {
  if (owner !== VIEWER_LOGIN) throw notFound();
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) throw notFound();
  return repo;
}

function answer(ctx: ApiContext, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx.res, status, body, { ...requestIdHeader(ctx), ...extra });
}

/** A commit in the REST shape, from a stored commit object. */
function commitJson(ctx: ApiContext, repo: RepoState, oid: string): Record<string, unknown> {
  const parsed = ctx.store.parseCommitOf(repo, oid);
  // GitHub answers the message without its trailing newline.
  const message = (parsed?.message ?? '').replace(/\n+$/, '');
  const authorLine = parsed?.author ?? '';
  const committerLine = parsed?.committer ?? '';
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: '', email: '', date: trialNowIso() };
    return {
      name: match[1],
      email: match[2],
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  const author = parseIdentity(authorLine);
  const committer = parseIdentity(committerLine);
  return {
    sha: oid,
    commit: {
      message,
      author,
      committer,
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

// ------------------------------------------------------------------ repos

function createRepo(ctx: ApiContext): void {
  const body = jsonBody(ctx);
  const name = asString(body.name);
  if (name === undefined || name === '') throw new ApiError(422, 'Validation Failed: name is required');
  const isPrivate = asBoolean(body.private) ?? false;
  const description = asString(body.description) ?? '';
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, isPrivate, description);
  if (repo === null) throw new ApiError(422, `Repository ${name} already exists`);
  answer(ctx, 201, repoJson(repo, ctx.baseUrl));
}

function listViewerRepos(ctx: ApiContext): void {
  const repos = ctx.store.listRepos(VIEWER_LOGIN);
  const { items, link } = paginate(ctx, repos);
  answer(ctx, 200, items.map((repo) => repoJson(repo, ctx.baseUrl)), link === null ? {} : { link });
}

function getRepo(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  answer(ctx, 200, repoJson(repo, ctx.baseUrl));
}

function patchRepo(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const body = jsonBody(ctx);
  const description = asString(body.description);
  if (description !== undefined) repo.description = description;
  const isPrivate = asBoolean(body.private);
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  answer(ctx, 200, repoJson(repo, ctx.baseUrl));
}

function deleteRepo(ctx: ApiContext, owner: string, name: string): void {
  if (owner !== VIEWER_LOGIN) throw notFound();
  const deleted = ctx.store.deleteRepo(owner, name);
  if (!deleted) throw notFound();
  sendEmpty(ctx.res, 204);
}

// --------------------------------------------------------------- branches

function branchJson(repo: RepoState, name: string, sha: string, baseUrl: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function listBranches(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const branches = ctx.store
    .listRefs(repo)
    .filter((ref) => ref.name.startsWith('refs/heads/'))
    .map((ref) => branchJson(repo, ref.name.slice('refs/heads/'.length), ref.oid, ctx.baseUrl));
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  answer(ctx, 200, branches);
}

function getBranch(ctx: ApiContext, owner: string, name: string, branch: string): void {
  const repo = requireRepo(ctx, owner, name);
  const sha = ctx.store.getRef(repo, `refs/heads/${branch}`);
  if (sha === undefined) throw notFound('Branch not found');
  answer(ctx, 200, branchJson(repo, branch, sha, ctx.baseUrl));
}

// ---------------------------------------------------------------- commits

function listCommits(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = ctx.store.resolveRef(repo, ref);
  if (tip === undefined) {
    // An unborn default branch lists no commits; an unknown ref is a 404.
    if (ref === repo.defaultBranch && ctx.store.defaultBranchTip(repo) === undefined) {
      answer(ctx, 200, []);
      return;
    }
    throw notFound('No commit found for SHA');
  }
  const commits = ctx.store.listCommits(repo, tip);
  answer(ctx, 200, commits.map((oid) => commitJson(ctx, repo, oid)));
}

// ------------------------------------------------------------------- refs

function createRef(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const body = jsonBody(ctx);
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (ref === undefined || !ref.startsWith('refs/')) throw new ApiError(422, 'Validation Failed: ref is required');
  if (sha === undefined || !ctx.store.hasObject(repo, sha)) {
    throw new ApiError(422, 'Validation Failed: sha does not exist');
  }
  if (ctx.store.getRef(repo, ref) !== undefined) throw new ApiError(422, 'Reference already exists');
  ctx.store.setRef(repo, ref, sha);
  answer(ctx, 201, {
    ref,
    node_id: globalId('Ref', repo.id, ref),
    object: { sha, type: ctx.store.getObject(repo, sha)?.type ?? 'commit' },
    url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/git/refs/${ref.slice('refs/'.length)}`,
  });
}

function getRef(ctx: ApiContext, owner: string, name: string, refPath: string): void {
  const repo = requireRepo(ctx, owner, name);
  const ref = `refs/${refPath}`;
  const sha = ctx.store.getRef(repo, ref);
  if (sha === undefined) throw notFound('Reference not found');
  answer(ctx, 200, {
    ref,
    node_id: globalId('Ref', repo.id, ref),
    object: { sha, type: ctx.store.getObject(repo, sha)?.type ?? 'commit' },
    url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/git/refs/${refPath}`,
  });
}

// --------------------------------------------------------------- contents

function contentsFileJson(
  repo: RepoState,
  path: string,
  blobOid: string,
  data: Buffer,
  baseUrl: string,
): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
  };
}

function getContents(ctx: ApiContext, owner: string, name: string, path: string): void {
  const repo = requireRepo(ctx, owner, name);
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = ctx.store.resolveRef(repo, ref);
  if (tip === undefined) throw notFound('Not Found');
  const commit = ctx.store.parseCommitOf(repo, tip);
  if (commit === undefined) throw notFound('Not Found');
  const segments = path === '' ? [] : path.split('/');
  const blobOid = segments.length === 0 ? null : ctx.store.blobAtPath(repo, commit.tree, segments);
  if (blobOid !== null) {
    const blob = ctx.store.getObject(repo, blobOid);
    if (blob === undefined) throw notFound('Not Found');
    answer(ctx, 200, contentsFileJson(repo, path, blobOid, blob.data, ctx.baseUrl));
    return;
  }
  const dirOid = ctx.store.treeAtPath(repo, commit.tree, segments);
  if (dirOid === null) throw notFound('Not Found');
  const entries = ctx.store.parseTreeOf(repo, dirOid) ?? [];
  const listing = entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (ctx.store.getObject(repo, entry.oid)?.data.length ?? 0),
    url: `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/contents/${path === '' ? entry.name : `${path}/${entry.name}`}`,
  }));
  listing.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  answer(ctx, 200, listing);
}

function putContents(ctx: ApiContext, owner: string, name: string, path: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (path === '') throw new ApiError(422, 'Validation Failed: path is required');
  const body = jsonBody(ctx);
  const message = asString(body.message);
  const content = asString(body.content);
  if (message === undefined || message === '') throw new ApiError(422, 'Validation Failed: message is required');
  if (content === undefined) throw new ApiError(422, 'Validation Failed: content is required');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const sha = asString(body.sha);
  const tip = ctx.store.getRef(repo, `refs/heads/${branch}`);
  if (tip === undefined && branch !== repo.defaultBranch) {
    throw new ApiError(422, `Validation Failed: branch ${branch} does not exist`);
  }
  const parentCommit = tip === undefined ? undefined : ctx.store.parseCommitOf(repo, tip);
  const parentTree = parentCommit?.tree ?? null;
  const segments = path.split('/');
  const existing = parentTree === null ? null : ctx.store.blobAtPath(repo, parentTree, segments);
  if (existing !== null) {
    if (sha === undefined) throw new ApiError(422, 'Validation Failed: sha is required to update a file');
    if (sha !== existing) throw new ApiError(409, 'Conflict: the file has changed since the given sha');
  }
  const data = Buffer.from(content, 'base64');
  const blobOid = ctx.store.putObject(repo, 'blob', data);
  const treeOid = ctx.store.treeWithPath(repo, parentTree, segments, blobOid);
  const commitOid = ctx.store.createCommit(repo, treeOid, tip === undefined ? [] : [tip], `${message}\n`);
  ctx.store.setRef(repo, `refs/heads/${branch}`, commitOid);
  answer(ctx, existing === null ? 201 : 200, {
    content: contentsFileJson(repo, path, blobOid, data, ctx.baseUrl),
    commit: commitJson(ctx, repo, commitOid),
  });
}

function deleteContents(ctx: ApiContext, owner: string, name: string, path: string): void {
  const repo = requireRepo(ctx, owner, name);
  if (path === '') throw new ApiError(422, 'Validation Failed: path is required');
  const body = jsonBody(ctx);
  const message = asString(body.message);
  const sha = asString(body.sha);
  if (message === undefined || message === '') throw new ApiError(422, 'Validation Failed: message is required');
  if (sha === undefined) throw new ApiError(422, 'Validation Failed: sha is required');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const tip = ctx.store.getRef(repo, `refs/heads/${branch}`);
  if (tip === undefined) throw notFound('Not Found');
  const commit = ctx.store.parseCommitOf(repo, tip);
  if (commit === undefined) throw notFound('Not Found');
  const segments = path.split('/');
  const existing = ctx.store.blobAtPath(repo, commit.tree, segments);
  if (existing === null) throw notFound('Not Found');
  if (existing !== sha) throw new ApiError(409, 'Conflict: the file has changed since the given sha');
  const treeOid = ctx.store.treeWithoutPath(repo, commit.tree, segments);
  if (treeOid === null) throw notFound('Not Found');
  const commitOid = ctx.store.createCommit(repo, treeOid, [tip], `${message}\n`);
  ctx.store.setRef(repo, `refs/heads/${branch}`, commitOid);
  answer(ctx, 200, { content: null, commit: commitJson(ctx, repo, commitOid) });
}

// ----------------------------------------------------------------- labels

function createLabel(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const body = jsonBody(ctx);
  const labelName = asString(body.name);
  if (labelName === undefined || labelName === '') throw new ApiError(422, 'Validation Failed: name is required');
  const color = asString(body.color) ?? '000000';
  const label = ctx.store.createLabel(repo, labelName, color);
  if (label === null) throw new ApiError(422, `Label ${labelName} already exists`);
  answer(ctx, 201, { name: label.name, color: label.color });
}

function listLabels(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  answer(ctx, 200, ctx.store.listLabels(repo).map((label) => ({ name: label.name, color: label.color })));
}

// ----------------------------------------------------------------- issues

function requireIssue(ctx: ApiContext, repo: RepoState, number: number): IssueState {
  const issue = ctx.store.getIssue(repo, number);
  if (issue === undefined) throw notFound('Not Found');
  return issue;
}

function createIssue(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const body = jsonBody(ctx);
  const title = asString(body.title);
  if (title === undefined || title === '') throw new ApiError(422, 'Validation Failed: title is required');
  const issueBody = asString(body.body) ?? null;
  const labels = asStringArray(body.labels) ?? [];
  const result = ctx.store.createIssue(repo, title, issueBody, labels);
  if ('error' in result) throw new ApiError(422, result.error);
  answer(ctx, 201, issueJson(repo, result.issue, ctx.baseUrl));
}

function listIssues(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const stateParam = ctx.query.get('state') ?? 'open';
  const state = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
  const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
  const issues = ctx.store.listIssues(repo, state, direction);
  const { items, link } = paginate(ctx, issues);
  answer(ctx, 200, items.map((issue) => issueJson(repo, issue, ctx.baseUrl)), link === null ? {} : { link });
}

function getIssue(ctx: ApiContext, owner: string, name: string, number: number): void {
  const repo = requireRepo(ctx, owner, name);
  const issue = requireIssue(ctx, repo, number);
  answer(ctx, 200, issueJson(repo, issue, ctx.baseUrl));
}

function patchIssue(ctx: ApiContext, owner: string, name: string, number: number): void {
  const repo = requireRepo(ctx, owner, name);
  requireIssue(ctx, repo, number);
  const body = jsonBody(ctx);
  const state = asString(body.state);
  if (state !== undefined && state !== 'open' && state !== 'closed') {
    throw new ApiError(422, 'Validation Failed: state must be open or closed');
  }
  const labels = body.labels === undefined ? undefined : asStringArray(body.labels);
  if (body.labels !== undefined && labels === undefined) {
    throw new ApiError(422, 'Validation Failed: labels must be an array of strings');
  }
  const result = ctx.store.updateIssue(repo, number, {
    state: state as 'open' | 'closed' | undefined,
    title: asString(body.title),
    body: body.body === undefined ? undefined : (asString(body.body) ?? null),
    labels,
  });
  if (result === null) throw notFound('Not Found');
  if ('error' in result) throw new ApiError(422, result.error);
  answer(ctx, 200, issueJson(repo, result.issue, ctx.baseUrl));
}

function createComment(ctx: ApiContext, owner: string, name: string, number: number): void {
  const repo = requireRepo(ctx, owner, name);
  requireIssue(ctx, repo, number);
  const body = jsonBody(ctx);
  const text = asString(body.body);
  if (text === undefined || text === '') throw new ApiError(422, 'Validation Failed: body is required');
  const comment = ctx.store.addComment(repo, number, text);
  if (comment === null) throw notFound('Not Found');
  const issue = ctx.store.getIssue(repo, number) as IssueState;
  answer(ctx, 201, commentJson(repo, issue, comment, ctx.baseUrl));
}

function listComments(ctx: ApiContext, owner: string, name: string, number: number): void {
  const repo = requireRepo(ctx, owner, name);
  const issue = requireIssue(ctx, repo, number);
  answer(ctx, 200, issue.comments.map((comment) => commentJson(repo, issue, comment, ctx.baseUrl)));
}

// ------------------------------------------------------------------ pulls

function createPull(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const body = jsonBody(ctx);
  const title = asString(body.title);
  const head = asString(body.head);
  const base = asString(body.base);
  if (title === undefined || title === '') throw new ApiError(422, 'Validation Failed: title is required');
  if (head === undefined || head === '') throw new ApiError(422, 'Validation Failed: head is required');
  if (base === undefined || base === '') throw new ApiError(422, 'Validation Failed: base is required');
  const result = ctx.store.createPull(repo, title, asString(body.body) ?? null, head, base);
  if ('error' in result) throw new ApiError(result.status, result.error);
  answer(ctx, 201, pullJson(repo, result.pull, ctx.store, ctx.baseUrl));
}

function listPulls(ctx: ApiContext, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const stateParam = ctx.query.get('state') ?? 'open';
  const state = stateParam === 'closed' ? 'closed' : stateParam === 'all' ? 'all' : 'open';
  const pulls = ctx.store.listPulls(repo, state);
  const { items, link } = paginate(ctx, pulls);
  answer(ctx, 200, items.map((pull) => pullJson(repo, pull, ctx.store, ctx.baseUrl)), link === null ? {} : { link });
}

function getPull(ctx: ApiContext, owner: string, name: string, number: number): void {
  const repo = requireRepo(ctx, owner, name);
  const pull = ctx.store.getPull(repo, number);
  if (pull === undefined) throw notFound('Not Found');
  answer(ctx, 200, pullJson(repo, pull, ctx.store, ctx.baseUrl));
}

function listPullFiles(ctx: ApiContext, owner: string, name: string, number: number): void {
  const repo = requireRepo(ctx, owner, name);
  const pull = ctx.store.getPull(repo, number);
  if (pull === undefined) throw notFound('Not Found');
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTree = headTip === undefined ? null : (ctx.store.parseCommitOf(repo, headTip)?.tree ?? null);
  const baseTree = baseTip === undefined ? null : (ctx.store.parseCommitOf(repo, baseTip)?.tree ?? null);
  const files = ctx.store.diffTrees(repo, baseTree, headTree);
  answer(ctx, 200, files);
}

function mergePull(ctx: ApiContext, owner: string, name: string, number: number): void {
  const repo = requireRepo(ctx, owner, name);
  const result = ctx.store.mergePull(repo, number);
  if ('error' in result) throw new ApiError(result.status, result.error);
  answer(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ------------------------------------------------------------------ router

/**
 * Handle a REST v3 request. `segments` starts after /api/v3 (so [] is the API
 * root, which app.ts answers before reaching here). Throws ApiError for the
 * error replies; app.ts renders those as JSON.
 */
export function handleRest(ctx: ApiContext): void {
  const [first, ...rest] = ctx.segments;
  const method = ctx.method;

  if (first === 'meta' && rest.length === 0) {
    if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
    answer(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  if (first === 'user' && rest.length === 0) {
    if (method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
    answer(ctx, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: 'ada iversen',
      email: 'adaiversen@example.invalid',
      type: 'User',
      url: `${ctx.baseUrl}/api/v3/user`,
      html_url: `${ctx.baseUrl}/${VIEWER_LOGIN}`,
    });
    return;
  }

  if (first === 'user' && rest.length === 1 && rest[0] === 'repos') {
    if (method === 'GET') {
      listViewerRepos(ctx);
      return;
    }
    if (method === 'POST') {
      createRepo(ctx);
      return;
    }
    throw new ApiError(405, 'Method Not Allowed');
  }

  if (first === 'repos' && rest.length >= 2) {
    const [owner, name, resource, ...tail] = rest;
    if (resource === undefined) {
      if (method === 'GET') {
        getRepo(ctx, owner, name);
        return;
      }
      if (method === 'PATCH') {
        patchRepo(ctx, owner, name);
        return;
      }
      if (method === 'DELETE') {
        deleteRepo(ctx, owner, name);
        return;
      }
      throw new ApiError(405, 'Method Not Allowed');
    }

    if (resource === 'branches' && method === 'GET') {
      if (tail.length === 0) {
        listBranches(ctx, owner, name);
        return;
      }
      getBranch(ctx, owner, name, tail.join('/'));
      return;
    }

    if (resource === 'commits' && tail.length === 0 && method === 'GET') {
      listCommits(ctx, owner, name);
      return;
    }

    if (resource === 'git' && tail.length >= 1 && tail[0] === 'refs') {
      if (tail.length === 1 && method === 'POST') {
        createRef(ctx, owner, name);
        return;
      }
      if (tail.length > 1 && method === 'GET') {
        getRef(ctx, owner, name, tail.slice(1).join('/'));
        return;
      }
      throw new ApiError(405, 'Method Not Allowed');
    }

    if (resource === 'contents') {
      const path = tail.join('/');
      if (method === 'GET') {
        getContents(ctx, owner, name, path);
        return;
      }
      if (method === 'PUT') {
        putContents(ctx, owner, name, path);
        return;
      }
      if (method === 'DELETE') {
        deleteContents(ctx, owner, name, path);
        return;
      }
      throw new ApiError(405, 'Method Not Allowed');
    }

    if (resource === 'labels') {
      if (tail.length !== 0) throw notFound();
      if (method === 'GET') {
        listLabels(ctx, owner, name);
        return;
      }
      if (method === 'POST') {
        createLabel(ctx, owner, name);
        return;
      }
      throw new ApiError(405, 'Method Not Allowed');
    }

    if (resource === 'issues') {
      if (tail.length === 0) {
        if (method === 'GET') {
          listIssues(ctx, owner, name);
          return;
        }
        if (method === 'POST') {
          createIssue(ctx, owner, name);
          return;
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      const number = asPositiveInt(tail[0]);
      if (number === null) throw notFound();
      if (tail.length === 1) {
        if (method === 'GET') {
          getIssue(ctx, owner, name, number);
          return;
        }
        if (method === 'PATCH') {
          patchIssue(ctx, owner, name, number);
          return;
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      if (tail.length === 2 && tail[1] === 'comments') {
        if (method === 'GET') {
          listComments(ctx, owner, name, number);
          return;
        }
        if (method === 'POST') {
          createComment(ctx, owner, name, number);
          return;
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      throw notFound();
    }

    if (resource === 'pulls') {
      if (tail.length === 0) {
        if (method === 'GET') {
          listPulls(ctx, owner, name);
          return;
        }
        if (method === 'POST') {
          createPull(ctx, owner, name);
          return;
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      const number = asPositiveInt(tail[0]);
      if (number === null) throw notFound();
      if (tail.length === 1) {
        if (method === 'GET') {
          getPull(ctx, owner, name, number);
          return;
        }
        throw new ApiError(405, 'Method Not Allowed');
      }
      if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
        listPullFiles(ctx, owner, name, number);
        return;
      }
      if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
        mergePull(ctx, owner, name, number);
        return;
      }
      throw notFound();
    }
  }

  throw notFound();
}

// The in-memory store: every repo, git object, ref, issue and pull request the
// forge holds lives here, in one process, in Maps. Objects are content
// addressed and immutable, so parsed-commit and parsed-tree caches never go
// stale. All timestamps come from the trial instant; all ordering is explicit.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  trialNowEpochSec,
  trialNowIso,
} from './determinism.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  identityLine,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjectType,
  type ParsedCommit,
  type TreeEntry,
} from './gitpack.ts';

export interface LabelState {
  name: string;
  color: string;
}

export interface CommentState {
  id: number;
  body: string;
  createdSeq: number;
}

export interface IssueState {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentState[];
  createdSeq: number;
  closedAt: string | null;
}

export interface PullState {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreation: string;
  baseShaAtCreation: string;
  createdSeq: number;
}

export interface RepoState {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  insertSeq: Map<string, number>;
  commitCache: Map<string, ParsedCommit>;
  treeCache: Map<string, TreeEntry[]>;
  refs: Map<string, string>;
  /** Cached upload-pack fetch responses, keyed by request params; cleared on any object/ref change. */
  fetchCache: Map<string, Buffer>;
  labels: Map<string, LabelState>;
  issues: Map<number, IssueState>;
  pulls: Map<number, PullState>;
  nextNumber: number;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** A global id: base64 of a typed string, opaque to callers, decodable by us. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id into its kind and parts, or null when it does not parse. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function viewerJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
}

export function repoJson(repo: RepoState, baseUrl: string): Record<string, unknown> {
  const now = trialNowIso();
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: viewerJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: now,
    updated_at: now,
    pushed_at: now,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
  };
}

export function issueJson(repo: RepoState, issue: IssueState, baseUrl: string): Record<string, unknown> {
  const now = trialNowIso();
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: viewerJson(),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    created_at: now,
    updated_at: now,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: RepoState, pull: PullState, store: Store, baseUrl: string): Record<string, unknown> {
  const now = trialNowIso();
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreation;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreation;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: viewerJson(),
    created_at: now,
    updated_at: now,
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? now) : null,
    mergeable: store.pullMergeable(repo, pull) === 'MERGEABLE',
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentJson(repo: RepoState, issue: IssueState, comment: CommentState, baseUrl: string): Record<string, unknown> {
  const now = trialNowIso();
  return {
    id: comment.id,
    node_id: globalId('Comment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: viewerJson(),
    created_at: now,
    updated_at: now,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

/** The number of lines in a blob's content (a trailing newline ends the last line). */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Line-level diff counts between two blobs, via longest common subsequence. */
function diffLineCounts(a: Buffer, b: Buffer): { additions: number; deletions: number } {
  const aLines = a.toString('utf8').split('\n');
  const bLines = b.toString('utf8').split('\n');
  if (aLines.length > 0 && aLines[aLines.length - 1] === '') aLines.pop();
  if (bLines.length > 0 && bLines[bLines.length - 1] === '') bLines.pop();
  if (aLines.length === 0 && bLines.length === 0) return { additions: 0, deletions: 0 };
  // LCS dynamic program over line arrays; files here are small (a few KB).
  const rows = aLines.length + 1;
  const cols = bLines.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = aLines.length - 1; i >= 0; i -= 1) {
    for (let j = bLines.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        aLines[i] === bLines[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  const lcs = table[0];
  return { additions: bLines.length - lcs, deletions: aLines.length - lcs };
}

export class Store {
  private repos = new Map<string, RepoState>();
  private nextRepoId = 1;
  private nextRestId = 1;
  private nextCommentId = 1;
  private nextSeq = 1;

  // ------------------------------------------------------------- repos

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoState | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: RepoState = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq,
      objects: new Map(),
      insertSeq: new Map(),
      commitCache: new Map(),
      treeCache: new Map(),
      refs: new Map(),
      fetchCache: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoState | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): RepoState | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): RepoState[] {
    const out: RepoState[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ------------------------------------------------------------ objects

  /** Store an object (deduplicated); returns its oid. */
  putObject(repo: RepoState, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { oid, type, data });
      repo.insertSeq.set(oid, this.nextSeq);
      this.nextSeq += 1;
      repo.fetchCache.clear();
    }
    return oid;
  }

  putObjects(repo: RepoState, objects: readonly GitObject[]): void {
    let added = false;
    for (const object of objects) {
      if (!repo.objects.has(object.oid)) {
        repo.objects.set(object.oid, object);
        repo.insertSeq.set(object.oid, this.nextSeq);
        this.nextSeq += 1;
        added = true;
      }
    }
    if (added) repo.fetchCache.clear();
  }

  getObject(repo: RepoState, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  hasObject(repo: RepoState, oid: string): boolean {
    return repo.objects.has(oid);
  }

  /** Parse a commit, cached (objects are immutable, so the cache never stales). */
  parseCommitOf(repo: RepoState, oid: string): ParsedCommit | undefined {
    const cached = repo.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return undefined;
    const parsed = parseCommit(object.data);
    repo.commitCache.set(oid, parsed);
    return parsed;
  }

  /** Parse a tree, cached. */
  parseTreeOf(repo: RepoState, oid: string): TreeEntry[] | undefined {
    const cached = repo.treeCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return undefined;
    const parsed = parseTree(object.data);
    repo.treeCache.set(oid, parsed);
    return parsed;
  }

  /** Follow an annotated tag chain to the first non-tag object (or the oid itself). */
  peelToNonTag(repo: RepoState, oid: string): string | undefined {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return undefined;
  }

  // --------------------------------------------------------------- refs

  getRef(repo: RepoState, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: RepoState, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.fetchCache.clear();
  }

  deleteRef(repo: RepoState, ref: string): boolean {
    const deleted = repo.refs.delete(ref);
    if (deleted) repo.fetchCache.clear();
    return deleted;
  }

  /** All refs, sorted by name. */
  listRefs(repo: RepoState): { name: string; oid: string }[] {
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Resolve a branch name, full ref, or raw oid to a commit oid (peeling tags). */
  resolveRef(repo: RepoState, ref: string): string | undefined {
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return this.peelToNonTag(repo, direct);
    const headed = repo.refs.get(`refs/heads/${ref}`);
    if (headed !== undefined) return this.peelToNonTag(repo, headed);
    if (repo.objects.has(ref)) return this.peelToNonTag(repo, ref);
    return undefined;
  }

  defaultBranchTip(repo: RepoState): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  // -------------------------------------------------------------- trees

  /** Flatten a tree (recursively) into path -> {oid, mode} for blob entries. */
  flattenTree(repo: RepoState, treeOid: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (treeOid === null) return out;
    const walk = (oid: string, prefix: string): void => {
      const entries = this.parseTreeOf(repo, oid);
      if (entries === undefined) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path map, creating subtrees as needed. */
  buildTreeFromMap(repo: RepoState, flat: Map<string, { oid: string; mode: string }>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, value] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: buildLevel(childPrefix) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildLevel('');
  }

  /** The blob oid at `segments` in the tree, or null when the path is absent. */
  blobAtPath(repo: RepoState, treeOid: string | null, segments: readonly string[]): string | null {
    if (treeOid === null || segments.length === 0) return null;
    let current: string | null = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      if (current === null) return null;
      const entries = this.parseTreeOf(repo, current);
      if (entries === undefined) return null;
      const entry = entries.find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        return entry.mode === '40000' ? null : entry.oid;
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The tree oid at `segments` (a directory), or null when absent/not a dir. */
  treeAtPath(repo: RepoState, treeOid: string | null, segments: readonly string[]): string | null {
    if (treeOid === null) return null;
    if (segments.length === 0) return treeOid;
    let current: string | null = treeOid;
    for (const segment of segments) {
      if (current === null) return null;
      const entries = this.parseTreeOf(repo, current);
      if (entries === undefined) return null;
      const entry = entries.find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return current;
  }

  /** A tree like `treeOid` but with `segments` set to `blobOid` (creating dirs). */
  treeWithPath(repo: RepoState, treeOid: string | null, segments: readonly string[], blobOid: string): string {
    const head = segments[0];
    const entries = treeOid === null ? [] : (this.parseTreeOf(repo, treeOid) ?? []);
    const kept = entries.filter((entry) => entry.name !== head);
    if (segments.length === 1) {
      kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const child = this.treeWithPath(repo, existing?.oid ?? null, segments.slice(1), blobOid);
      kept.push({ mode: '40000', name: head, oid: child });
    }
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** A tree like `treeOid` but with `segments` removed, or null when absent. */
  treeWithoutPath(repo: RepoState, treeOid: string, segments: readonly string[]): string | null {
    const entries = this.parseTreeOf(repo, treeOid);
    if (entries === undefined) return null;
    const head = segments[0];
    const existing = entries.find((entry) => entry.name === head);
    if (existing === undefined) return null;
    const kept = entries.filter((entry) => entry.name !== head);
    if (segments.length > 1) {
      if (existing.mode !== '40000') return null;
      const child = this.treeWithoutPath(repo, existing.oid, segments.slice(1));
      if (child === null) return null;
      const childEntries = this.parseTreeOf(repo, child);
      if (childEntries !== undefined && childEntries.length > 0) {
        kept.push({ mode: '40000', name: head, oid: child });
      }
      // An emptied directory drops out of the tree entirely.
    }
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  // ------------------------------------------------------------ commits

  /** Create a commit authored by the viewer at the trial instant. */
  createCommit(repo: RepoState, tree: string, parents: readonly string[], message: string): string {
    const identity = identityLine(VIEWER_NAME, VIEWER_EMAIL, trialNowEpochSec());
    const data = buildCommit({ tree, parents, author: identity, committer: identity, message });
    return this.putObject(repo, 'commit', data);
  }

  /** Commits reachable from a tip, newest first (depth-first pre-order). */
  listCommits(repo: RepoState, tipOid: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack = [tipOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.parseCommitOf(repo, oid);
      if (commit === undefined) continue;
      out.push(oid);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
    }
    return out;
  }

  /** Every commit reachable from a tip, including the tip. */
  ancestors(repo: RepoState, tipOid: string): Set<string> {
    return new Set(this.listCommits(repo, tipOid));
  }

  /** Whether `ancestor` is reachable from `descendant` (or equal to it). */
  isAncestor(repo: RepoState, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    // Targeted search: stop as soon as the ancestor is found instead of
    // walking the whole history (a push's old tip is usually one step away).
    // Only parseable commits count, exactly as ancestors() lists them.
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.parseCommitOf(repo, oid);
      if (commit === undefined) continue;
      if (oid === ancestor) return true;
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
    }
    return false;
  }

  /** A common ancestor of two commits (the first found walking from `b`). */
  mergeBase(repo: RepoState, a: string, b: string): string | null {
    const ancestorsOfA = this.ancestors(repo, a);
    const seen = new Set<string>();
    const stack = [b];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const commit = this.parseCommitOf(repo, oid);
      if (commit === undefined) continue;
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
    }
    return null;
  }

  /** Every object reachable from a set of commit oids (commits, trees, blobs). */
  collectReachable(repo: RepoState, commitOids: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    const visitedTrees = new Set<string>();
    const walkTree = (treeOid: string): void => {
      if (visitedTrees.has(treeOid)) return;
      visitedTrees.add(treeOid);
      out.add(treeOid);
      const entries = this.parseTreeOf(repo, treeOid);
      if (entries === undefined) return;
      for (const entry of entries) {
        if (entry.mode === '40000') walkTree(entry.oid);
        else out.add(entry.oid);
      }
    };
    for (const oid of commitOids) {
      const commit = this.parseCommitOf(repo, oid);
      if (commit === undefined) continue;
      out.add(oid);
      walkTree(commit.tree);
    }
    return out;
  }

  // --------------------------------------------------------- diff/merge

  /** File-level diff between two trees, with line counts. */
  diffTrees(repo: RepoState, baseTree: string | null, headTree: string | null): FileChange[] {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: FileChange[] = [];
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        const blob = repo.objects.get(h.oid);
        const additions = blob === undefined ? 0 : lineCount(blob.data);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: h.oid });
      } else if (b !== undefined && h === undefined) {
        const blob = repo.objects.get(b.oid);
        const deletions = blob === undefined ? 0 : lineCount(blob.data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: b.oid });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const baseBlob = repo.objects.get(b.oid);
        const headBlob = repo.objects.get(h.oid);
        const { additions, deletions } =
          baseBlob === undefined || headBlob === undefined
            ? { additions: 1, deletions: 1 }
            : diffLineCounts(baseBlob.data, headBlob.data);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: h.oid });
      }
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  /**
   * Three-way merge of flattened trees: `base` is the merge-base tree, `ours`
   * the base branch tip tree, `theirs` the head branch tip tree. Returns the
   * merged flat map and the list of conflicting paths (empty when clean).
   */
  threeWayMerge(
    repo: RepoState,
    baseTree: string | null,
    oursTree: string | null,
    theirsTree: string | null,
  ): { merged: Map<string, { oid: string; mode: string }>; conflicts: string[] } {
    const base = this.flattenTree(repo, baseTree);
    const ours = this.flattenTree(repo, oursTree);
    const theirs = this.flattenTree(repo, theirsTree);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    for (const path of paths) {
      const b = base.get(path)?.oid;
      const o = ours.get(path);
      const t = theirs.get(path);
      if (t?.oid === b) {
        if (o !== undefined) merged.set(path, o);
      } else if (o?.oid === b) {
        if (t !== undefined) merged.set(path, t);
      } else if (o?.oid === t?.oid) {
        if (o !== undefined) merged.set(path, o);
      } else {
        conflicts.push(path);
      }
    }
    conflicts.sort();
    return { merged, conflicts };
  }

  /** The mergeability of a pull request: MERGEABLE, CONFLICTING or UNKNOWN. */
  pullMergeable(repo: RepoState, pull: PullState): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const headCommit = this.parseCommitOf(repo, headTip);
    const baseCommit = this.parseCommitOf(repo, baseTip);
    if (headCommit === undefined || baseCommit === undefined) return 'UNKNOWN';
    const baseOid = this.mergeBase(repo, baseTip, headTip);
    const baseTree = baseOid === null ? null : this.parseCommitOf(repo, baseOid)?.tree ?? null;
    const { conflicts } = this.threeWayMerge(repo, baseTree, baseCommit.tree, headCommit.tree);
    return conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
  }

  // ------------------------------------------------------------- labels

  createLabel(repo: RepoState, name: string, color: string): LabelState | null {
    if (repo.labels.has(name)) return null;
    const label: LabelState = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  listLabels(repo: RepoState): LabelState[] {
    return [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // ------------------------------------------------------------- issues

  createIssue(
    repo: RepoState,
    title: string,
    body: string | null,
    labels: readonly string[],
  ): { issue: IssueState } | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `Label does not exist: ${label}` };
    }
    const issue: IssueState = {
      id: this.nextRestId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq,
      closedAt: null,
    };
    this.nextRestId += 1;
    this.nextSeq += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  getIssue(repo: RepoState, number: number): IssueState | undefined {
    return repo.issues.get(number);
  }

  listIssues(
    repo: RepoState,
    state: 'open' | 'closed' | 'all',
    direction: 'asc' | 'desc',
  ): IssueState[] {
    const out: IssueState[] = [];
    for (const issue of repo.issues.values()) {
      if (state !== 'all' && issue.state !== state) continue;
      out.push(issue);
    }
    out.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return out;
  }

  updateIssue(
    repo: RepoState,
    number: number,
    patch: { state?: 'open' | 'closed'; title?: string; body?: string | null; labels?: string[] },
  ): { issue: IssueState } | { error: string } | null {
    const issue = repo.issues.get(number);
    if (issue === undefined) return null;
    if (patch.labels !== undefined) {
      for (const label of patch.labels) {
        if (!repo.labels.has(label)) return { error: `Label does not exist: ${label}` };
      }
      issue.labels = [...patch.labels];
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) {
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? trialNowIso() : null;
    }
    return { issue };
  }

  addComment(repo: RepoState, number: number, body: string): CommentState | null {
    const issue = repo.issues.get(number);
    if (issue === undefined) return null;
    const comment: CommentState = { id: this.nextCommentId, body, createdSeq: this.nextSeq };
    this.nextCommentId += 1;
    this.nextSeq += 1;
    issue.comments.push(comment);
    return comment;
  }

  // --------------------------------------------------------------- pulls

  createPull(
    repo: RepoState,
    title: string,
    body: string | null,
    head: string,
    base: string,
  ): { pull: PullState } | { error: string; status: number } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined) return { error: `Head branch does not exist: ${head}`, status: 422 };
    if (baseTip === undefined) return { error: `Base branch does not exist: ${base}`, status: 422 };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: 'A pull request already exists for these branches', status: 422 };
      }
    }
    const pull: PullState = {
      id: this.nextRestId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headShaAtCreation: headTip,
      baseShaAtCreation: baseTip,
      createdSeq: this.nextSeq,
    };
    this.nextRestId += 1;
    this.nextSeq += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { pull };
  }

  getPull(repo: RepoState, number: number): PullState | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: RepoState, state: 'open' | 'closed' | 'all'): PullState[] {
    const out: PullState[] = [];
    for (const pull of repo.pulls.values()) {
      if (state !== 'all' && pull.state !== state) continue;
      out.push(pull);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch: one new commit on the
   * base tip whose tree is the three-way merge of merge-base, base tip and
   * head tip. Returns the merge commit sha, or an error with an HTTP status.
   */
  mergePull(repo: RepoState, number: number): { sha: string } | { error: string; status: number } {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { error: 'Not Found', status: 404 };
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) {
      return { error: 'Head or base branch does not exist', status: 422 };
    }
    const headCommit = this.parseCommitOf(repo, headTip);
    const baseCommit = this.parseCommitOf(repo, baseTip);
    if (headCommit === undefined || baseCommit === undefined) {
      return { error: 'Head or base tip is not a commit', status: 422 };
    }
    const baseOid = this.mergeBase(repo, baseTip, headTip);
    const baseTree = baseOid === null ? null : this.parseCommitOf(repo, baseOid)?.tree ?? null;
    const { merged, conflicts } = this.threeWayMerge(repo, baseTree, baseCommit.tree, headCommit.tree);
    if (conflicts.length > 0) {
      return { error: `Merge conflict in: ${conflicts.join(', ')}`, status: 405 };
    }
    const mergedTree = this.buildTreeFromMap(repo, merged);
    const message = `${pull.title} (#${pull.number})\n\n${pull.body ?? ''}`.trimEnd() + '\n';
    const sha = this.createCommit(repo, mergedTree, [baseTip], message);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeCommitSha = sha;
    return { sha };
  }
}

export { makeObject, ZERO_OID };

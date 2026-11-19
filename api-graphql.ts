// GraphQL v4: a small parser and executor for the fixed documents the suite
// sends (queries, mutations, variables, aliases, inline fragments, input
// objects). Unknown fields answer HTTP 200 with an `errors` array naming the
// field; an unknown repository answers `data.repository = null` with no errors.
// Batching (a JSON array of operations) answers an array in order.

import { VIEWER_ID, VIEWER_LOGIN, trialNowIso } from './determinism.ts';
import {
  ApiError,
  jsonValue,
  sendJson,
  type ApiContext,
} from './http-util.ts';
import {
  globalId,
  parseGlobalId,
  type IssueState,
  type PullState,
  type RepoState,
  type Store,
} from './store.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= input.length) throw new Error('unterminated string');
        const c = input[i];
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === '\\') {
          const esc = input[i + 1];
          const simple: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(input.slice(i + 2, i + 6), 16));
            i += 6;
          } else if (simple[esc] !== undefined) {
            value += simple[esc];
            i += 2;
          } else {
            throw new Error(`invalid string escape \\${esc}`);
          }
          continue;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(input.slice(i));
      if (match === null) throw new Error(`invalid number at ${i}`);
      const text = match[0];
      i += text.length;
      tokens.push(
        text.includes('.') || text.includes('e') || text.includes('E')
          ? { kind: 'float', value: Number(text) }
          : { kind: 'int', value: Number(text) },
      );
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface VariableDefinition {
  name: string;
  defaultValue: ValueNode | null;
}

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: VariableDefinition[];
  selections: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  private acceptName(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'name' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          operation: 'query',
          name: null,
          variables: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next.kind === 'name') name = this.expectName();
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        if (!this.acceptName('on')) throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error('unexpected definition');
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const out: VariableDefinition[] = [];
    if (!this.acceptPunct('(')) return out;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      this.skipDirectives();
      out.push({ name, defaultValue });
    }
    return out;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private skipDirectives(): void {
    while (this.acceptPunct('@')) {
      this.expectName();
      const next = this.peek();
      if (next.kind === 'punct' && next.value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.acceptPunct('...')) {
      const token = this.peek();
      if (token.kind === 'name' && token.value !== 'on') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      let typeCondition: string | null = null;
      if (this.acceptName('on')) typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    const brace = this.peek();
    if (brace.kind === 'punct' && brace.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next.kind === 'punct' && next.value === ']') break;
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      for (;;) {
        const next = this.peek();
        if (next.kind === 'punct' && next.value === '}') break;
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('expected a value');
  }
}

// ------------------------------------------------------------- value coercion

type Variables = Map<string, unknown>;

function coerceValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables.get(node.name);
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => coerceValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = coerceValue(field.value, variables);
      return out;
    }
  }
}

function coerceArgs(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = coerceValue(arg.value, variables);
  return out;
}

// ------------------------------------------------------------------ schema

/** The fields each type answers, used for introspection (__type) and errors. */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate',
    'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt',
    'closedAt', 'url', 'repository', 'comments',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author',
    'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url',
  ],
  User: ['id', 'login', 'name', 'email', 'url'],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  GitObject: ['oid'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ------------------------------------------------------------------ nodes

type GqlNode = Record<string, unknown> & { __typename: string };

function userNode(): GqlNode {
  return {
    __typename: 'User',
    id: globalId('User', VIEWER_ID),
    login: VIEWER_LOGIN,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
  };
}

function repoNode(repo: RepoState): GqlNode {
  return { __typename: 'Repository', _repo: repo };
}

function issueNode(repo: RepoState, issue: IssueState): GqlNode {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullNode(repo: RepoState, pull: PullState): GqlNode {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): GqlNode {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    hasPreviousPage: false,
    startCursor,
    endCursor,
  };
}

/** A cursor over a numbered list: base64 of "cursor:<number>". */
function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- resolution

class FieldError extends Error {}

interface ExecContext {
  store: Store;
  baseUrl: string;
}

function issueStateEnum(issue: IssueState): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateEnum(pull: PullState): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Paginate a numbered list (issues or pulls) in a given order. */
function paginateNumbered<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
  wrap: (item: T) => GqlNode,
  typeName: string,
): GqlNode {
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : 100;
  const afterNumber = decodeCursor(typeof args.after === 'string' ? args.after : undefined);
  let ordered = [...items];
  // The caller sorts before this; here only the cursor and the limit apply.
  if (afterNumber !== null) {
    const index = ordered.findIndex((item) => item.number === afterNumber);
    if (index >= 0) ordered = ordered.slice(index + 1);
  }
  const page = ordered.slice(0, first);
  const hasNextPage = ordered.length > first;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return {
    __typename: typeName,
    nodes: page.map(wrap),
    edges: page.map((item) => ({
      __typename: typeName === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge',
      node: wrap(item),
      cursor: encodeCursor(item.number),
    })),
    pageInfo: pageInfoNode(hasNextPage, endCursor, startCursor),
    totalCount: items.length,
  };
}

function resolveIssuesField(ctx: ExecContext, repo: RepoState, args: Record<string, unknown>): GqlNode {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states);
    issues = issues.filter((issue) => wanted.has(issueStateEnum(issue)));
  }
  if (orderBy.direction === 'DESC') {
    issues.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  } else {
    issues.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
  }
  return paginateNumbered(issues, args, (issue) => issueNode(repo, issue), 'IssueConnection');
}

function resolvePullRequestsField(ctx: ExecContext, repo: RepoState, args: Record<string, unknown>): GqlNode {
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states);
  let pulls = [...repo.pulls.values()].filter((pull) => wanted.has(pullStateEnum(pull)));
  pulls.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
  return paginateNumbered(pulls, args, (pull) => pullNode(repo, pull), 'PullRequestConnection');
}

function resolvePullFilesField(ctx: ExecContext, repo: RepoState, pull: PullState, args: Record<string, unknown>): GqlNode {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTree = headTip === undefined ? null : (ctx.store.parseCommitOf(repo, headTip)?.tree ?? null);
  const baseTree = baseTip === undefined ? null : (ctx.store.parseCommitOf(repo, baseTip)?.tree ?? null);
  const files = ctx.store.diffTrees(repo, baseTree, headTree);
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : 100;
  const page = files.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: page.map((file) => ({
      __typename: 'PullRequestChangedFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status.toUpperCase(),
    })),
    edges: [],
    pageInfo: pageInfoNode(files.length > first, null, null),
    totalCount: files.length,
  };
}

function resolveTypeField(name: string): GqlNode | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
    description: null,
    fields: (fields ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null })),
    enumValues: (enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
  };
}

function nodeFromGlobalId(ctx: ExecContext, id: string): GqlNode | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
    return repo === undefined ? null : repoNode(repo);
  }
  if (parsed.kind === 'Issue') {
    const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
    if (repo === undefined) return null;
    const issue = repo.issues.get(Number(parsed.parts[1]));
    return issue === undefined ? null : issueNode(repo, issue);
  }
  if (parsed.kind === 'PullRequest') {
    const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
    if (repo === undefined) return null;
    const pull = repo.pulls.get(Number(parsed.parts[1]));
    return pull === undefined ? null : pullNode(repo, pull);
  }
  return null;
}

function repoFromGlobalId(ctx: ExecContext, id: unknown): RepoState | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  return ctx.store.getRepoById(Number(parsed.parts[0])) ?? null;
}

/** Resolve one field of one node. Throws FieldError for an unknown field. */
function resolveField(
  ctx: ExecContext,
  typeName: string,
  fieldName: string,
  parent: GqlNode,
  args: Record<string, unknown>,
): unknown {
  if (fieldName === '__typename') return typeName;

  // Fields answered from a property the node already carries.
  if (!fieldName.startsWith('_') && fieldName in parent) {
    const value = parent[fieldName];
    if (value !== undefined) return value;
  }

  switch (typeName) {
    case 'Query': {
      if (fieldName === 'viewer') return userNode();
      if (fieldName === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        const repo = ctx.store.getRepo(owner, name);
        return repo === undefined ? null : repoNode(repo);
      }
      if (fieldName === 'node') {
        return typeof args.id === 'string' ? nodeFromGlobalId(ctx, args.id) : null;
      }
      if (fieldName === '__type') {
        return typeof args.name === 'string' ? resolveTypeField(args.name) : null;
      }
      break;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (fieldName === 'createIssue') {
        const repo = repoFromGlobalId(ctx, input.repositoryId);
        if (repo === null) throw new FieldError('repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : null;
        const result = ctx.store.createIssue(repo, title, body, []);
        if ('error' in result) throw new FieldError(result.error);
        return { __typename: 'CreateIssuePayload', issue: issueNode(repo, result.issue) };
      }
      if (fieldName === 'closeIssue') {
        const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
        if (parsed === null || parsed.kind !== 'Issue') throw new FieldError('issue not found');
        const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
        if (repo === undefined) throw new FieldError('issue not found');
        const result = ctx.store.updateIssue(repo, Number(parsed.parts[1]), { state: 'closed' });
        if (result === null || 'error' in result) throw new FieldError('issue not found');
        return { __typename: 'CloseIssuePayload', issue: issueNode(repo, result.issue) };
      }
      if (fieldName === 'createPullRequest') {
        const repo = repoFromGlobalId(ctx, input.repositoryId);
        if (repo === null) throw new FieldError('repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : null;
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const result = ctx.store.createPull(repo, title, body, head, base);
        if ('error' in result) throw new FieldError(result.error);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, result.pull) };
      }
      if (fieldName === 'mergePullRequest') {
        const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
        if (parsed === null || parsed.kind !== 'PullRequest') throw new FieldError('pull request not found');
        const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
        if (repo === undefined) throw new FieldError('pull request not found');
        const result = ctx.store.mergePull(repo, Number(parsed.parts[1]));
        if ('error' in result) throw new FieldError(result.error);
        const pull = repo.pulls.get(Number(parsed.parts[1]));
        if (pull === undefined) throw new FieldError('pull request not found');
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
      }
      if (fieldName === 'addComment') {
        const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
        if (parsed === null || parsed.kind !== 'Issue') throw new FieldError('subject not found');
        const repo = ctx.store.getRepoById(Number(parsed.parts[0]));
        if (repo === undefined) throw new FieldError('subject not found');
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = ctx.store.addComment(repo, Number(parsed.parts[1]), body);
        if (comment === null) throw new FieldError('subject not found');
        const issueNumber = Number(parsed.parts[1]);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: globalId('Comment', repo.id, issueNumber, comment.id),
              body: comment.body,
            },
            cursor: encodeCursor(comment.id),
          },
        };
      }
      break;
    }
    case 'Repository': {
      const repo = parent._repo as RepoState;
      if (fieldName === 'id') return globalId('Repository', repo.id);
      if (fieldName === 'databaseId') return repo.id;
      if (fieldName === 'name') return repo.name;
      if (fieldName === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (fieldName === 'owner') return userNode();
      if (fieldName === 'defaultBranchRef') {
        const tip = ctx.store.defaultBranchTip(repo);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (fieldName === 'viewerPermission') return 'ADMIN';
      if (fieldName === 'hasIssuesEnabled') return true;
      if (fieldName === 'description') return repo.description;
      if (fieldName === 'isPrivate') return repo.isPrivate;
      if (fieldName === 'createdAt' || fieldName === 'updatedAt') return trialNowIso();
      if (fieldName === 'url') return `${ctx.baseUrl}/${repo.owner}/${repo.name}`;
      if (fieldName === 'issue') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueNode(repo, issue);
      }
      if (fieldName === 'issues') return resolveIssuesField(ctx, repo, args);
      if (fieldName === 'pullRequests') return resolvePullRequestsField(ctx, repo, args);
      if (fieldName === 'pullRequest') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      break;
    }
    case 'Issue': {
      const repo = parent._repo as RepoState;
      const issue = parent._issue as IssueState;
      if (fieldName === 'id') return globalId('Issue', repo.id, issue.number);
      if (fieldName === 'number') return issue.number;
      if (fieldName === 'title') return issue.title;
      if (fieldName === 'state') return issueStateEnum(issue);
      if (fieldName === 'body') return issue.body;
      if (fieldName === 'author') return userNode();
      if (fieldName === 'createdAt' || fieldName === 'updatedAt') return trialNowIso();
      if (fieldName === 'closedAt') return issue.closedAt;
      if (fieldName === 'url') return `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (fieldName === 'repository') return repoNode(repo);
      break;
    }
    case 'PullRequest': {
      const repo = parent._repo as RepoState;
      const pull = parent._pull as PullState;
      if (fieldName === 'id') return globalId('PullRequest', repo.id, pull.number);
      if (fieldName === 'number') return pull.number;
      if (fieldName === 'title') return pull.title;
      if (fieldName === 'body') return pull.body;
      if (fieldName === 'state') return pullStateEnum(pull);
      if (fieldName === 'merged') return pull.merged;
      if (fieldName === 'mergeable') return ctx.store.pullMergeable(repo, pull);
      if (fieldName === 'headRefName') return pull.headRef;
      if (fieldName === 'baseRefName') return pull.baseRef;
      if (fieldName === 'headRef') return { __typename: 'Ref', name: pull.headRef };
      if (fieldName === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
      if (fieldName === 'files') return resolvePullFilesField(ctx, repo, pull, args);
      if (fieldName === 'author') return userNode();
      if (fieldName === 'createdAt' || fieldName === 'updatedAt') return trialNowIso();
      if (fieldName === 'mergedAt') return pull.mergedAt;
      if (fieldName === 'mergeCommit') {
        return pull.mergeCommitSha === null ? null : { __typename: 'GitObject', oid: pull.mergeCommitSha };
      }
      if (fieldName === 'url') return `${ctx.baseUrl}/${repo.owner}/${repo.name}/pulls/${pull.number}`;
      break;
    }
    case 'User': {
      if (fieldName === 'url') return `${ctx.baseUrl}/${VIEWER_LOGIN}`;
      break;
    }
    case '__Type': {
      if (fieldName === 'fields' || fieldName === 'enumValues') {
        // The node already carries the lists; the property lookup above answers.
        return parent[fieldName] ?? null;
      }
      break;
    }
    default:
      break;
  }

  throw new FieldError(`Cannot query field "${fieldName}" on type "${typeName}".`);
}

// --------------------------------------------------------------- execution

interface ExecutionResult {
  data: Record<string, unknown> | null;
  errors: { message: string }[];
}

function executeSelectionSet(
  ctx: ExecContext,
  selections: readonly SelectionNode[],
  parent: GqlNode,
  parentType: string,
  variables: Variables,
  fragments: Map<string, FragmentNode>,
  errors: { message: string }[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(data, executeSelectionSet(ctx, fragment.selections, parent, parentType, variables, fragments, errors));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(data, executeSelectionSet(ctx, selection.selections, parent, parentType, variables, fragments, errors));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const args = coerceArgs(selection, variables);
    let value: unknown;
    try {
      value = resolveField(ctx, parentType, selection.name, parent, args);
    } catch (err) {
      if (err instanceof FieldError) {
        errors.push({ message: err.message });
        data[responseKey] = null;
        continue;
      }
      throw err;
    }
    if (selection.selections === null || value === null || value === undefined) {
      data[responseKey] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      data[responseKey] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in item) {
          return executeSelectionSet(
            ctx,
            selection.selections as SelectionNode[],
            item as GqlNode,
            (item as GqlNode).__typename,
            variables,
            fragments,
            errors,
          );
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in value) {
      const node = value as GqlNode;
      data[responseKey] = executeSelectionSet(
        ctx,
        selection.selections,
        node,
        node.__typename,
        variables,
        fragments,
        errors,
      );
      continue;
    }
    data[responseKey] = value;
  }
  return data;
}

function executeOperation(
  ctx: ExecContext,
  document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> },
  operationName: unknown,
  rawVariables: unknown,
): ExecutionResult {
  const errors: { message: string }[] = [];
  let operation: OperationNode | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = document.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const provided = (rawVariables ?? {}) as Record<string, unknown>;
  const variables: Variables = new Map();
  for (const definition of operation.variables) {
    if (provided[definition.name] !== undefined) {
      variables.set(definition.name, provided[definition.name]);
    } else if (definition.defaultValue !== null) {
      variables.set(definition.name, coerceValue(definition.defaultValue, variables));
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlNode = { __typename: rootType };
  try {
    const data = executeSelectionSet(ctx, operation.selections, root, rootType, variables, document.fragments, errors);
    return { data, errors };
  } catch (err) {
    return { data: null, errors: [...errors, { message: err instanceof Error ? err.message : 'internal error' }] };
  }
}

// ------------------------------------------------------------------ handler

function executeRequest(ctx: ExecContext, payload: unknown): ExecutionResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { data: null, errors: [{ message: 'Must provide a query.' }] };
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(tokenize(body.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  return executeOperation(ctx, document, body.operationName, body.variables);
}

/**
 * Handle POST /api/graphql. Batching (a JSON array) answers an array of
 * results in order. GraphQL errors answer HTTP 200 with an `errors` array,
 * as GitHub does; only transport problems (bad JSON, wrong auth) use HTTP
 * error statuses, and those are handled by app.ts before reaching here.
 */
export function handleGraphQL(ctx: ApiContext): void {
  let payload: unknown;
  try {
    payload = jsonValue(ctx);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'Problems parsing JSON');
  }
  const exec: ExecContext = { store: ctx.store, baseUrl: ctx.baseUrl };
  const shape = (result: ExecutionResult): Record<string, unknown> => {
    // GitHub omits `errors` when there are none.
    return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
  };
  if (Array.isArray(payload)) {
    sendJson(ctx.res, 200, payload.map((item) => shape(executeRequest(exec, item))));
    return;
  }
  sendJson(ctx.res, 200, shape(executeRequest(exec, payload)));
}

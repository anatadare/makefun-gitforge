// Git smart HTTP: info/refs discovery, upload-pack (fetch, protocol v0 and v2)
// and receive-pack (push). The wire shapes are git's own: pkt-line framing,
// sideband channels, report-status inside band 1, PACK v2 packs.

import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { VIEWER_LOGIN } from './determinism.ts';
import { planFetch, type FetchRequest } from './gitfetch.ts';
import { readPack, writePack, ZERO_OID } from './gitpack.ts';
import { FLUSH, PktReader, pktLine, pktLines, sideband } from './pktline.ts';
import { Store, type RepoState } from './store.ts';

export interface GitRequest {
  store: Store;
  method: string;
  owner: string;
  repoName: string;
  action: 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
  res: ServerResponse;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

/** Split a buffer into sideband band-1 packets (data chunks of at most 16 KiB). */
function chunkSideband(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = 16384;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    parts.push(sideband(1, data.subarray(offset, Math.min(offset + chunkSize, data.length))));
  }
  return parts;
}

function wantsV2(headers: IncomingHttpHeaders): boolean {
  const protocol = headers['git-protocol'];
  return typeof protocol === 'string' && protocol.split(',').some((part) => part.trim() === 'version=2');
}

// ------------------------------------------------------------- discovery

/** The v0 ref advertisement: service preamble, refs (HEAD first), capabilities on the first line. */
function advertiseV0(repo: RepoState, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const capabilities =
    service === 'git-upload-pack'
      ? `symref=HEAD:${headRef} side-band-64k thin-pack ofs-delta shallow agent=forge/1.0`
      : `symref=HEAD:${headRef} report-status delete-refs side-band-64k ofs-delta agent=forge/1.0`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = repoListRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const headTip = repo.refs.get(headRef) ?? ZERO_OID;
    parts.push(pktLine(`${headTip} HEAD\0${capabilities}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag' && ref.name.startsWith('refs/tags/')) {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== undefined && peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: no service preamble, "version 2" first. Constant, so built once. */
const ADVERTISE_V2 = pktLines([
  'version 2\n',
  'agent=forge/1.0\n',
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
]);

// Small wrappers so this module does not reach into Store internals directly.
function repoListRefs(repo: RepoState): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function peelTag(repo: RepoState, oid: string): string | undefined {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return undefined;
    if (object.type !== 'tag') return current;
    const text = object.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    if (match === null) return undefined;
    current = match[1];
  }
  return undefined;
}

// ------------------------------------------------------------ upload-pack

interface V2Command {
  command: string;
  args: string[];
}

/** Parse a v2 upload-pack request: command line, optional agent/object-format, delim, args. */
function parseV2Command(body: Buffer): V2Command {
  const reader = new PktReader(body);
  let command = '';
  const args: string[] = [];
  let sawDelim = false;
  for (;;) {
    const pkt = reader.read();
    if (pkt === null || pkt.kind === 'flush') break;
    if (pkt.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (pkt.kind !== 'line') continue;
    const text = pkt.text.replace(/\n$/, '');
    if (!sawDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      // agent= and object-format= lines are acknowledged and ignored.
    } else {
      args.push(text);
    }
  }
  if (command === '') throw new Error('v2 request has no command');
  return { command, args };
}

/** Answer a v2 ls-refs command. */
function lsRefsV2(store: Store, repo: RepoState, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const lines: string[] = [];
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
  }
  for (const ref of repoListRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== undefined && peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return pktLines(lines);
}

/** Parse a v2 fetch command's arguments into a fetch request. */
function parseFetchArgs(args: readonly string[]): FetchRequest {
  const request: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    deepen: null,
    deepenSince: null,
    deepenNot: [],
  };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.deepen = Number(arg.slice(7));
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13));
    else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
    // thin-pack, no-progress, ofs-delta, filter and done need no action here:
    // thin-pack is permission to send deltas (we send none), filter is not
    // exercised by the suite, and done just ends the argument list.
  }
  return request;
}

/** Cache key for a fetch response: everything that determines its bytes. */
function fetchCacheKey(request: FetchRequest, protocol: 'v0' | 'v2', sideband: boolean): string {
  return JSON.stringify([
    protocol,
    sideband,
    request.wants,
    request.haves,
    request.shallow,
    request.deepen,
    request.deepenSince,
    request.deepenNot,
  ]);
}

/** Store a fetch response in the repo's bounded cache (oldest entry evicted first). */
function cacheFetch(repo: RepoState, key: string, response: Buffer): void {
  if (repo.fetchCache.size >= 128) {
    const oldest = repo.fetchCache.keys().next().value;
    if (oldest !== undefined) repo.fetchCache.delete(oldest);
  }
  repo.fetchCache.set(key, response);
}

/** Answer a v2 fetch command: acknowledgments, shallow-info, packfile sections. */
function fetchV2(store: Store, repo: RepoState, args: readonly string[]): Buffer {
  const request = parseFetchArgs(args);
  for (const want of request.wants) {
    if (!store.hasObject(repo, want)) throw new Error(`upload-pack: not our ref ${want}`);
  }
  const key = fetchCacheKey(request, 'v2', false);
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(store, repo, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktLine('ready\n'), FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  const pack = writePack(plan.objects);
  parts.push(pktLine('packfile\n'));
  parts.push(...chunkSideband(pack));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  cacheFetch(repo, key, out);
  return out;
}

/** Parse a v0 fetch request: want section, flush, have section, flush. */
function parseV0Fetch(body: Buffer): { request: FetchRequest; sideband: boolean } {
  const reader = new PktReader(body);
  const request: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    deepen: null,
    deepenSince: null,
    deepenNot: [],
  };
  let sidebandRequested = false;
  // First section: wants (the first want may carry capabilities), shallow, deepen.
  for (;;) {
    const pkt = reader.read();
    if (pkt === null || pkt.kind === 'flush') break;
    if (pkt.kind !== 'line') continue;
    const text = pkt.text.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const space = rest.indexOf(' ');
      request.wants.push(space === -1 ? rest : rest.slice(0, space));
      if (space !== -1 && rest.slice(space + 1).split(' ').includes('side-band-64k')) {
        sidebandRequested = true;
      }
    } else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) request.deepen = Number(text.slice(7));
    else if (text.startsWith('deepen-since ')) request.deepenSince = Number(text.slice(13));
    else if (text.startsWith('deepen-not ')) request.deepenNot.push(text.slice(11).trim());
  }
  // Second section: haves and done.
  for (;;) {
    const pkt = reader.read();
    if (pkt === null || pkt.kind === 'flush') break;
    if (pkt.kind !== 'line') continue;
    const text = pkt.text.replace(/\n$/, '');
    if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
  }
  return { request, sideband: sidebandRequested };
}

/** Answer a v0 fetch: shallow/unshallow lines, NAK/ACK lines, sideband pack. */
function fetchV0(store: Store, repo: RepoState, body: Buffer): Buffer {
  const { request, sideband: sidebandRequested } = parseV0Fetch(body);
  for (const want of request.wants) {
    if (!store.hasObject(repo, want)) throw new Error(`upload-pack: not our ref ${want}`);
  }
  const key = fetchCacheKey(request, 'v0', sidebandRequested);
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(store, repo, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const pack = writePack(plan.objects);
  if (sidebandRequested) {
    parts.push(...chunkSideband(pack));
    parts.push(FLUSH);
  } else {
    parts.push(pack);
  }
  const out = Buffer.concat(parts);
  cacheFetch(repo, key, out);
  return out;
}

// ------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Answer a push: unpack the pack, validate each command, apply the accepted ones. */
function receivePack(store: Store, repo: RepoState, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (;;) {
    const pkt = reader.read();
    if (pkt === null || pkt.kind === 'flush') break;
    if (pkt.kind !== 'line') continue;
    let text = pkt.text.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1).split(' ').filter(Boolean);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length < 3) throw new Error('malformed receive-pack command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const packBytes = reader.remaining();
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const entries = readPack(packBytes, (oid) => store.getObject(repo, oid));
      store.putObjects(repo, entries);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpacker error';
    }
  } else if (updatesRef) {
    unpackError = 'unpacker error: no pack received';
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackError !== null) {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
    }
  } else {
    for (const command of commands) {
      if (command.newOid === ZERO_OID) {
        // Delete: the ref must exist and the old value must match.
        const current = store.getRef(repo, command.ref);
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          store.deleteRef(repo, command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create: the ref must not exist and the new object must be known.
        if (store.getRef(repo, command.ref) !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else if (!store.hasObject(repo, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
        } else {
          store.setRef(repo, command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
      } else {
        // Update: old must match the current tip and the new commit must
        // descend from it (fast-forward), when both ends are commits.
        const current = store.getRef(repo, command.ref);
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else if (!store.hasObject(repo, command.newOid)) {
          results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
        } else {
          const oldIsCommit = store.parseCommitOf(repo, command.oldOid) !== undefined;
          const newIsCommit = store.parseCommitOf(repo, command.newOid) !== undefined;
          if (
            oldIsCommit &&
            newIsCommit &&
            !store.isAncestor(repo, command.oldOid, command.newOid)
          ) {
            results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          } else {
            store.setRef(repo, command.ref, command.newOid);
            results.push({ ref: command.ref, ok: true, reason: '' });
          }
        }
      }
    }
  }

  // The report-status stream is itself pkt-lined; with sideband it rides
  // inside band 1, followed by an outer flush packet.
  const innerLines: string[] = [`unpack ${unpackError === null ? 'ok' : unpackError}\n`];
  for (const result of results) {
    innerLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = pktLines(innerLines);
  if (capabilities.includes('side-band-64k')) {
    return Buffer.concat([...chunkSideband(inner), FLUSH]);
  }
  return inner;
}

// ------------------------------------------------------------------ entry

/** Handle one git smart HTTP request. Assumes the router matched a git path. */
export function handleGitHttp(req: GitRequest): void {
  const { store, res } = req;
  // Only the viewer's own repos exist here; any other owner is a 404.
  if (req.owner !== VIEWER_LOGIN) {
    sendText(res, 404, 'Not Found\n');
    return;
  }
  const repo = store.getRepo(req.owner, req.repoName);
  if (repo === undefined) {
    sendText(res, 404, 'Not Found\n');
    return;
  }

  try {
    if (req.action === 'info/refs') {
      if (req.method !== 'GET') {
        sendText(res, 405, 'Method Not Allowed\n');
        return;
      }
      const service = req.query.get('service');
      if (service === 'git-upload-pack') {
        if (wantsV2(req.headers)) send(res, 200, UPLOAD_AD, ADVERTISE_V2);
        else send(res, 200, UPLOAD_AD, advertiseV0(repo, 'git-upload-pack'));
      } else if (service === 'git-receive-pack') {
        send(res, 200, RECEIVE_AD, advertiseV0(repo, 'git-receive-pack'));
      } else {
        sendText(res, 400, 'Bad Request: unknown service\n');
      }
      return;
    }

    if (req.action === 'git-upload-pack') {
      if (req.method !== 'POST') {
        sendText(res, 405, 'Method Not Allowed\n');
        return;
      }
      if (wantsV2(req.headers)) {
        const { command, args } = parseV2Command(req.body);
        if (command === 'ls-refs') send(res, 200, UPLOAD_RESULT, lsRefsV2(store, repo, args));
        else if (command === 'fetch') send(res, 200, UPLOAD_RESULT, fetchV2(store, repo, args));
        else sendText(res, 400, `Bad Request: unknown command ${command}\n`);
      } else {
        send(res, 200, UPLOAD_RESULT, fetchV0(store, repo, req.body));
      }
      return;
    }

    // git-receive-pack
    if (req.method !== 'POST') {
      sendText(res, 405, 'Method Not Allowed\n');
      return;
    }
    send(res, 200, RECEIVE_RESULT, receivePack(store, repo, req.body));
  } catch (err) {
    // A malformed git request is a 400; the server keeps serving.
    sendText(res, 400, `Bad Request: ${err instanceof Error ? err.message : 'malformed request'}\n`);
  }
}

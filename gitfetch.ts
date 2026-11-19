// Fetch planning for upload-pack (protocol v0 and v2 share this). Given what
// the client wants, what it already has, and any depth limits, decide which
// objects to send, which acknowledgments to report, and which shallow and
// unshallow boundaries apply.
//
// Rules, as the git protocol settles them:
// - Included commits C: walk from the wants along parent edges, stopping at the
//   requested depth (deepen N keeps N levels; depth 1 is the wants alone) and
//   at commits older than deepen-since. Then remove everything the client has.
// - The exclusion set E: everything reachable from the haves, except that the
//   walk stops at the parents of commits in the client's shallow set (a shallow
//   commit is one the client holds without its history).
// - Objects sent: everything reachable from C (commits, their trees, blobs,
//   wanted tags) minus everything reachable from E.
// - Shallow boundaries: included commits with at least one parent outside C.
// - Unshallow: a previous shallow boundary that is now included together with
//   all of its parents.

import type { GitObject } from './gitpack.ts';
import type { RepoState, Store } from './store.ts';

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

export interface FetchPlan {
  objects: GitObject[];
  acks: string[];
  shallow: string[];
  unshallow: string[];
}

/** Walk parent edges from `tips`, stopping at `stop` commits (excluded, not walked past). */
function walkCommits(
  store: Store,
  repo: RepoState,
  tips: readonly string[],
  stop: ReadonlySet<string>,
  maxDepth: number | null,
  since: number | null,
): Set<string> {
  const out = new Set<string>();
  const queue: { oid: string; depth: number }[] = tips.map((oid) => ({ oid, depth: 1 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (out.has(oid) || stop.has(oid)) continue;
    const commit = store.parseCommitOf(repo, oid);
    if (commit === undefined) continue;
    if (since !== null && commit.committerTime < since) continue;
    out.add(oid);
    if (maxDepth !== null && depth >= maxDepth) continue;
    for (const parent of commit.parents) {
      if (!out.has(parent) && !stop.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return out;
}

export function planFetch(store: Store, repo: RepoState, request: FetchRequest): FetchPlan {
  const shallowSet = new Set(request.shallow);

  // Exclusion set: reachable from the haves, but never past a shallow commit's
  // parents (the client holds a shallow commit without its history), and never
  // past deepen-not tips.
  const deepenNotTips = new Set<string>();
  for (const ref of request.deepenNot) {
    const resolved = store.resolveRef(repo, ref);
    if (resolved !== undefined) deepenNotTips.add(resolved);
  }
  const exclusionRoots = [...request.haves, ...deepenNotTips];
  const excluded = new Set<string>();
  {
    const queue = [...exclusionRoots];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (excluded.has(oid)) continue;
      const commit = store.parseCommitOf(repo, oid);
      if (commit === undefined) continue;
      excluded.add(oid);
      // A shallow have is a wall: its parents are not excluded.
      if (shallowSet.has(oid)) continue;
      for (const parent of commit.parents) {
        if (!excluded.has(parent)) queue.push(parent);
      }
    }
  }

  // Wanted tags are sent as objects; their targets join the walk.
  const wantedTags: GitObject[] = [];
  const walkTips: string[] = [];
  for (const want of request.wants) {
    const object = store.getObject(repo, want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantedTags.push(object);
      const peeled = store.peelToNonTag(repo, want);
      if (peeled !== undefined && peeled !== want) walkTips.push(peeled);
    } else if (object.type === 'commit') {
      walkTips.push(want);
    }
    // A want naming a tree or blob directly is not a fetch the suite performs.
  }

  // Included commits: the depth/since-limited walk from the wants, minus the
  // exclusion set.
  const walked = walkCommits(store, repo, walkTips, new Set<string>(), request.deepen, request.deepenSince);
  const included = new Set<string>();
  for (const oid of walked) if (!excluded.has(oid)) included.add(oid);

  // Objects: everything reachable from the included commits (and wanted tags),
  // minus everything reachable from the excluded commits.
  const reachableIncluded = store.collectReachable(repo, included);
  const reachableExcluded = store.collectReachable(repo, excluded);
  const objects: GitObject[] = [];
  for (const oid of reachableIncluded) {
    if (reachableExcluded.has(oid)) continue;
    const object = store.getObject(repo, oid);
    if (object !== undefined) objects.push(object);
  }
  for (const tag of wantedTags) {
    if (!objects.some((object) => object.oid === tag.oid)) objects.push(tag);
  }

  // Shallow boundaries: included commits with a parent the client will still
  // lack after this fetch (in neither the included set nor the exclusion set).
  const known = new Set<string>([...included, ...excluded]);
  const shallow: string[] = [];
  for (const oid of included) {
    const commit = store.parseCommitOf(repo, oid);
    if (commit === undefined || commit.parents.length === 0) continue;
    if (commit.parents.some((parent) => !known.has(parent))) shallow.push(oid);
  }
  shallow.sort();

  // Unshallow: a previous shallow boundary whose parents the client now holds
  // (included here, or already held), so it is no longer a boundary.
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    const commit = store.parseCommitOf(repo, oid);
    if (commit === undefined) continue;
    if (commit.parents.every((parent) => known.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();

  // Acknowledgments: one per have the server holds (the client only records
  // them; an empty have list is answered with NAK by the caller).
  const acks: string[] = [];
  for (const have of request.haves) {
    if (store.hasObject(repo, have)) acks.push(have);
  }

  return { objects, acks, shallow, unshallow };
}

// Git conformance test: drive the forge with the kit's own GitClient.
// Run: MAKEFUN_SHOP_TOKEN=... node --experimental-strip-types git-test.ts
import { createApp } from './app.ts';
import {
  GitClient,
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  hashObject,
  type GitObject,
} from '/home/hatch/workspace/makefun/github-core-clone-01-kit/program/env/src/git-client.ts';

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

const client = new GitClient({ baseUrl: BASE, token: TOKEN });
const v0 = new GitClient({ baseUrl: BASE, token: TOKEN, gitProtocol: 0 });
const OWNER = 'adaiversen';

// A local object store for building commits, like the grader's fixture does.
const store = new Map<string, GitObject>();
function put(type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  store.set(oid, { type, data });
  return oid;
}
function commitOn(parent: string | null, path: string, content: string, message: string): string {
  const blob = put('blob', Buffer.from(content, 'utf8'));
  const tree = put('tree', buildTree([{ mode: '100644', name: path, oid: blob }]));
  const commit = put(
    'commit',
    buildCommit({ tree, parents: parent === null ? [] : [parent], message: `${message}\n`, timestamp: 1700000000 }),
  );
  return commit;
}

try {
  // Missing repo: 404 on info/refs for both services.
  try {
    await client.advertisement(OWNER, 'missing', 'git-upload-pack');
    check('missing repo upload-pack 404', false, 'no error thrown');
  } catch (err: unknown) {
    check('missing repo upload-pack 404', String((err as Error).message).includes('404'), (err as Error).message);
  }
  try {
    await client.advertisement(OWNER, 'missing', 'git-receive-pack');
    check('missing repo receive-pack 404', false, 'no error thrown');
  } catch (err: unknown) {
    check('missing repo receive-pack 404', String((err as Error).message).includes('404'), (err as Error).message);
  }

  // Empty repo: v2 advertisement, unborn ls-refs, empty clone.
  await client.createRepo(OWNER, 'git-demo');
  const adV2 = await client.advertisement(OWNER, 'git-demo', 'git-upload-pack');
  check('empty repo v2 ad', adV2.protocol === 2 && adV2.capabilities.get('fetch') === 'shallow filter' && (adV2.capabilities.get('ls-refs') ?? '').includes('unborn'));
  const lsEmpty = await client.lsRefs(OWNER, 'git-demo');
  check('empty repo ls-refs unborn HEAD', lsEmpty.refs.some((r) => r.name === 'HEAD' && r.unborn === true && r.symrefTarget === 'refs/heads/main'), JSON.stringify(lsEmpty.refs));
  const emptyClone = await client.clone(OWNER, 'git-demo');
  check('empty clone no objects', emptyClone.objects.size === 0 && emptyClone.pack === null);

  // Push a 3-commit chain to main.
  const c1 = commitOn(null, 'a.txt', 'one\n', 'first');
  const c2 = commitOn(c1, 'a.txt', 'two\n', 'second');
  const c3 = commitOn(c2, 'a.txt', 'three\n', 'third');
  const pushed = await client.push(OWNER, 'git-demo', [{ oldOid: ZERO_OID, newOid: c3, ref: 'refs/heads/main' }], {
    objects: [...store.values()],
  });
  check('push chain ok', pushed.report !== null && pushed.report.unpackOk && pushed.report.refs.length === 1 && pushed.report.refs[0].ok, JSON.stringify(pushed.report));

  // v0 advertisement now lists HEAD + main with caps.
  const adV0 = await v0.advertisement(OWNER, 'git-demo', 'git-upload-pack');
  check(
    'v0 ad lists HEAD and main',
    adV0.protocol === 0 && adV0.refs.some((r) => r.name === 'HEAD' && r.oid === c3) && adV0.refs.some((r) => r.name === 'refs/heads/main' && r.oid === c3) && adV0.capabilities.has('side-band-64k') && adV0.capabilities.has('shallow'),
    adV0.protocol === 0 ? JSON.stringify(adV0.refs) : 'not v0',
  );
  const adRecv = await client.advertisement(OWNER, 'git-demo', 'git-receive-pack');
  check(
    'receive-pack ad caps',
    adRecv.protocol === 0 && adRecv.capabilities.has('report-status') && adRecv.capabilities.has('side-band-64k') && adRecv.capabilities.has('delete-refs'),
  );

  // Full clone: 9 objects (3 commits, 3 trees, 3 blobs).
  const full = await client.clone(OWNER, 'git-demo');
  check('full clone 9 objects', full.objects.size === 9 && full.checksumOk, `got ${full.objects.size}`);
  check('full clone head symref', full.head === 'refs/heads/main');

  // Shallow depth-1 clone: tip commit + tree + blob, shallow boundary at tip.
  const shallow = await client.clone(OWNER, 'git-demo', { depth: 1, parse: true });
  check('shallow clone 3 objects', shallow.objects.size === 3 && shallow.shallow.includes(c3), `objects=${shallow.objects.size} shallow=${JSON.stringify(shallow.shallow)}`);

  // ls-refs with a prefix: rawRefs must be filtered server-side.
  const lsPrefixed = await client.lsRefs(OWNER, 'git-demo', { prefixes: ['refs/heads/'] });
  check('ls-refs prefix filters server-side', lsPrefixed.rawRefs.length === 1 && lsPrefixed.rawRefs[0].name === 'refs/heads/main', JSON.stringify(lsPrefixed.rawRefs));

  // v0 fetch of the tip with a have: only the new objects come back.
  const fetched = await v0.fetch(OWNER, 'git-demo', { wants: [c3], haves: [c1] });
  check('v0 fetch with have', fetched.objects.size === 6 && fetched.acks.includes(c1), `objects=${fetched.objects.size} acks=${JSON.stringify(fetched.acks)}`);

  // Fetch nothing new: haves include the tip, 0 objects.
  const nothing = await client.fetch(OWNER, 'git-demo', { wants: [c3], haves: [c3] });
  check('fetch nothing new', nothing.objects.size === 0, `objects=${nothing.objects.size}`);

  // Non-fast-forward push is refused with the exact reason, ref unmoved.
  const divergent = commitOn(c1, 'a.txt', 'divergent\n', 'divergent');
  const refused = await client.push(OWNER, 'git-demo', [{ oldOid: c3, newOid: divergent, ref: 'refs/heads/main' }], {
    objects: [...store.values()],
  });
  check('non-fast-forward refused', refused.report !== null && refused.report.refs[0].ok === false && refused.report.refs[0].reason === 'non-fast-forward', JSON.stringify(refused.report));
  const afterRefusal = await client.lsRefs(OWNER, 'git-demo', { prefixes: ['refs/heads/main'] });
  check('ref unmoved after refusal', afterRefusal.refs[0]?.oid === c3);

  // Push a second branch from c2, then an annotated tag on c3.
  const branchPush = await client.push(OWNER, 'git-demo', [{ oldOid: ZERO_OID, newOid: c2, ref: 'refs/heads/feature' }], {
    objects: [...store.values()],
  });
  check('push feature branch', branchPush.report?.refs[0]?.ok === true);
  const tagOid = put('tag', buildTag({ object: c3, type: 'commit', tag: 'v1.0', tagger: 'Conformance <conformance@make.fun>', timestamp: 1700000000, message: 'release 1.0\n' }));
  const tagPush = await client.push(OWNER, 'git-demo', [{ oldOid: ZERO_OID, newOid: tagOid, ref: 'refs/tags/v1.0' }], {
    objects: [...store.values()],
  });
  check('push annotated tag', tagPush.report?.refs[0]?.ok === true, JSON.stringify(tagPush.report));
  const lsPeeled = await client.lsRefs(OWNER, 'git-demo', { prefixes: ['refs/tags/'], peel: true });
  check('ls-refs peel tag', lsPeeled.refs[0]?.peeled === c3, JSON.stringify(lsPeeled.refs));

  // Deepen a shallow clone: fetch depth 3 with the shallow boundary.
  const deepened = await client.fetch(OWNER, 'git-demo', { wants: [c3], haves: [c3], shallow: [c3], depth: 3 });
  check('deepen unshallows tip', deepened.unshallow.includes(c3) && deepened.objects.size === 6, `unshallow=${JSON.stringify(deepened.unshallow)} objects=${deepened.objects.size}`);

  // Mixed push: one ok ref, one refused ref.
  const c4 = commitOn(c3, 'a.txt', 'four\n', 'fourth');
  const mixed = await client.push(
    OWNER,
    'git-demo',
    [
      { oldOid: c3, newOid: c4, ref: 'refs/heads/main' },
      { oldOid: c3, newOid: divergent, ref: 'refs/heads/feature' },
    ],
    { objects: [...store.values()] },
  );
  check(
    'mixed push one ok one ng',
    mixed.report !== null && mixed.report.refs.length === 2 && mixed.report.refs[0].ok === true && mixed.report.refs[1].ok === false,
    JSON.stringify(mixed.report),
  );

  // Delete the feature branch.
  const deleted = await client.push(OWNER, 'git-demo', [{ oldOid: c2, newOid: ZERO_OID, ref: 'refs/heads/feature' }]);
  check('delete branch', deleted.report?.refs[0]?.ok === true, JSON.stringify(deleted.report));
  const afterDelete = await client.lsRefs(OWNER, 'git-demo', { prefixes: ['refs/heads/'] });
  check('branch gone after delete', afterDelete.refs.length === 1 && afterDelete.refs[0].name === 'refs/heads/main');

  // Malformed upload-pack body: 400, server survives.
  {
    const res = await fetch(`${BASE}/${OWNER}/git-demo.git/git-upload-pack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-upload-pack-request', Authorization: `Bearer ${TOKEN}` },
      body: 'zzzznot-a-pkt-line',
    });
    check('malformed upload-pack 400', res.status === 400, `status ${res.status}`);
    const stillAlive = await client.lsRefs(OWNER, 'git-demo');
    check('server survives malformed body', stillAlive.refs.length >= 1);
  }

  // Push to a missing repo: 404.
  try {
    await client.push(OWNER, 'missing', [{ oldOid: ZERO_OID, newOid: c3, ref: 'refs/heads/main' }], { objects: [...store.values()] });
    check('push to missing repo 404', false, 'no error thrown');
  } catch (err: unknown) {
    check('push to missing repo 404', String((err as Error).message).includes('404'), (err as Error).message);
  }
} catch (err: unknown) {
  console.log('UNCAUGHT', err instanceof Error ? err.stack ?? err.message : String(err));
  failures += 1;
}

console.log(failures === 0 ? 'ALL GIT CHECKS PASSED' : `${failures} GIT CHECKS FAILED`);
server.close();
process.exit(failures === 0 ? 0 : 1);

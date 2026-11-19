// Perf probe: time the hot paths the benchmark measures (push, clone, read, write)
// plus the pack parser in isolation, to see where the milliseconds go.
import { createApp } from './app.ts';
import {
  GitClient,
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  writePack,
  type GitObject,
} from '/home/hatch/workspace/makefun/github-core-clone-01-kit/program/env/src/git-client.ts';
import { readPack as myReadPack } from './gitpack.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'shpat_testtoken0123456789abcdef0123456789abcdef';
const server = createApp();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address() as { port: number };
const BASE = `http://127.0.0.1:${address.port}`;
const client = new GitClient({ baseUrl: BASE, token: TOKEN });
const auth = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const store = new Map<string, GitObject>();
function put(type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  store.set(oid, { type, data });
  return oid;
}

// --- pack parser in isolation: a 3-object pack like the bench push carries ---
const blob = put('blob', Buffer.from('x'.repeat(1024), 'utf8'));
const tree = put('tree', buildTree([{ mode: '100644', name: 'bench-data.txt', oid: blob }]));
const commit = put('commit', buildCommit({ tree, parents: [], message: 'bench\n', timestamp: 1700000000 }));
const pack = writePack([...store.values()]);
console.log('pack bytes:', pack.length);
{
  const t0 = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i += 1) myReadPack(pack);
  console.log(`myReadPack 3-obj pack: ${((performance.now() - t0) / N).toFixed(3)} ms each`);
}

// --- full push round trip, bench style ---
await client.createRepo('adaiversen', 'bench-push');
let tip = ZERO_OID;
const contents = 'x'.repeat(1024);
{
  const t0 = performance.now();
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    const b = put('blob', Buffer.from(`${contents}${i}`, 'utf8'));
    const t = put('tree', buildTree([{ mode: '100644', name: 'bench-data.txt', oid: b }]));
    const c = put('commit', buildCommit({ tree: t, parents: tip === ZERO_OID ? [] : [tip], message: `bench ${i}\n`, timestamp: 1700000000 }));
    const objects = [...store.values()].filter((o) => [b, t, c].includes(hashObject(o.type, o.data)));
    await client.push('adaiversen', 'bench-push', [{ oldOid: tip, newOid: c, ref: 'refs/heads/main' }], { objects });
    tip = c;
  }
  console.log(`push round trip (incl. client build): ${((performance.now() - t0) / N).toFixed(3)} ms each, total ${(performance.now() - t0).toFixed(0)} ms`);
}

// --- clone: build a 200-commit repo, then 50 concurrent depth-1 clones ---
await client.createRepo('adaiversen', 'bench-clone');
{
  let ctip: string | null = null;
  const objs: GitObject[] = [];
  for (let i = 0; i < 200; i += 1) {
    const b = put('blob', Buffer.from(`content ${i}`, 'utf8'));
    const t = put('tree', buildTree([{ mode: '100644', name: 'file.txt', oid: b }]));
    const c = put('commit', buildCommit({ tree: t, parents: ctip === null ? [] : [ctip], message: `commit ${i}\n`, timestamp: 1700000000 }));
    objs.push(store.get(b) as GitObject, store.get(t) as GitObject, store.get(c) as GitObject);
    ctip = c;
  }
  await client.push('adaiversen', 'bench-clone', [{ oldOid: ZERO_OID, newOid: ctip as string, ref: 'refs/heads/main' }], { objects: objs });
  console.log('200-commit repo pushed');
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 50 }, () => client.clone('adaiversen', 'bench-clone', { depth: 1, parse: false })));
  console.log(`50 concurrent depth-1 clones: ${(performance.now() - t0).toFixed(0)} ms`);
  const t1 = performance.now();
  await client.clone('adaiversen', 'bench-clone', { depth: 1, parse: false });
  console.log(`single depth-1 clone: ${(performance.now() - t1).toFixed(2)} ms`);
}

// --- read: 2000 GETs of one issue ---
{
  await fetch(`${BASE}/api/v3/user/repos`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'bench-read' }) });
  await fetch(`${BASE}/api/v3/repos/adaiversen/bench-read/issues`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 't' }) });
  const t0 = performance.now();
  for (let i = 0; i < 2000; i += 1) {
    const res = await fetch(`${BASE}/api/v3/repos/adaiversen/bench-read/issues/1`, { headers: auth });
    await res.text();
  }
  console.log(`2000 GET issue: ${(performance.now() - t0).toFixed(0)} ms (${((performance.now() - t0) / 2000).toFixed(3)} ms each)`);
}

// --- write: 200 POST issues ---
{
  await fetch(`${BASE}/api/v3/user/repos`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'bench-write' }) });
  const t0 = performance.now();
  for (let i = 0; i < 200; i += 1) {
    const res = await fetch(`${BASE}/api/v3/repos/adaiversen/bench-write/issues`, { method: 'POST', headers: auth, body: JSON.stringify({ title: `t${i}` }) });
    await res.text();
  }
  console.log(`200 POST issue: ${(performance.now() - t0).toFixed(0)} ms (${((performance.now() - t0) / 200).toFixed(3)} ms each)`);
}

server.close();
process.exit(0);

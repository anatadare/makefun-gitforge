// Clone-path probe: time each git request type separately.
import { createApp } from './app.ts';
import {
  GitClient,
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  type GitObject,
} from '/home/hatch/workspace/makefun/github-core-clone-01-kit/program/env/src/git-client.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? 'shpat_testtoken0123456789abcdef0123456789abcdef';
const server = createApp();
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address() as { port: number };
const BASE = `http://127.0.0.1:${address.port}`;
const client = new GitClient({ baseUrl: BASE, token: TOKEN });

const store = new Map<string, GitObject>();
function put(type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  store.set(oid, { type, data });
  return oid;
}
await client.createRepo('adaiversen', 'bench-clone');
let tip: string | null = null;
const objs: GitObject[] = [];
for (let i = 0; i < 200; i += 1) {
  const b = put('blob', Buffer.from(`content ${i}`, 'utf8'));
  const t = put('tree', buildTree([{ mode: '100644', name: 'file.txt', oid: b }]));
  const c = put('commit', buildCommit({ tree: t, parents: tip === null ? [] : [tip], message: `commit ${i}\n`, timestamp: 1700000000 }));
  objs.push(store.get(b) as GitObject, store.get(t) as GitObject, store.get(c) as GitObject);
  tip = c;
}
await client.push('adaiversen', 'bench-clone', [{ oldOid: ZERO_OID, newOid: tip as string, ref: 'refs/heads/main' }], { objects: objs });

async function timeIt(name: string, n: number, fn: () => Promise<void>): Promise<void> {
  for (let i = 0; i < 5; i += 1) await fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) await fn();
  console.log(`${name}: ${((performance.now() - t0) / n).toFixed(3)} ms each`);
}

await timeIt('GET /healthz (raw fetch)', 200, async () => {
  const res = await fetch(`${BASE}/healthz`);
  await res.text();
});
await timeIt('advertisement v2', 200, async () => {
  await client.advertisement('adaiversen', 'bench-clone', 'git-upload-pack');
});
await timeIt('ls-refs', 200, async () => {
  await client.lsRefs('adaiversen', 'bench-clone');
});
await timeIt('fetch depth-1 (parse)', 200, async () => {
  await client.fetch('adaiversen', 'bench-clone', { wants: [tip as string], depth: 1 });
});
await timeIt('fetch depth-1 (no parse)', 200, async () => {
  await client.fetch('adaiversen', 'bench-clone', { wants: [tip as string], depth: 1, parse: false });
});
await timeIt('full clone depth-1', 50, async () => {
  await client.clone('adaiversen', 'bench-clone', { depth: 1, parse: false });
});
// Raw fetch POST of the same fetch body, bypassing client parsing:
{
  const { encodePktLines } = await import('/home/hatch/workspace/makefun/github-core-clone-01-kit/program/env/src/git-client.ts').catch(() => ({ encodePktLines: null as unknown as null }));
  void encodePktLines;
}
server.close();
process.exit(0);

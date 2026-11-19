[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/anatadare/makefun-gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/anatadare/makefun-gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# makefun-gitforge

A GitHub-compatible git forge in a single Node process, built for the [make.fun](https://make.fun/bounty/github-core-clone-01) competition `github-core-clone-01`. One server speaks all four surfaces GitHub clients use:

- **Git smart HTTP** at `/{owner}/{repo}.git` (info/refs, upload-pack, receive-pack; protocol v0 and v2, shallow and deepening fetches, fast-forward enforcement)
- **REST v3** under `/api/v3` (repos, branches, commits, refs, contents, labels, issues, pull requests with squash merge)
- **GraphQL** at `/api/graphql` (the queries and mutations `gh` and `github-mcp-server` send, plus introspection)
- **MCP** at `/mcp` (JSON-RPC 2.0, modern `server/discover` era with the legacy `initialize` handshake as a fallback)

No git binary, no npm dependencies, no disk I/O in request paths: the whole forge is in-memory, written in erasable TypeScript on Node built-ins only.

## Run

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the trial env at `$MAKEFUN_ENV_URL`, and exits when the env says the trial is done. It needs `MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN` (the bearer token every API call carries), `MAKEFUN_TRIAL_SEED` and `MAKEFUN_TRIAL_NOW` (the deterministic clock: no request path reads the wall clock or `Math.random()`).

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | The entry/env lifecycle (starter file, kept as it ships) |
| `app.ts` | The HTTP server: routing, auth, body reading, error rendering |
| `store.ts` | The in-memory store: repos, objects, refs, issues, pull requests, trees, diffs, three-way merge |
| `gitpack.ts` | Git objects and PACK v2: hashing, commit/tree/tag codecs, pack read/write, delta resolution |
| `gitfetch.ts` | Fetch planning: wants/haves negotiation, depth, shallow and unshallow boundaries |
| `git-http.ts` | Smart HTTP: v0/v2 advertisements, ls-refs, fetch, receive-pack with report-status |
| `pktline.ts` | pkt-line framing and sideband packets |
| `api-rest.ts` | REST v3 routes |
| `api-graphql.ts` | A small GraphQL parser and executor |
| `api-mcp.ts` | MCP JSON-RPC methods and tools |
| `http-util.ts` | Shared JSON, pagination and error helpers |
| `determinism.ts` | Trial timestamps, seeded ids, the viewer identity |

## Tests

Four suites exercise the forge with the kit's own clients plus plain fetch calls:

```sh
MAKEFUN_SHOP_TOKEN=shpat_testtoken0123456789abcdef0123456789abcdef \
MAKEFUN_TRIAL_NOW=2026-03-15T12:00:00Z MAKEFUN_TRIAL_SEED=12345 \
node --experimental-strip-types smoke.ts        # REST, GraphQL, MCP basics
node --experimental-strip-types git-test.ts     # git smart HTTP via GitClient
node --experimental-strip-types graphql-test.ts # the suite's 18 GraphQL documents
node --experimental-strip-types mcp-test.ts     # MCP via McpClient
```

`grade-local` on the kit (process driver) scores the entry at **988/1000**: 120/120 conformance checks, agent 200/200, perf 188/200, with the replay check matching byte for byte.

## License

MIT.

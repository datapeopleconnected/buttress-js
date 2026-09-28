# Benchmarking

`npm run bench` measures how fast a build serves the REST API, and `npm run bench:compare` compares two
measurements. Use them to see whether a change made Buttress faster or slower.

## Measure a Build

```bash
npm run build
npm run bench
```

The benchmark starts the build in `dist/` as its own REST process. It creates an app with a user under a policy,
seeds 1,000 records, then sends each scenario's request with 10 requests in flight. Scenarios take turns over 5
rounds of 3 seconds each, about a minute and a half in total. It prints a summary and writes the results to
`bench-results/<commit>-<time>.json`.

| Scenario | Request |
| --- | --- |
| get-one | GET one record by id |
| list | GET all 1,000 records, streamed |
| search | SEARCH records by name |
| post | POST one record |
| put | PUT a path update to a record |

For each scenario it records requests per second, latency (p50, p90, p99 and max) and, on Linux, the server's CPU
time per request and memory use.

## Compare Two Builds

Measure each build on the same machine, then compare the results:

```bash
git checkout develop && npm run build && npm run bench -- --out bench-results/develop.json
git checkout my-branch && npm run build && npm run bench -- --out bench-results/my-branch.json
npm run bench:compare -- bench-results/develop.json bench-results/my-branch.json
```

To measure a build without switching branches, point `--dist` at it, for example another checkout's build:
`npm run bench -- --dist ../other-checkout/dist`.

`bench:compare` shows each metric's median for both builds and the change between them. It marks a metric
**better** or **worse** only when every round of one build beat every round of the other and the medians differ by
at least 5% (`--threshold` changes this). Smaller or inconsistent differences are left unmarked as run-to-run noise.

Timings depend on the machine, so compare results measured on the same machine, with no other heavy work running.
`bench:compare` warns when two results come from different settings, CPUs, or Node, MongoDB or Redis versions.

## Requirements

MongoDB and Redis, set with `BENCH_MONGO_URL` (default `mongodb://localhost:27017`) and `BENCH_REDIS_URL` (default
`redis://localhost:6379`). The benchmark uses its own database, `bjs-bench-prod`, and Redis key prefix,
`bjs-bench:`. It clears both before and after a run and leaves other data alone.

## Options

`npm run bench -- --help` lists them: `--dist`, `--out`, `--label`, `--duration`, `--rounds`, `--concurrency`,
`--scenarios` and `--port` (default 8100).

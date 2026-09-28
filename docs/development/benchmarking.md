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

A machine can speed up or slow down over the few minutes two benchmarks take, so whichever build runs second can
look better or worse than it is. To even that out, measure the builds in turns and give each side as a
comma-separated list of its results files. `bench:compare` pools each side's rounds:

```bash
npm run bench -- --dist ../develop-checkout/dist --rounds 3 --out bench-results/base-1.json
npm run bench -- --rounds 3 --out bench-results/head-1.json
npm run bench -- --rounds 3 --out bench-results/head-2.json
npm run bench -- --dist ../develop-checkout/dist --rounds 3 --out bench-results/base-2.json
npm run bench:compare -- bench-results/base-1.json,bench-results/base-2.json bench-results/head-1.json,bench-results/head-2.json
```

Timings depend on the machine, so compare results measured on the same machine, with no other heavy work running.
`bench:compare` warns when two results come from different settings, CPUs, or Node, MongoDB or Redis versions.

## In CI

The **Benchmark** workflow runs on every push to `develop` or `main` and on every pull request. It skips changes
that only touch docs or Markdown. It builds the new commit and the one it builds on: the branch's previous tip for
a push, or the base for a pull request. It benchmarks both on the same runner, in turns (base, head, head, base, 3
rounds each), and puts the `bench:compare` table in the job summary. The results files are kept as the `bench-results` artifact for 30 days.

It's report-only. Timings on shared CI runners vary from run to run, so it never fails over them, though it adds a
warning when a metric is marked worse. Before acting on a change it reports, confirm it by benchmarking both
builds locally. To compare against something else, run the workflow by hand (Actions → Benchmark → Run workflow)
and give it a branch, tag or commit as the base.

## Requirements

MongoDB and Redis, set with `BENCH_MONGO_URL` (default `mongodb://localhost:27017`) and `BENCH_REDIS_URL` (default
`redis://localhost:6379`). The benchmark uses its own database, `bjs-bench-prod`, and Redis key prefix,
`bjs-bench:`. It clears both before and after a run and leaves other data alone.

## Options

`npm run bench -- --help` lists them: `--dist`, `--out`, `--label`, `--duration`, `--rounds`, `--concurrency`,
`--scenarios` and `--port` (default 8100).

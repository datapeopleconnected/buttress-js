# Performance: benchmarks, I/O budgets and Server-Timing

## Benchmarking a build

`npm run bench` ([test/bench/run.mjs](../test/bench/run.mjs)) measures a build's REST throughput, latency and
server CPU per request, and writes a results file; `npm run bench:compare -- <base.json> <head.json>`
([test/bench/compare.mjs](../test/bench/compare.mjs)) compares two. Either side can be a comma-separated list of
one build's results files, whose rounds are pooled and the medians recomputed. Usage is in
[docs/development/benchmarking.md](../docs/development/benchmarking.md).

It boots the build from `--dist` (default `dist/`, so build first) as its own single-instance REST process, with
`ENV_FILE=bench` so no `.<env>.env` file overrides its settings. Isolation comes from the app code `bjs-bench`: it
names the database (`bjs-bench-prod`) and prefixes every Redis key and NRP channel, and the benchmark clears only
those. A new scenario goes in the `SCENARIOS` map in run.mjs.

In CI, [.github/workflows/bench.yml](../.github/workflows/bench.yml) benchmarks each push to `develop`/`main`, and
each PR, against the commit it builds on, and puts the comparison in the job summary. The two builds take turns
(base, head, head, base) so drift over the job, such as a cold runner warming up, doesn't all land on one side. It
is report-only and runs apart from the Tests workflow, so a slow or failing benchmark can't hold up the Docker
publish.

## I/O budgets

[test/perf/io-budgets.json](../test/perf/io-budgets.json) holds the exact number of MongoDB commands, Redis commands
and NRP publishes each common request causes. [test/e2e/perf/io-budgets.test.js](../test/e2e/perf/io-budgets.test.js)
checks them as the last suite of `npm run test:e2e`, so a budget failure fails CI and stops the Docker image
publishing. Counts are the same on every machine, so a failure is always a real change in the work a request does.
Budgets are exact both ways: a request doing less than its budget fails too, which locks improvements in.

Scenarios:

- **REST**: the generated schema CRUD routes (GET one, LIST, SEARCH, count, POST, bulk add, path PUT, DELETE), sent
  with a user token under the `admin-access` policy so access control runs. Each is sent once to warm the token,
  policy and schema caches, then measured three times; the three must match.
- **SPR**: one REST write fanned out to four connected sockets: two on `admin-access` (evaluated once for all its
  tokens) and two on `env-user-query`, which refers to the user, so the SPR evaluates it per connected token.

Run just this suite with `npm run build && npm run test:io-budgets`. Like `test:e2e`, it wipes the test database and
Redis first.

### When a budget test fails

1. Read the failure: it lists each operation whose count changed (`mongo find: budget 3, now 4 (+1)`), the request's
   new counts on a `Now:` line, and every operation in order with its collection, Redis key or NRP channel.
2. Find the change that added or removed those operations.
3. If the request now does more, fix the regression. If the extra work is genuinely needed, or the request now does
   less, propose the `Now:` counts to the user with the reason, and update `io-budgets.json` once they approve.
   Budget changes are always the user's decision.

"Different I/O on identical runs" means the request's work isn't repeatable, for example a cache that is still cold
on the second request. Make it repeatable before budgeting it.

### Adding a budget

Add the request to the test's `requests` map (or a new `describe` for another scenario), run the suite, check the
reported operations are the work the request should do, then add them to `io-budgets.json` under the reported name.

### How counting works

[IOStats](../src/helpers/io-stats.ts) counts I/O against a **unit of work** through AsyncLocalStorage, so work a unit
starts keeps counting after it returns:

- A REST request is unit `<request id>` (its `x-bjs-request-id` header), opened in `RoutesMiddleware._createContext`.
  It includes the work left running after the response: the activity log insert and the broadcasts.
- The SPR handles every `rest:activity` as the one unit `spr`. The test forgets `spr` before each write, so measure
  one write at a time.

Hooks: `MongodbAdapter.connect` turns on the driver's command monitoring, so a Mongo client counts only if it
connected after `IOStats.enable()`. Redis commands come from node-redis's `node-redis:command` diagnostics channel,
without PUBLISH. `NodeRedisPubsub.publish` counts NRP publishes by channel, without the scope prefix.

Counting is off unless `IOStats.enable()` is called, and `run()`/`record()` then cost a boolean check. Counts live in
the process that did the work, so budgets need single-instance mode (`BUTTRESS_APP_WORKERS=0`) with every process
type booted in the test process, which is how e2e runs.

## Server-Timing header

`BUTTRESS_LOGGING_SERVER_TIMING=TRUE` makes `Route._respond` add a `Server-Timing` header, built by
`Helpers.serverTimingHeader` from `req.context.timings`: `auth` (token), `ac` (access control), `validate`, `exec`,
and `total`, the time until the response starts (so it excludes streaming a body). It is off by default because it
exposes internal timings.

`req.context.timings` holds `Timer.interval` values: **seconds** since the request started, marking the start of each
stage. The header converts them to milliseconds. A new stage needs a mark at its start (as
`accessControlPolicyMiddleware` sets `accessControl`) and an entry in `SERVER_TIMING_STAGES`.

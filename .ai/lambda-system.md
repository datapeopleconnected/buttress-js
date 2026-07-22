# Lambda System

Lambdas are app-scoped, git-deployed JS functions executed in an `isolated-vm` sandbox. See
[docs/applications/lambda.md](../docs/applications/lambda.md) for the user-facing shape (`trigger` types
`CRON`/`PATH_MUTATION`/`API_ENDPOINT`, `git.{url,branch,hash,entryFile,entryPoint}`, `policyProperties`).
The runtime is split across two classes that only exist in the **Lambda process**
([architecture.md](architecture.md)):

## LambdaManager (`src/lambda/lambda-manager.ts`) — one per primary process

Coordinates work; never executes lambda code itself. Talks to `LambdaRunner` workers purely over NRP.

- **Queue loop**: `_processQueue()` on a timer (`Config.timeout.lambdaManager`, default 10s) calls
  `__getPendingLambdaExec()` — queries `LambdaExecutionSchemaModel` for `status: PENDING` rows where
  `executeAfter` has passed (or is null), batched (`_queueBatchSize = 25`), sorted by `priority` then
  `executeAfter` — then `__announcePendingExecutions()` emits one `lambda:worker:announce` per pending
  execution. `ExecPriority` enum orders `CRON` (0) < `PATH_MUTATION` (50) < `API_ENDPOINT` (55) <
  `API_ENDPOINT_SYNC` (90) < `URGENT` (100).
- **Worker handshake**: workers reply `lambda:worker:available`; the manager assigns via
  `lambda:worker:execute` and tracks the assignment in `_workerMap` (workerId→executionId) and
  `_inflightExecutions`, so a second worker announcing for the same execution is ignored. Workers report
  back `lambda:worker:finished`/`errored`/`overloaded`, each of which untracks the assignment.
- **Path-mutation lambdas**: `_loadLambdaPathsMutation()` caches every executable lambda with a
  `PATH_MUTATION` trigger into `_pathsMutation` at boot (and on `rest:worker:rebuild-path-mutation-cache`).
  When a REST write fires `rest:worker:notifyLambdaPathChange` (see `Route._checkBasedPathLambda()` in
  [routing.md](routing.md)), `_checkMatchingPaths()`/`_checkMatchingRelativePaths()` do wildcard path
  matching (`schema.*`, `schema.id.field`, trailing `*`) against each cached lambda's `trigger.pathMutation.paths`.
  Matches are **debounced** per lambda+change-hash (`_debounceLambdaTriggers`, 1s window,
  `_maximumRetry = 500`) before a `LambdaExecution` row is actually created — this coalesces bursts of
  writes into one execution.
- `_setupLambdaFolders()` ensures `Config.paths.lambda.{code,plugins}` exist and wipes
  `Config.paths.lambda.bundles` on init (webpack bundles are rebuilt fresh each boot, not reused across
  restarts).

## LambdaRunner (`src/lambda/lambda-runner.ts`) — one per worker process

Each worker is typed at spawn time (`LambdaType`: `API_ENDPOINT` | `PATH_MUTATION` | `CRON` | `ALL`) —
`BootstrapLambda.__getLambdaWorkerType()` assigns types round-robin up to
`Config.lambda.{apiWorkers,pathMutationWorkers,cronWorkers}`, remaining workers get `ALL`. A worker only
picks up `lambda:worker:announce` messages matching its own type (or if it's `ALL`).

Execution (`execute()`), per invocation:

1. Resolves the lambda's own token (`_lambdaId` on `Token`) and, if the execution carries a `_tokenId`
   (impersonation — e.g. an API endpoint call authenticated as a specific user), resolves that token +
   user too, and uses *that* token's value inside the sandbox instead of the lambda's own.
2. `_getLambdaModulesName()` + `bundleLambdaModules()` — webpack-bundles `@buttress/api`,
   `@buttress/snippets`, `sugar`, and the lambda's own entry file
   (`Config.paths.lambda.code/lambda-<gitHash>/<entryFile>`) into `Config.paths.lambda.bundles/*.js`,
   skipping any bundle that already exists on disk. `_registerLambdaModules()` then
   `compileScriptSync().runSync()`s each bundle into the **shared isolate context** created once in
   `init()` (`ivm.Isolate` → `createContextSync()` → `this._jail`), tracked in `_registeredBundles` so a
   module is only registered once per worker lifetime.
3. Injects everything the lambda code needs as `ivm.ExternalCopy` globals: `buttressOptions`
   (pre-configured `@buttress/api` client pointed at this Buttress instance, authenticated as the
   resolved token), `lambdaInfo`, `lambdaData`/`lambdaQuery`/`lambdaRequestHeaders` (the triggering
   request, for `API_ENDPOINT`), `lambdaExecution`.
4. Runs a small wrapper script inside the isolate that does `Buttress.init(buttressOptions, true)`,
   `require()`s the bundled entry file (a shim resolving `lambdaModules` names to isolate globals),
   instantiates it, and calls `lambdaCode[entryPoint]()`.
5. On success/failure updates `LambdaExecution.status` (`RUNNING`→`COMPLETE`/`ERROR`) and, for
   `API_ENDPOINT` lambdas, emits `lambda:worker:execution-result` (keyed by `reqId`) back to the REST
   process that's holding the HTTP response open — see `_queueLambdaAPIExecution` in
   [src/routes/lambda-setup.ts](../src/routes/lambda-setup.ts).
6. If the completed execution had a `nextCronExpression`, a new `PENDING` `LambdaExecution` is queued
   automatically (`_updateDBLambdaFinishExecution`) — this is how recurring CRON lambdas keep going;
   there's no separate cron scheduler process.

`installLambdaPackages()` (installing a lambda's own `package.json` deps against an allow-list) exists
but is commented out of the active `execute()` path — currently unused/dead unless re-wired.

## Key invariant

Only one `isolated-vm` `Isolate`/`Context` exists per `LambdaRunner` (i.e. per worker process), reused
across every execution that worker handles. A `LambdaRunner` has a `working` boolean guard — if it's
`true` it declines new work (`lambda:worker:overloaded`) rather than running two lambdas concurrently in
the same isolate. Don't assume lambda executions on the same worker are isolated from each other beyond
what `Buttress.clean()` does at the start of the wrapper script.

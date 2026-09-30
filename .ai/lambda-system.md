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
  back `lambda:worker:finished`/`errored`/`overloaded`, each of which untracks the assignment. Each queue
  pass also gives up on an assignment older than the runner's timeout plus a minute
  (`_expireLostAssignments()`): the worker is freed, and an execution still RUNNING or PENDING is set to
  ERROR (`lambda_worker_lost`) and its API caller answered, never retried, so a lambda doesn't run twice.
- **Path-mutation lambdas**: `_loadLambdaPathsMutation()` caches every executable lambda with a
  `PATH_MUTATION` trigger into `_pathsMutation` at boot (and on `rest:worker:rebuild-path-mutation-cache`,
  which the lambda routes publish when a path-watching lambda is updated, redeployed or deleted, or any lambda's
  triggers change). A rebuild replaces the list once it's loaded, so path changes meanwhile still match.
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
picks up `lambda:worker:announce` messages matching its own type (or if it's `ALL`). The primary main hands the
types out over NRP (`lambdaProcessWorker:worker-initiated` → `lambdaProcessMain:worker-type`) and keeps which
worker id has which. When a worker exits, its main publishes `lambdaProcessMain:worker-exited` and the primary
main takes the type back, so the replacement gets it.

An execution of a lambda whose `executable` is `false` isn't run: `handleLambdaExecutionMessage()` records it
as ERROR (`lambda_is_not_executable`), answers an API caller 400, and still queues a cron's next run, so turning
a lambda off pauses its cron.

Execution (`execute()`), per invocation:

1. Resolves the lambda's own token (`_lambdaId` on `Token`) and, if the execution carries a `_tokenId`
   (impersonation — e.g. an API endpoint call authenticated as a specific user), resolves that token +
   user too, and uses *that* token's value inside the sandbox instead of the lambda's own.
2. `_getLambdaModulesName()` + `bundleLambdaModules()` — webpack-bundles `@buttress/api`,
   `@buttress/snippets`, `sugar`, and the lambda's own entry file
   (`Config.paths.lambda.code/lambda-<gitHash>/<entryFile>`) into `Config.paths.lambda.bundles/*.js`,
   skipping any bundle that already exists on disk. Each build runs in a `.build-*` folder of its own inside
   the bundles folder and its files are renamed into place only once it succeeds, so a worker that finds a
   bundle on disk never reads one another worker is still writing, or one from a failed build (webpack writes
   a bundle even when the build has errors). A bad read used to stick: the compiled script is cached for the
   isolate's lifetime and shared by every app's context. The lambda's own code is the module
   `lambda_<id>_<gitHash>`, so a redeploy's code is a new module rather than the old one again; it's rebuilt
   for every run only when the hash is `HEAD` (which moves with each pull) or `LAMBDA_DEV_RELOAD=TRUE`.
   `_registerLambdaModules()` then `compileScriptSync().runSync()`s each bundle into the executing app's
   context (`_useAppContext()`: one context per app, least recently used let go past 32), tracked in that
   context's `_registeredBundles` so a module is registered once per context. Compiled scripts are kept in
   `_compiledBundles` and shared by the contexts; a lambda's older builds are released when a new one loads.
3. Injects everything the lambda code needs as `ivm.ExternalCopy` globals: `buttressOptions`
   (pre-configured `@buttress/api` client pointed at this Buttress instance, authenticated as the
   resolved token), `lambdaInfo`, `lambdaData`/`lambdaQuery`/`lambdaRequestHeaders` (the triggering
   request, for `API_ENDPOINT`), `lambdaExecution`.
4. Runs a small wrapper script inside the isolate that does `Buttress.init(buttressOptions, true)`,
   `require()`s the bundled entry file (a shim resolving `lambdaModules` names to isolate globals),
   instantiates it, and calls `lambdaCode[entryPoint]()`.
5. On success/failure updates `LambdaExecution.status` (`RUNNING`→`COMPLETE`/`ERROR`), in the same write
   pushing onto its `logs` what the lambda logged (`lambda.log*`/`console.*`, collected by `IsolateBridge`, up
   to 1 MB a run) and, on failure, why. A failure to record the error is only logged. For
   `API_ENDPOINT` lambdas, emits `lambda:worker:execution-result` (keyed by `reqId`) back to the REST
   process that's holding the HTTP response open — see `_queueLambdaAPIExecution` in
   [src/routes/lambda-setup.ts](../src/routes/lambda-setup.ts).
6. If the completed execution had a `nextCronExpression`, a new `PENDING` `LambdaExecution` is queued
   automatically (`_updateDBLambdaFinishExecution`) — this is how recurring CRON lambdas keep going;
   there's no separate cron scheduler process.

`installLambdaPackages()` (installing a lambda's own `package.json` deps against an allow-list) exists
but is commented out of the active `execute()` path — currently unused/dead unless re-wired.

## Key invariant

One `isolated-vm` `Isolate` exists per `LambdaRunner` (i.e. per worker process), with a `Context` per app,
reused across every execution of that app's lambdas on that worker; a run that times out disposes the isolate
and the runner starts a new one. A `LambdaRunner` has a `working` boolean guard — if it's `true` it declines
new work (`lambda:worker:overloaded`) rather than running two lambdas concurrently in the same isolate. Don't
assume executions of one app's lambdas on the same worker are isolated from each other beyond what
`Buttress.clean()` does at the start of the wrapper script.

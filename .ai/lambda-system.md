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
   `sugar`, any shared modules the lambda declares (`git.sharedModules`), and the lambda's own entry file
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
   Before that, `execute()` makes sure the isolate can take the lambda, see
   [Replacing the isolate](#replacing-the-isolate).
3. Injects everything the lambda code needs as `ivm.ExternalCopy` globals: `buttressOptions`
   (pre-configured `@buttress/api` client pointed at this Buttress instance, authenticated as the
   the lambda's own token), `lambdaInfo`, `lambdaData`/`lambdaQuery`/`lambdaRequestHeaders` (the triggering
   request, for `API_ENDPOINT`), `lambdaExecution`.
   `lambdaInfo.callerType` and `lambdaInfo.callerId` say who called an API endpoint: the owner of the token it was
   called with, from the execution's `_callerTokenId`, which the token's type names (`user`: its user, `lambda`: its
   lambda, `app`: its app). Never the token's id or value. Both are `null` when the token isn't of the lambda's own
   app, has gone since, or is of another type, for a CRON or PATH_MUTATION execution, and for a PUBLIC endpoint that
   doesn't use the caller's token, which never reads the caller's token. For any other endpoint they're set whether or
   not it uses the caller's token. A token that has gone since doesn't stop the run.
   Unlike `_tokenId` (the token the execution runs as), they never change who the lambda acts as.
   An `API_ENDPOINT` trigger with `useCallerToken` runs as its caller, but the caller's token never enters the
   isolate: the runner keeps it on the run (`LambdaRun.caller`, see [Runs kept apart](#runs-kept-apart)), and the
   lambda's default `appToken` is the placeholder
   `BUTTRESS_CALLER`. The host `_fetch` replaces that placeholder in the `Authorization` header of a request to
   this instance (origin match) with `Bearer <caller token>`, dropping a `?token=`. A call that names a token of
   its own, e.g. `save(data, { token: lambdaInfo.lambdaToken })`, and requests to other hosts are untouched.
4. Runs a small wrapper script inside the isolate that does `Buttress.init(buttressOptions, true)`,
   `require()`s the bundled entry file (a shim resolving `lambdaModules` names to isolate globals),
   instantiates it, and calls `lambdaCode[entryPoint]()`.
5. On success/failure updates `LambdaExecution.status` (`RUNNING`→`COMPLETE`/`ERROR`), in the same write
   pushing onto its `logs` what the lambda logged (`lambda.log*`/`console.*`, collected by the run, up
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
reused across every execution of that app's lambdas on that worker. A `LambdaRunner` has a `working` boolean
guard — if it's `true` it declines new work (`lambda:worker:overloaded`) rather than running two lambdas
concurrently in the same isolate. Don't assume executions of one app's lambdas on the same worker are isolated
from each other beyond what `Buttress.clean()` does at the start of the wrapper script, and what
[Runs kept apart](#runs-kept-apart) gives: globals an app's lambda sets stay in its context for the next.

## Runs kept apart

A lambda can return leaving work running, e.g. `sleep(50).then(() => lambda.setResult(...))`, and the context it ran in
is kept for the app's next run (another app's lambda runs in between in the same isolate). Host functions are set on a
context once and get no identity from the isolate when called, so what they act for is a `LambdaRun`
([src/lambda-helpers/lambda-run.ts](../src/lambda-helpers/lambda-run.ts)) rather than state shared by every run.

- `execute()` starts one (`LambdaRun.start()`) for the app's context once the lambda's tokens are resolved, just before
  its modules load, with the lambda's id, git hash and caller. It ends in `execute()`'s `finally`, after the execution
  is recorded and an API caller answered, so it never outlasts `working`.
- Every host function (`IsolateBridge`'s logs and plugins, and `_setResult`, `_fetch`, `_sleep`, `_updateMetadata`, the
  crypto ones and so on in `helpers.ts`, through `forRun()`) asks `LambdaRun.in(context, name)` for the run going in
  the context it was set on, and acts for that run from then on: its result, logs, lambda id, git hash and caller.
  With none (between runs, or another app's run going) the call is dropped with a warning and never answered. Only
  `_cryptoRandomBytesSync`, which acts for no one and has to return at once, isn't bound.
- When a run ends its `AbortSignal` cancels its `sleep()`s (`timers/promises`) and aborts its requests (the `signal` of
  `nodeHttpFetch()`), and `run.answer()` stops passing anything back to the isolate for it: no resolve, reject or
  `fetch` text callback. Work it started that can't be cancelled (a metadata write, a PDF) finishes, unanswered.

So once a run has ended nothing calls back into its code, and its code left behind has no way to resume and call a host
function during a later run: the isolate has no timers or I/O of its own. That rests on the host never answering it, not
on telling one run's code from another's, which the isolate can't. The exception is an app's own code: a later run of
the app can call functions an earlier one left in the context, which then act for the later run.

## Values a lambda gives the host

`ExternalCopy` copies a value out of the isolate keeping its shared references, so a small value can stand for one that
unfolds to far more (`let n = {}; for (...60) n = {a: n, b: n}` is 2^60 leaves), and the host writing it out
(`JSON.stringify` of a result or log, a request body, a metadata write) would block the worker's event loop outside the
isolate's timeout and memory limit. `src/lambda-helpers/lambda-value.ts` measures what a value would take written out in
time linear in what it holds (`unfoldedSize`, each object walked once), and every host function checks what it's given
before using it: `forRun()`, `_fetch` and plugins reject the call (`refusedValue`), `_setResult` makes the result an
error, and a log over the limit is replaced by a note. The limit, `MAX_LAMBDA_VALUE_BYTES`, is 128 MB, the isolate's own
heap, so only a value with shared references can reach it. A cycle is refused too, except in a log, which is written as
before.

## Replacing the isolate

The isolate has isolated-vm's default memory limit (128 MB, reported as a `heap_size_limit` of 131 MB;
`Constants.MEMORY_LIMIT` is unset), and a heap that fills ends the lambda running in it and disposes the isolate.
Loading a new app's context takes up to 12 MB at its peak with the real `@buttress/api` and `sugar` bundles, and
about 4-5 MB of it stays once garbage is collected, more with a lambda's own code and shared modules. The 32
contexts `Constants.APP_CONTEXTS` allows therefore don't fit (a measured run with only those two bundles lost the
isolate at the 29th), and the compiled bundles of deleted lambdas stay in `_compiledBundles` for as long as the
isolate lives (`_releaseCompiledLambda()` only lets go of other builds of the same lambda id).
Before this was handled, an isolate disposed for its memory left every later lambda on the worker failing with
`Isolated is disposed` (isolated-vm's spelling), cron lambdas included, until the process restarted.

`_replaceIsolate()` disposes the isolate, which stops whatever is still running in it, and calls
`_createIsolate()`. Contexts and bundles are made again as lambdas need them, about 100 ms for the first app's
bundles. It happens when:

- **A run times out**, in `_runLambdaScript()`: disposing is what stops code still running after an `await`.
- **The isolate has been disposed** (`_replaceDisposedIsolate()`), as a lambda or a module load that runs it out of
  memory leaves it. `execute()`'s catch block replaces it, so the next lambda gets a working one, and `execute()`
  checks again as it starts, for anything that disposed it between lambdas. The failing execution stays an error,
  answered to an API caller like any other, and is never run again: the lambda may have had side effects.
- **The heap is mostly full** (`_recycleFullIsolate()`), checked as `execute()` starts. If the isolate's
  `used_heap_size` plus `externally_allocated_size` (memory outside the heap, which counts against the same limit)
  is more than `Constants.HEAP_RECYCLE_THRESHOLD` (0.6) of its `heap_size_limit`, it's replaced before the lambda
  starts rather than failing it partway. All of the isolate goes, not the least recently used context: a released
  context only frees its memory once the isolate next collects garbage, and the compiled bundles belong to the
  isolate rather than a context. 60% (79 MB at the default limit) leaves 52 MB, enough for the next app's context
  and the lambda's own memory, with `used_heap_size` counting up to 10 MB of garbage not yet collected.

Both checks happen with no lambda running in the isolate: `working` is set before `handleLambdaExecutionMessage()`
starts and cleared only once `execute()` has finished, and that is the only place `execute()` is called from, so a
second lambda can't reach it meanwhile (`lambda:worker:execute` is declined as overloaded instead).

This doesn't help against a lambda that allocates in a tight loop, which can outrun isolated-vm's check of the
limit. The isolate may then be lost to V8 altogether, and `onCatastrophicError` in `_createIsolate()` aborts the
worker process. Growth in steps, as loading modules into new contexts is, is stopped cleanly.

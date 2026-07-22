# Architecture

ButtressJS is a single TypeScript codebase (`src/`, compiled to `dist/`) that boots into **four different
process types** from the same source tree. Which one you get depends only on which entry script runs.

## Process types

| Process | Entry script (shell) | Entry module | Bootstrap class | Purpose |
| --- | --- | --- | --- | --- |
| REST | `bin/app.sh` | [src/bin/app.ts](../src/bin/app.ts) | [BootstrapRest](../src/bootstrap-rest.ts) | HTTP API: core routes + generated per-app schema CRUD routes |
| Socket | `bin/app-socket.sh` | [src/bin/app-socket.ts](../src/bin/app-socket.ts) | [BootstrapSocket](../src/bootstrap-socket.ts) | Socket.IO realtime delivery, data-sharing sockets |
| Lambda | `bin/app-lambda.sh` | [src/bin/app-lambda.ts](../src/bin/app-lambda.ts) | [BootstrapLambda](../src/bootstrap-lambda.ts) | Runs `LambdaManager` (primary) + `LambdaRunner` workers |
| SPR (Socket Policy Router) | `bin/app-spr.sh` | [src/bin/app-spr.ts](../src/bin/app-spr.ts) | [BootstrapSocketPolicyRouter](../src/bootstrap-spr.ts) | Consumes REST activity, evaluates policies per connected token, decides what to broadcast |

`bin/buttress.sh` starts all four. There is no "monolith" mode — REST, Socket, Lambda and SPR are always
separate OS processes, even in local/dev, and they only talk to each other over **Redis** (NRP pub/sub,
see below) and shared **MongoDB** state.

## Bootstrap lifecycle (`src/bootstrap.ts`)

Every process type extends the abstract [`Bootstrap`](../src/bootstrap.ts) class, which implements a
Node `cluster`-based primary/worker model:

1. `new BootstrapXxx()` — constructor picks worker count from `Config.app.workers` (or CPU count).
2. `.init()` — connects the primary datastore and NRP, registers per-process services into a
   `Services` map (`Map<string, unknown>`, keyed by strings like `'nrp'`, `'modelManager'`,
   `'policyCache'`, `'redisClient'`), then calls `__createCluster()`.
3. `__createCluster()` — `cluster.isPrimary` branches into `__initMain()` (primary: sets up
   NRP listeners, spawns N `cluster.fork()` workers via `__spawnWorkers()`, waits for all workers to
   report `worker:initiated`) or `__initWorker()` (worker: does the actual REST/Socket/Lambda/SPR work).
4. Primary and worker processes talk over **Node IPC** (`process.send` / `worker.send`), not just
   Redis — e.g. REST's primary tells workers to regenerate app routes after a schema change
   (`app-schema:updated` → `notifyWorkers`), and Socket's primary hands off raw TCP connections to a
   worker via `notifyWorker(idx, payload, connection)` using IP-hash routing (`__indexFromIP`).
5. `BUTTRESS_APP_WORKERS=0` runs "single instance mode" — `__spawnWorkers()` just calls
   `__initWorker()` directly in the primary process instead of forking.

Each `BootstrapXxx` subclass overrides `__initMain` / `__initWorker` / `__handleMessageFromMain` /
`__handleMessageFromWorker` / `clean()`. Read the relevant subclass, not the base class, to understand
what a given process actually does on startup.

### Services map

Bootstrap classes populate `this.__services` (a `Map<string, unknown>`) and pass it down to `Model`,
`Routes`, `Route`, and model instances. Common keys: `nrp` (NodeRedisPubsub), `redisClient`,
`policyCache` (`PolicyCache`), `modelManager` (the singleton `Model`), `sdsRouting` (REST only). This is
the only dependency-injection mechanism in the codebase — there's no DI container.

## Data flow (REST write → realtime delivery)

1. Client `POST`s to `/<apiPath>/api/v1/<schema>` on the REST process.
2. Express middleware chain (see [routing.md](routing.md)) authenticates the token, resolves
   `req.context.authApp` / `authUser`, and runs the access-control policy middleware
   (see [access-control.md](access-control.md)).
3. The generated schema route ([src/routes/schema-routes](../src/routes/schema-routes)) calls into the
   app's `StandardModel` instance, which writes through a `Datastore` adapter (MongoDB by default).
4. `Route._boardcastData()` emits an `rest:activity` event over NRP/Redis with the full mutation payload
   (`RESTActivity`), and separately emits `rest:worker:notifyLambdaPathChange` if the write matches a
   path any lambda cares about.
5. The **SPR** process's primary picks up `rest:activity`, resolves which cached policies/tokens care
   about that schema+verb, evaluates each policy's query/projection against the entity, and re-emits a
   filtered `spr:activity` event per token (or per policy, batched in groups of 1000 token ids).
6. Each **Socket** worker's `_workerOnSPRActivity` listens for `spr:activity` and emits `db-activity` to
   the Socket.IO room(s) for the matching app namespace/tokens, and to `/stats` for global counters.
7. If the write matched a `PATH_MUTATION` lambda trigger, the **Lambda** primary's `LambdaManager` debounces
   and eventually creates a `LambdaExecution`, then announces it to `LambdaRunner` workers over NRP.

This REST → SPR → Socket split exists so that expensive policy evaluation for realtime delivery doesn't
run inline in the REST request path, and so a single SPR can serve many Socket workers.

## Multi-tenancy

A single Buttress deployment hosts multiple **apps** (`AppSchemaModel`, collection `apps`). Each app has
its own `apiPath` (mounted as an Express sub-router, see [routing.md](routing.md)), its own JSON schema
(`app.__schema`, merged from local `src/schema/*.json` + per-app custom schema, see
[data-layer.md](data-layer.md)), and optionally its own datastore connection string
(`app.datastore.connectionString`) — otherwise it shares the core MongoDB datastore. Core collections
(`apps`, `tokens`, `users`, `policies`, ...) always live in the core datastore and are never per-app.

The very first app created is the **super app** (`system` token type, see `__systemInstall()` in
`bootstrap-rest.ts`) — its token is written once to `<appData>/super.json` and must be captured/deleted
manually. Its token type bypasses the access-control policy middleware entirely.

## Plugin system

[src/plugins/index.ts](../src/plugins/index.ts) (`Plugins` singleton) scans `Config.paths.plugins` for
subdirectories containing an `index.js`, imports each as a `ButtressPlugin` subclass
([src/plugins/plugin.ts](../src/plugins/plugin.ts)), and calls `.initialise()` — which branches on
`APP_TYPE` (`rest`/`socket`/`lambda`) to `initialiseRest/Socket/Lambda()`. Plugins register Express
routes (`plugin.routes`, mounted via `Routes.createPluginRoutes`) and/or WordPress-style
`addAction`/`addFilter` hooks consumed via `Plugins.do_action(name, ...)` /
`Plugins.apply_filters(name, value, ...)`. Plugins are file-system based, not npm packages — there is no
plugin registry in this repo, only the loader.

## Federation / data sharing

Two independent mechanisms, both keyed off `AppDataSharingSchemaModel` ("DSA" — data sharing agreement):

- **Datastore-level**: a schema's `remotes` field points a `RemoteCombinedModel`
  ([src/model/type/remote-combined.ts](../src/model/type/remote-combined.ts)) at a remote Buttress
  instance via a `butt://`/`butts://` connection string
  ([src/datastore/adapters/buttress.ts](../src/datastore/adapters/buttress.ts)), built from the DSA's
  `remoteApp` details (`Helpers.DataSharing.createDataSharingConnectionString`).
- **Realtime**: the Socket process's primary opens an outbound `socket.io-client` connection per active
  DSA (`__primaryCreateDataShareConnection`) and relays `dataShareSocket:share` events back into the
  local `rest:activity` NRP channel, so remote mutations flow through the same SPR pipeline as local
  ones.

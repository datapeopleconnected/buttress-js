# Routing

## Routes (`src/routes/index.ts`) — one instance per REST worker process

`Routes` doesn't use a single Express `Router` — it maintains a map of named sub-routers
(`_routerMap` / `_routerOrder`) and dispatches to them in registration order via a single Express
middleware (`_mountRouterDispatcher` → `_dispatchRouters`). Router keys in practice:

- `'core'` — registered once in `initRoutes()`, holds every class from `CoreRoutes`
  ([src/routes/api/index.ts](../src/routes/api/index.ts): app, user, token, policy, lambda,
  lambda-execution, activity, tracking, deployment, secure-store, app-data-sharing, status).
- `'<app.apiPath>'` — one per tenant app, built by `_generateAppRoutes()` from that app's decoded schema
  (only `type: 'collection'` entries, and only ones whose `remotes` data-sharing-agreement is active —
  see `_generateAppRoutes` filtering). Regenerated wholesale via `regenerateAppRoutes(appId)` whenever
  `app-schema:updated` arrives over NRP (see `BootstrapRest.__handleMessageFromMain`).
- `'plugin-<pluginName>'` — one per plugin that declares `routes`, see
  [architecture.md](architecture.md#plugin-system).

`_deregisterRouter` runs on `rest:worker:app-deleted` (app removed).

### Middleware chain (`_preRouteMiddleware`, applied to every route individually)

Every registered path gets this exact array wired in as Express middleware, in order (see
`_initRoute`/`_initSchemaRoutes`):

1. `_middlewareHelper._createContext` — creates `req.context` (id, timer, timings, auth placeholders) —
   see [src/types/bjs-express.ts](../src/types/bjs-express.ts) `RequestContext` for the full shape.
2. `_middlewareHelper._timeRequest` — sets `x-bjs-request-id`, starts the timer.
3. `_authenticateToken` → delegates to `RoutesMiddleware._authenticateToken`
   ([src/routes/middleware.ts](../src/routes/middleware.ts)) — resolves the token (admin call, lambda
   API-endpoint token, or normal bearer/query token via `RoutesTokens`), then `req.context.authApp`,
   `authUser`, `authAppDataSharing`, `authLambda`.
4. `AccessControl.accessControlPolicyMiddleware` — see [access-control.md](access-control.md).
5. `_configCrossDomain` — CORS header logic; **also the point where a missing token becomes a 401** for
   non-system/app tokens, and where per-token `domains` allow-lists are enforced for user tokens.

This is a flat array re-run per route registration (not once globally) — see the comment in the
`Routes` constructor about why (avoiding router-level middleware firing once per sub-router match).

## Route base class (`src/routes/route.ts`)

Every concrete route (core API routes, schema CRUD routes, plugin routes) extends `Route` and implements
`_validate(req, res)` + `_exec(req, res, validate)`. `Route.exec()` is the fixed pipeline all of them
share:

1. `_authenticate()` — checks `req.context.token` exists and its `type` meets `this.authType`.
   Authority is ranked by array position in `Constants.Type` (`AuthTypeOrder = Object.values(Constants.Type)`
   = `[user, dataSharing, lambda, app, system]`), so `system` outranks `app` outranks `lambda` outranks
   `dataSharing` outranks `user` — a route with `authType = Constants.Type.USER` (the default) accepts
   any token type. There are separate `app`/`dataSharing` branches after this check that currently just
   `resolve()` with no extra logic (marked `// NOT GOOD` in source for the `dataSharing` case) — don't
   assume they enforce anything beyond the authority check above.
2. `_validate(req, res)` then `_exec(req, res, validate)` — the only two methods subclasses must implement.
3. `_respond()` — if `_exec` returned a `Stream.Readable`, pipes it through `JSONStringifyStream` (with
   per-chunk redaction via `Helpers.Schema.prepareSchemaResult`) straight to the HTTP response; otherwise
   `res.json()`s the (redacted, unless `redactResults = false`) result directly.
4. `_logActivity()` — fire-and-forget `ActivitySchemaModel.add()` for non-GET/SEARCH verbs, if
   `this.activity` (default `true`).
5. `_boardcastData()` — for non-GET/SEARCH verbs: emits `rest:activity` twice (once as a "super"
   broadcast, once as a normal one — see `_broadcast(req, res, result, path, isSuper)`), only if
   `this.activityBroadcast === true` (**opt-in per route**, default `false`); then calls
   `_checkBasedPathLambda()` to fire `rest:worker:notifyLambdaPathChange` if applicable (see
   [lambda-system.md](lambda-system.md)) — this happens regardless of `activityBroadcast`.

Route flags a subclass typically sets: `verb`, `authType`, `permissions`, `activityBroadcast`,
`activityTitle`/`activityDescription`, `redactResults`, `addSourceId`. Schema-generated routes call
`__configureSchemaRoute()` which sets `core = false`, `redactResults = true`, `addSourceId = true`.

## Schema-routes (`src/routes/schema-routes/`)

Twelve generic route classes (`add-one`, `add-many`, `get-one`, `get-many`, `get-list`, `search-list`,
`search-count`, `update-one`, `update-many`, `delete-one`, `delete-many`, `delete-all`) get instantiated
once per `(app, schema)` pair by `Routes._initSchemaRoutes()` — this is what generates the standard REST
CRUD surface for every tenant collection without hand-written route files. Each one is a thin `Route`
subclass whose `_exec` calls the app's `StandardModel` and applies `req.context.ac.policyConfigs` (the
access-control output) to the query/projection. If you need a new generic CRUD behavior, it goes here,
not in a per-schema file (there are no per-schema route files — schemas never have custom route code,
only custom validation via their JSON schema).

## Lambda API endpoints & tokens

[src/routes/lambda-setup.ts](../src/routes/lambda-setup.ts) (`RoutesLambdaSetup`) mounts one Express
route per `API_ENDPOINT`-trigger lambda under `/lambda/v1/<apiPath>/<endpoint url>`, holds the HTTP
response open, and resolves it when `lambda:worker:execution-result` arrives for the matching `reqId`
(`_queueLambdaAPIExecution`). [src/routes/tokens.ts](../src/routes/tokens.ts) (`RoutesTokens`) caches all
tokens in memory (`loadTokens()`, refreshed on `app-routes:bust-cache`) for fast lookup by header/query
value — token lookups are **not** a DB hit per request in the common case.

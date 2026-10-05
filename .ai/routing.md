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
- `'lambda:<apiPath>'` — one per app, its `API_ENDPOINT` lambdas under `/lambda/v1/<apiPath>/...`, registered by
  `RoutesLambdaSetup` at boot and when an app is added (see [Lambda API endpoints](#lambda-api-endpoints--tokens)).

After the dispatcher, `_mountErrorHandler` mounts a 404 `unknown_route` answer for a request no router took, and the
error handler. Routers registered later are still dispatched to ahead of them, since the dispatcher reads the map
on each request.

`_deregisterRouter` runs on `rest:worker:app-deleted` (app removed), for the app's router and its `lambda:` one.

### Middleware chain (`_preRouteMiddleware`, applied to every route individually)

Every registered path gets this exact array wired in as Express middleware, in order (see
`_initRoute`/`_initSchemaRoutes`):

1. `_middlewareHelper._createContext` — creates `req.context` (id, timer, timings, auth placeholders) —
   see [src/types/bjs-express.ts](../src/types/bjs-express.ts) `RequestContext` for the full shape — and
   runs the rest of the request as its own I/O-counting unit (see [performance.md](performance.md)).
2. `_middlewareHelper._timeRequest` — sets `x-bjs-request-id`, starts the timer.
3. `_authenticateToken` → delegates to `RoutesMiddleware._authenticateToken`
   ([src/routes/middleware.ts](../src/routes/middleware.ts)) — resolves the token (admin call, lambda
   API-endpoint token, or normal bearer/query token via `RoutesTokens`), then `req.context.authApp`,
   `authUser`, `authAppDataSharing`, `authLambda`.
4. `AccessControl.accessControlPolicyMiddleware` — see [access-control.md](access-control.md).
5. `_configCrossDomain` — CORS header logic; **also the point where a missing token becomes a 401 `missing_token`** for
   non-system/app tokens, and where per-token `domains` allow-lists are enforced for user tokens.
   The origin (`Origin`, else `Host`) loses its `http(s)://` and keeps its port. A domain without `*` has to equal it;
   one with `*` has to match all of it, each `*` any run of characters and the rest literal, so `*.example.com`
   takes neither `example.com` nor `a.example.com:8443`
   (see [docs/core/access-control.md](../docs/core/access-control.md#token-domains)).
   Entries that aren't strings are ignored, so they match no origin. The routes that write a token's
   domains (`POST user`'s `token.domains`, `POST user/:id/token`, `POST lambda`'s `auth.domains`) refuse
   anything but a list of non-empty strings with `400 invalid_domains` (`Helpers.isDomainList`).

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
   `res.json()`s the (redacted, unless `redactResults = false`) result directly. With
   `BUTTRESS_LOGGING_SERVER_TIMING` on it first sets a `Server-Timing` header (see [performance.md](performance.md)).
   A stream can fail after `exec` has returned (MongoDB only checks some queries, e.g. a non-array `$in`, once
   the cursor runs). `exec` listens for the result's `'error'` and passes it to Express's `next`, as `pipe()`
   doesn't forward errors and an unhandled one would kill the worker. The error handler then sends an error
   status, or destroys the socket if the response has started. Anything that pipes or merges find streams
   (the adapters, `models-access.find`) must pass errors on too: use `Stream.pipeline()`, or destroy the
   output with the error.
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

**Core collections are shared by every app**, so a core route reaches them through
`this.scoped(req, CoreModel)`, a `TenantScopedModel` ([src/model/type/tenant-scoped.ts](../src/model/type/tenant-scoped.ts))
limited to the caller's app (every app's for a system token), rather than `Model.getCoreModel()`:

- queries (`find`, `findOne`, `count`, `rmAll`) get `{[TenantKey]: app}` ANDed in as they reach the model, after
  `parseQuery`; `findById` gives `null` for another app's row; `exists` is scoped; `updateByPath`, `rm` and
  `owned(id)` (the model itself, for its own by-id methods) refuse another app's row as one that doesn't exist, 404
  `not_found`, and an id that can't be one with 400 `invalid_id`; `findByIdOrFail(id)` and `assertExists(id)` do
  the same for a route's own by-id checks; `rmBulk` removes only the app's rows; `add` puts the app into the
  internals.
- Each core model says which property names a row's app: `static TenantKey`, `_appId`, or `id` for `apps`.
- `this.unscopedModel(CoreModel, reason)` is the explicit way to reach every app's rows.
- A filter that names the caller's own app for a system token too (a policy name check, sync) stays in the
  query, since the scoped model passes a system token through.

Every route in `src/routes/api` reaches core data this way. `Model.getCoreModel()` is left there only for a
model's `schemaData`, `Constants`, `createId`, validation and `parseQuery`, which touch no rows. System-only routes
(tracking, activity, most of the apps routes) use `unscopedModel(…, 'the route takes only system tokens')`.
`ACM.find`/`ACM.count` take a scoped model as they do a schema model (`QueryableModel`).

Two checks keep it so. ESLint's `no-restricted-syntax` on `src/routes/api/**` refuses `Model.getCoreModel(X)` for
anything but the members that touch no rows, and refuses keeping or passing the model itself
([eslint/core-model-access.mjs](../eslint/core-model-access.mjs), tested in `test/unit/eslint/`). And
`test/unit/src/routes/api/core-routes-scoping.test.js` walks every core route's compiled code: a route that takes other
than system tokens may use `unscopedModel` only where its list names the route, model and reason, so reaching every
app from a new place is a change to that list.

**Core route bases** ([src/routes/core-routes.ts](../src/routes/core-routes.ts), R4). A route class extends
`CoreSearch`, `CoreCount`, `CoreUpdateByPath`, `CoreBulkUpdate`, `CoreGetOne`, `CoreGetList`, `CoreDeleteAll` or
`CoreTokenPolicyProperties` (each `<M>`, the core model) and gives a `static config`, `{path, name, model, authType,
permissions, scope?, idParam?, activityBroadcast?, takesIds?, policyProperties?}`; the base reads it off the class (so a route made with `Object.create` in a
test has it too).

- A search takes `{query, skip, limit, sort, project}`, as a schema search does, and refuses a list body with 400
  `invalid_body`; a count takes `{query}` or the body as its query, without `actualCount`.
- An update by path (`PUT <path>/:id`) and a bulk update (`POST <path>/bulk/update`, `[{id, body}]`) check each row's
  updates with `validateUpdate` (400 `invalid_update`), then the route's `updateProblem` hook (policy configs,
  data-sharing destinations), then that the rows are ones the caller reaches (`assertExists`, or for a bulk update
  `assertAllExist`, one `$in` query naming the first missing id), before anything is written; `afterUpdates` then gets every row written (lambda pulls code and rebuilds the path-mutation cache once).
- A get-one is `findByIdOrFail` (404 `not_found`, 400 `invalid_id`), its `present(row)` hook giving what's sent
  (activity sends its `body`); a get-list lists the rows the caller reaches, only those `?ids=a,b` names where the
  route `takesIds` (policy, lambda; D-29); a delete-all is `rmAll` over them.
- A policy-property route (`set`, `update`, `remove` or `clear`, its `policyProperties`) checks the row exists, finds
  its token with the owner's `findToken` (a lambda's by `_lambdaId`, a user's by `:tokenId`, id or value), checks
  set or merged properties against the app's list (400 `invalid_field`), then changes the token; `afterChange`
  follows (a user's sockets look at its rooms again after a remove or clear).
- Rows are reached through `this.scoped()`, or `this.ownAppScoped()` for `scope: 'own-app'`, which limits a system
  token to its own app too (secure-store).
- App and token search attach tokens, AppUpdate checks its api path against every app, GetUser and FindUser attach
  tokens, and the app, policy and data-sharing delete-alls clean up after themselves, so they keep their own code.
  DeleteAppPolicies removes every app's policies for a system token, unlike DeleteAllUsers (D-30). The scoping walk test reads the bases' code with each route's.

**Work a request doesn't wait for.** NRP publishes return promises that reject when Redis does, and a rejection left
unhandled ends the process. A route publishes with `this._notify(channel, message)`, which logs a failed publish, and
starts other work it doesn't wait for with `this._unawaited(step, promise)` (logging and broadcasting the activity).
ESLint's `no-floating-promises` and `no-misused-promises` are errors in `src/routes`.

## Errors (`src/helpers/errors.ts`)

A route, middleware or model refuses a request by throwing an `ApiError` from one of its factories: `badRequest`
(400), `unauthorised` (401: no token, or one that isn't valid), `forbidden` (403: a valid token that isn't allowed),
`notFound` (404), `entityNotFound(schema, id)` (404 `not_found`, for an id that names nothing the caller can
reach), `methodNotAllowed`, `conflict`, `unavailable` and `internal(reason)` (500 `internal_error`, with the reason
kept for the log only). Each takes a snake_case `code`, an optional message for people and optional `details`.
`PolicyError` extends it. The validation refusals are `invalidEntityError` and `invalidUpdateError` in
`src/model/shared.ts` (400 `missing_field`/`invalid_value`/`invalid_update`, with the schema and path).

Everything reaches one handler, `RoutesMiddleware.logErrors`, mounted last: it answers `toApiError(err)`'s status
and `{code, message, details?}`, and anything that isn't an `ApiError` as 500 `internal_error`, logging it. The
body parsers' refusals (`_handleEarlyError`), the policy middleware, the CORS check, the admin routes and the lambda
endpoints (which have the same handler on their own paths) pass errors to it rather than answering themselves. A
refused bulk update item carries `{status, ...toBody()}` in its `validation`.

Each code has one status: `test/unit/src/helpers/error-codes.test.js` reads the compiled code for every factory
call and fails when a code is used with two statuses. The user-facing list is [docs/core/errors.md](../docs/core/errors.md),
and `test/e2e/rest/error-contract.test.js` is the table of (condition → status, code) over a running server.

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

[src/routes/lambda-setup.ts](../src/routes/lambda-setup.ts) (`RoutesLambdaSetup`) registers a router per app,
`lambda:<apiPath>`, whose one route takes `/lambda/v1/<apiPath>/<endpoint url>` for the app's `API_ENDPOINT`-trigger
lambdas; its errors reach the one error handler. It holds the HTTP
response open for a SYNC endpoint, and resolves it when `lambda:worker:execution-result` arrives for the
matching `reqId`. One subscription per process hands results to the waiting requests
(`_pendingResults`), and a request is waiting before its execution is queued (`_queueLambdaAPIExecution`), so
a fast result isn't missed. The call goes through the trigger at its url and method, which the execution
names in its `API_ENDPOINT` metadata so the runner applies that trigger's settings. [src/routes/tokens.ts](../src/routes/tokens.ts) (`RoutesTokens`) caches all
tokens in memory (`loadTokens()`, refreshed on `app-routes:bust-cache`) for fast lookup by header/query
value — token lookups are **not** a DB hit per request in the common case.

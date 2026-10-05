# Access Control & Realtime Policy Routing

There are **two** separate policy-evaluation paths that share the same underlying `Policy` model and
`PolicyCache`, but run in different processes for different purposes. Don't confuse them:

1. **REST request-time policy middleware** — decides whether a request is allowed, and what
   query/projection constraints to apply to it.
2. **SPR (Socket Policy Router) broadcast-time policy evaluation** — decides, after a write already
   happened, which *connected sockets* should be told about it.

See [docs/applications/policy.md](../docs/applications/policy.md) for the policy JSON shape
(`selection`, `config[].verbs/schema/query/projection/condition`, `merge`, `priority`, `limit`).

## PolicyCache (`src/services/policy-cache.ts`)

Backs both paths with Redis-cached policy state, all keys namespaced under `Config.redis.scope`:

- `token:<id>:policies` — set of policy ids applicable to a token. `'STALE'` is a sentinel member meaning
  "force a rehydrate" (written by `setTokenIdAsStale`, e.g. after `Token.setPolicyPropertiesById`).
- `policies` (hash) — policy id → serialized `Policy` document, populated lazily via `getPolicies()`.
- `policy:<id>:tokens` / `connected-tokens` (sorted set, score = expiry epoch) — which tokens are
  currently connected to a socket and which policies apply to them; used by SPR to know who to notify.
  `connected-token:<id>:sockets` holds each connected token's socket ids (`worker:socket:connection` /
  `disconnect` send `{tokenId, socketId}`), so a token stays connected until its last socket closes. Each Socket
  process publishes `worker:socket:heartbeat` with the tokens it has sockets for every 15 minutes, which renews
  them (`ZADD XX`) within the hour's expiry; a token whose sockets were in a process that died expires. A token's
  connection changes and the expiry sweep run one at a time in the SPR primary.
- `policy:propertyIndex:<key>` — reverse index from a policy-selection property name to token ids, used
  by `invalidatePolicyAndTokensBySelection()` to mark affected tokens stale when a policy changes.
- `policy:selectionRules` — the `SELECTION_RULES_VERSION` the cached `token:<id>:policies` sets were selected by. The
  primary REST main process swaps it at start-up (`markStaleIfSelectionRulesChanged`); when it differed, every cached
  token is marked stale before requests are served and then reselected in the background (`reselectTokens`). Bump
  the version whenever `AccessControlPolicyMatch.selects` changes what it selects.
- `app:<appId>:schema:<schemaName>` (+ `%ALL%` / `%APP_SCHEMA%` wildcard variants; `%CORE_SCHEMA%` is written but not read) — index
  used by SPR's `getPoliciesByRestActivity()` to find candidate policies for an incoming activity without
  scanning every policy.

`rehydrateToken()` always re-fetches the token fresh from Mongo (not the possibly-stale one on the
request) before recomputing — this matters if you're debugging "policy changes don't take effect
immediately" issues.

## REST path: `AccessControl.accessControlPolicyMiddleware` (`src/access-control/index.ts`)

Mounted as one of `Routes._preRouteMiddleware` (see [routing.md](routing.md)), runs on every request
after token authentication. Flow:

1. System tokens (`req.context.token.type === 'system'`) and plugin paths skip straight through.
2. Resolves `schemaName` from the URL, loads/caches the app's schema (`__cacheAppSchema`).
3. `PolicyCache.getPoliciesByToken(token)` — the token's applicable policies (sorted by `priority`).
4. `__getOutcome(tokenPolicies, req, schemaName, appId)` — REST's side of the policy engine:
   - `evaluate(policies, context)` ([evaluator.ts](../src/access-control/evaluator.ts)) gives the token's
     **grants** on the schema for the verb, one per config that applies: the policy hasn't reached its `limit`,
     the config is for the verb and schema (`filterPolicyConfigs`; `grantsVerb()` treats `QUERY` and `SEARCH` as one
     verb, so a config listing either grants both methods), the schema exists, its `condition` holds
     (`AccessControlConditions.filterPoliciesByPolicyConditions`, with the request env; a config without a
     condition applies), and its `query`'s `#env.` values are set (`Filter.buildPolicyQuery`; an unset one drops
     the config). Each check that leaves nothing refuses with its `PolicyError`. A grant is
     `{policies, appId, config, query, projection}`: the query with its env read and access keys dropped (`{}`
     reads every entity), and the properties it reads (null for every one).
   - `Projection.filterGrantsByRequest` keeps the grants the request's reads and writes can go through: a read
     may only query properties a grant reads (at any depth of `$and`/`$or`/`$nor`), an update's paths must be
     within them (else 403 `property_access_denied`), a create's other properties get their defaults.
   - `mergeGrants` merges without changing what they give together: the same query unions properties (every
     property if one reads all), and grants reading every property OR their queries. The result goes on
     `req.context.ac.policyConfigs` (projection as `{key: 1}`) for the routes.
   - Routes read through `models-access.ts`: one config is combined with the request's query and projection;
     several are read in **one** find per source (their queries OR'd), and each entity keeps the properties of
     the configs whose query matches it (`matchQuery`, as MongoDB matches), so an entity comes once and paging
     holds. `count` is one `$or` count.
5. No matching policy at any stage → throws `PolicyError` (403 `access_denied`, `property_access_denied` for
   projections, 404 `unknown_schema`, 401 `app_not_found` for a token outliving its app) → the middleware passes
   it to the error handler (see [routing.md](routing.md#errors-srchelperserrorsts)). **Default is deny, not
   allow.**
6. If the token has any policy with a `limit` (expiry) within one week, schedules a one-shot cleanup
   (`_queuePolicyLimitDeleteEvent`) that strips the token's matching `policyProperties` and deletes the
   policy when it expires.

`AccessControlEnv.generateRequestGlobalEnvs(req, appId, user)` builds the `env` object that policy
`query`/`condition` values can reference via dotted paths (e.g. `env.userId`) — read
[src/access-control/env.ts](../src/access-control/env.ts) when a policy needs a new environment variable
exposed. `env.ipAddress` is the requester's `req.ip`, so it's only as trustworthy as `BUTTRESS_TRUST_PROXY`
(Express's `trust proxy`) is right for the deployment; an IPv4-mapped IPv6 address is given as plain IPv4. SPR
builds its env without a request, so `env.ipAddress` is always null there.

## SPR path: `BootstrapSocketPolicyRouter._handleIncomingMessage` (`src/bootstrap-spr.ts`)

Runs only in the SPR primary process, triggered by the `rest:activity` NRP event that every REST
`Route._broadcast()` call emits (twice per write: a copy for system tokens, `isSuper`, and one for policies). By
the time this runs the write has happened; the question is who may read it, and what of it. The policies are
evaluated with the same evaluator as REST (`evaluate` with `reads: true`: configs that let a token read the
schema, whatever the verb), and an entity is matched as a REST query would match it (D-31).

Only app schemas' activity is routed. Core entities (users, tokens, policies, lambdas, apps…) are never sent
over sockets: `__handleEntityActivity` drops an activity with `isCoreSchema`, and `%CORE_SCHEMA%` has no
lookup in the policy cache (decided 2026-09-30).

`__splitBulkActivity` first turns a bulk update/delete, and a delete-all that the caller's policies limited (its
`response` lists the deleted ids), into one by-id activity per entity. A deleted entity can't be loaded, so the REST
route sends it along as it was, in `deletedEntities` (`Route._keepEntitiesBeingDeleted`). A limited delete-all is split
for system tokens (`isSuper`) too: sent whole, it would clear entities that still exist.

Each entity activity goes through a `KeyedQueue` keyed by app, schema and entity, so an entity's activities are
relayed in the order they arrive (other entities' alongside), and one that fails is logged. Then
`__handleEntityActivity`:

1. Drops `broadcast: false` activities; sends the `isSuper` copy whole to every system token (one find, no entity
   read).
2. `PolicyCache.getPoliciesByRestActivity()` finds the candidate policies for the schema/app (one `SUNION`, one
   `HMGET`), keeping those not past their `limit` with configs that let a token read the schema.
3. `PolicyCache.getConnectedTokenIdsByPolicyIds()` gives each one's connected tokens (an `SMEMBERS` per policy, one
   `ZMSCORE` for all, Redis 6.2+); a policy no connected token holds isn't evaluated, and nothing is read for it.
4. A policy whose configs' queries or conditions refer to the token's user (`dependsOnToken`, which follows env
   references through the policy's and config's env and env lookups) is evaluated for each of its tokens, with
   that token's user; the tokens and their users are read in one find each (`__constructTokenEnvs`). Other
   policies are evaluated once, with the app's env.
5. `__readingFor` evaluates a policy and checks which grants' queries read the entity
   (`Filter.evaluateQueryAgainstEntity`); the entity is read once, when first needed. A token may read the
   union of what its policies' reading grants let it (`addReading`).
6. `__relay` groups tokens that may read the same, trims the activity's `response` to those properties
   (`Projection.projectActivityResponse`, which understands PUT diffs and sends nothing when none are visible), and
   re-emits it as `spr:activity` (`DataShareSocketSharePayload`, up to 1000 token ids a message), which Socket
   workers pick up in `_workerOnSPRActivity` and turn into `db-activity` Socket.IO emits. A token gets one activity
   for an entity, however many of its policies read it.

`test/perf/io-budgets.json`'s `spr` entry pins this work for one write to four sockets.

If you're debugging "REST write succeeded but nobody got a socket update," the fault is almost always
somewhere in this SPR pipeline or in the `connected-tokens`/`policy:<id>:tokens` cache state, not in the
REST handler.

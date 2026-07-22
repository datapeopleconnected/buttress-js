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
- `policy:propertyIndex:<key>` — reverse index from a policy-selection property name to token ids, used
  by `invalidatePolicyAndTokensBySelection()` to mark affected tokens stale when a policy changes.
- `app:<appId>:schema:<schemaName>` (+ `%ALL%` / `%APP_SCHEMA%`/`%CORE_SCHEMA%` wildcard variants) — index
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
4. `__getOutcome(tokenPolicies, req, schemaName, appId)` — the core evaluation pipeline:
   - `filterPolicyConfigs` (in [helpers.ts](../src/access-control/helpers.ts)) — narrows each policy's
     `config[]` entries to ones matching the request verb + schema.
   - `AccessControlConditions.filterPoliciesByPolicyConditions` — evaluates `config.condition` blocks
     against a generated request environment (`AccessControlEnv.generateRequestGlobalEnvs`, see below);
     drops policies whose condition fails.
   - `AccessControlFilter.buildApplicablePoliciesQuery` — resolves each policy's `query` block (which may
     reference `env.*` paths) into a concrete MongoDB query fragment.
   - `AccessControlProjection.filterPoliciesByPolicyProjection` — resolves field-level projection
     restrictions; if this leaves zero applicable policies, access is denied
     (`access-control-properties-permission-error`).
   - Remaining policy configs are merged where possible (same verbs/schema/query → merge projections;
     same verbs/schema/no-projection → OR the queries together) into `parsedPolicyConfig[]`, stored on
     `req.context.ac.policyConfigs` for the route handler to apply to its DB query.
5. No matching policy at any stage → throws `PolicyError` (401) → middleware turns it into a JSON error
   response. **Default is deny, not allow.**
6. If the token has any policy with a `limit` (expiry) within one week, schedules a one-shot cleanup
   (`_queuePolicyLimitDeleteEvent`) that strips the token's matching `policyProperties` and deletes the
   policy when it expires.

`AccessControlEnv.generateRequestGlobalEnvs(req, appId, user)` builds the `env` object that policy
`query`/`condition` values can reference via dotted paths (e.g. `env.userId`) — read
[src/access-control/env.ts](../src/access-control/env.ts) when a policy needs a new environment variable
exposed.

## SPR path: `BootstrapSocketPolicyRouter._handleIncomingMessage` (`src/bootstrap-spr.ts`)

Runs only in the SPR primary process, triggered by the `rest:activity` NRP event that every REST
`Route._broadcast()` call emits. This is a **separate, coarser** evaluation from the REST middleware —
it exists because by the time this runs, the write already happened and the question is purely "who
should be told":

1. Loads the mutated entity by id (unless it's a delete with no entity).
2. `isSuper` activities (from the super/system app) broadcast to every `system`-type token unconditionally.
3. Otherwise, `PolicyCache.getPoliciesByRestActivity()` finds candidate policies for the schema/app, then
   for each policy: `filterPolicyConfigs` narrows to matching verb+schema configs.
4. `containsTokenLevelRef()` (in [helpers.ts](../src/access-control/helpers.ts)) checks whether the
   policy's env/query/condition references anything token-specific (e.g. `env.userId`). If so, evaluation
   must happen **per connected token** (`getConnectedTokenIdsByPolicyId` → loop → build a per-token env
   via `__constructTokenEnv` → evaluate). If not, it evaluates once and broadcasts to every token
   connected to that policy.
5. `AccessControlFilters.buildPolicyQuery()` + `evaluateQueryAgainstEntity()` — evaluates the resolved
   query **in-memory against the already-fetched entity** (not a DB query — the write already happened),
   deciding broadcast/no-broadcast. Projection (`config.projection`) trims the broadcast payload's
   `response` fields.
6. Approved broadcasts are re-emitted as `spr:activity` (`DataShareSocketSharePayload`, batched to 1000
   token ids at a time via `__broadcastDataByPolicyId`/`__broadcastDataByToken`), which Socket workers
   pick up in `_workerOnSPRActivity` and turn into `db-activity` Socket.IO emits.

If you're debugging "REST write succeeded but nobody got a socket update," the fault is almost always
somewhere in this SPR pipeline or in the `connected-tokens`/`policy:<id>:tokens` cache state, not in the
REST handler.

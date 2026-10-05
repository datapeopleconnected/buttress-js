# Data Layer: Models, Schema, Datastore

## ModelManager (`Model` singleton)

[src/model/index.ts](../src/model/index.ts) exports a default singleton instance of `ModelManager`
(everyone imports it as `Model`). It owns two model registries:

- `Model.models.core[name]` — the 11 fixed **core models** (`CoreModels` map: `Activity`, `App`,
  `AppDataSharing`, `Deployment`, `Lambda`, `LambdaExecution`, `Policy`, `SecureStore`, `Token`,
  `Tracking`, `User`), one instance per process, created by `initCoreModels()`. Access via
  `Model.getCoreModel(AppSchemaModel)` (typed, pass the class) or `getCoreModelByName('App')` (untyped).
- `Model.models[appId][schemaName]` — dynamically created **per-app models**, one set per tenant app,
  built from that app's JSON schema by `initSchema(appId?)`. Access via
  `await Model.getAppModel(appId, schemaName)` (async — may not exist yet).

`initSchema()` reads every app's `app.__schema` (encoded JSON, see below), decodes + "builds" it
(resolves `extends`), and for each `type: 'collection'` entry either instantiates a plain
`StandardModel` against the app's datastore, or — if the schema entry has a `remotes` field — a
`RemoteCombinedModel` wired to one or more remote datastores (federation, see
[architecture.md](architecture.md)). This runs once at boot and again per-app whenever
`app-schema:updated` fires over NRP (e.g. after a schema edit), see `Model.initSchema(appId)` calls in
each bootstrap class.

Core vs. per-app models share the same base class and API — the difference is only which
`app`/`schemaData`/`datastore` they were constructed with.

## StandardModel (`src/model/type/standard.ts`)

This is the base class basically everything queries through — core models subclass it directly
(e.g. `TokenSchemaModel extends StandardModel<Token>`), per-app models are plain instances of it.
Key things to know:

- Constructor takes `(schemaData, app, services)`. `collectionName` is `schemaData.name`, prefixed with
  a short hash of the app id for per-app models (`Helpers.shortId(app.id)`) so different apps' data
  never collides in a shared MongoDB.
- `initAdapter(datastore)` clones the datastore's adapter connection
  (`datastore.adapter.cloneAdapterConnection()`), connects it, and calls `adapter.setCollection()` /
  `adapter.updateSchema()`. **All actual DB work is delegated to `this.adapter`** — `StandardModel`
  itself has no MongoDB-specific code; `find`, `findOne`, `add`, `update`, `rm`, `count`, etc. are thin
  pass-throughs to the adapter (see Datastore adapters below).
- `parseQuery()` / `parseQueryProperty()` translate Buttress's REST query DSL into MongoDB operators:
  `$not`→`$ne`, `$elMatch`→`$elemMatch`, `$gtDate`/`$ltDate`/`$gteDate`/`$lteDate`→`$gt`/`$lt`/`$gte`/`$lte`,
  `$rex`/`$rexi`→`$regex` (with `i` flag for `$rexi`), `$inProp`→`$regex`. It also auto-converts string
  operands to `ObjectId`s for properties whose schema type is `id`, and to `Date` for `__type: 'date'`.
  This is the layer that both REST query params and Access Control query injection go through.
- `updateByPath()` implements Buttress's **path-based PUT** semantics (`{path, value}` updates), used for
  partial/vector updates (`vector-add`, `vector-rm`, `scalar-increment`). `resolveUpdatePath()` in
  [src/model/update-paths.ts](../src/model/update-paths.ts) walks a path's segments against the flattened schema
  and gives the property it writes, how (its kind), its enum values and whether it writes the property, one array
  item or a path beneath an object or item; or refuses it as `unknown_path` or `immutable` (`__allowUpdate:
  false`). `validateUpdate()` (shared.ts) checks values through it, and `updateByPath()` hands the adapter its
  kind.
- `__parseAddBody()` auto-generates `id` (via `adapter.ID.new()`) and, if the schema `extends` includes
  `timestamps`, stamps `createdAt`/`updatedAt`.
- `add(body, internals)`: `internals` are the fields only the server sets, merged over the sanitised body, so
  they win. A core model's row names its app as `internals._appId`, with the model's own internals beside it
  (an execution's `_tokenId`, a lambda's `auth` and `app`, a token's `_userId`...); `App` and `Activity` are the
  exceptions (an app is its own tenant; an activity takes its app from the request).

## Schema system

Schemas are plain JSON objects (`{name, type, properties, extends?, remotes?, core?}`), see
[docs/applications/schema.md](../docs/applications/schema.md) for the end-user-facing property syntax
(`__type`, `__default`, `__required`, `__allowUpdate`, `__enum`, `__schema` for nested objects,
`__itemtype` for typed arrays). Core model schemas are defined as static `Schema` getters right on the
model class (e.g. `TokenSchemaModel.Schema`, `AppSchemaModel.Schema` — both have `core: true`).

Two schema sources get merged for every app:

1. **Local schema** — JSON files in [src/schema/](../src/schema/) (currently `person.json`,
   `timestamps.json`), loaded by `BootstrapRest._getLocalSchemas()` and merged into every app's schema on
   boot (`__updateAppSchema()`) and set via `AppSchemaModel.setLocalSchema()`.
2. **App-defined schema** — set by app owners through the API, stored encoded on `app.__schema`
   (`Helpers.Schema.encode`/`decode` — effectively JSON stringify/parse plus whatever normalization lives
   in [src/helpers/schema.ts](../src/helpers/schema.ts)) and raw on `app.__rawSchema`.

`Helpers.Schema.buildCollections()` resolves `extends` chains before a schema is used to build a model.
A schema entry with a `remotes` field (`{name, schema}` or an array of those) is a **federated**
collection — see `_initSchemaModel()` in `model/index.ts` and [architecture.md](architecture.md).

`Helpers.getFlattenedSchema()` flattens a nested schema into a dotted-path map — this flattened form is what
creates, updates and `parseQuery` all operate on. It leaves the schema as it is; an array's flattened `__schema` is in
the result. A model flattens its schema once, when it's set (`flatSchemaData`), and validation, updates and queries
use that.

A create's body is read in one pass by `parseDocument()` ([src/model/parse-document.ts](../src/model/parse-document.ts)),
which walks the flattened schema as a tree (cached per flattened schema) and gives `{value, issues, missing,
invalid}`: the value to store, with defaults and each value read as its type, and every problem. It never changes the
body. `validateSchemaObject` (the issues, plus a `strict` schema's unknown fields) and `sanitizeSchemaObject` (the
value) in [src/model/shared.ts](../src/model/shared.ts) are both views of it, so what's checked and what's stored can't
disagree; the Mongo adapter reads an array item an update writes through it too. A nested object (a property without
`__type`) that's given something other than an object or null is refused.

Every value is read as its `__type` through one codec per type, `decode()` in
[src/helpers/codecs.ts](../src/helpers/codecs.ts): bodies (`checkProp` in `helpers/schema.ts`),
update values, and compared query values (`StandardModel.__decodeOperand`). Validation lists every problem as an
issue, `{path, code, expected?, received?}`, which `invalidEntityError`/`invalidUpdateError` put in the error's
`details.issues`. A schema with `strict: true` refuses fields it doesn't define on create. A `__private` property never
leaves in a response (`Route._respond` strips it, `Helpers.Schema.stripPrivate`); a `__unique` one gets a unique
partial index from the Mongo adapter's `updateSchema()` when the model starts (a failed build is logged, D-25), and a
write that breaks it is 400 `duplicate` (`uniquePathOf` reads the index name, `unique_<path>`).

## Datastore adapters

[src/datastore/index.ts](../src/datastore/index.ts) exports a `Datastore` lifecycle manager
(`createInstance`/`getInstance`/`clean`) that caches one `Datastore` instance per connection-string hash
(`hashConfig` — SHA1 of the connection string), plus a fixed `'core'` hash for the primary datastore.
[src/datastore/adapter-factory.ts](../src/datastore/adapter-factory.ts) picks the concrete adapter purely
from the connection string's URL protocol:

| Protocol | Adapter | Use |
| --- | --- | --- |
| `mongodb:` | [adapters/mongodb.ts](../src/datastore/adapters/mongodb.ts) | Default/primary datastore |
| `butt:` / `butts:` | [adapters/buttress.ts](../src/datastore/adapters/buttress.ts) | Federation — talks to a remote Buttress instance over its REST API |
| `empty:` | [adapters/empty.ts](../src/datastore/adapters/empty.ts) | No-op adapter (used by `test/before-e2e.js` bootstrap path outside e2e mode) |

Adding a new backing store means adding a new adapter here and a new `case` in `adapter-factory.ts` —
nothing else in the model layer needs to change, since `StandardModel` only calls generic `adapter.*`
methods.

The factory also gives the adapter the datastore's options query string as `URLSearchParams`
(`Config.datastore.options`, i.e. `BUTTRESS_DATASTORE_OPTIONS`, for the primary datastore; an app's own datastore and
data-sharing partners get none). Only the MongoDB adapter uses them: `connect()` adds each option the connection
string doesn't set to its query, so the driver parses them as it does the connection string's own (typed, unknown
names refused). An option in both keeps the connection string's value, since the driver refuses one given twice.

The contract is typed on [AbstractAdapter](../src/datastore/abstract-adapter.ts), with the shared shapes
in [src/types/datastore.ts](../src/types/datastore.ts). Adapters return untyped documents
(`AdapterDocument`); `StandardModel<TDocument>` casts them to its document type (`findById` →
`Promise<TDocument>`, `findOne` → `Promise<TDocument | null>`). `find`/`findAll` return
`AdapterFindResult` (`Readable | Promise<Readable>`): the Mongo adapter's find is synchronous but the
Buttress adapter's and `RemoteCombinedModel`'s aren't, so await the result before using it as a stream.

Ids are strings outside the adapters. MongoDB stores them as `ObjectId`s, and
[mongodb-ids.ts](../src/datastore/adapters/mongodb-ids.ts) converts at the adapter boundary, going by the
schema the model passes to `adapter.updateSchema()`: properties with `__type: 'id'` (including nested ones
and those in array item schemas), arrays with `__itemtype: 'id'`, and each document's `id`/`_id`.
Documents, queries and update documents going in have the id strings under those properties converted to
`ObjectId`s (a new copy, and `id` becomes `_id`); every `ObjectId` in a document coming out becomes a
string. So a query or `$set` on an id property can be written with plain strings. Ids inside free-form
`object` properties aren't converted on the way in, so they're stored as strings.

This was decided on 2026-09-28, after ids had been a mix of `ObjectId`s and strings. Strings won because most of
the system already sees ids as JSON (API responses, NRP messages, the SPR's entities, federated Buttress
remotes), strings compare with `===` where two `ObjectId`s don't, and it keeps a datastore's id type inside its
adapter. What's stored didn't change, so no migration was needed. Keep conversion in the adapter: code outside
it shouldn't create or expect `ObjectId`s.

## Core model quirks worth knowing before touching them

- `TokenSchemaModel` ([src/model/core/token.ts](../src/model/core/token.ts)) generates the actual token
  string itself (`createTokenString()`, overrides `add()`), and every policy-property mutation
  (`setPolicyPropertiesById`, `updatePolicyProperties`, `clearPolicyPropertiesById`) also marks the token
  stale in `PolicyCache` and emits `app-routes:bust-cache` — if you add a new way to mutate
  `policyProperties`, you must do the same or the access-control cache goes stale.
- `AppSchemaModel` ([src/model/core/app.ts](../src/model/core/app.ts)) `.add()` creates the app's token,
  and for non-system apps auto-creates a default "App Policy" (full access to `%APP_SCHEMA%`, scoped
  access to its own `app`/`policy`/`user`/`token`/`lambda`/... core rows) — see
  `__handleAddingNonSystemApp()`. `.rm()` cascades deletes across every core collection scoped to that
  `_appId` plus `dropAndCleanAppModels()`. `updateSchema()` is the only place that emits
  `app-schema:updated` / `app:update-schema` over NRP, which is what triggers `Model.initSchema()` and
  route regeneration everywhere else.

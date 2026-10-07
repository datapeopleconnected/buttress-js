# Development Workflow

## Requirements

- Node.js `>= 24.15` (`.nvmrc` pins `v24.15`; `.nvm-node` is a symlink to the active nvm node binary used
  by npm scripts — regenerate it with `npm run nvm` if it goes stale).
- MongoDB and Redis reachable via `BUTTRESS_DATASTORE_CONNECTION_STRING` / `BUTTRESS_REDIS_URL` (or the
  `.<env>.env` equivalents) for anything beyond a type-check/lint/build.
- `SERVER_ID` env var must be set to run any process from source (`export SERVER_ID='name'`).

## Build

```bash
npm run build          # clean + tsc + copy non-.ts files from src/ to dist/
npm run watch          # watch mode (tsc -w + copyfiles --watch in parallel)
```

Source is TypeScript in `src/`, compiled to `dist/` (nodenext ESM, target ES2024, `strict: true`, which
includes `noImplicitAny` — see [tsconfig.json](../tsconfig.json)). **Nothing runs against `src/` directly**
— processes (`bin/*.sh`), unit tests, and e2e tests all import from `dist/`. Always rebuild after
changing `src/` before running tests or starting a process locally.

## Lint / format / license / typecheck

```bash
npm run lint            # eslint ./src
npm run lint:fix
npm run format           # prettier --check ./src
npm run format:fix
npm run lint:staged      # eslint --fix + prettier --write on staged src files only (run by the hook)
npm run licence-check    # ./scripts/licence-check — every src file (except html/json/md/sh) must
                          # contain the AGPL header block from scripts/licencing_header.txt
npm run docs:check       # scripts/docs-check.mjs — every link and image in docs/ reaches a page, heading or
                          # file in docs/, resolved as docsify resolves it (see Docs site below)
npm run check            # tsc --noEmit && lint && format && licence-check && docs:check — the full pre-PR gate
```

The pre-commit hook ([.githooks/pre-commit](../.githooks/pre-commit), enabled by the `prepare` script
setting `core.hooksPath` on `npm install`) runs `lint:staged`, `licence-check` + `build` on every commit,
with the node version from `.nvmrc` when nvm is installed. `lint:staged` is
[lint-staged](https://github.com/lint-staged/lint-staged) (config under `"lint-staged"` in `package.json`):
it fixes the staged version of each `src/` file and re-stages it, hiding the unstaged changes of partially
staged files while it runs and restoring them afterwards, so staging one hunk still commits only that hunk.
A commit will fail if ESLint finds an error it can't fix (the files are left as they were), a new/edited
`src/*.ts` file is missing the license header, or the build breaks. ESLint config
([eslint.config.mjs](../eslint.config.mjs)) is type-aware (`projectService`): `max-len` 150 (ignoring
strings/template literals), and `@typescript-eslint/no-explicit-any` plus the `no-unsafe-*` rules are
errors. Prettier: single quotes, trailing commas, 120 print width, 2-space indent, semicolons — see
[.prettierrc.json](../.prettierrc.json).

### Types

With `noImplicitAny` on, `no-explicit-any` an error, and the `no-unsafe-*` rules stopping `any` from
libraries flowing on, every value needs a real type:

- Values from outside (request bodies, `JSON.parse`, `require()`/`import()`, `@buttress/api` and
  isolated-vm results, NRP messages) are `unknown` or a described shape at the point they come in: cast
  the result (`const msg = JSON.parse(json) as AppDeletedMessage`; annotating the variable instead fails
  `no-unsafe-assignment`) or type the request (`RequestWithBody<TBody, TParams>` from
  [src/types/routes.ts](../src/types/routes.ts)).
- `Array.isArray()` narrows to `unknown[]` rather than `any[]`
  ([src/types/array-is-array.d.ts](../src/types/array-is-array.d.ts)), so cast the array when the
  elements have a known type.
- Shared shapes live in [src/types/](../src/types): `datastore.ts` (the adapter contract's ids,
  documents, queries and update-by-path bodies), `schema.ts`, `bjs-query.ts`, `routes.ts`,
  `bjs-nrp-objects.ts`. Entity types (`App`, `Token`, ...) live with their core model and are type
  aliases rather than interfaces, so they're assignable to `AdapterDocument` (`Record<string, unknown>`).
- npm packages without types get a minimal local declaration in `src/types/<package>.d.ts`
  (`object-hash`, `morgan`, `pug`, `randomstring`, `on-finished`, `@dpc/node-env-obj`).
- Ids are strings (an ObjectId's hex form) everywhere outside the datastore adapters: `createId()` and
  `adapter.ID.new()` return strings, and documents come back with string ids. Only the MongoDB adapter
  deals in `ObjectId`s, see [data-layer.md](data-layer.md). To check for an `ObjectId` use `isObjectId()`
  from `src/datastore/adapters/object-id.ts`, not `instanceof`: bson's ESM and CommonJS builds have
  different `ObjectId` classes, and the driver uses the CommonJS one.

## Tests

```bash
npm run test              # build + test:unit + test:e2e (what CI runs)
npm run test:unit         # mocha over test/unit/**/* — imports compiled dist/, NOT src/
npm run test:e2e          # drops the test DB and the test app code's Redis keys, boots a real Buttress in
                            # INSTALL_MODE, then runs test/e2e/index.test.js against it
npm run test:io-budgets   # as test:e2e, but only the I/O budget suite (see performance.md)
npm run bench             # measure dist/'s REST performance into bench-results/ (see performance.md)
npm run bench:compare -- a.json b.json   # compare two bench results
npm run test:federation   # boots two Buttress instances and tests data sharing between them
```

- **Unit tests import `dist/`** (see e.g. [test/unit/src/helpers/schema.test.js](../test/unit/src/helpers/schema.test.js)
  which does `import * as Helpers from '../../../../dist/helpers/index.js'`). If you edit `src/` and run
  `npm run test:unit` directly (skipping `npm run build`), you're testing stale compiled output.
- **Don't stub `parseQuery`** in a route or access-control test: a pass-through hides what parsing does (operators
  become `$eq`, an empty `$and` goes, a bad id becomes `null`). For an app's schema model, use
  `createSchemaModel(schema, rows)` from [test/schema-model.js](../test/schema-model.js): a real `StandardModel` over an
  in-memory datastore that evaluates the parsed query (and throws on an operator it doesn't know), keeps the `rows`
  array it's given up to date, and records its `calls`. Rows need ObjectId-hex ids (`newId()`). For a core model with
  the rest stubbed, spread `realQueryParser(CoreModel)` from [test/query-parser.js](../test/query-parser.js).
- To run a **single unit test file**: `npm run build && NODE_ENV=test npx mocha --timeout 2000 test/unit/src/access-control/filter.test.js`
  (mocha config is in [.mocharc.cjs](../.mocharc.cjs) — `require: ["test/hooks.js"]` sets up logging
  capture per test via `mochaHooks`).
- **E2E requires MongoDB + Redis actually running** at whatever `.test.env` points to (see
  `test:e2e` details below) — `test/before-e2e.js` connects, drops the test database and deletes the
  `<app code>:*` Redis keys (never FLUSHDB) before every e2e run, then `test/hooks.js` reads
  `<appData>/super.json` for the install-generated super token (`Config.testToken`) since e2e runs against a
  fully-installed instance, not mocks. See [Running e2e next to a dev instance](#running-e2e-next-to-a-dev-instance).
  [test/e2e/index.test.js](../test/e2e/index.test.js) is the entry point that requires the individual
  `test/e2e/{rest,sock,lambda,spr,perf}/*.test.js` suites.
- Env used for tests is `.test.env` (`NODE_ENV=test`) — see `helpers/config.ts`, which loads
  `.${NODE_ENV}.env` from the repo root via `@dpc/node-env-obj`. Performance tools (`npm run bench` and
  the I/O budget suite) are in [performance.md](performance.md).
- **Federation:** `npm run test:federation` builds, then runs [test/federation/](../test/federation) with mocha
  (without `.mocharc.cjs`). [setup.mjs](../test/federation/setup.mjs) installs and starts two stacks, a and b, each
  its own REST, Socket and SPR processes from `dist/bin` ([stacks.mjs](../test/federation/stacks.mjs)), on ports
  8200/8210 and 8300/8310 (`FEDERATION_BASE_PORT`), with its own `app_data` folder under the OS temp folder and its
  own app code, so its own database (`bjs-fed-<a|b>-prod`) and Redis prefix (`bjs-fed-<a|b>:`). It clears only
  those, before and after. MongoDB and Redis come from `FEDERATION_MONGO_URL` and `FEDERATION_REDIS_URL`
  (default localhost). Redis pub/sub isn't split by key prefix for socket.io's adapter, so the stacks' apps use
  different api paths. The suite pairs an app on each stack through the real agreement handshake and covers reads,
  writes, restarts, realtime both ways, policy-limited sharing, deactivation and a partner offline at boot; a test
  that fails because of a known gap names its plan item. `FEDERATION_WORKERS=2` runs the stacks with workers,
  `FEDERATION_LOG_LEVEL=silly` logs more, and each stack's logs are kept (and named) when a test fails or
  `FEDERATION_KEEP=1`. The singletons (`Model`, `Datastore`, `Config`) are why the stacks are processes, not
  bootstraps in the mocha process as in e2e. CI runs it as the Tests workflow's `federation-tests` job, once with
  `FEDERATION_WORKERS=0` and once with 2, keeping the stacks' work folders under the runner's temp folder and
  uploading their logs when it fails; the docker job waits for it.
- **Coverage:** `coverage:unit` (the CI coverage job) and `coverage` use c8, whose figures read high: it
  counts licence headers, comments and types as covered lines in any file that loads, and only counts
  branches inside functions that ran. For real numbers use `npm run coverage:istanbul` (add `-- unit` or
  `-- e2e` for one suite). It builds, runs the suites with `dist/` instrumented on load by a loader hook
  ([test/istanbul/](../test/istanbul), so `dist/` itself is untouched), and prints per-suite and combined
  coverage of `src/*.ts`; the HTML report lands in `coverage/istanbul/lcov-report/`. Its e2e step is plain
  `test:e2e`, so it needs MongoDB + Redis and clears them the same way.

### Running e2e next to a dev instance

`npm run test:e2e` can run while a dev Buttress (`.development.env`) uses the same MongoDB and Redis servers,
as long as the two configs differ in these ways:

| Shared thing | How the test run stays apart |
| --- | --- |
| MongoDB | Its own database, `<app code>-test` (or the connection string's path), which is the only one dropped. |
| Redis keys | Its own database index: set `BUTTRESS_REDIS_URL=redis://localhost:6379/15` in `.test.env`. Only `<app code>:*` keys are deleted in any case. |
| Redis pub/sub | Channels ignore the database index, so they're scoped by app code instead: NRP's are `<app code>::<channel>`, Socket.IO's adapter uses the key `<app code>:socket.io`. The test app code must differ from dev's. |
| Lambda folders | `paths.lambda.{code,plugins,bundles}` have test variants under `<appData>/test/lambda/`. The Lambda process deletes its bundles folder at boot, and the suites write a `lambda-HEAD` stub into the code folder. |
| Ports and host | Test REST/Socket ports (8022/8032) and host (`test.buttress.localhost`) differ from dev's. |

`test/before-e2e.js` checks this before it touches anything. It reads `.development.env` from this checkout and,
in a git worktree, from the main checkout, resolves it as a dev process would, and refuses to run if the
MongoDB database, Redis database, app code, REST URL, a listen port, the app data folder or a lambda folder
matches. It also refuses if `NODE_ENV` isn't `test` or `BUTTRESS_APP_PATH` is unset. Values that a dev process
gets from its shell environment rather than `.development.env` aren't seen.

A worktree has no `.test.env` (it's gitignored). Copy the main checkout's and set `BUTTRESS_APP_PATH` to the
worktree, so the run uses the worktree's `app_data/test` and the lambda suites clone the worktree's code. Two
e2e runs at once still collide on the test ports and database.

## Running from source (non-Docker)

```bash
npm install
export SERVER_ID='name'
npm run build
./bin/buttress.sh        # all 4 processes (REST, Socket, Lambda, SPR)
# or individually:
./bin/app.sh              # REST only
./bin/app-spr.sh           # SPR only
./bin/app-socket.sh        # Socket only
./bin/app-lambda.sh        # Lambda only
```

The first REST boot with no existing apps runs `__systemInstall()` and writes a one-time super-app token
to `<appData>/super.json` — capture it and delete the file (see [architecture.md](architecture.md)).

## Configuration

Config is loaded by [`@dpc/node-env-obj`](../src/helpers/config.ts) from two layers:

1. [src/config.json](../src/config.json) — the schema of every config key, as `%ENV_VAR_NAME%`
   placeholders under `global`, plus their defaults under `environment`.
2. `.<NODE_ENV>.env` (or `.<ENV_FILE>.env` if `ENV_FILE` is set) at the repo root — actual values for
   local dev, e.g. `.development.env`, `.test.env` (gitignored except `.example.env`, which documents the
   minimal variable set: `BUTTRESS_APP_TITLE`, `BUTTRESS_APP_CODE`, `BUTTRESS_APP_PATH`,
   `BUTTRESS_HOST_URL`, Mongo/Redis URLs, REST/Socket ports, `LAMBDA_*` worker counts).

Notable config paths used throughout the code (`Config.<path>`, all resolved from `src/config.json`):
`app.{title,code,version,protocol,host,apiPrefix,workers,trustProxy}`, `listenPorts.{rest,sock}`,
`datastore.{connectionString,options}`, `redis.{url,scope}`, `rest.app` / `sio.app` (`primary`/`secondary`
— controls which instance of a multi-instance REST/Socket deployment owns primary-only responsibilities),
`lambda.{apiWorkers,pathMutationWorkers,cronWorkers,developmentEmailAddress}`,
`timeout.{lambdaManager,lambdasRunner,shutdown}`, `paths.{appData,plugins,lambda.{code,plugins,bundles}}`.
`paths.logs`, `paths.appData` and `paths.lambda.*` have `dev`/`prod`/`test` variants, picked by `NODE_ENV`.

## Docker

```bash
npm run docker:build            # local image, tag "buttress"
npm run docker:build-token      # same, with --build-arg NPM_TOKEN for private package installs
npm run docker:run              # .docker/docker-compose.yml
npm run docker:run-full         # .docker/docker-compose.full.yml — Buttress + MongoDB + Redis
```

CI publishes `dpcltd/buttress:develop` on push to `develop` and `dpcltd/buttress:latest` +
`dpcltd/buttress:<version>` on push to `main`, only after tests pass (see
[docs/development/building.md](../docs/development/building.md)).

## Docs site

`npm run docs` serves [docs/](../docs) (docsify) locally — that's the **end-user-facing** documentation
(published to https://datapeopleconnected.github.io/buttress-js/). It's a good source for the JSON
shapes of policies/lambdas/schemas/secure-store, but doesn't cover internals — that's what the other
files in [.ai/](.) are for.

GitHub Pages serves `main:/docs`, so doc changes on develop go live with a release. Links in a page are relative to
that page, as on GitHub (`relativePath: true` in [docs/index.html](../docs/index.html)). Links in `_sidebar.md`
start with `/`, since it's shown on every page. `npm run docs:check` resolves every link and image the way docsify
does and fails on any that doesn't reach a page, heading or file in docs/; it doesn't fetch other sites.

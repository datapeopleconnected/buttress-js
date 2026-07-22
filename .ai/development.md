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

Source is TypeScript in `src/`, compiled to `dist/` (nodenext ESM, target ES2024, `strict: true`,
`noImplicitAny: false` — see [tsconfig.json](../tsconfig.json)). **Nothing runs against `src/` directly**
— processes (`bin/*.sh`), unit tests, and e2e tests all import from `dist/`. Always rebuild after
changing `src/` before running tests or starting a process locally.

## Lint / format / license / typecheck

```bash
npm run lint            # eslint ./src
npm run lint:fix
npm run format           # prettier --check ./src
npm run format:fix
npm run licence-check    # ./.husky/licence-check — every src file (except html/json/md/sh) must
                          # contain the AGPL header block from .husky/licencing_header.txt
npm run check            # tsc --noEmit && lint && format && licence-check — the full pre-PR gate
```

The pre-commit hook (`.husky/pre-commit`) runs `licence-check` + `build` on every commit — a commit will
fail if a new/edited `src/*.ts` file is missing the license header or the build breaks. ESLint config
([eslint.config.mjs](../eslint.config.mjs)): `max-len` 150 (ignoring strings/template literals),
`@typescript-eslint/no-explicit-any` is a warning (not an error — `any` is used pervasively in this
codebase, don't treat `no-explicit-any` warnings as things that must be fixed). Prettier: single quotes,
trailing commas, 120 print width, 2-space indent, semicolons — see
[.prettierrc.json](../.prettierrc.json).

## Tests

```bash
npm run test              # build + test:unit + test:e2e (what CI runs)
npm run test:unit         # mocha over test/unit/**/* — imports compiled dist/, NOT src/
npm run test:e2e          # wipes the test DB/Redis, boots a real Buttress in INSTALL_MODE, then runs
                            # test/e2e/index.test.js against it
```

- **Unit tests import `dist/`** (see e.g. [test/unit/src/helpers/schema.test.js](../test/unit/src/helpers/schema.test.js)
  which does `import * as Helpers from '../../../../dist/helpers/index.js'`). If you edit `src/` and run
  `npm run test:unit` directly (skipping `npm run build`), you're testing stale compiled output.
- To run a **single unit test file**: `npm run build && NODE_ENV=test npx mocha --timeout 2000 test/unit/src/access-control/filter.test.js`
  (mocha config is in [.mocharc.cjs](../.mocharc.cjs) — `require: ["test/hooks.js"]` sets up logging
  capture per test via `mochaHooks`).
- **E2E requires MongoDB + Redis actually running** at whatever `.test.env` points to (see
  `test:e2e` details below) — `test/before-e2e.js` connects and drops the test database + flushes Redis
  before every e2e run, then `test/hooks.js` reads `<appData>/super.json` for the install-generated super
  token (`Config.testToken`) since e2e runs against a fully-installed instance, not mocks.
  [test/e2e/index.test.js](../test/e2e/index.test.js) is the entry point that requires the individual
  `test/e2e/{rest,sock,lambda,spr}/*.test.js` suites.
- Env used for tests is `.test.env` (`NODE_ENV=test`) — see `helpers/config.ts`, which loads
  `.${NODE_ENV}.env` from the repo root via `@dpc/node-env-obj`. `test:e2e:timed` /
  `perf:baseline:record` / `perf:compare` wrap the e2e run with timing collection
  ([test/perf/](../test/perf)) to catch performance regressions between runs.

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
`timeout.{lambdaManager,lambdasRunner}`, `paths.{appData,plugins,lambda.{code,plugins,bundles}}`.

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

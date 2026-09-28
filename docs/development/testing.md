# Testing

Testing is split between unit tests and end-to-end (E2E) tests.

## Run All Tests

```bash
npm run test
```

This runs:

1. Build
2. Unit tests
3. E2E tests

## Run Test Suites Individually

```bash
npm run build   # unit tests import compiled dist/, not src/ — rebuild after any source change
npm run test:unit
npm run test:e2e
```

To run a single unit test file directly:

```bash
npm run build && NODE_ENV=test npx mocha --timeout 2000 test/unit/src/access-control/filter.test.js
```

## Local Requirements for E2E

E2E tests boot a real Buttress instance (in install mode) against MongoDB and Redis, then run against it —
there are no mocks. Both must be reachable before you run `npm run test:e2e`.

Buttress reads test configuration from a `.test.env` file at the repo root (`NODE_ENV=test`). It's
gitignored, so you need to create your own — copy `.example.env` and set at least
`BUTTRESS_DATASTORE_CONNECTION_STRING` and `BUTTRESS_REDIS_URL`. Any value you don't set falls back to the
same defaults as a normal build: `mongodb://localhost:27017` and `redis://localhost:6379`. If you're also
running a dev instance locally, point `.test.env` at different ports (or a different database name) so the
two don't collide — `npm run test:e2e` and `npm run test:io-budgets` both drop the test database and flush
Redis before running.

If MongoDB/Redis aren't reachable, E2E setup fails immediately (for example with a MongoDB connection
refused error) before any tests run.

## Docker-Assisted Local E2E Setup

A simple approach is to start dedicated dependencies in Docker on non-default ports, then point `.test.env`
at them:

```bash
docker run -d --name buttress-test-mongodb -p 27018:27017 mongo:8
docker run -d --name buttress-test-redis -p 6380:6379 redis:alpine
```

```bash
# .test.env
BUTTRESS_DATASTORE_CONNECTION_STRING=mongodb://localhost:27018
BUTTRESS_REDIS_URL=redis://localhost:6380
```

Then run:

```bash
npm run test:e2e
```

## CI Behavior

In CI, the tests workflow runs unit and E2E tests.

Docker image publishing is triggered only after successful test completion on push events:

- Push to `develop` -> publish `dpcltd/buttress:develop`
- Push to `main` -> publish `dpcltd/buttress:latest` and `dpcltd/buttress:<version>`

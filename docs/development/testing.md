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
npm run test:unit
npm run test:e2e
```

## Local Requirements for E2E

E2E tests require both MongoDB and Redis to be available.

Required defaults used by tests:

- MongoDB: `mongodb://localhost:27018`
- Redis: `redis://localhost:6380`

If these services are missing, E2E setup fails (for example with MongoDB connection refused).

## Docker-Assisted Local E2E Setup

A simple approach is to start dependencies in Docker:

```bash
docker run -d --name buttress-test-mongodb -p 27018:27017 mongo:8
docker run -d --name buttress-test-redis -p 6380:6379 redis:alpine
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

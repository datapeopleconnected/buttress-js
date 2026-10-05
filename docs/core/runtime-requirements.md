# Runtime Requirements

## Supported Runtime

| Component | Requirement |
| --- | --- |
| Node.js | >= 24.15 |
| TypeScript (build-time) | ^5.8 |
| MongoDB | Compatible with project datastore usage |
| Redis | 6.2 or later (the SPR uses `ZMSCORE`), with `@redis/client` ^5.6 |

## Process Dependencies

- REST, Socket, Lambda, and SPR processes share a common environment model, and communicate with each
  other only over Redis and Node `cluster` IPC — never direct function calls, even locally.
- MongoDB is required for persistent data.
- Redis is required for cache and pub/sub behavior.
- The `SERVER_ID` environment variable must be set to run any process from source, e.g.
  `export SERVER_ID='name'`. Not needed when running the published Docker image.

## Build and Test Baseline

```bash
npm run build
npm run test:unit
npm run test:e2e
```

Everything at runtime (processes, unit tests, e2e tests) imports from `dist/`, never `src/` directly — run
`npm run build` again after any source change before testing or starting a process locally.

If `test:e2e` fails locally, validate MongoDB/Redis availability and your `.test.env` configuration — see
[Testing](../development/testing.md).

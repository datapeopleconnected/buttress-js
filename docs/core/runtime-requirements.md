# Runtime Requirements

## Supported Runtime

| Component | Requirement |
| --- | --- |
| Node.js | >= 24.15 |
| TypeScript (build-time) | ^5.8 |
| MongoDB | Compatible with project datastore usage |
| Redis | Compatible with `@redis/client` ^5.6 |

## Process Dependencies

- REST, Socket, Lambda, and SPR processes share a common environment model.
- MongoDB is required for persistent data.
- Redis is required for cache and pub/sub behavior.

## Build and Test Baseline

```bash
npm run build
npm run test:unit
npm run test:e2e
```

If `test:e2e` fails locally, validate MongoDB/Redis availability and configured ports.

# Architecture

ButtressJS runs as four cooperating processes backed by MongoDB and Redis.

## Process Model

| Process | Entry Script | Purpose | Default Port |
| --- | --- | --- | --- |
| REST | `bin/app.sh` | Core HTTP API and generated schema routes | 8000 |
| Socket | `bin/app-socket.sh` | Realtime delivery over Socket.IO | 8010 |
| Lambda | `bin/app-lambda.sh` | Serverless lambda execution workers | n/a |
| SPR | `bin/app-spr.sh` | Secondary proxy/routing process | n/a |

`bin/buttress.sh` starts all required processes.

## Shared Runtime Patterns

- Bootstrap classes initialize process concerns (startup, cleanup, worker lifecycle).
- Redis is used for cache and pub/sub (NRP).
- Worker count is controlled by `BUTTRESS_APP_WORKERS`.
- Configuration is environment-driven.

## Data Flow Summary

1. Client sends REST request with token.
2. Access control resolves policies and constraints.
3. Datastore operation executes.
4. Mutation events are published.
5. Socket process broadcasts updates to subscribed clients.
6. Path mutations can trigger lambda execution.

## Multi-Tenant Model

Each registered app is tenant-isolated at the policy/schema level and may optionally override datastore connection settings.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ButtressJS — a federated, real-time, multi-tenant data platform (Node.js/TypeScript, MongoDB, Redis,
Express, Socket.IO). One codebase, four cooperating process types (REST, Socket, Lambda, SPR).

## Read this first

Detailed, code-accurate architecture notes live in **[.ai/](.ai/)** — read the relevant file(s) there
before working in an area rather than re-deriving them from scratch:

| File | Covers |
| --- | --- |
| [.ai/architecture.md](.ai/architecture.md) | The 4 process types, bootstrap/cluster lifecycle, end-to-end request→realtime data flow, multi-tenancy, plugin system, federation |
| [.ai/data-layer.md](.ai/data-layer.md) | `ModelManager`/`Model`, `StandardModel`, the JSON schema system, datastore adapters (Mongo/Buttress/Empty) |
| [.ai/access-control.md](.ai/access-control.md) | Policy engine: REST request-time middleware vs. SPR broadcast-time evaluation, `PolicyCache` |
| [.ai/lambda-system.md](.ai/lambda-system.md) | `LambdaManager` (queueing/debouncing) + `LambdaRunner` (isolated-vm execution) |
| [.ai/routing.md](.ai/routing.md) | `Routes`/`Route` request lifecycle, middleware chain, generated schema CRUD routes |
| [.ai/development.md](.ai/development.md) | Build/lint/format/test commands, running a single test, config & env vars, Docker |

User-facing product docs (policy/lambda/schema JSON shapes, deployment guides) live in [docs/](docs/)
(docsify site) — useful for payload shapes, not for internals.

## Quick command reference

```bash
npm run build          # tsc + copy non-.ts assets, src/ -> dist/ (required before running or unit-testing)
npm run lint            # eslint ./src
npm run format           # prettier --check ./src
npm run check            # tsc --noEmit && lint && format && licence-check — full pre-PR gate
npm run test             # build + test:unit + test:e2e (needs MongoDB + Redis reachable)
npm run test:unit        # mocha over test/unit/**/* (imports compiled dist/, run build first)
npm run docker:run-full  # Buttress + MongoDB + Redis via docker-compose
```

See [.ai/development.md](.ai/development.md) for single-test invocation, env/config wiring, and
license-header requirements enforced by the pre-commit hook.

## Working conventions specific to this repo

- Everything imports from `dist/`, never `src/`, at runtime and in tests — rebuild after every source
  change before running a process or `test:unit`.
- Every source file under `src/` (except `.html`/`.json`/`.md`/`.sh`) must carry the AGPL license header
  block checked by `npm run licence-check` / the pre-commit hook.
- REST, Socket, Lambda, and SPR are always separate processes, even locally — cross-process
  communication only happens over Redis pub/sub (NRP) and Node `cluster` IPC, never direct function
  calls. When changing behavior that spans processes (e.g. a new mutation type that should trigger a
  socket update), trace the NRP event chain in [.ai/architecture.md](.ai/architecture.md) rather than
  assuming in-process calls will reach the other side.

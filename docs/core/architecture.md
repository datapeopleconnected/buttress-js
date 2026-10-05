# Architecture

ButtressJS is one codebase that boots into four cooperating process types, backed by MongoDB (durable
storage) and Redis (cache + cross-process pub/sub). Which process you get depends only on which entry
script runs — there's no "monolith" mode, even for local development.

## Process Model

| Process | Entry Script | Purpose | Default Port |
| --- | --- | --- | --- |
| REST | `bin/app.sh` | Core HTTP API: built-in routes (apps, users, tokens, policies, ...) plus generated CRUD routes per app schema | 8000 |
| Socket | `bin/app-socket.sh` | Realtime delivery to connected clients over Socket.IO | 8010 |
| Lambda | `bin/app-lambda.sh` | Runs app-scoped serverless functions (CRON, path-mutation and API-endpoint triggers) | n/a |
| SPR (Socket Policy Router) | `bin/app-spr.sh` | Evaluates access policy at broadcast time to decide which connected sockets should hear about a change | n/a |

`bin/buttress.sh` starts all four together and forwards shutdown signals to each. In Docker, this is the
container's entrypoint. Lambda and SPR don't listen on a port — they're internal workers driven entirely
by Redis pub/sub events, not HTTP.

## Shared Runtime Patterns

- Every process type uses the same primary/worker model (Node's `cluster` module): a primary process forks
  N workers that do the actual work, and talks to them over IPC as well as Redis. `BUTTRESS_APP_WORKERS`
  controls how many workers are forked (`0` runs everything in a single process, useful for local debugging).
- Redis backs two independent things: the policy/token cache (see [Access Control](access-control.md)) and
  NRP (Node Redis Pub/sub) — the cross-process event bus every process type listens to.
- Configuration is entirely environment-driven — see [Configuration](../getting-started/configuration.md).
- On shutdown (SIGTERM/SIGINT) each process stops accepting new work but lets in-flight requests and
  running lambdas finish, up to `BUTTRESS_TIMEOUT_SHUTDOWN` seconds (default 8) before it exits anyway.

## Data Flow: a write to a realtime update

A `POST`/`PUT`/`DELETE` against a schema's generated API doesn't talk to the Socket process directly —
it goes through the SPR so that access-control evaluation for realtime delivery never runs inline in the
request path:

1. A client sends a REST request with a token. The REST process authenticates the token and runs the
   request-time access-control policy middleware, which can inject query/projection constraints into the
   datastore operation (see [Access Control](access-control.md)).
2. The datastore operation executes (MongoDB by default, or a remote Buttress instance for a federated
   collection — see [Federation](../federation/)).
3. The REST process publishes the mutation over Redis (NRP), and separately flags it for any lambda whose
   `PATH_MUTATION` trigger matches the write.
4. The SPR process picks up the mutation, resolves every policy that's relevant to that schema, evaluates
   each one against the mutated entity for every currently-connected token, and republishes a filtered,
   per-token (or per-policy) event.
5. Socket process workers pick up the SPR's filtered events and emit them to the Socket.IO room(s) for the
   matching app/token, which is what a connected client actually receives.
6. If the write matched a `PATH_MUTATION` lambda trigger, the Lambda process debounces matching writes and
   runs the lambda — see [Lambda](../applications/lambda.md).

If a REST write succeeded but a client isn't seeing the realtime update, the fault is almost always
somewhere in this REST → SPR → Socket pipeline (a policy that doesn't grant the token realtime visibility,
or the socket not actually subscribed), not in the write itself.

## Multi-Tenant Model

A single Buttress deployment hosts multiple **apps**. Each app has its own API path (mounted as its own
sub-router), its own JSON schema, and optionally its own datastore connection string — otherwise it shares
the core MongoDB datastore. Core collections (apps, tokens, users, policies, ...) always live in the core
datastore and are never per-app.

The first app ever created is the **super app** — its token bypasses the access-control policy middleware
entirely and is written once to `app_data/<app_code>.json` on first boot. See [Admin](../getting-started/admin.md).

## Plugins

Buttress can load plugins from the filesystem (not npm packages) at `Config.paths.plugins`. A plugin can
register its own Express routes and hook into request handling via WordPress-style actions/filters. There's
no plugin registry in this repository, only the loader — plugins live outside the core codebase.

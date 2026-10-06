# Access Control

Buttress enforces declarative, policy-based access control. See [Policy](../applications/policy.md) for the
JSON shape (`selection`, `config[].verbs/schema/query/projection/condition`). This page covers how policies
get evaluated.

## Core Concepts

- Tokens carry identity and **policy properties** (arbitrary key/value pairs, e.g. `role: "admin"`).
- A policy's `selection` block matches against a token's policy properties to decide whether the policy
  applies to that token at all.
- A policy's `config` entries then scope what the token can do: which verbs, which schema(s), and optional
  query/projection constraints that get merged into the request.
- **Default is deny.** If no policy grants a token access to a given verb+schema, the request is rejected —
  there's no implicit access.

## Two separate evaluation paths

Policies get evaluated in two different places, for two different questions, and it's easy to conflate them:

1. **REST request-time middleware** — runs on every REST request, before the route handler. Decides *whether
   this request is allowed at all*, and resolves the query/projection constraints the route handler applies
   to its datastore operation.
2. **SPR (Socket Policy Router) broadcast-time evaluation** — runs only in the SPR process, *after* a write
   has already happened. Decides *which currently-connected sockets should be told about it*, by evaluating
   policies against the mutated entity for each connected token. See [Architecture](architecture.md) for
   where this sits in the write → realtime-update pipeline.

Both decide the same way: a token's socket is told about a change to an entity when its policies would let a REST
read reach that entity, with the properties they'd let it read. The SPR decides it separately, after the write,
for the tokens the policy cache has as connected; so if REST access works but realtime updates don't show up, look at
the SPR pipeline and the cache, not the policy.

## REST evaluation flow

1. Token is extracted and loaded.
2. The token's applicable policies are resolved (from the policy cache) and sorted by `priority`.
3. Each policy's `config` entries are narrowed to ones matching the request's verb + schema.
4. Any `condition` blocks are evaluated against the request; policies that fail drop out.
5. Remaining `query` blocks resolve into a concrete datastore query fragment, their `#env.` values read from the
   request. A config whose query can't be applied (an `#env.` value that isn't set, an operator Buttress doesn't
   know, or a query the schema can't read) drops out, and the token's other configs still apply.
6. `projection` blocks resolve into field-level restrictions: a read may only query or sort by the properties a
   projection lets through; if resolving projections leaves no applicable policy, the request is denied.
7. Surviving configs are merged where that doesn't change what they give together (the same query reads every
   property either config does; configs that read every property have their queries OR'd together) and handed to
   the route handler, which reads the rest in one query per data source: each entity comes once, with the
   properties of each config whose query reads it.

## Policy Cache

Resolved policy and token state is cached in Redis to avoid re-resolving policies on every request and to
let the SPR quickly find which tokens/sockets a given change is relevant to. This cache **must** be
invalidated whenever a token's policy properties change, or whenever a policy itself is created/updated/
deleted — Buttress does this automatically for its own APIs (creating a token, setting policy properties,
editing a policy), so it only matters if you're writing code that mutates these collections directly rather
than through the model layer.

## Token domains

A user token's `domains` say which web origins may use it. Every REST request made with a user token is checked, and
one from an origin that isn't allowed is answered 403 `origin_not_allowed`. Other tokens aren't checked, and neither
are Socket.IO connections.

- The origin is the request's `Origin` header, or its `Host` if it has no `Origin`, without the `http://` or
  `https://`: a host, with its port if it has one (`app.example.com`, `localhost:3000`). An `http://` or `https://`
  in a domain is ignored too.
- A domain without a `*` allows the origin that is the same text.
- In any other domain, `*` stands for any run of characters, and the domain has to match the whole origin:
  - `*` on its own allows every origin;
  - `*.example.com` allows `app.example.com` and `app.eu.example.com`, but not `app.example.com.evil.io`, or
    `example.com` itself, which needs its own entry;
  - a port is part of the origin, so `*.example.com` doesn't allow `app.example.com:8443`. List
    `*.example.com:8443`, or end a domain with `:*` to allow any port (`localhost:*`).
- The instance's own host, `BUTTRESS_HOST_URL`, is always allowed.

Earlier releases matched a domain with a `*` anywhere in the origin, so `*.example.com` also allowed
`app.example.com.evil.io` and `app.example.com:8443`. A token that relied on such a partial match is now refused
with 403 `origin_not_allowed`. No route changes a token's domains, so give the user a new token whose `domains` list
every origin it's used from (`POST /api/v1/user/:id/token`).

## Practical Guidance

- Use least-privilege policies by default; there's no implicit access to fall back on.
- Scope policy selectors to explicit roles/capabilities rather than broad matches.
- Keep wildcard access (`%FULL_ACCESS%`, `%ALL%`) for admin-only policies, and keep those policies few and
  auditable.
- A policy can carry a `limit` (expiry date): it grants nothing once the limit passes, and Buttress then removes it,
  along with the property a transient policy selects its tokens by. See [Policy](../applications/policy.md#limit).

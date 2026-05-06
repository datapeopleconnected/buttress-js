# Access Control

Buttress enforces declarative access control on REST and Socket operations.

## Core Concepts

- Tokens carry identity and policy properties.
- Policies define who can access what and under which conditions.
- Policy config can inject query and projection constraints.

## Evaluation Flow

1. Token is extracted and loaded.
2. Token policy properties are matched against policy `selection` blocks.
3. Applicable policy configs are evaluated.
4. Query constraints are merged into datastore queries.
5. Projection constraints are applied to response fields.
6. Final filtering ensures responses stay within policy bounds.

## Policy Cache

Resolved policy state is cached to reduce repeated resolution overhead.

Operational note:

- Cache invalidation must happen when token policy properties change.

## Practical Guidance

- Use least-privilege policies by default.
- Scope policy selectors to explicit roles/capabilities.
- Keep wildcard access (`%FULL_ACCESS%`, `%ALL%`) for admin-only paths.

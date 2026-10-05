# Applications

An application is a tenant boundary in Buttress.

Each app has its own:

- API path (`apiPath`)
- Token scope
- Schema
- Policy set
- Optional datastore override

## Core Resources

- Schema: defines data structure and generated API collections
- Policy: enforces access control and query/projection constraints
- Lambda: app-scoped serverless execution model
- Secure Store: app-scoped encrypted object storage

## Typical Lifecycle

1. Create app
2. Create or update schema
3. Create policies
4. Create tokens and set policy properties
5. Add optional lambdas and secure store secrets

Continue with:

- [Schema](schema.md)
- [Policy](policy.md)
- [Lambda](lambda.md)
- [Secure Store](secure-store.md)
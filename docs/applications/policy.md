# Policy

Policies define access control behavior for app tokens.

By default, requests without matching policy access are denied.

## Policy Shape

| Property | Type | Required | Description |
| :- | :- | :-: | :- |
| name | string | yes | Policy name |
| version | string | yes | Policy version. A policy without one is refused with `invalid_policy_no_version` |
| merge | boolean | no | Merge behavior when multiple policies apply |
| priority | number | no | Evaluation precedence |
| selection | object | yes | Selector against token policy properties |
| env | object | no | Values a config's query can use |
| config | array | yes | Access definitions (verbs, endpoints, schema, query, projection, condition) |
| limit | date | no | Optional policy expiry |

A policy is checked when it's added, synced or updated, and refused with a 400, `invalid_policy`, listing each
problem in `details.issues`, when a config would grant nothing or fail when it's evaluated. Each config needs
`verbs`, a list of `GET`, `QUERY`, `POST`, `PUT`, `DELETE` or `%ALL%`; `schema`, a list of schema names; and a
`query` object (`{"access": "%FULL_ACCESS%"}` for every entity). A `projection` is `{"keys": [...]}`, and a
`condition` or `env` is an object. Earlier releases saved a config without a query, and it granted nothing.

`QUERY` grants [searches](schema.md#searching). `SEARCH`, its name in earlier releases, is the same verb: a config
listing either grants requests made with either method, so existing policies don't need changing.

A policy that's added or synced is then read as the table types it, as an app's schema reads an entity, and a value
that isn't of its type is refused with a 400, `invalid_value`, naming it, with every problem in `details.issues`:
a `priority` that isn't a number, say, or a `limit` that isn't a date. Earlier releases stored such values as they
were given.

## Listing and Removing

`GET /api/v1/policy` lists the app's policies; `?ids=a,b` lists only those of them. Earlier releases checked the ids
and listed every policy. `DELETE /api/v1/policy` removes the app's policies; with a system token it removes every
app's.

## CLI Commands

Create from a JSON file:

```bash
bjs policy create --filePath="./policy.json"
```

List property metadata:

```bash
bjs policy list-property
```

## Example

```json
[
  {
    "name": "email-reader",
    "version": "1",
    "selection": {
      "emailReader": {
        "@eq": true
      }
    },
    "config": [
      {
        "verbs": ["GET"],
        "schema": ["email"],
        "query": {
          "access": "%FULL_ACCESS%"
        }
      }
    ]
  },
  {
    "name": "junior-account-manager",
    "version": "1",
    "selection": {
      "role": {
        "@eq": "accountant"
      }
    },
    "config": [
      {
        "verbs": ["GET", "QUERY"],
        "schema": ["finance"],
        "query": {
          "salary": {
            "$lte": 40000
          }
        }
      }
    ]
  }
]
```

## Best Practices

- Prefer least privilege and explicit selectors.
- Keep admin wildcard policies separate and tightly scoped.
- Use projection/query constraints to enforce row and field-level restrictions.
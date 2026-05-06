# Policy

Policies define access control behavior for app tokens.

By default, requests without matching policy access are denied.

## Policy Shape

| Property | Type | Required | Description |
| :- | :- | :-: | :- |
| name | string | yes | Policy name |
| merge | boolean | no | Merge behavior when multiple policies apply |
| priority | number | no | Evaluation precedence |
| selection | object | yes | Selector against token policy properties |
| config | array | yes | Access definitions (verbs, endpoints, schema, query, projection, condition) |
| limit | date | no | Optional policy expiry |

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
    "selection": {
      "role": {
        "@eq": "accountant"
      }
    },
    "config": [
      {
        "verbs": ["GET", "SEARCH"],
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
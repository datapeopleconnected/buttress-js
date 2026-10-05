# Secure Store

Secure Store provides app-scoped encrypted object storage for sensitive values used by lambdas and services.

## Object Shape

| Property | Type | Required | Description |
| :- | :- | :-: | :- |
| name | string | yes | Secure store key name |
| storeData | object/array | yes | Arbitrary payload |

## CLI Commands

Create keys from a JSON file:

```bash
bjs secure-store create --filePath="./secure-store.json"
```

List available properties:

```bash
bjs secure-store list-property
```

## Example

```json
[
  {
    "name": "google-credentials",
    "storeData": {
      "client_id": "CLIENT_ID",
      "client_secret": "CLIENT_SECRET",
      "redirect_uri": "REDIRECT_URI",
      "scope": "SCOPE"
    }
  },
  {
    "name": "allowed-members",
    "storeData": [
      {
        "identifierEmail": "person@example.org",
        "policySelectors": {
          "role": "developer"
        }
      }
    ]
  }
]
```

## Security Guidance

- Do not commit real secret values to source control.
- Scope stored data per app and per function purpose.
- Rotate secrets and update dependent lambdas after changes.
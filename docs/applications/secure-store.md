# Secure Store

Secure Store provides app-scoped encrypted object storage for sensitive values used by lambdas and services.

## Object Shape

| Property | Type | Required | Description |
| :- | :- | :-: | :- |
| name | string | yes | Secure store key name |
| storeData | object/array | yes | Arbitrary payload |

A create, one (`POST /api/v1/secure-store`) or a list of them (`POST /api/v1/secure-store/bulk/add`), refuses a `name`
that isn't a string, or `storeData` that isn't an object, with a 400 `invalid_value` naming the property (and, in a
list, the item's `index`), as it does a name the app already has with `already_exist`. Earlier releases took a number
for a `name`, and checked a list less closely, taking a `name` that was an object as a query.

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
# Lambda

Lambdas are app-scoped serverless functions deployed from git and executed in an isolated runtime.

## Trigger Types

- `CRON`
- `PATH_MUTATION`
- `API_ENDPOINT`

## Lambda Shape

| Property | Type | Required | Description |
| :- | :- | :-: | :- |
| name | string | yes | Lambda name |
| type | string | no | `PRIVATE` or `PUBLIC` |
| git | object | yes | Repository details (`url`, `branch`, `hash`, `entryFile`, `entryPoint`) |
| trigger | array | yes | Trigger configuration list |
| policyProperties | object | yes | Policy properties attached to lambda execution context |

## CLI Commands

Create from file:

```bash
bjs lambda create --filePath="./lambda.json"
```

List fields:

```bash
bjs lambda list-property
```

## Example

```json
[
  {
    "name": "hello-world-lambda",
    "type": "PRIVATE",
    "git": {
      "url": "ssh://git@example.org/lambdas/hello-world.git",
      "branch": "main",
      "hash": "54f2fd5f0c0e889881f0a2af40f9d69240b47b6b",
      "entryFile": "index.js",
      "entryPoint": "execute"
    },
    "trigger": [
      {
        "type": "CRON",
        "cron": {
          "status": "PENDING",
          "periodicExecution": "in 1 minute"
        }
      }
    ],
    "policyProperties": {
      "adminAccess": {
        "@eq": true
      }
    }
  },
  {
    "name": "outbound-email",
    "git": {
      "url": "ssh://git@example.org/lambdas/google-outbound-emails.git",
      "branch": "main",
      "hash": "3c4a3fce2e8d102fb14b410e22464551bc8a30bb",
      "entryFile": "index.js",
      "entryPoint": "execute"
    },
    "trigger": [
      {
        "type": "PATH_MUTATION",
        "pathMutation": {
          "paths": ["email.*"]
        }
      }
    ],
    "policyProperties": {
      "googleEmail": {
        "@eq": true
      }
    }
  }
]
```

## Notes

- API endpoint lambdas are invoked via configured lambda endpoint routes.
- Use `PUBLIC` only when endpoint exposure is explicitly required.
- Keep lambda git inputs pinned and auditable.
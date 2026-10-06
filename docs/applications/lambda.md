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
| type | string | no | `PRIVATE` (the default) or `PUBLIC`. Only a `PUBLIC` lambda's API endpoint takes calls without a token; any other takes a token of the lambda's app, or a system token |
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
- `GET /api/v1/lambda` lists the app's lambdas; `?ids=a,b` lists only those of them. Earlier releases checked the ids
  and listed every lambda. A lambda search takes `skip`, `limit`, `sort` and `project`, as any search does.
- Use `PUBLIC` only when endpoint exposure is explicitly required.
- A lambda that's added is read as the lambda schema types it, and a value that isn't of its type, or a trigger
  setting that isn't one it takes (an `apiEndpoint.method` other than `GET` or `POST`, say), is refused with a 400,
  `invalid_value` (`missing_field` for a `metadata` item without its `key` or `value`), with every problem in
  `details.issues`. Earlier releases stored such values as they were given.
- Earlier releases stored a lambda added without a `type` with none, and its API endpoint took calls without a token.
  It's now stored `PRIVATE`, and a lambda already stored without a type is treated as `PRIVATE`: set its `type` to
  `PUBLIC` if it should keep taking calls without a token.
- Keep lambda git inputs pinned and auditable.
- Deploying a lambda again takes a branch that doesn't track the repository's (as git sets one up with
  `branch.autoSetupMerge` off), and refuses a branch the repository doesn't have with a 400, `branch_not_found`.
  Earlier releases refused the first as `branch_not_found` and failed on the second as a server error.
- A run ends once the promise its entry point returns has settled and the execution is recorded. Work it leaves running,
  such as a `sleep()` or `fetch()` it didn't await, stops then: its sleeps and requests are cancelled, and anything it
  calls after that (`setResult`, logging, `updateMetadata`, `fetch`, ...) is refused. Earlier releases let that work go
  on into the worker's later runs, where it answered, logged and acted for them. Await what a lambda needs done before
  it returns.
- A value a lambda gives the server (its result, a log, what it passes to `fetch`, `updateMetadata` or a plugin) has to
  be one the server can write out as JSON in 128 MB: a result over that, or one that refers to itself, fails the run;
  a log over it is logged as a note saying so; and a call given one rejects. Only a value that refers to the same
  objects many times over can get that big, as the lambda's own memory is no bigger. Earlier releases tried to write
  such a value out, which could stop the worker running any lambda.
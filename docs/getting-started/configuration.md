# Configuration

## Environment Files
Buttress reads configuration from environment variables. You can also provide an env file.

- `NODE_ENV=development` loads `.development.env`
- `NODE_ENV=production` loads `.production.env`

You can explicitly choose an env file with `ENV_FILE`:

```bash
ENV_FILE=.development.env NODE_ENV=development ./bin/buttress.sh
```

## Parameters
The table below lists commonly used runtime parameters.

| Property | Type | Default | Description |
| :- | :-: | :-: | -: |
| NODE_ENV | string | production | Used to determine the current deployment environment |
| BUTTRESS_APP_TITLE | string | ButtressJS | A title/name for the current Buttress Instance |
| BUTTRESS_APP_CODE | string | buttressjs | A unique code for the current Buttress instance |
| BUTTRESS_APP_PROTOCOL | string | https | Public protocol used in generated URLs |
| BUTTRESS_APP_PATH | string | (empty) | Absolute path to the runtime root |
| BUTTRESS_APP_WORKERS | boolean/int | FALSE | FALSE uses default worker strategy; integer sets worker count |
| BUTTRESS_HOST_URL | string | (empty) | Public host and optional port for generated URLs |
| BUTTRESS_REST_LISTEN_PORT | int | 8000 | REST process listen port |
| BUTTRESS_SOCK_LISTEN_PORT | int | 8010 | Socket process listen port |
| BUTTRESS_DATASTORE_CONNECTION_STRING | string | mongodb://localhost:27017 | Datastore connection string |
| BUTTRESS_DATASTORE_OPTIONS | string | appName=%BUTTRESS_APP_CODE%&maxPoolSize=100 | |
| BUTTRESS_REDIS_URL | string | redis://localhost:6379 | Redis connection URL |
| BUTTRESS_REST_APP | string | primary | |
| BUTTRESS_SOCKET_APP | string | primary | |
| BUTTRESS_LOGGING_LEVEL | string | info | |
| BUTTRESS_LOGGING_SLOW | boolean | TRUE | |
| BUTTRESS_LOGGING_SLOW_TIME | int | 2 | |

## Lambda Runtime Parameters

| Property | Type | Default | Description |
| :- | :-: | :-: | -: |
| LAMBDA_API_WORKERS | int | inherited | API lambda worker count |
| LAMBDA_PATH_MUTATION_WORKERS | int | inherited | Path-mutation worker count |
| LAMBDA_CRON_WORKERS | int | inherited | Cron worker count |
| BUTTRESS_TIMEOUT_LAMBDA | int | 5 | Lambda manager timeout |
| BUTTRESS_TIMEOUT_LAMBDAS_RUNNER | int | 10 | Lambda runner timeout |

## Notes

- `BUTTRESS_APP_PROTOCOL` and `BUTTRESS_HOST_URL` should match your externally reachable endpoint.
- In Docker Compose, local defaults may differ from source defaults (for example 8080/8081).
- Keep secrets (tokens, credentials) out of committed env files.

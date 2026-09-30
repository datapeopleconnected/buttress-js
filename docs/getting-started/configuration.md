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
| BUTTRESS_APP_INDEX_PAGE | boolean | TRUE | Serves the Buttress landing page at `/` and `/index.html`. Set FALSE to return 404 there instead |
| BUTTRESS_HOST_URL | string | (empty) | Public host and optional port for generated URLs |
| BUTTRESS_REST_LISTEN_PORT | int | 8000 | REST process listen port |
| BUTTRESS_SOCK_LISTEN_PORT | int | 8010 | Socket process listen port |
| BUTTRESS_TRUST_PROXY | int/boolean/string | 1 | Express `trust proxy` for the REST process: the number of proxy hops to trust, TRUE/FALSE, or a comma-separated list of proxy addresses/subnets. Set FALSE if clients reach Buttress directly, or they can set their own IP with `X-Forwarded-For`. Policies see the IP it gives as `#env.ipAddress` |
| BUTTRESS_DATASTORE_CONNECTION_STRING | string | mongodb://localhost:27017 | Datastore connection string |
| BUTTRESS_DATASTORE_OPTIONS | string | appName=%BUTTRESS_APP_CODE%&maxPoolSize=100 | |
| BUTTRESS_REDIS_URL | string | redis://localhost:6379 | Redis connection URL |
| BUTTRESS_REST_APP | string | primary | |
| BUTTRESS_SOCKET_APP | string | primary | |
| BUTTRESS_LOGGING_LEVEL | string | info | |
| BUTTRESS_LOGGING_SLOW | boolean | TRUE | |
| BUTTRESS_LOGGING_SLOW_TIME | int | 2 | |
| BUTTRESS_LOGGING_SERVER_TIMING | boolean | FALSE | Adds a `Server-Timing` header to API responses, with how long token auth, access control, validation and execution took. Exposes internal timings, so leave it off for public-facing instances |
| BUTTRESS_TIMEOUT_SHUTDOWN | int | 8 | Seconds a process has to finish in-flight work after SIGTERM/SIGINT before it exits anyway |
| BUTTRESS_DATA_SHARING_ALLOWED_HOSTS | string | (empty) | Comma-separated hosts data sharing agreements may connect to (`*` for any host, `*.example.com` for its subdomains). Empty lets them connect anywhere. When set, an agreement's endpoint and socket URL need an `http(s)://` or `ws(s)://` scheme and a listed host, and a host at a loopback, private, link-local or shared address is refused even if listed. Agreements outside it get a 400 `data_sharing_<reason>` and aren't connected |

## Lambda Runtime Parameters

| Property | Type | Default | Description |
| :- | :-: | :-: | -: |
| LAMBDA_API_WORKERS | int | inherited | API lambda worker count |
| LAMBDA_PATH_MUTATION_WORKERS | int | inherited | Path-mutation worker count |
| LAMBDA_CRON_WORKERS | int | inherited | Cron worker count |
| BUTTRESS_TIMEOUT_LAMBDA | int | 5 | Lambda manager timeout |
| BUTTRESS_TIMEOUT_LAMBDAS_RUNNER | int | 10 | Seconds a lambda execution may run before it's stopped |
| BUTTRESS_LAMBDA_ALLOWED_HOSTS | string | (empty) | Comma-separated hosts lambdas' `fetch()` and `generatePDF()` may reach, as for BUTTRESS_DATA_SHARING_ALLOWED_HOSTS. Empty lets them reach anywhere. When set, a fetch elsewhere, or to a loopback, private, link-local or shared address, fails with `fetch_<reason>`, and a PDF's HTML can't load resources from there |

## Notes

- `BUTTRESS_APP_PROTOCOL` and `BUTTRESS_HOST_URL` should match your externally reachable endpoint.
- In Docker Compose, local defaults may differ from source defaults (for example 8080/8081).
- Keep secrets (tokens, credentials) out of committed env files.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/buttress-logo-inverted.svg">
    <img src="brand/buttress-logo.svg" alt="buttress" width="360">
  </picture>
</p>

<p align="center">
  The digital spine designed to unlock interoperability, strengthen infrastructure and deliver real-world impact.
</p>

<p align="center">
  <a href="https://datapeopleconnected.github.io/buttress-js/">Documentation</a> ·
  <a href="https://datapeopleconnected.github.io/buttress-js/#/getting-started/quick-start">Quick start</a> ·
  <a href="https://hub.docker.com/r/dpcltd/buttress">Docker image</a> ·
  <a href="LICENSE">AGPL-3.0</a>
</p>

---

Buttress is an open source platform for federated, real-time data sharing. You describe your data as a schema, and
Buttress gives you a REST API for it, live updates over sockets, and access control on every record, for as many
applications as you like on one instance.

- **Federated.** Share collections between Buttress instances through data sharing agreements, so each organisation
  keeps its own data and controls what its partners can see.
- **Real-time.** Every change is pushed to connected clients over Socket.IO, filtered by what each client is allowed
  to read.
- **Policy-based access control.** Policies decide who can read and write which records and fields, with
  conditions such as an expiry date or the requester's IP address.
- **Multi-tenant.** Each application has its own schema, policies, tokens and data.
- **Lambdas.** Run your own JavaScript in a sandbox on a schedule, on an API call, or when data changes.

Buttress runs as four cooperating processes, REST, Socket, SPR (the socket policy router) and Lambda, backed by MongoDB
and Redis. One container runs all four. See [Architecture](docs/core/architecture.md) for how they fit together.

## Getting started

You need [Docker](https://docs.docker.com/get-docker/). Buttress listens on two ports: **8000** for the REST API
and **8010** for sockets.

### 1. Start MongoDB, Redis and Buttress

```bash
docker network create buttress-net
```

```bash
docker run -d --name buttress-mongodb --network buttress-net mongo:8
```

```bash
docker run -d --name buttress-redis --network buttress-net redis:alpine
```

```bash
docker run -d --name buttress --network buttress-net \
  -p 8000:8000 -p 8010:8010 \
  -e BUTTRESS_APP_PATH=/opt/buttress \
  -e BUTTRESS_APP_PROTOCOL=http \
  -e BUTTRESS_HOST_URL=localhost:8000 \
  -e BUTTRESS_DATASTORE_CONNECTION_STRING=mongodb://buttress-mongodb:27017 \
  -e BUTTRESS_REDIS_URL=redis://buttress-redis:6379 \
  dpcltd/buttress:latest
```

Open <http://localhost:8000> and you should see the Buttress landing page.

Image tags: `latest` is the latest release, `develop` tracks the develop branch, and each release has its own
version tag, such as `3.0.0-6`.

### 2. Get the super token

On its first start, Buttress creates a super token, which can administer the whole instance. It's written to a
file inside the container:

```bash
docker exec buttress cat /opt/buttress/app_data/super.json
```

Copy the `token` value somewhere safe, such as a secret manager, then delete the file:

```bash
docker exec buttress rm /opt/buttress/app_data/super.json
```

### 3. Make a request

Send tokens in the `Authorization` header. Buttress doesn't accept them in the query string.

```bash
curl http://localhost:8000/api/v1/app -H "Authorization: Bearer <your super token>"
```

You'll get back a list holding the super app.

### 4. Build your first application

Use the super token to create an application, give it a schema and policies, and issue tokens for your users. Follow
[Create an Application](docs/getting-started/create-an-application.md) for a complete example, and use one of the
[client libraries](docs/getting-started/client-libraries.md) to talk to it from your app.

## Other ways to run it

### Docker Compose, built from this repository

```bash
npm run docker:run-full
```

This builds an image from your checkout and starts it with MongoDB and Redis. The REST API is on port **8080** and
sockets on **8081**. The super token is at `/code/app_data/super.json` inside the `buttress` container.

### From source

You need Node.js 24.15 or later (`nvm use` picks the version in `.nvmrc`), and MongoDB and Redis running locally.

```bash
npm install
```

```bash
npm run build
```

Buttress reads its settings from environment variables, or from `.<NODE_ENV>.env` in the repository root. Create
`.development.env` with at least:

```bash
BUTTRESS_APP_PATH=/absolute/path/to/buttress-js
BUTTRESS_APP_PROTOCOL=http
BUTTRESS_HOST_URL=localhost:8000
BUTTRESS_DATASTORE_CONNECTION_STRING=mongodb://localhost:27017
BUTTRESS_REDIS_URL=redis://localhost:6379
```

Then start all four processes:

```bash
NODE_ENV=development npm start
```

The super token is written to `app_data/super.json` under `BUTTRESS_APP_PATH`. To run one process on its own, set
`APP_TYPE` to `REST`, `SOCK`, `SPR` or `LAMB`.

## Configuration

Every setting has a default except the ones above. [Configuration](docs/getting-started/configuration.md) lists them
all, including workers, logging, timeouts, and the allowed hosts for data sharing and lambdas. For production,
see the [deployment guides](docs/docker.md) and [Admin](docs/getting-started/admin.md) for looking after tokens.

## Development

```bash
npm run check
```

This runs the type check, lint, formatting, licence header and docs link checks: the gate before a pull request.

```bash
npm test
```

This builds, then runs the unit and end-to-end tests. The end-to-end tests need MongoDB and Redis. See
[Building](docs/development/building.md), [Testing](docs/development/testing.md) and
[Benchmarking](docs/development/benchmarking.md) for more, including how to run a single test.

To browse the documentation locally:

```bash
npm run docs
```

## Contributing

Contributions are welcome. Fork the repository, make your change on a branch, and open a pull request against
`develop` describing what it changes and why. Every source file needs the licence header that `npm run check`
looks for.

## License

Buttress is free software, licensed under the [GNU Affero General Public License v3.0](LICENSE) or later.
Copyright © 2016-2026 Data People Connected LTD.

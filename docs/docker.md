# Docker

Docker is the primary deployment path for ButtressJS.

## Quick Start (Docker Hub)

1. Create a local network:

```bash
docker network create buttress-net
```

2. Start MongoDB and Redis:

```bash
docker run -d --name buttress-mongodb --network buttress-net mongo:8
docker run -d --name buttress-redis --network buttress-net redis:alpine
```

3. Start ButtressJS:

```bash
docker run -d --name buttress \
  --network buttress-net \
  -p 8000:8000 \
  -p 8010:8010 \
  -e NODE_ENV=production \
  -e BUTTRESS_APP_PATH=/opt/buttress \
  -e BUTTRESS_HOST_URL=localhost:8000 \
  -e BUTTRESS_APP_PROTOCOL=http \
  -e BUTTRESS_DATASTORE_CONNECTION_STRING=mongodb://buttress-mongodb:27017 \
  -e BUTTRESS_REDIS_URL=redis://buttress-redis:6379 \
  dpcltd/buttress:latest
```

Image tags:

- `dpcltd/buttress:develop`
- `dpcltd/buttress:latest`
- `dpcltd/buttress:<version>`

## Compose (Local Build)

From the repository root:

```bash
npm run docker:run-full
```

This starts Buttress, MongoDB, and Redis together using `.docker/docker-compose.full.yml`.

Default ports:

- REST: `http://localhost:8080`
- SOCK: `http://localhost:8081`

## Build Image Locally

```bash
npm run docker:build
```

If private npm auth is needed:

```bash
npm run docker:build-token
```

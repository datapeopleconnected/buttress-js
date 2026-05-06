# Quick Start

## Prerequisites
Docker is the recommended way to run ButtressJS.

Install:
- Docker
- Docker Compose

## Run With Docker Hub Image (Recommended)
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

Available image tags:
- `dpcltd/buttress:latest`
- `dpcltd/buttress:develop`
- `dpcltd/buttress:<version>`

## Run With Docker Compose (From Source)
From the project root:
```bash
npm run docker:run-full
```

This starts Buttress, MongoDB, and Redis together.

Default ports:
- REST: `http://localhost:8080`
- SOCK: `http://localhost:8081`

Note: Docker Hub run mode and Compose mode use different default ports.

## Configuration
Buttress configuration is provided via environment variables.

For a full parameter reference, see [Configuration](configuration.md).

Minimum required values:

| Property | Type | Example | Description |
| :- | :-: | :-: | -: |
| BUTTRESS_APP_PATH | string | /opt/buttress | Runtime path in the container |
| BUTTRESS_DATASTORE_CONNECTION_STRING | string | mongodb://buttress-mongodb:27017 | Datastore connection string |
| BUTTRESS_REDIS_URL | string | redis://buttress-redis:6379 | Redis connection string |

### Connection String
The datastore connection string must match your selected datastore adapter.

For MongoDB:
```
mongodb://[username:password@]host1[:port1]
```

## Running From Source (Alternative)
If you need to run directly from source for development:
```bash
npm install
npm run build
NODE_ENV=development ./bin/buttress.sh
```

### First Run - Super Token
On first run a super token is generated in `app_data/${app_code}.json`. The default app_code is `buttressjs`.

The most important field is `"token"`. Save it securely and then remove the file.

A token is required whenever a call is made to Buttress.

## Making a request
You can make a test request using the super token:

```bash
curl --location --request GET 'http://localhost:8000/api/v1/app?token=<INSERT TOKEN HERE>'
```

If running via Compose defaults, change the port to `8080`.

## Next Steps
Continue with [Create an Application](create-an-application.md) to set up schema and policy.
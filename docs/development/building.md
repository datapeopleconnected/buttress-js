# Building

ButtressJS is distributed and deployed primarily as a Docker image.

## Docker First (Recommended)

Build a local image:

```bash
npm run docker:build
```

Build with npm token support (for private package access):

```bash
npm run docker:build-token
```

The default image name from the npm script is `buttress`.

## Compose Build and Run

To build and run all required services (Buttress, MongoDB, Redis):

```bash
npm run docker:run-full
```

This uses `.docker/docker-compose.full.yml`.

## CI/CD Image Publishing

The repository publishes to Docker Hub after successful tests:

- `develop` branch push -> `dpcltd/buttress:develop`
- `main` branch push -> `dpcltd/buttress:latest` and `dpcltd/buttress:<version>`

## Build From Source (Alternative)

Use this path when actively changing source and debugging locally:

```bash
npm install
npm run build
```

Watch mode for TypeScript and non-TS assets:

```bash
npm run watch
```

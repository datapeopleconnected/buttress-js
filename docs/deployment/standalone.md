# Standalone Deployment

Standalone deployment runs Buttress directly from source or a local build artifact.

## Use Cases

- Local development
- Debugging without container orchestration
- Controlled environments where Docker is not used

## Run from Source

```bash
npm install
npm run build
NODE_ENV=development ./bin/buttress.sh
```

## Required Dependencies

- MongoDB
- Redis

Configure connectivity through environment variables described in [Configuration](../getting-started/configuration.md).

## Production Guidance

For production, use containerized deployment unless you have strong operational reasons not to. Docker-based deployments provide a more reproducible runtime.

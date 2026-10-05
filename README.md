# 🚀 ButtressJS
The federated real-time open data platform.

## 🌐 Overview
ButtressJS is an open-source platform designed to enable federated, real-time data sharing and management. It provides a robust framework for building scalable, data-driven applications with a focus on collaboration and security.

## ✨ Features
- **Federated Data Sharing**: Seamlessly share data across multiple systems while maintaining control and security.
- **Real-Time Updates**: Ensure your applications stay up-to-date with real-time data synchronization.
- **Extensibility**: Easily extend functionality with plugins and custom modules.
- **Open Source**: Fully open-source under the AGPL-3.0 license, encouraging community contributions and transparency.

## 📚 Documentation
You can view the latest version of the documentation at the following URL:  
[ButtressJS Documentation](https://datapeopleconnected.github.io/buttress-js/)

To view the documentation locally, run the following command:
```bash
npm run docs
```

## Prerequisites
Docker is the primary way to run ButtressJS.

## Running
### Option 1: Run with Docker Hub image
This is the quickest way to run ButtressJS without building locally.

1. Create a Docker network:
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

Use these tags for branch-aligned images:
- `dpcltd/buttress:develop`
- `dpcltd/buttress:latest`
- `dpcltd/buttress:<version>`

### Option 2: Run with Docker Compose (local build)
From the repository root:
```bash
npm run docker:run-full
```

This starts:
- ButtressJS
- MongoDB
- Redis

By default, this setup exposes:
- REST on `http://localhost:8080`
- Socket endpoint on `http://localhost:8081`

## Building
Build a local Docker image:
```bash
npm run docker:build
```

If you need to pass an npm token for private packages:
```bash
npm run docker:build-token
```

## Running From Source (Alternative)
If you are actively developing against the codebase, you can still run ButtressJS directly.

Install dependencies:
```bash
npm install
```

Set up an environment variable `SERVER_ID`:
```bash
export SERVER_ID='name'
```

Build the source files:
```bash
npm run build
```

Run the application:
```bash
./bin/buttress.sh
```

Run individual components:
```bash
./bin/app.sh
./bin/app-spr.sh
./bin/app-socket.sh
./bin/app-lambda.sh
```

## Testing
Run all tests (unit and e2e):
```bash
npm run test
```

Run tests individually:
```bash
npm run test:unit
npm run test:e2e
```

## Contributing
We welcome contributions from the community! To get started:
1. Fork the repository.
2. Create a new branch for your feature or bug fix.
3. Submit a pull request with a detailed description of your changes.

For more details, see our [Contributing Guide](https://github.com/datapeopleconnected/buttress-js/blob/main/CONTRIBUTING.md).

## License
ButtressJS is licensed under the AGPL-3.0. See the [LICENSE](https://github.com/datapeopleconnected/buttress-js/blob/main/LICENSE) file for details.

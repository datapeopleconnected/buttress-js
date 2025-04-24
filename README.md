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
Install the latest dependencies:
```bash
npm install
```

Set up an environment variable `SERVER_ID`:
```bash
export SERVER_ID='name'
```
Add this to your `.profile` or `.bashrc` file.

Update the `config.json` file and create a `.production.env` or `.development.env` file in the root folder with your environment settings.

## Building
To build the source files, run:
```bash
npm run build
```
For development, use the watch mode to auto-build on changes:
```bash
npm run watch
```

## Running
To run the application, use:
```bash
./bin/buttress.sh
```

Alternatively, you can run individual components:
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

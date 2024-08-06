# ButtressJS
The federated real-time open data platform.

## Documentation
Run the following to view the Documentation:
```bash
npm run docs
```

## Prerequisites
Then you'll need to grab the latest dependencies: 
```bash
npm install
```
## Configuring ##
You need to setup an environment variable: `SERVER_ID`
Add `export SERVER_ID = 'name'` to your .profile or .bashrc

Then add to config.json.

Create a `.production.env` or `.development.env` in the route folder with your environmental settings.

## Building
To build the source files simply run build, as seen below. If you're planning to make changes to the source you can also use watch to auto build when changes are made: 
```bash
npm run build
// or
npm run watch
```

## Running
To run the application use the following in a terminal:
```bash
./bin/buttress.sh
```

You can also run the individually using the following:
```bash
./bin/app.sh
```
```bash
./bin/app-socket.sh
```
```bash
./bin/app-lambda.sh
```
## Testing ##
Tests are implemented in the ButtressJS API.
You can find the API here: https://github.com/wearelighten/buttress-js-api

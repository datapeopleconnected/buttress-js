# ButtressJS
The federated real-time open data platform.

## Documentation
Run the following to view the Documentation:
```
npm run docs
```

## Prerequisites
Then you'll need to grab the latest dependencies: 
```
npm install
```
## Configuring ##
You need to setup an environment variable: `SERVER_ID`
Add `export SERVER_ID = 'name'` to your .profile or .bashrc

Then add to config.json.

Create a `.production.env` or `.development.env` in the route folder with your environmental settings.

## Running
```
./bin/app.js
```
```
./bin/app-socket.js
```
## Testing ##
Tests are implemented in the ButtressJS API.
You can find the API here: https://github.com/wearelighten/buttress-js-api

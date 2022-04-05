# ButtressJS
The federated real-time open data platform.

# What's New

### **Latest**: 2.4.3 :tada:
- FIX: early out if the id can not be converted to objectId (#14)
- FIX: convert $in query ids to ObjectId (#15)

*See changelog.md for version history*

## Prerequisites ##
You'll need gulp:
`npm install -g gulp && npm install gulp`

Then you'll need to grab the latest modules:
`npm install`
## Configuring ##
You need to setup an environment variable: `SERVER_ID`
Add `export SERVER_ID = 'name'` to your .profile or .bashrc

Then add to config.json.

Create a `.production.env` or `.development.env` in the route folder with your environmental settings.

## Building ##
```
npm run build
npm start
```
## Testing ##
Tests are implemented in the ButtressJS API.
You can find the API here: https://github.com/wearelighten/buttress-js-api

# Quick Start

## Prerequisites
NodeJS is used for Buttress's runtime and is required to run it. Nodejs supports many platforms and is available for [download here](https://nodejs.dev/en/download/).   
It should run on Node versions 10 and above but is only tested with LTS versions (14). NPM should be bundled with most installs of NodeJS if not you will need to manually install NPM to resolve the dependencies required to run Buttress.

A MongoDB database is required for it's data storage. This can be hosted locally or a remore instance can be used. MongoDB Community addition is free and available for [download here](https://www.mongodb.com/try/download/community).

Redis is required for inter-process communication. This can be hosted locally or a remore instance can be used. Redis is free and is available for [download here](https://redis.io/download/).

## Initialize
Use NPM to download all of the dependencies needed to run Buttress. You can do this by running the following in the root of the ButtressJS folder using your terminal.
```bash
npm install
```

If there isn't one already create an `app_data` folder within the root of the Buttress folder. This will be used to store data related to Buttress as runtime.
```bash
mkdir app_data
```

## Configuration

The configuration parameters for Buttress are passed through environment variable to the process. They can also be stored inside of a `.env`. You can create one in the root of the buttress folder:
```bash
touch .development.env
```

Open this file up in an editor of your choice, add and modify the following lines to suite your environment. You can see a full description of the configuration parameters [here](/getting-started/configuration?id=parameters):
```env
# Basic Config
BUTTRESS_APP_CODE=bjs
BUTTRESS_APP_PATH=/home/chris/../../buttress-js
BUTTRESS_HOST_URL=localhost:6000

# Datastore
BUTTRESS_DATASTORE_CONNECTION_STRING=mongodb://username:password@127.0.0.1
```

The following parameters are required and need to be configured in the file above.

| Property | Type | Example | Description |
| :- | :-: | :-: | -: |
| BUTTRESS_APP_PATH | string | /home/chris/.../.../buttress-js | The path of the buttress folder in the local file system |
| BUTTRESS_DATASTORE_CONNECTION_STRING | string | mongodb://127.0.0.1 | The datastore connection string used to connect to your datastore |

### Connection String
The connection string describes what type of datastore you want to use for your buttress instance and the connection details. The follows a simliar format to the MongoDB standard connection string format but can be used for different datastores. The square brackets bellow show optional fields:
```
datastore://[username:password@]host1[:port1]
```

## Building
If you're running the program from source you'll need to build the application before being able to run it. To do this simply run the following:
```bash
npm run build
```

!> If your editing the source you can use `npm run watch` instead to automatically build when changes are made.

## Running
ButtressJS is made up of three process types (`Rest` / `Sock` | `Lambda`) which allow the Buttress process to scale. To run the `All` processes run the following line in a terminal:
```bash
NODE_ENV=development ./bin/buttress.sh
``` 

You can also run the processes individually which gives you more control in deployment and visibility in development.

To run the `Rest` process in a separate terminal run 
```bash
NODE_ENV=development ./bin/app.sh
```

To run the `Sock` process in a separate terminal run 
```bash
NODE_ENV=development ./bin/app-socket.sh
```

To run the `Lambda` process in a separate terminal run 
```bash
NODE_ENV=development ./bin/app-lambda.sh
```

The combination of the processes make up ButtressJS, the don't nessesarly need to be run on the same system.

### First Run - Super Token
On first run a super token will be generated, this can be found in `app_data/${app_code}.json`. The default app_code is `buttressjs` The JSON object found within this file is a dump of the super application object but the most important property is `"token"`. Please copy this value or the file to a safe place for use later. Once you've made a copy delete the file.

An example of the token is the following `hkcQ4Fx98VpFV0kIBtU8s0hsgglkgRFlc1Vk`. A token is required whenever a call is made to Buttress.

## Making a request
You now have all you need to start interacting with Buttress. You can make a test request to Buttress using the super token. Replace the `<INSERT TOKEN HERE>` part of the example below:

```bash
curl --location --request GET 'localhost:6000/api/v1/app?token=<INSERT TOKEN HERE>'
```

You'll receive back a list of the applications that exist within Buttress.

## Next Steps
You should move onto [creating an application](/getting-started/create-an-application.md) within Buttress. This will briefly cover creation of schema & policy.
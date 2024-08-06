# Configuration

## Environment Files
Buttress requires a few configuration parameters before you can run the process. You can add your own configuration to buttress using `.env` files depending on your deployment environment. The deployment environment is detected using the `NODE_ENV` environment variable.

If the `NODE_ENV` environment variable is set to `development` then Buttress will try to load the `.development.env` file on startup. If it's set to `production` it will attempt to load the `.production.env` file on startup.

You can manually speifify which configuration file is loaded by using the `ENV_FILE` environment variable, this can be used in the case we're your unable to define the `NODE_ENV` environment variable on your system. An example of this being used is the following:
```bash
NODE_ENV=.development.env ./bin/app.js
```

## Parameters
The following table shows the configuration parameters available for Buttress.

| Property | Type | Default | Description |
| :- | :-: | :-: | -: |
| NODE_ENV | string | production | Used to determine the current deployment environment |
| BUTTRESS_APP_TITLE | string | ButtressJS | A title/name for the current Buttress Instance |
| BUTTRESS_APP_CODE | string | buttressjs | A unqiue code given for the current Buttress Instance |
| BUTTRESS_APP_PROTOCOL | string | http | The protocol which will be used to listen for connections |
| BUTTRESS_APP_PATH | string | The path of the buttress folder in the local file system |
| BUTTRESS_APP_WORKERS | booelan / int | FALSE | If an Int is passed the Buttress will spawn that number of workers |
| BUTTRESS_HOST_URL | string | | |
| BUTTRESS_REST_LISTEN_PORT | int | 6000 |  |
| BUTTRESS_SOCK_LISTEN_PORT | int | 6010 | |
| BUTTRESS_DATASTORE_CONNECTION_STRING | string | |
| BUTTRESS_DATASTORE_OPTIONS | string | appName=%BUTTRESS_APP_CODE%&maxPoolSize=100 | |
| BUTTRESS_REDIS_PORT | int | 6379 | |
| BUTTRESS_REDIS_HOST | string | localhost | |
| BUTTRESS_REST_APP | string | primary | |
| BUTTRESS_SOCKET_APP | string | primary | |
| BUTTRESS_LOGGING_LEVEL | string | info | |
| BUTTRESS_LOGGING_SLOW | boolean | TRUE | |
| BUTTRESS_LOGGING_SLOW_TIME | int | 2 | |

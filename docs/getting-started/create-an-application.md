# Create an Application
The following steps show a fast path for creating an application in Buttress.

## Using the CLI
Using the CLI, you can create applications quickly after connection setup.

### Install

To install the CLI run the following command:
```bash
npm i -g @buttress/cli
```

### Setting up a connection

Once the CLI is installed, you can access it globally in your terminal. You can inspect commands using:
```bash
bjs help
```

Make sure your Buttress instance is running. Next, add a connection to the CLI. Once added, you can select it later without re-entering host and token details.
```bash
# bjs connect url token app_code
bjs connect http://localhost:8000 yoursupertoken bjs
```

Once added, you can list saved connections and select one by index:
```bash
bjs list
...
bjs connection 0
```

### Creating an app
To create an app using the CLI, run the following command. Replace "Test" with your application name and "test" with your app path. The app path is used for API calls and must be unique.
```bash
bjs app create -n "Test" --path "test"
```

After running the command, Buttress will return output similar to:
```bash
...
Connecting to Buttress...
Created App Test with token QAoRcMMJ0ZYM9o0d49IYNEoJhcM0N414g5dZ
Program complete, exiting...
```

Make note of the app path and newly created application token. You will use these values to create schema and policy under the app namespace.

#### Setting and updating an app's policy property list with the CLI
To set a policy property list for an app, run:

```bash
bjs app set-policy-list --list=role:developer,team:rnd,level:junior-intermediate-senior
```
The command creates a list object of arrays for the app. The required `list` option is a colon-separated key/value string (`key:value`). Multiple values can be provided by separating them with a hyphen (`-`).

To update a policy property list for an app, run:
```bash
bjs app update-policy-list --list=role:staff-manager
```
If you run this after the first command, Buttress concatenates values for existing keys (like `role`). The final app list will be:
```
{
  role: ['developer', 'staff', 'manager'],
  team: ['rnd'],
  level: ['junior', 'intermediate', 'senior']
}
```


## Schema
Application schema defines your data model. Buttress uses schema definitions to generate API collections for your app.

More schema details are available in [Schema](../applications/schema.md).

```json
{
  "name": "cars",
  "type": "collection",
  "properties": {
    "name": {
      "__type": "string",
      "__default": null,
      "__required": true,
      "__allowUpdate": true
    },
    "make": {
      "__type": "string",
      "__default": null,
      "__required": true,
      "__allowUpdate": true
    }
  }
}
```

You can update schema and policy programmatically with `@buttress/api` as shown below.

## Policy
App policy is used to restrict and control what actions are performed against ButtressJS. An example policy is the following which is basically a wild card for read / write access for an admin in your application.

Policy is applied to tokens through policy properties.

More policy details are available in [Policy](../applications/policy.md).

```json
{
  "name": "admin-access",
  "selection": {
    "role": {
      "@eq": "admin"
    }
  },
  "config": [{
    "verbs": ["GET", "SEARCH", "PUT", "POST", "DELETE"],
    "schema": ["%ALL%"],
    "query": {
      "access": "%FULL_ACCESS%"
    }
  }]
}
```

## Sync Schema / Policy Script

The following script syncs your application's schema and policy. It requires `@buttress/api`.

If it's not already installed, run:
```bash
npm i @buttress/api
```

Once you've got the `@buttress/api` installed you'll need to create two files `schema.json` & `policy.json`.
```bash
touch schema.json policy.json sync.js
```

Edit `schema.json` and add the following. The `updateSchema` API function expects an array of schemas.
```json
[{
  "name": "cars",
  "type": "collection",
  "properties": {
    "name": {
      "__type": "string",
      "__default": null,
      "__required": true,
      "__allowUpdate": true
    },
    "make": {
      "__type": "string",
      "__default": null,
      "__required": true,
      "__allowUpdate": true
    }
  }
}]
```

Edit `policy.json` and add the following. Policy sync also expects an array.
```json
[{
  "name": "admin-access",
  "selection": {
    "role": {
      "@eq": "admin"
    }
  },
  "config": [{
    "verbs": ["GET", "SEARCH", "PUT", "POST", "DELETE"],
    "schema": ["%ALL%"],
    "query": {
      "access": "%FULL_ACCESS%"
    }
  }]
}]
```

Edit `sync.js` and add the following:
```nodejs
const Buttress = require('@buttress/api');

const Schema = require('./schema.json');
const AppPolicies = require('./policy.json');

(async () => {
  await Buttress.init({
    buttressUrl: 'http://localhost:8000',
    appToken: 'Your app token here',
    apiPath: 'Your app path here',
    version: 1,
    allowUnauthorized: true, // Use only in development with local/self-signed certs
  });

  await Buttress.App.updateSchema(Schema);
  await Buttress.Policy.syncAppPolicy(AppPolicies);

  console.log('Updated');
})();
```

Finally, update schema and policy:
```bash
node sync.js
```

The schema and policy for your application will now be updated in Buttress, and a `cars` API will be available. You can test this with the command below. Replace `<APP TOKEN>` with your app token and `<APP CODE>` with your app code.
```bash
curl --location --request GET 'http://localhost:8000/<APP CODE>/api/v1/cars?token=<APP TOKEN>'
```

## Next Steps
Take a look at [Client Libraries](client-libraries.md) to integrate Buttress into your apps.
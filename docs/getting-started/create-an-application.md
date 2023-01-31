# Create an Application
The following steps are going to detail how to quickly create an application within Buttress.

## Using the CLI
Using the CLI we can quickly create applications in a single command after the connection has been configured.

### Install

To install the cli run the following command:
```bash
npm i -g @buttress/cli
```

### Setting up a connection

Once the cli is installed you'll be able to access it globally within your terminal. You can see what commands are available using the following: 
```bash
bjs help
```

Make sure your Buttress instance is running, we need to add a connection to the cli tool. Once you've added a connection you'll be able to select this connection in the future without having to enter the host / token details again.
```bash
# bjs connect url token app_code
bjs connect https://localhost:6000 yoursupertoken bjs
```

Once added you can see all of the connections avaible using and select a connection by using the `bjs connect` command followed by the connection indx
```bash
bjs list
...
bjs connection 0
```

### Creating an app
To create an app using the CLI need to run the following line; Replace "Test" with the application name that your trying to create, Replace "test" with the app path, this will be used when calling api's against the application and need so be unique.
```bash
bjs app create -n "Test" --path "test"
```

After running the command, Buttress will provide you with the following responce:
```bash
...
Connecting to Buttress...
Created App Test with token QAoRcMMJ0ZYM9o0d49IYNEoJhcM0N414g5dZ
Program complete, exiting...
```

Make note of the app path you selected and the new application token created. You'll be able to use this to create schema & policy under the apps namespace.

#### Setting and updating apps policy property list using the CLI
To set policy property list for an app using the CLI run the following command:

```bash
bjs app set-policy-list --list=role:developer,team:rnd,level:junior-intermediate-senior
```
The above command creates a list for an app and the list is an object of arrays. The required list option is a colon separated string such that the lhs of the colon is the key and thr rhs of the colon is the value (key:value), multiple values can be added by separating it by a hyphen (-)

Similarly to update a policy property list for an app using the CLI run the following command:
```bash
bjs app update-policy-list --list=role:staff-manager
```
Note that running the above command after running the first command, the app will concatenate the values of role that already exist on the app policy list to the list of the command and the final app list will be:
```
{
  role: ['developer', 'staff', 'manager'],
  team: ['rnd'],
  level: ['junior', 'intermediate', 'senior']
}
```


## Schema
The application schema is used to describe what data the application is going to use and has other features. Using the schemas you provide Buttress will use these to create API's ready for your application to call.

More detail on the properties of schema can be [found here](/todo.md)

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

At the moment the only way to update the schema is via the the @buttress/api, see the script below on how to update both schema & policy for your new app.

## Policy
App policy is used to restrict and control what actions are performed against ButtressJS. An example policy is the following which is basically a wild card for read / write access for an admin in your application.

Policy is then applied to tokens within the system via the policy properties.

More detail on the properties of polices can be [found here](./applications/policy.md)

```json
{
  "name": "admin-access",
  "selection": {
    "role": {
      "@eq": "admin"
    }
  },
  "config": [{
    "endpoints": ["GET", "SEARCH", "PUT", "POST", "DELETE"],
    "query": [{
      "schema": ["ALL"],
      "access": "FULL_ACCESS"
    }]
  }]
}
```

## Sync Schema / Policy Script

The following script allows you to sync your applications schema & policy. It requires `@buttress/api` to be installed. If it's not already run the following in the scripts location to install it locally
```bash
npm i @buttress/api
```

Once you've got the `@buttress/api` installed you'll need to create two files `schema.json` & `policy.json`.
```bash
touch schema.json policy.json sync.js
```

Edit `schema.json` and add the following to it, the updateSchema schema function of the API expects mutiple schema to be updated at once so it expects an array.
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

Edit `policy.json` and add the following to it, the updateSchema schema function of the API expects mutiple schema to be updated at once so it expects an array.
```json
[{
  "name": "admin-access",
  "selection": {
    "role": {
      "@eq": "admin"
    }
  },
  "config": [{
    "endpoints": ["GET", "SEARCH", "PUT", "POST", "DELETE"],
    "query": [{
      "schema": ["ALL"],
      "access": "FULL_ACCESS"
    }]
  }]
}]
```

Edit `sync.js` and add the following:
```nodejs
const Buttress = require('@buttress/api');

const Schema = require('./schema.json');
const AppPolicies = require('./policy.json');

await Buttress.init({
  buttressUrl: `http://localhost:6000`,
  appToken: `Your app token here`,
  apiPath: `Your app path here`,
  version: 1,
  allowUnauthorized: true, // This should only be used in development when using locally signed certs
});

await Buttress.App.updateSchema(Schema);
await Buttress.Policy.syncAppPolicy(AppPolicies);

console.log('Updated');
```

Finally you can update the schema & policy by running the following:
```bash
node sync.js
```

The schema & policy for your application will have been updated inside of Buttress and there will now be cars api available for your application. You can test this by running the following. Make sure to replace `<APP TOKEN>` with your newly created app token and `<APP CODE>` with the app code used when creating the app.
```bash
curl --location --request GET 'localhost:6000/api/v1/<APP CODE>/cars?token=<APP TOKEN>'
```

## Next Steps
Take a look at our [Client Libraries](/getting-started/client-libraries.md) to configure and interact with Buttress using a front-end application.
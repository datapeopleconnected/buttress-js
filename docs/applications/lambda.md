# Introduction
TODO

It is worth mentioning that the API lambda is executed by either calling the /lambda/v1/{lambdaId} or /lambda/v1/{lambdaAPIURL}

# Create a Lambda
The following steps are going to detail how to a lambda within Buttress.

## Lambda Details
The following parameters are required and need to be configured in the file above.

| Property | Type | Field Type | Options | Default | Description
| :- | :- | :- | :- | :- | :-
| name | String | required | | | The name of the buttress lambda
| type | String | optional | PRIVATE, PUBLIC | PRIVATE | An optional type that determines whether a lambda can publicly executed or not
| git | Object | required | | | The lambda git information<ul><li> url - String - required - git repo url</li><li> hash - String - required - git hash</li><li> branch - String - required - git branch</li><li> entryFile - String - required - lambda entry file</li><li> entryPoint - String - required - lambda entry function to be executed</li></ul>
| Trigger | Array(Object) | required | | | Lambda triggers information<ul><li> type - String - required - CRON, PATH_MUTATION_API_ENDPOINT - CRON - Lambda type</li><li> cron - Object - optional - Contains information about the cron such as execution time, etc.<ul><li>executionTime - Date - optional - Lambda execution time</li><li>periodicExecution - String - optional - When the lambde should re-execute</li><li>status - String - optional - PENDING, RUNNING, ERROR, PAUSE - PENDING - Lambda cron's status</li></ul></li><li>apiEndpoint - Object - optional - Contains information about the API such as endpoint, etc.<ul><li>method - String - optional - GET,POST - GET - Lambda's API endpoint method</li><li>url - String - optional - Lambda's API url</li><li>type - String - optional - ASYNC, SYNC - ASYNC - Lambda's execution type</li><li>redirect - String - optional - A redirect flag that redirect lambda's response to another domain</li></ul></li><li>pathMutation - Object - optional - Contains the paths that execute lambda whenever a change happens<ul><li>paths - Array(String) - optional - The paths that execute lambda</li></ul></li></ul>
| policyProperties | Object | required | | | The policy properties that determines which policy to apply to any request that lambda make

## Using the CLI
To create a lambda using the CLI need to run the following line; Replace "filePath" with the path to the json file that contains your lambdas that your trying to create
```bash
bjs lambda create --filePath="filePath"
```

To list all of the properties in the cli that are needed to create a lambda run the following command
```bash
bjs lambda list-property
```

### File Example
```
[{
  name: 'hello-world-lambda',
  git: {
    url: 'ssh://git@git.wearelighten.co.uk:8822/lambdas/hello-world.git',
    branch: 'main',
    hash: '54f2fd5f0c0e889881f0a2af40f9d69240b47b6b',
    entryFile: 'index.js',
    entryPoint: 'execute'
  },
  trigger: [{
    type: 'CRON',
    cron: {
    status: 'PENDING',
    periodicExecution: 'in 1 minutes',
    executionTime: Sugar.Date.create()
    }
  }],
  policyProperties: {
    adminAccess: {
      @eq: true
    }
  }
}, {
  "name": "outbound-email",
  "git": {
    "url": "ssh://git@git.wearelighten.co.uk:8822/lambdas/google-outbound-emails.git",
    "branch": "main",
    "hash": "3c4a3fce2e8d102fb14b410e22464551bc8a30bb",
    "entryFile": "index.js",
    "entryPoint": "execute"
  },
  "trigger": [{
    "type": "PATH_MUTATION",
    "pathMutation": {
      "paths": ["email.*"]
    }
  }],
  "policyProperties": {
    "googleEmail": {
      "@eq": true
    }
  }
}]
```

The example file above contains two lambdas, The first lambda is called hello-world-lambda. The said lambda type is "CRON" and its executionTime indicates that it will be executed when the lambda process starts and its periodicExecution indicates that it will keep re-executing every 1 minute.

The second lambda is called outbound-email, its type is PATH_MUTATION and from the paths array it indicates that whenever a change happens to the email collection the lambda will execute.
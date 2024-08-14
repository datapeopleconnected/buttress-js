# Introduction
TODO

But it is worth mentioning that by default you need a policy to access any kind of data through Buttress.

# Create a Policy
The following steps are going to detail how to a policy within Buttress.

## Policy Details
The following parameters are required and need to be configured in the file above.

| Property | Type | Field Type | Default | Description
| :- | :- | :- | :- | :-
| name | String | required | | The name of the buttress policy
| merge | Boolean | optional | false | A merge option that determines whether to merge the policy with other policies
| priority | Int | optional | 0 | A priority option that determines which policy to run if there are multiple policies<br>targeting the same data with merge option set to false
| selection | Object | required | | The selection policy block is used to determine whether the policy will be applied<br>to the request depending on the requester's policy props
| config | Array(Object) | required | | The policy configuration block<ul><li> endpoints - Array(String) - required - endpoints for policy execution</li><li> env - Object - optional - Environment variables to be used in the policy execution</li><li> conditions - Array(Object) - optional - An array of objects that determines the conditions for applying the policy to pre-specified collection of data</li><li> projection - Array(Object) - optional - An array of objects that specifies certain fields  of the data to be sent back in the response</li><li> query - Array(Object) - required - An array of objects that specifies which schema and what filter to be applied to the request when the policy is applied to the request</li></ul>
| limit | Date | optional | null | An expiration date for the policy

## Using the CLI
To create a policy using the CLI need to run the following line; Replace "filePath" with the path to the json file that contains your policies that your trying to create
```bash
bjs policy create --filePath="filePath"
```

To list all of the properties in the cli that are needed to create a policy run the following command
```bash
bjs policy list-property
```

### File Example
```
[{
  "name": "email-reader",
  "selection": {
    "emailReader": {
      "@eq": true
    }
  },
  "config":[{
    "endpoints": ["GET"],
    "query": [{
      "schema": ["email"],
      "access": "%FULL_ACCESS%"
    }]
  }]
}, {
  "name": "junior-account-manager",
  "selection": {
    "role": {
      "@eq": "accountant"
    }
  },
  "config":[{
    "endpoints": ["ALL"],
    "query": [{
      "schema": ["finance"],
      "salary": {
        $lte: 40000
      }
    }]
  }]
}]
```

The example file above contains two policies, The first policy is called email-reader. As shown in the selection block of the first policy the requester must have emailReader policy property in their list for the policy to be applied to their request (The application also must have emailReader in its list to be able to assign it to the requester). The said policy is only applied when reading - "GET" - from the email collection and it gives full access to the email data - "%FULL_ACCESS%".

The second policy is called junior-account-manager, its selection block shows that the requester must have role accountant in ther list for the policy to be applied. The configuration block of the policy shows that the policy will be applied when reading, editing, adding or deleting from the finance collection, but it shows that the policy will only give access to the data that salary is less than 40k in the finance collection.
# Introduction
TODO

# Create a Secure Store Key
The following steps are going to detail how to a secure store key within Buttress.

## Secure Store Details
The following parameters are required and need to be configured in the file above.

| Property | Type | Field Type | Description
| :- | :- | :- | :-
| name | String | required | Secure store key name
| storeData | Array(Object) | required | Secure store key data

## Using the CLI
To create a secure store key using the CLI need to run the following line; Replace "filePath" with the path to the json file that contains your secure store keys that your trying to create
```bash
bjs secure-store create --filePath="filePath"
```

To list all of the properties in the cli that are needed to create a secure store key run the following command
```bash
bjs secure-store list-property
```

### File Example
```
[{
  "name": "google-credentials",
  "storeData": [{
    "client_id": "CLIENT_ID",
    "client_secret": "CLIENT_SECRET",
    "redirect_uri": "REDIRECT_URI",
    "scope": "SCOPE"
  }]
}, {
  "name": "allowed-members",
  "storeData": [{
    "identifierEmail": "tomc@dpc-ltd.com",
    "policySelectors": {
      "role": "developer"
    }
  }, {
    "identifierEmail": "mahmoud@dpc-ltd.com",
    "policySelectors": {
      "role": "developer"
    }
  }, {
    "identifierEmail": "spencer@dpc-ltd.com",
    "policySelectors": {
      "role": "developer"
    }
  }, {
    "identifierEmail": "chris@dpc-ltd.com",
    "policySelectors": {
      "role": "developer"
    }
  }, {
    "identifierEmail": "brian.bishop@dpc-ltd.com",
    "policySelectors": {
      "role": "developer"
    }
  }]
}, {
  "name": "google-service-account",
  "storeData": [{
    "iss": "ISS",
    "sub": "SUB",
    "private_key": "PRIVATE_KEY"
  }]
}, {
  "name": "domains",
  "storeData": [{
    appURL: '%APP_URL%',
    buttressURL: '%BUTTRESS_URL_INSTANCE%'
  }]
}]
```
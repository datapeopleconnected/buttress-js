# Data Sharing

A data sharing agreement (DSA) is a record of type `AppDataSharing`, created via the `app-data-sharing` API
on both sides of the relationship, that describes how to reach and authenticate against the other app.

## Agreement Shape

| Property | Type | Required | Description |
| :- | :- | :-: | :- |
| name | string | yes | Agreement name |
| remoteApp.endpoint | string | yes | Remote app's REST endpoint, e.g. `https://buttress.example.org` |
| remoteApp.ws | string | no | Remote app's Socket endpoint, if different from `endpoint` |
| remoteApp.apiPath | string | yes | Remote app's `apiPath` |
| remoteApp.token | string | yes on the joining side | Token used to authenticate against the remote app |
| policyConfig | array | yes | Policy `config` entries applied to data received over this agreement |

```json
{
  "name": "partner-org-share",
  "remoteApp": {
    "endpoint": "https://partner.example.org",
    "apiPath": "partner-app",
    "token": ""
  },
  "policyConfig": [
    {
      "verbs": ["GET"],
      "schema": ["order"],
      "query": { "access": "%FULL_ACCESS%" }
    }
  ]
}
```

`POST /<apiPath>/api/v1/app-data-sharing` with this body creates the agreement (`remoteApp.token` can be
left blank on the initiating side — see activation below). Internally, Buttress builds a `butt://` (or
`butts://` for an `https` endpoint) connection string from `remoteApp.endpoint` + `apiPath` + `token`; that's
also the connection string format used by a schema's `remotes` field (see below).

## Activation

Both sides need to agree before an agreement goes live:

1. App A creates its DSA. Buttress creates a `dataSharing`-type token for it and returns a
   `registrationToken` — hand this to App B's admin out of band.
2. App B creates its own DSA with `remoteApp.token` set to that registration token.
3. Creating the DSA on App B automatically calls `POST app-data-sharing/activate` on App A (authenticated as
   the registration token), passing a freshly-generated token.
4. App A swaps in the new token, marks its side `active`, and returns it.
5. App B stores that returned token as its own `remoteApp.token` and marks its side `active`.

From then on, each side calls the other using the token it holds — so the two sides can each rotate their
half of the pair independently. `PUT app-data-sharing/deactivate/:id` / `.../reactivate/:id` turn a DSA off
and back on without deleting it.

## Datastore-Level Federation (`remotes`)

A collection schema becomes federated by adding a `remotes` field naming one or more active data sharing
agreements:

```json
{
  "name": "order",
  "type": "collection",
  "remotes": [{ "name": "partner-org-share", "schema": "order" }],
  "properties": { "...": {} }
}
```

Reads and writes against that collection are then combined across the local datastore and every named
remote — see [Schema](../applications/schema.md) for the rest of the schema shape.

## Realtime Federation

Independent of `remotes`, an active DSA also gets the Socket process an outbound connection to the remote
app. Mutations relayed over that connection are fed back into the local REST → SPR → Socket pipeline (see
[Architecture](../core/architecture.md)), so a change made on the remote app reaches local clients the same
way a local write would, subject to the DSA's `policyConfig`.

## Operational Guidance

- Keep agreements explicit and minimal — `policyConfig` controls exactly what's exposed, so scope it as
  tightly as you would any other policy.
- Rotate sharing tokens regularly; each side can rotate its own half independently since the two directions
  use separate tokens.
- Deactivate an agreement rather than deleting it if you expect to need it again — deleting removes the
  underlying token too.

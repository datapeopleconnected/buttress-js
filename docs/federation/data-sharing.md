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

Each record such a collection returns has a `sourceId`, the app it comes from: the app's own id for its own
records, and the partner app's for a partner's. To change or delete a partner's record, address it by its id, as
you would one of the app's own: `PUT <schema>/:id`, `DELETE <schema>/:id`, `POST <schema>/bulk/update` and
`POST <schema>/bulk/delete`. Buttress finds the record within your policies and sends the change through the
agreement it was read through, so a partner's record can't send a change anywhere else, whatever `sourceId` it
names.

More than one source can have a record with the same id, such as an entity whose parts several partners hold. Then a
change goes to the app's own record, unless the request names the source with `PUT <schema>/:sourceId/:id` (or
`sourceId` in a `bulk/update` item), and is refused with a 409 `ambiguous_source` when the app has none of its own
and the request names no source. A create that names a partner's app as its `sourceId` is added there, once the
collection has read one of that partner's records. Earlier releases sent a change to a partner's record by the
`sourceId` it named, so `PUT <schema>/:id` didn't reach one, and a change could fail until the collection had read
from that partner again.

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

## Upgrading

A federated collection sends a search's query on to each partner as a Buttress query, which the partner checks as it
checks its own clients' queries. A partner on this release refuses an operator it doesn't know with a 400,
`unknown_operator`, and that includes `$options`, which earlier releases send for a `$rexi` search (as `$regex` with
`$options: "i"`). So upgrade the instances that read through an agreement before the partners they read from. An
instance on this release sends `$rexi` as it is, which earlier releases read too.

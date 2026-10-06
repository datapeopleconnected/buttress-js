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
| remoteApp.appId | id | no | The remote app's id. Activation records it, and an agreement activated before it did asks the remote app (see below) |
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
3. Creating the DSA on App B automatically calls `POST app-data-sharing/activate?appId=<App B's id>` on App A
   (authenticated as the registration token), passing a freshly-generated token.
4. App A swaps in the new token, records App B's id as its `remoteApp.appId`, marks its side `active`, and returns
   the token with its own app's id.
5. App B stores that returned token as its own `remoteApp.token` and App A's id as its `remoteApp.appId`, and marks
   its side `active`.

From then on, each side calls the other using the token it holds — so the two sides can each rotate their
half of the pair independently. `PUT app-data-sharing/deactivate/:id` / `.../reactivate/:id` turn a DSA off
and back on without deleting it.

Agreements activated by an earlier release don't record the other app's id. Once both sides run this release, a
collection that reads through such an agreement asks the remote app for it when it connects
(`GET app-data-sharing/identity`, which answers a `dataSharing` token with the app it's for), and records it. Until
then, its owner can set `remoteApp.appId` with `PUT app-data-sharing/:id`.

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

A search's `sort` orders the combined list as it orders the app's own: each direction is `1`, `-1`, `"asc"`, `"desc"`,
`"ascending"` or `"descending"`. A count adds up each source's, leaving out (and logging) a partner's answer that isn't
a count. Earlier releases merged a search sorted `"desc"` or `"descending"` in ascending order, and joined a count a
partner gave as text onto the total as text.

Each record such a collection returns has a `sourceId`, the app it comes from: the app's own id for its own
records, and the partner app's for a partner's. To change or delete a partner's record, address it by its id, as
you would one of the app's own: `PUT <schema>/:id`, `DELETE <schema>/:id`, `POST <schema>/bulk/update` and
`POST <schema>/bulk/delete`. Buttress finds the record within your policies and sends the change through the
agreement it was read through, so a partner's record can't send a change anywhere else, whatever `sourceId` it
names.

More than one source can have a record with the same id, such as an entity whose parts several partners hold. Then a
change goes to the app's own record, unless the request names the source with `PUT <schema>/:sourceId/:id` (or
`sourceId` in a `bulk/update` item), and is refused with a 409 `ambiguous_source` when the app has none of its own
and the request names no source.

To create a record on a partner, give its app's id as the record's `sourceId`, with `POST <schema>` or in the items of
a `POST <schema>/bulk/add`; a record without one, or with the app's own id, is the app's own. It goes through the
agreement whose `remoteApp.appId` that is, never by what a partner's records say. A bulk add with items for more than
one source checks every item's source first, then creates the items a source at a time, and gives them back in the
order they were sent; if one source fails, the items already created elsewhere stay. A create is refused when its
`sourceId` is:

- an app no agreement of the collection reaches: 400 `unknown_source`;
- an app more than one agreement says it reaches: 409 `ambiguous_source`;
- not placed while an agreement doesn't know its remote app yet: 409 `data_sharing_partner_unknown`;
- a partner that can't be reached: 503 `data_sharing_partner_unavailable`.

Earlier releases sent a change to a partner's record by the `sourceId` it named, so `PUT <schema>/:id` didn't reach
one; a write or create to a partner could fail until the collection had read from that partner again; and a bulk add
kept every item in the app's own collection, whatever source it named.

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

Creating a record on a partner needs the agreement to know the partner's app. An agreement activated by an earlier
release learns it once both instances run this release, so until then creates through it are refused with
`data_sharing_partner_unknown`, unless its owner sets `remoteApp.appId` (see [Activation](#activation)).

# Federation

Federation lets one Buttress instance share data and realtime events with an app on another Buttress
instance (or another app on the same instance). It's built from a **data sharing agreement** ("DSA") — an
`AppDataSharing` record that both sides create and activate — and works at two independent layers:

1. **Datastore-level federation** — a schema's `remotes` field points a collection at a remote Buttress app
   over a `butt://`/`butts://` connection string, so reads/writes for that collection are combined from the
   local and remote datastores.
2. **Realtime federation** — the Socket process holds an outbound connection per active DSA and relays
   remote mutations back into the local realtime pipeline, so they reach local clients the same way a local
   write would (see [Architecture](../core/architecture.md)).

You don't have to use both — a DSA with no federated schema (`remotes`) still gives you realtime forwarding,
and vice versa.

See [Data Sharing](data-sharing.md) for the agreement's JSON shape, how activation works, and how the
`remotes` schema field is used.
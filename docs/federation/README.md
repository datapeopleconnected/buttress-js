# Federation

Federation lets Buttress exchange data and events between apps and instances.

## Federation Layers

1. Datastore-level federation

- App datastore can point at a remote Buttress endpoint (`butt://` or `butts://`).

2. Realtime federation

- Socket process forwards mutation events through remote socket connections.

## Main Resource

`AppDataSharing` records define active sharing agreements and remote connection details.

See [Data Sharing](data-sharing.md) for configuration and operational guidance.
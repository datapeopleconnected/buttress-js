# Data Sharing

Buttress federation supports cross-instance and cross-app data sharing.

## Data Sharing Agreement

An app data sharing agreement defines:

- Remote REST endpoint
- Remote Socket endpoint
- Remote app API path
- Token used for authenticated data exchange

## Federation Modes

1. Datastore-level federation

- App datastore connection points to remote Buttress adapter (`butt://` or `butts://`).

2. Realtime federation

- Socket process maintains remote connections and forwards mutation events.

## Operational Guidance

- Keep agreements explicit and minimal.
- Rotate sharing tokens regularly.
- Track routing and state via application logs for troubleshooting.

# Client Libraries

## Overview

Most integrations use one or both of the following:

- `@buttress/api` for backend or automation scripts
- Socket.IO client for realtime updates

## Node.js with `@buttress/api`

Install:

```bash
npm i @buttress/api
```

Example:

```js
// The client is the package's default export
const {default: Buttress} = require('@buttress/api');

async function main() {
	await Buttress.init({
		buttressUrl: 'http://localhost:8000',
		appToken: process.env.BUTTRESS_APP_TOKEN,
		apiPath: process.env.BUTTRESS_APP_PATH,
		version: 1,
		allowUnauthorized: true,
	});

	const schema = [{
		name: 'cars',
		type: 'collection',
		properties: {
			name: { __type: 'string', __allowUpdate: true },
			make: { __type: 'string', __allowUpdate: true },
		},
	}];

	await Buttress.App.updateSchema(schema);
}

main().catch(console.error);
```

## Realtime with Socket.IO

Buttress Socket process publishes mutation events for subscribed clients.

Typical client flow:

1. Connect to the app's namespace, `<socket endpoint>/<apiPath>`, passing the token as `auth: {token}` (`io(url, {auth: {token}, forceNew: true})`). A token in the query string (`query: {token}`) is refused with `token-in-query-not-supported`, as a query string ends up in proxy access logs. The same goes for REST: send a token in the `Authorization: Bearer <token>` header, including to lambda endpoints and the admin routes (`GET /api/v1/admin/activate`, `POST /api/v1/admin/install-lambda`), which answer a `?token=` or a token in the path with 400 `token_in_url_not_supported`.
2. Consume `db-activity` events and update local state.

A token can only connect to its own app's namespace; anywhere else the connection fails with the `connect_error` message `invalid-namespace`. System tokens may connect to any app's namespace. Pass `forceNew: true` when connecting to more than one namespace on the same endpoint, or socket.io reuses the first connection and its token.

## Security Guidance

- Never ship super tokens to frontend clients.
- Use app/user tokens with policy constraints.
- Restrict token origins/domains where applicable.

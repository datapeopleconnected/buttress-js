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
const Buttress = require('@buttress/api');

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

1. Connect to the Socket endpoint.
2. Authenticate with token information.
3. Subscribe to schema-specific channels/rooms.
4. Consume mutation events and update local state.

## Security Guidance

- Never ship super tokens to frontend clients.
- Use app/user tokens with policy constraints.
- Restrict token origins/domains where applicable.

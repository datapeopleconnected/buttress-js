# Admin

Buttress has two high-trust administration contexts:

- Instance administration (super token)
- Application administration (app token and policy)

## Super Token

A super token is created during install mode for bootstrapping and emergency administration.

Recommendations:

- Store it in a secret manager.
- Do not embed it in code or frontend apps.
- Rotate it if leaked.

## Application Administration

For regular operations, use app-scoped tokens and policies instead of super tokens.

The core API (`/api/v1/...`) acts on the app your token belongs to, super tokens included, so to administer an app, use that app's token. A `?apiPath=` query parameter naming any other app is refused with a 400, `apiPath_not_supported`, rather than being applied to the token's own app. Routes that act on another app say so in their path: an app's schema routes (`/<apiPath>/api/v1/<schema>`) act on that app, and take only its own tokens or a system token (the super token is one); another app's token gets a 401, `insufficient_authority`. `GET app/policy-property-list/:apiPath` lets a super token read another app's list.

Typical flow:

1. Create an app.
2. Define schema.
3. Create policies.
4. Issue token(s) with policy properties.

See the [Create an Application](create-an-application.md) guide for a complete example.

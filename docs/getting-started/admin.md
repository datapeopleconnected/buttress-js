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

A request always acts on the app its token belongs to, super tokens included. To administer an app, use that app's token. A `?apiPath=` query parameter naming any other app is refused with a 400, `apiPath_not_supported`, rather than being applied to the token's own app. Routes that can act on another app say so in their path, such as `GET app/policy-property-list/:apiPath` for a super token.

Typical flow:

1. Create an app.
2. Define schema.
3. Create policies.
4. Issue token(s) with policy properties.

See the [Create an Application](create-an-application.md) guide for a complete example.

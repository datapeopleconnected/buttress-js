# Errors

Every error the REST API answers with has the same JSON body, whichever route or check refused the request:

```json
{
  "code": "not_found",
  "message": "No policy was found with that id",
  "details": { "schema": "policy", "id": "6abd48ee72a9620e4e5f4fdb" }
}
```

- `code` is a snake_case identifier for the condition. It's the part to match on: it doesn't change between
  releases.
- `message` is for people. It can change, so don't match on it.
- `details`, when present, names what the error is about: the schema, id, path or index the request got wrong.

A body parser's refusal, a policy refusal, a lambda endpoint and the admin routes answer with this body too. An
unexpected failure on the server is answered `500` with `{"code": "internal_error", "message": "Internal server
error"}`, and its detail goes to the server's log, not the response.

## Statuses

Each code is always answered with the same status.

| Status | Means | Codes include |
| --- | --- | --- |
| 400 | The request is malformed or refused by the schema | `invalid_body`, `invalid_id`, `missing_id`, `missing_field`, `invalid_value`, `invalid_update`, `duplicate_id`, `unknown_path`, `unknown_operator`, `invalid_schema`, `invalid_policy`, `apiPath_not_supported`, `token_in_url_not_supported` |
| 401 | No token, or one that isn't valid: unknown, revoked, or its app or user has gone | `missing_token`, `invalid_token`, `app_not_found` |
| 403 | The token is valid, but not allowed to do this | `insufficient_authority`, `access_denied`, `property_access_denied`, `data_sharing_inactive`, `origin_not_allowed` |
| 404 | What the request names can't be found, or no route takes the request | `not_found`, `unknown_route`, `unknown_schema`, `unknown_lambda_endpoint` |
| 405 | A lambda endpoint called with a method other than GET or POST | `method_not_allowed` |
| 409 | The entity changed while it was being updated; try again | `update_conflict` |
| 413, 415 | The body is too large, or in an encoding or type the server doesn't read | `body_too_large`, `unsupported_body_encoding`, `unsupported_query_type` |
| 500 | An unexpected failure on the server | `internal_error` |
| 503 | A data sharing partner the request needs can't be reached | `data_sharing_partner_unavailable` |

## Validation

A body or update the schema refuses is answered with the code of its first problem (`missing_field`,
`invalid_value`, `invalid_update`, `duplicate_id`, or `unknown_path` for a field a
[strict](../applications/schema.md#schema-structure) schema doesn't define), and `details.issues` lists every
problem:

```json
{
  "code": "invalid_update",
  "message": "note: Update value is invalid: done failed schema test",
  "details": {
    "schema": "note",
    "issues": [
      { "path": "done", "code": "type", "expected": "boolean", "received": "string" },
      { "path": "nothing", "code": "unknown_path" }
    ]
  }
}
```

An issue's `code` is `required`, `type`, `enum`, `unknown_path` or `immutable` (a property that doesn't allow
updates); a schema refused when it's saved, `invalid_schema`, also uses `invalid_name`; `expected` is the type, the listed values or the
missing key, and `received` the type of what was given. The value itself isn't repeated. A policy refused when it's
saved, `invalid_policy`, also uses `unknown_operator`, whose `received` is the operator's name, and `type` for an
operand an operator can't take, whose `expected` is `array`, `string`, `pattern` or `object`.

## Queries

A search's query is refused with `400 unknown_operator`, `details: {path, received}`, for an operator Buttress doesn't
know; with `400 invalid_value`, `details: {path, expected}`, for a value that can't be read as its property's type or
an operand an operator can't take (`array`, `string`, `pattern` or `object`); and with `400 unknown_path`,
`details: {path}`, for a path a [strict](../applications/schema.md#schema-structure) schema doesn't define, or one
naming `__proto__`. See [Searching](../applications/schema.md#searching).

## Ids

An id that can't be one is answered `400 invalid_id`. A well-formed id that names nothing the caller can reach is
answered `404 not_found`, with the schema and id in `details`. That includes another app's entity, and an entity
the caller's policies don't let it read: they're answered the same as one that doesn't exist.

## Bulk updates

A bulk update (`POST <schema>/bulk/update`) answers `200` whenever the request is well formed, and reports each
item it didn't apply in the item's `validation`, with the status its own request would have been answered with:

```json
{ "id": "…", "results": null, "validation": { "status": 404, "code": "not_found", "message": "…", "details": { … } } }
```

## Changes from earlier releases

Earlier releases answered errors as `{"statusMessage": …, "message": …}`, with the code in `message`, or as
`{"message": …}`, plain text or HTML depending on where the request was refused; a path no route took got
Express's HTML page. They now all answer with the body above. `statusMessage` is gone, and the code moved from
`message` to `code`.

Statuses changed where the same condition was answered differently in different places:

- A valid token that isn't allowed to do something is answered `403`, where it was `401`: a token of another app,
  an app token on a system token's route, a policy that refuses the request, and a deactivated data sharing
  agreement.
- An id that names nothing is `404 not_found`, where it was `400` with one of `invalid_id`, `policy_does_not_exist`,
  `lambda_does_not_exist`, `secure_store_does_not_exist`, `app_data_sharing_does_not_exist`,
  `lambda_execution_does_not_exist` or `user_not_found`. The same goes for looking a user up by a token nobody has.
- Codes that named the entity (`invalid_policy_id`, `missing_required_lambda_id`…) are now `invalid_id` and
  `missing_id`.
- A refused bulk update item's `validation` has `status` and a string `code`, where `code` was the numeric status.
- A route reached without the app a token should have, and an admin lambda install that fails, are `500
  internal_error`.
- A value that can't be read as its property's type is `400 invalid_value`, in a body, an update or a query; see
  [How Values Are Read](../applications/schema.md#how-values-are-read).
- A query naming an operator Buttress doesn't know is `400 unknown_operator`, with `details: {path, received}`, and
  one giving an operator a value it can't take is `400 invalid_value`; both were `500 internal_error`. See
  [Searching](../applications/schema.md#searching).
- A request through a policy saved by an earlier release, whose query its schema can't read, is answered as the
  token's other policies allow, or `403 access_denied` when none does; it was `400 invalid_value` or
  `500 internal_error`. See [Policy](../applications/policy.md).

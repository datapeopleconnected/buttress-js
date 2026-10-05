# Schema

Schemas are the backbone of ButtressJS, defining the structure and behavior of data within the platform. They allow developers to create, manage, and extend data models that are used across applications.

## What is a Schema?
A schema is a blueprint for a data model. It defines the properties, types, and constraints of the data objects stored in ButtressJS. Schemas ensure data consistency and provide a foundation for features like validation, permissions, and real-time updates.

## Key Features
- **Property Definitions**: Specify the type, default value, and constraints for each property.
- **Extensibility**: Extend schemas to inherit properties and behaviors from other schemas.
- **Validation**: Enforce data integrity with built-in validation rules.

## Schema Structure
A schema in ButtressJS is defined as a JSON object with the following key components:

- **name**: The unique name of the schema.
- **type**: The type of schema (e.g., `collection`, `template`).
- **properties**: A dictionary of property definitions, each specifying the type, default value, and constraints.
- **extends**: (Optional) A list of schemas to inherit properties from.
- **remotes**: (Optional) One or more federation data sharing agreements this collection reads/writes
  through — see [Federation](../federation/).
- **strict**: (Optional) `true` to refuse a create that gives a field the schema doesn't define, with a 400
  `unknown_path` naming it. Without it such fields are dropped, so a client can post back an entity it read. A
  property typed `object` takes anything beneath it; `id`, `sourceId` and `_`-prefixed keys are always taken. An
  update to a path the schema doesn't define is refused either way.

### Example
```json
{
  "name": "person",
  "type": "collection",
  "properties": {
    "name": {
      "__type": "string",
      "__default": "",
      "__allowUpdate": true
    },
    "age": {
      "__type": "number",
      "__default": 0,
      "__allowUpdate": true
    },
    "email": {
      "__type": "string",
      "__default": "",
      "__allowUpdate": true
    }
  }
}
```

## Property Attributes

Every property is described by these keys:

| Attribute | Description |
| :- | :- |
| `__type` | `string`, `number`, `boolean`, `date`, `id`, `uuid`, `array`, or `object` |
| `__default` | Default value if none is supplied. `"randomString"` for a `string` generates a random 36-char value; `"new"` for `id`/`uuid` generates a new one on creation |
| `__required` | Fails validation if the property is missing and has no default |
| `__allowUpdate` | Whether the property can be set on `PUT`/path-update, not just on create |
| `__enum` | Array of allowed values (any type) |
| `__itemtype` | For `__type: "array"` of primitives — the type of each item (e.g. `"string"`, `"id"`) |
| `__schema` | For `__type: "array"` of objects — the property definitions for each array item |
| `__timeSeries` | See [Time Series Properties](#time-series-properties) below |
| `__private` | `true` to keep the property out of every response, though it's stored and can be set; a user's `auth[].password` is one |
| `__unique` | `true` so no two entities have the same value: a second is refused with a 400, `duplicate`, naming the property. Entities without a value don't count. Not for a property of array items. The datastore enforces it with an index built when the collection starts; if existing values already repeat, the server logs that and carries on without it |

A property without `__type` is treated as a **nested object** — give it its own map of sub-properties
directly, the same way you'd describe a top-level schema's `properties`:

```json
{
  "git": {
    "url": { "__type": "string", "__required": true, "__allowUpdate": true },
    "branch": { "__type": "string", "__default": "main", "__allowUpdate": true }
  }
}
```

An array of objects combines `__type: "array"` with `__schema` for the item shape:

```json
{
  "deployments": {
    "__type": "array",
    "__allowUpdate": true,
    "__schema": {
      "hash": { "__type": "string", "__required": true, "__allowUpdate": true },
      "deployedAt": { "__type": "date", "__required": true, "__allowUpdate": true }
    }
  }
}
```

An array of primitives uses `__itemtype` instead:

```json
{
  "tags": { "__type": "array", "__itemtype": "string", "__allowUpdate": true }
}
```

## How Values Are Read

A value is read as its property's `__type` the same way wherever it's given: in a body you create, in an update,
or in a query that compares it (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$all`, and a bare
value). A value that can't be read is refused with a 400, `invalid_value`, naming the property and the type it
expected. `null` is always taken, as no value.

| `__type` | Takes |
| :- | :- |
| `boolean` | `true` and `false`; `"true"`/`"false"`, `"yes"`/`"no"` and `"1"`/`"0"`, in any case; `1` and `0` |
| `number` | a number, or text that reads as one (`"4.5"`) |
| `string` | text, or a number, which is stored as text; one of `__enum`'s values when it has one |
| `date` | a date as text or a number of milliseconds |
| `id` | a 24-character hex id |
| `uuid` | a uuid in its usual form, `8-4-4-4-12` hex characters |
| `array` | a list |
| `object` | an object |
| a nested object (no `__type`) | an object, whose own properties are read as above |

Earlier releases stored any other text, or any number but `1`, as `false` for a `boolean`, took any text as a
`uuid`, and compared a query value as it was given, so `"true"` matched no `boolean` and an id that couldn't be one
matched every entity without one.

### Creating an Entity

A create stores the schema's properties, each read as above, and nothing else. A property that's left out takes its
`__default`, or its type's: `0` for a `number`, `false` for a `boolean`, `null` for an `id` or `uuid`, the time it was
created for a `date`, `[]` for an `array` and `{}` for an `object`. A `string` without a `__default` is left out, and
only `__required` makes leaving a property out an error. A value that's the same as the property's `__default` is
made as the default is, at any depth, so `"new"` given for an `id` with `__default: "new"` is a new id.

An array of items with a `__schema` reads each item through it, so each item keeps only its own properties and takes
their defaults. `null` for it stores no items, `[]`, and a `__default` for it is read through the item schema too.
A nested object's properties take their defaults when it's left out or `null`.

Earlier releases refused a `string` without a `__default` that was left out, though it wasn't required; failed with
a 500 for `null` given for an array of items, or for an array of items within a nested object; stored `{}` given for
an `object` as `null`; stored an array of items that was left out as `[]`, whatever its `__default`; and replaced a
nested object given as anything but an object with its properties' defaults, where it's now refused.

## Time Series Properties

Tagging a property with `__timeSeries: "<group>"` pulls it out of the main collection into its own
auto-generated collection, `<schema-name>-<group>`, instead of storing it on every document. Use this for
values that change often and would otherwise bloat the parent record (e.g. a running counter, a location
ping). Every property sharing the same `<group>` name lands in the same generated collection, alongside an
`entityId` (a string, correlating back to the parent record's `id`) and the standard `timestamps` fields:

```json
{
  "name": "vehicle",
  "type": "collection",
  "properties": {
    "name": { "__type": "string", "__allowUpdate": true },
    "location": {
      "__type": "object",
      "__timeSeries": "telemetry",
      "__allowUpdate": true
    }
  }
}
```

This generates a second collection, `vehicle-telemetry`, with `entityId` + `location` (+ `createdAt`/
`updatedAt`) — one row per update, instead of overwriting `location` in place on the `vehicle` document.

## Creating a Schema
To create a schema, define its structure in a JSON file and register it with ButtressJS. Schemas are added to applications and can be managed through the ButtressJS API.

## Extending Schemas
Schemas can inherit properties from other schemas using the `extends` field. This allows you to create reusable and modular data models.

### Example
```json
{
  "name": "employee",
  "type": "collection",
  "extends": ["person"],
  "properties": {
    "employeeId": {
      "__type": "string",
      "__default": "",
      "__allowUpdate": true
    },
    "department": {
      "__type": "string",
      "__default": "",
      "__allowUpdate": true
    }
  }
}
```

## Ids
Every object has an `id`, and a property can hold ids of other objects with `"__type": "id"` (or an array of
them with `"__type": "array", "__itemtype": "id"`). Ids are always strings in the API: 24-character hex strings,
such as `"507f1f77bcf86cd799439011"`. Send them as strings when creating, updating or querying, and they're
returned as strings. Creating or updating an id property with a value that isn't a valid id fails validation.

Every object Buttress returns also has a `sourceId`: the id of the app it comes from, which Buttress adds as it
returns the object. For a collection with `remotes`, that's the partner app a record comes from (see
[Federation](../federation/data-sharing.md)). A create checks a `sourceId` it's given, but doesn't store it. Earlier
releases stored one given at the top of an entity, which then took the place of the app's own, and left out a
property called `source`, at the top of an entity or in an array item, which is now stored like any other.

Ids held inside an `object` property aren't treated as ids, so they're kept exactly as they're sent.

## Updating Array Properties
`PUT <schema>/:id` takes an update `{path, value}`, or an array of them. For a property of `__type: "array"`:

| Update | Effect |
| --- | --- |
| `{"path": "tags", "value": "a"}` | Appends one item |
| `{"path": "tags", "value": ["a", "b"]}` | Replaces the whole array |
| `{"path": "tags.2", "value": "c"}` | Sets one item |
| `{"path": "tags.2.__remove__", "value": ""}` | Removes one item |

Items are checked against the array's `__itemtype` or item `__schema`, element by element when the whole array is replaced. Objects in an array with an item `__schema` keep only the properties the item schema declares, so declare `id` in the item schema if clients give items their own ids. An item of either kind of typed array can't be `null`; to add an item of defaults to an array with an item `__schema`, send `{}`. An array with neither takes any value. An array value always replaces the whole property, so an item that is itself an array can't be appended; replace the whole array instead. To append several items, send one update per item, as an array of updates to `PUT <schema>/:id` or as items of a `bulk/update`; they're applied in order.

## Searching

A search sends its query in the body, with the `QUERY` method ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)),
which reads like `GET` but takes a body:

- `QUERY <schema>` takes `{query, skip, limit, sort, project}`, each optional, and responds with the entities found.
- `QUERY <schema>/count` takes a query, or `{query}`, and responds with the number found.
- `QUERY <schema>/bulk/load` takes `{query: {ids: [...]}, project}` and responds with those entities.

A `QUERY`'s body must be JSON, sent with `Content-Type: application/json`. Without it the request is refused with a
415, `unsupported_query_type`. Responses carry `Accept-Query: "application/json"` to say so. A browser on another
origin sends a preflight `OPTIONS` before a `QUERY`, as it does before a `PUT`.

Earlier releases took searches with the `SEARCH` method, from the drafts that became RFC 10008. `SEARCH` is still
answered as before, with or without a `Content-Type`, but it's deprecated: its responses carry a `Deprecation`
header ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)), and a later major release will drop it. Move clients
to `QUERY`.

## Bulk Requests
`POST <schema>/bulk/update` takes `[{id, sourceId?, body}]`, where `body` is an update or an array of them. Each item is validated and applied on its own, in order, and the response has one entry per item, in request order:

- Applied: `{id, sourceId, results}`, where `results` is what `PUT <schema>/:id` would have returned for that body.
- Refused: `{id, sourceId, results: null, validation: {status, code, message, details?}}`, the status and [error body](../core/errors.md) the item's own request would have been answered with. Nothing in that item's body was applied, but other items were, including other items for the same entity. An item is refused when it fails validation (400 `invalid_update`), when its entity is missing or outside the caller's scope (404 `not_found`), or when its write fails, for example with a 400 because the stored data can't take it.

The response is a 200 whenever the request itself is well formed. The `x-bulk-refused` header gives the number of refused items, so a client only needs to look through the results when it isn't `0`.

`POST <schema>/bulk/add` and `POST <schema>/bulk/delete` are all or nothing. `bulk/add` stores nothing unless every entity is valid and none reuses an id, whether another entity's in the request or one already stored; the 400 names the index of the first entity that fails, for example `car: Missing field: name at index 3`. An array sent to `POST <schema>` is stored and checked in the same way. `bulk/delete` deletes nothing unless every id exists and is in the caller's scope, and responds `true`.

`DELETE <schema>` deletes every entity in the caller's scope and responds `true`. A system token, or a token with a `%FULL_ACCESS%` policy, empties the collection, and realtime clients get a single delete with no id. For any other token, the entities its policies' queries don't select are left alone, and realtime clients get a delete for each entity removed, as `DELETE <schema>/:id` would send.

## Searching
`SEARCH <schema>` and `SEARCH <schema>/count` take a query in the body, `{"query": {…}}`. A query gives each
property a value to equal, or an object of operators; the operators can be written with `$` or `@`:

| Operator | Matches a property that |
| :- | :- |
| `$eq`, a bare value | equals the value; an object of fields is compared whole, as MongoDB compares it (`{"address": {"city": "Leeds"}}` matches only an `address` of exactly that), so use a path to reach inside one (`{"address.city": "Leeds"}`) |
| `$ne` (`$not`) | doesn't equal it |
| `$gt`, `$gte`, `$lt`, `$lte`, and `$gtDate`, `$gteDate`, `$ltDate`, `$lteDate` | is after or before it |
| `$in`, `$nin`, `$all` | is one of a list, none of it, or holds all of it; the value must be a list |
| `$exists` | is there, or isn't |
| `$rex`, `$rexi` (`$regex`) | matches a pattern, with case or without |
| `$inProp` | contains the text |
| `$elMatch` (`$elemMatch`) | is a list with an item that matches a query, or a value that passes operators |

`$and`, `$or` and `$nor` take a list of queries. A query naming an operator Buttress doesn't know, or a name with an
operator's prefix where a property goes, is refused with a 400, `unknown_operator`, naming the property and the
operator (`$where`, `$expr` and other MongoDB operators included); one giving an operator a value it can't take,
such as `$in` without a list or a pattern that isn't one, with a 400, `invalid_value`. Earlier releases sent both on,
and the request failed with a 500.

A property's value is read as described in [How Values Are Read](#how-values-are-read).

## Managing Schemas
Schemas can be updated, extended, or deleted using the ButtressJS API. The `Schema` class provides methods for merging, validating, and encoding schemas.

An app's schemas are checked when they're saved (`PUT /api/v1/app/schema`), and refused with a 400,
`invalid_schema`, listing each problem in `details.issues`, rather than saved to misbehave later:

- a `__type` or `__itemtype` that isn't one of the types above;
- a key a property definition doesn't have, such as a misspelt `__requried`, or `required` without its
  underscores;
- `__required` or `__allowUpdate` that isn't `true` or `false`, an `__enum` that isn't a list, or a `__schema` on
  anything but an `array`;
- a property name that's empty, has a dot, or starts with `_` (those are the server's) or `$`;
- an object with definition keys but no `__type`.

`PUT /api/v1/app/schema` answers once the REST workers of the process that took the request have the new schema's
routes, so a client can use a collection it has just added straight away. Earlier releases answered as soon as the
change was saved, and a request straight after could reach a worker that didn't have the route yet and fail with a 404.
If a worker is slow, the request answers after 10 seconds anyway. Other REST processes, and Socket and SPR, pick the
change up as they always have, a moment later.

## Best Practices
- Use meaningful names for schemas and properties.
- Leverage the `extends` field to avoid duplication.
- Define default values and constraints to ensure data integrity.
- Regularly validate schemas to catch errors early.

## Next Steps
Learn more about [creating applications](../getting-started/create-an-application.md) and how schemas integrate with policies and secure stores.
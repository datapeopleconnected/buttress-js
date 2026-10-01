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

Earlier releases stored any other text, or any number but `1`, as `false` for a `boolean`, took any text as a
`uuid`, and compared a query value as it was given, so `"true"` matched no `boolean` and an id that couldn't be one
matched every entity without one.

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

## Bulk Requests
`POST <schema>/bulk/update` takes `[{id, sourceId?, body}]`, where `body` is an update or an array of them. Each item is validated and applied on its own, in order, and the response has one entry per item, in request order:

- Applied: `{id, sourceId, results}`, where `results` is what `PUT <schema>/:id` would have returned for that body.
- Refused: `{id, sourceId, results: null, validation: {status, code, message, details?}}`, the status and [error body](../core/errors.md) the item's own request would have been answered with. Nothing in that item's body was applied, but other items were, including other items for the same entity. An item is refused when it fails validation (400 `invalid_update`), when its entity is missing or outside the caller's scope (404 `not_found`), or when its write fails, for example with a 400 because the stored data can't take it.

The response is a 200 whenever the request itself is well formed. The `x-bulk-refused` header gives the number of refused items, so a client only needs to look through the results when it isn't `0`.

`POST <schema>/bulk/add` and `POST <schema>/bulk/delete` are all or nothing. `bulk/add` stores nothing unless every entity is valid and none reuses an id, whether another entity's in the request or one already stored; the 400 names the index of the first entity that fails, for example `car: Missing field: name at index 3`. An array sent to `POST <schema>` is stored and checked in the same way. `bulk/delete` deletes nothing unless every id exists and is in the caller's scope, and responds `true`.

`DELETE <schema>` deletes every entity in the caller's scope and responds `true`. A system token, or a token with a `%FULL_ACCESS%` policy, empties the collection, and realtime clients get a single delete with no id. For any other token, the entities its policies' queries don't select are left alone, and realtime clients get a delete for each entity removed, as `DELETE <schema>/:id` would send.

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

## Best Practices
- Use meaningful names for schemas and properties.
- Leverage the `extends` field to avoid duplication.
- Define default values and constraints to ensure data integrity.
- Regularly validate schemas to catch errors early.

## Next Steps
Learn more about [creating applications](../getting-started/create-an-application.md) and how schemas integrate with policies and secure stores.
# Schema

Schemas are the backbone of ButtressJS, defining the structure and behavior of data within the platform. They allow developers to create, manage, and extend data models that are used across applications.

## What is a Schema?
A schema is a blueprint for a data model. It defines the properties, types, and constraints of the data objects stored in ButtressJS. Schemas ensure data consistency and provide a foundation for features like validation, permissions, and real-time updates.

## Key Features
- **Property Definitions**: Specify the type, default value, and constraints for each property.
- **Extensibility**: Extend schemas to inherit properties and behaviors from other schemas.
- **Validation**: Enforce data integrity with built-in validation rules.
- **Time Series Support**: Automatically generate time-series collections for specific properties.

## Schema Structure
A schema in ButtressJS is defined as a JSON object with the following key components:

- **name**: The unique name of the schema.
- **type**: The type of schema (e.g., `collection`, `template`).
- **properties**: A dictionary of property definitions, each specifying the type, default value, and constraints.
- **extends**: (Optional) A list of schemas to inherit properties from.

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

## Updating Array Properties
`PUT <schema>/:id` takes an update `{path, value}`, or an array of them. For a property of `__type: "array"`:

| Update | Effect |
| --- | --- |
| `{"path": "tags", "value": "a"}` | Appends one item |
| `{"path": "tags", "value": ["a", "b"]}` | Replaces the whole array |
| `{"path": "tags.2", "value": "c"}` | Sets one item |
| `{"path": "tags.2.__remove__", "value": ""}` | Removes one item |

Items are checked against the array's `__itemtype` or item `__schema`, element by element when the whole array is replaced. Objects in an array with an item `__schema` keep only the properties the item schema declares, so declare `id` in the item schema if clients give items their own ids. An array with neither takes any value. An array value always replaces the whole property, so an item that is itself an array can't be appended; replace the whole array instead. To append several items, send one update per item, as an array of updates to `PUT <schema>/:id` or as items of a `bulk/update`; they're applied in order.

## Bulk Requests
`POST <schema>/bulk/update` takes `[{id, sourceId?, body}]`, where `body` is an update or an array of them. Each item is validated and applied on its own, in order, and the response has one entry per item, in request order:

- Applied: `{id, sourceId, results}`, where `results` is what `PUT <schema>/:id` would have returned for that body.
- Refused: `{id, sourceId, results: null, validation: {code, message}}`. Nothing in that item's body was applied, but other items were, including other items for the same entity.

The response is a 200 whenever the request itself is well formed, so check each item's `results`.

`POST <schema>/bulk/add` and `POST <schema>/bulk/delete` are all or nothing. `bulk/add` stores nothing unless every entity is valid and none reuses an id, whether another entity's in the request or one already stored; the 400 names the index of the first entity that fails, for example `car: Missing field: name at index 3`. `bulk/delete` deletes nothing unless every id exists and is in the caller's scope, and responds `true`.

## Managing Schemas
Schemas can be updated, extended, or deleted using the ButtressJS API. The `Schema` class provides methods for merging, validating, and encoding schemas.

## Best Practices
- Use meaningful names for schemas and properties.
- Leverage the `extends` field to avoid duplication.
- Define default values and constraints to ensure data integrity.
- Regularly validate schemas to catch errors early.

## Next Steps
Learn more about [creating applications](../getting-started/create-an-application.md) and how schemas integrate with policies and secure stores.
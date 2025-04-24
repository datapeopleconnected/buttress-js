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

## Managing Schemas
Schemas can be updated, extended, or deleted using the ButtressJS API. The `Schema` class provides methods for merging, validating, and encoding schemas.

## Best Practices
- Use meaningful names for schemas and properties.
- Leverage the `extends` field to avoid duplication.
- Define default values and constraints to ensure data integrity.
- Regularly validate schemas to catch errors early.

## Next Steps
Learn more about [creating applications](../getting-started/create-an-application.md) and how schemas integrate with policies and secure stores.
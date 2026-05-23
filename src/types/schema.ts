export type PropertyDefinition = {
  __type: 'string' | 'number' | 'object' | 'array' | 'boolean' | 'id' | 'date' | 'uuid';
  __default?: unknown;
  __required?: boolean;
  __enum?: unknown[];
  __itemtype?: string;
  __allowUpdate?: boolean;
};

export type ArraySchema = {
  __type: 'array';
  __allowUpdate?: boolean;
  __schema: Properties;
};

export type Remotes = {
  name: string;
  schema: string;
};

export type Properties = {
  [key: string]: PropertyDefinition | ArraySchema | { [key: string]: PropertyDefinition | ArraySchema };
};

export type FlattenedSchemaProperty = {
  __type: 'string' | 'number' | 'object' | 'array' | 'boolean' | 'id' | 'date' | 'uuid';
  __default?: unknown;
  __required?: boolean;
  __enum?: unknown[];
  __itemtype?: string;
  __allowUpdate?: boolean;
  __schema?: Record<string, FlattenedSchemaProperty>;
};

export type FlattenedSchema = Record<string, FlattenedSchemaProperty>;

export interface Schema {
  name: string;
  core?: boolean;
  extends?: string[];
  remotes?: Remotes | Remotes[];
  type: 'collection' | 'template';
  properties: Properties;
}

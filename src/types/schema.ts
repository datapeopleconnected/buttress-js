/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
 * <https://www.dpc-ltd.com/>
 *
 * This file is part of Buttress.
 * Buttress is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public Licence as published by the Free Software
 * Foundation, either version 3 of the Licence, or (at your option) any later version.
 * Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public Licence for more details.
 * You should have received a copy of the GNU Affero General Public Licence along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 */
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

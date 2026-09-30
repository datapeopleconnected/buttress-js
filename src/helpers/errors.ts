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

export type ApiErrorDetails = Record<string, unknown>;

// What the API answers an error with
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: ApiErrorDetails;
}

// `invalid_id` reads as "Invalid id"
const describeCode = (code: string) => `${code.charAt(0).toUpperCase()}${code.slice(1).replace(/_/g, ' ')}`;

/**
 * An error the API answers with its own status and body: a snake_case `code` for clients to match on, a `message` for
 * people, and `details` naming what it's about where that helps. Anything else thrown is answered as a 500
 * `internal_error`, as its message may carry internal details. A 500's reason is kept as its `cause`, for the log.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: ApiErrorDetails;

  constructor(status: number, code: string, message?: string, details?: ApiErrorDetails, cause?: unknown) {
    super(message ?? describeCode(code), cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toBody(): ApiErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export const badRequest = (code: string, message?: string, details?: ApiErrorDetails) =>
  new ApiError(400, code, message, details);

// No token, or one that isn't known, has been revoked, or whose app or user has gone
export const unauthorised = (code: string, message?: string, details?: ApiErrorDetails) =>
  new ApiError(401, code, message, details);

// A valid token that isn't allowed to do this
export const forbidden = (code: string, message?: string, details?: ApiErrorDetails) =>
  new ApiError(403, code, message, details);

export const notFound = (code: string, message?: string, details?: ApiErrorDetails) =>
  new ApiError(404, code, message, details);

/**
 * A well-formed id that names nothing the caller can reach: nothing at all, or another app's entity, which are
 * answered alike.
 */
export const entityNotFound = (schema: string, id?: unknown) =>
  new ApiError(
    404,
    'not_found',
    `No ${schema} was found with that id`,
    id === undefined ? { schema } : { schema, id: String(id) },
  );

export const methodNotAllowed = (code: string, message?: string, details?: ApiErrorDetails) =>
  new ApiError(405, code, message, details);

export const conflict = (code: string, message?: string, details?: ApiErrorDetails) =>
  new ApiError(409, code, message, details);

export const unavailable = (code: string, message?: string, details?: ApiErrorDetails) =>
  new ApiError(503, code, message, details);

/**
 * Something that shouldn't happen went wrong on the server. The caller is told no more than that; `reason` goes to
 * the log.
 */
export const internal = (reason: string) =>
  new ApiError(500, 'internal_error', 'Internal server error', undefined, reason);

// A body parser's refusal of a body that's malformed, too large or in an unknown encoding
const bodyParserError = (err: unknown) => {
  const parserError = err as { type?: unknown; status?: unknown; expose?: unknown } | undefined;
  if (
    typeof parserError?.type !== 'string' ||
    parserError.expose !== true ||
    typeof parserError.status !== 'number' ||
    parserError.status < 400 ||
    parserError.status >= 500
  ) {
    return null;
  }

  if (parserError.status === 413) return new ApiError(413, 'body_too_large', 'The request body is too large');
  if (parserError.status === 415) {
    return new ApiError(415, 'unsupported_body_encoding', 'The request body is in an unsupported encoding');
  }
  return new ApiError(parserError.status, 'invalid_body', 'The request body could not be parsed');
};

/**
 * The ApiError to answer `err` with: itself, a body parser's refusal, or, for anything else, a 500 `internal_error`
 * with `err` as its cause.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return bodyParserError(err) ?? new ApiError(500, 'internal_error', 'Internal server error', undefined, err);
}

/** A body parser's refusal as an ApiError, or null for any other error. */
export function fromBodyParserError(err: unknown): ApiError | null {
  return bodyParserError(err);
}

export class SchemaNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaNotFound';
  }
}

export class SchemaInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaInvalid';
  }
}

export class RouteMissingModel extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteMissingModel';
  }
}

export class UnsupportedDatastore extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDatastore';
  }
}

export class NotYetImplemented extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotYetImplemented';
  }
}

export class InvalidRequest extends Error {
  code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'InvalidRequest';
    this.code = code;
  }
}

export class Unauthenticated extends Error {
  status: string;
  code: number;

  constructor(message: string, status: string, code: number) {
    super(message);
    this.name = 'Unauthenticated';
    this.status = status;
    this.code = code;
  }
}

export class InvalidToken extends Error {
  code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'InvalidToken';
    this.code = code;
  }
}

export class CodedError extends Error {
  code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'GENERIC_LAMBDA_ERROR';
    this.code = code;
  }
}

/**
 * An entity being added reuses the id of one already stored, found only when it was written. `index` is its position
 * among the entities being added.
 */
export class DuplicateIdError extends Error {
  index: number;
  id: string;

  constructor(index: number, id: string) {
    super(`Duplicate id ${id} at index ${index}`);
    this.name = 'DuplicateIdError';
    this.index = index;
    this.id = id;
  }
}

export class UpstreamApiError extends Error {
  code: string;
  httpStatus: number;
  retryable: boolean;
  errors?: Array<{ code?: string; message?: string; path?: string }>;

  constructor(
    message: string,
    code: string,
    httpStatus: number,
    opts: { retryable?: boolean; errors?: Array<{ code?: string; message?: string; path?: string }> } = {},
  ) {
    super(message);
    this.name = 'UPSTREAM_API_ERROR';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = opts.retryable ?? [429, 500, 502, 503, 504].includes(httpStatus);
    if (opts.errors) this.errors = opts.errors;
  }
}

export default {
  ApiError,
  badRequest,
  unauthorised,
  forbidden,
  notFound,
  entityNotFound,
  methodNotAllowed,
  conflict,
  unavailable,
  internal,
  toApiError,
  fromBodyParserError,
  SchemaNotFound,
  SchemaInvalid,
  RouteMissingModel,
  UnsupportedDatastore,
  NotYetImplemented,
  InvalidRequest,
  Unauthenticated,
  InvalidToken,
  CodedError,
  DuplicateIdError,
  UpstreamApiError,
};

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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

export class RequestError extends Error {
	code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
		this.name = 'RequestError';
	}
};

export class SchemaNotFound extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SchemaNotFound';
	}
};

export class SchemaInvalid extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SchemaInvalid';
	}
};

export class RouteMissingModel extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RouteMissingModel';
	}
};

export class UnsupportedDatastore extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedDatastore';
	}
};

export class NotYetImplemented extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NotYetImplemented';
	}
};

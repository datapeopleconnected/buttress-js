const Readable = require('stream').Readable;

class ReadableStreamClone extends Readable {
	constructor(readableStream, options) {
		super(options);

		readableStream.on('data', (chunk) => this.push(chunk));
		readableStream.on('end', () => this.push(null));
		readableStream.on('error', (err) => this.emit('error', err));
	}

	_read() {}
}

module.exports = {
	ReadableStreamClone,
};

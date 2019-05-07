/**
 * V2 exceptions.
 */


// Core/NPM modules
const _ = require('lodash');


/**
 * An error that will encode itself as a JSON object.
 */
class JSONSerializableError extends Error {

    /**
     * Construct a new error.
     */
    constructor(...args) {

        // Call super constructor
        super(...args);

        // If wrapping another error, override name and stack
        let e = args[0];
        if ((e instanceof Error) && !(e instanceof JSONSerializableError)) {
            this.name = e.name;
            this.stack = e.stack;
        }
        // Otherwise set name and capture stack trace.
        else {
            this.name = this.constructor.name;
            Error.captureStackTrace(this, this.constructor);
        }

    }

    /**
     * Return an object suitable for being serialized as JSON.
     */
    toJSON() {

        return _.assignIn({}, this, {
            message: this.message,
            name: this.name,
            stack: _.split(this.stack, '\n')
        });

    }

}


/**
 * A generic error encountered during inference.
 */
class InferenceError extends JSONSerializableError {}


/**
 * An unexpected error encountered during inference.
 */
class UnexpectedInferenceError extends InferenceError {}


/**
 * Indicates no base environments could be found.
 */
class NoBaseEnvironmentsFoundError extends InferenceError {}


/**
 * Indicates inference timed out without finding a working environment.
 */
class InferenceTimeoutError extends InferenceError {

    constructor(time, validations, ...args) {

        super(...args);
        this.time = time;
        this.validations = validations;

    }

}


/**
 * Indicates that inference finished without finding a working environment.
 */
class NoWorkingEnvironmentFoundError extends InferenceError {

    constructor(time, validations, metadata, ...args) {

        super(...args);
        this.time = time;
        this.validations = validations;
        this.metadata = metadata;

    }

}


/**
 * Indicates that inference has been terminated (SIGTERM).
 */
class InferenceTerminatedError extends InferenceError {

    constructor(signal, code, ...args) {

        super(...args);
        this.signal = signal;
        this.code = code;

    }

}


/**
 * A generic error encountered during validation.
 */
class ValidationError extends InferenceError {}


// Export
module.exports = {
    InferenceError,
    UnexpectedInferenceError,
    NoBaseEnvironmentsFoundError,
    InferenceTimeoutError,
    NoWorkingEnvironmentFoundError,
    InferenceTerminatedError,
    ValidationError,
};
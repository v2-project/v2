/**
 * Global shared metadata for the inference process.
 *
 * @module metadata
 */


/**
 * Shared metadata that gets used throughout the inference process.
 *
 * Several objects in the inference stack need access to the same metadata about the codebase under inference. This
 * class exists to track object metadata in a singleton instance, rather than passing metadata all the way through
 * the stack. It is expected that metadata is appropriately initialized by the v2 entrypoint.
 *
 * @property {String}  language The global language for the codebase being dockerized.
 * @property {String}  path     The resolved absolute path to the codebase.
 * @property {String}  basename The basename of the codebase path. Either a code file or directory.
 * @property {Boolean} isDir    True if path points to a directory.
 */
class Metadata {}


// Export singleton instance
module.exports = new Metadata();
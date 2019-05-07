/**
 * @module system-strategy
 */


// Constants
const NOT_IMPLEMENTED = 'not implemented';


/**
 * System strategy class.
 *
 * @property {String} system System name.
 */
class SystemStrategy {

    /**
     * System name.
     *
     * @returns {String} System name.
     */
    get system() { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Get all versions of a package that are available to be installed.
     *
     * @param   {String}                  pkg Package name.
     * @returns {Promise<Array.<String>>}     List of available version specifiers.
     */
    async getAvailablePackageVersions(pkg) { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Given a list of package versions, return them sorted order.
     *
     * @param   {Array.<String>}          versions          Versions to sort.
     * @param   {Boolean}                 [ascending=false] Whether to sort in ascending or descending order.
     * @param   {String}                  [cutoff]          Only include versions less than cutoff or equal to cutoff
     *                                                      if sorting descending, or greater than or equal to cutoff
     *                                                      if sorting ascending. Include all versions if not specified.
     * @returns {Promise<Array.<String>>}                   Sorted versions.
     */
    async sortPackageVersions(versions, ascending=false, cutoff) { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Get a system specific command for installing a package.
     *
     * @param   {Object} pkg Package to install.
     * @returns {Object}     Docker run command to install a package `name` at `version`.
     */
    getInstallRunCommand(pkg) { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Normalize a package name. Default is to do nothing. Some systems
     * may override this if they are case insensitive, allow multiple
     * separators, etc.
     *
     * @param   {String} pkg Package name.
     * @returns {String}     Normalized package name.
     */
    normalizePackageName(pkg) { return pkg; }

    /**
     * Search for a package exactly matching a given name using a packaging system implementation. If a version is
     * specified, the package search requires that a package exists matching both the name and version. Implementations
     * may vary on "exact." For example, some implementations may perform a case insensitive match.
     *
     * @param   {String}     name      Package name.
     * @param   {String}     [version] Package version.
     * @returns {Dependency}           Package with exact match.
     */
    async searchForExactPackageMatch(name, version) { throw new Error(NOT_IMPLEMENTED); }

}


// Export
module.exports = SystemStrategy;
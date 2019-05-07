/**
 * @module systems/apt/strategy
 */


// Core/NPM modules
const _              = require('lodash');
const Bluebird       = require('bluebird');
const semver         = require('semver');


// Local modules
const cache          = require('../../cache');
const dockerTools    = require('../../docker-tools');
const logger         = require('../../logger');
const SystemStrategy = require('../system-strategy');
const versionUtils   = require('../../version-utils');


/**
 * APT strategy implementation.
 */
class APTStrategy extends SystemStrategy {

    /**
     * Get all versions of a package that are available to be installed.
     *
     * @param   {String}                  pkg Package name.
     * @returns {Promise<Array.<String>>}     List of available version specifiers.
     */
    async getAvailablePackageVersions(pkg) {

        // Get redis client with Bluebird.using to properly close connection after finish.
        return Bluebird.using(cache.getClientFor('apt'), async (redis) => {

            // Normalize package name for cache storage
            pkg = this.normalizePackageName(pkg);
            logger.info(`Getting definition for apt package: '${pkg}'`);

            // Known package definition and when cache was updated
            let definition;
            let updated;

            // Check for package info in the cache
            if (await redis.existsAsync(pkg)) {

                // Get definition
                let cache = JSON.parse(await redis.send_commandAsync('JSON.GET', [pkg]));
                if (cache) {
                    definition = cache.definition;
                    updated = cache.updated;
                    logger.info(`Cache hit for '${pkg}'`);
                }

            }

            // Determine if the cache is stale (cache was last validated more than 1 week (604800 seconds) ago).
            let now = _.toInteger(Date.now() / 1000);  // Date.now() returns milliseconds.
            let stale = definition && (now - updated) > 604800;
            if (stale) { logger.info(`Cache is stale, updating`); }

            // Find versions
            if (definition === undefined || stale) {

                definition = await dockerTools.runDockerContainer('localhost:5000/v2/apt-versions:latest', pkg);

                // Cache definition
                try {
                    await redis.send_commandAsync('JSON.SET', [pkg, '.', JSON.stringify({
                        definition,
                        updated: now
                    })]);
                }
                catch (e) {
                    logger.error(e);
                }

            }

            // Return package definition
            return definition;

        });

    }

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
    async sortPackageVersions(versions, ascending=false, cutoff) {

        // Coerce to semver
        versions = versions.map(versionUtils.coerceSemver);
        cutoff = versionUtils.coerceSemver(cutoff);

        // Sort
        let comp = ascending ? (a, b) => a.compare(b) : (a, b) => -a.compare(b);
        versions = versions.sort(comp);

        // Filter if cutoff is specified
        if (cutoff) {
            versions = versions.filter(_.partial(ascending ? semver.gte : semver.lte, _, cutoff));
        }

        // Return
        return versions.map(v => v.version);

    }

    /**
     * Get default run command.
     *
     * @param   {Object} pkg Package object.
     * @returns {Object}     Run command object.
     */
    getInstallRunCommand(pkg) {

        return {
            command: 'apt-get',
            args: ['install', '-y', pkg.version ? `${pkg.name}=${pkg.version}` : pkg.name]
        };

    }

    /**
     * Search for a package exactly matching a given name using a packaging system implementation. If a version is
     * specified, the package search requires that a package exists matching both the name and version. Implementations
     * may vary on "exact." For example, some implementations may perform a case insensitive match.
     *
     * @param   {String}     name      Package name.
     * @param   {String}     [version] Package version.
     * @returns {Dependency}           Package with exact match.
     */
    async searchForExactPackageMatch(name, version) {

        // Get all available versions for the package by name
        let versions = await this.getAvailablePackageVersions(name);

        // If a specific version was requested, but it is not available, return null. Otherwise, return the package
        // object formatted with the requested version. If no version was requested, pick the most recent version.
        if (version && !_.includes(versions, version)) return null;
        else return { name, version: version || _.first(versions), system: 'apt' };

    }

}


// Export
module.exports = APTStrategy;
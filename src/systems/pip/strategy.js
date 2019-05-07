        /**
 * @module systems/pip/strategy
 */


// Core/NPM Modules
const _              = require('lodash');
const Bluebird       = require('bluebird');
const request        = require('request');
const status         = require('statuses');
const URL            = require('url').URL;


// Local modules
const cache          = require('../../cache');
const dockerTools    = require('../../docker-tools');
const logger         = require('../../logger');
const SystemStrategy = require('../system-strategy');


// Constants
const PYPI_BASE = 'https://pypi.org/pypi/';


/**
 * PIP strategy implementation.
 */
class PIPStrategy extends SystemStrategy {

    /**
     * Get a PyPI package definition using the PyPI API. This method respects the ETag header. Requests are made using
     * `If-None-Exists: <etag>`. If the API response is 200 OK, the returned definition is cached in redis. If the
     * response is 304 Not Modified, the definition is loaded from redis.
     *
     * @param   {String}          pkg Package name.
     * @returns {Promise<Object>}     Package definition.
     */
    async getPackageDefinition(pkg) {

        // Use Bluebird.using to properly close connection after finish.
        return Bluebird.using(cache.getClientFor('pip'), async (redis) => {

            // Normalize package name for cache storage
            pkg = this.normalizePackageName(pkg);
            logger.info(`Getting definition for pip package: '${pkg}'`);

            // Format API url
            let url = new URL(`${pkg}/json`, PYPI_BASE);

            // Known package definition and etag
            let definition;
            let etag;
            let updated;

            // Check for package info in the cache
            if (await redis.existsAsync(pkg)) {

                // Get definition and stored etag
                let cache = JSON.parse(await redis.send_commandAsync('JSON.GET', [pkg]));
                if (cache) {
                    definition = cache.definition;
                    etag = cache.etag;
                    updated = cache.updated;
                    logger.info(`Cache hit for '${pkg}'`);
                }

            }

            // Determine if the cache is stale (cache was last validated more than 1 hour (3600 seconds) ago).
            let now = _.toInteger(Date.now() / 1000);  // Date.now() returns milliseconds.
            let stale = definition && (now - updated) > 3600;
            if (stale) { logger.info(`Cache is stale, updating`); }

            // Call API on cache miss or if stale
            if (definition === undefined || stale) {

                // Ask for package from PyPI using If-None-Match
                logger.info(`Calling PyPI API: GET ${url}`);
                let response = await Bluebird.fromCallback(cb => request.get(
                    { url, json: true, headers: { 'If-None-Match': etag } },
                    cb
                ));

                // If not found, cache and return null
                if (response.statusCode === status('Not Found')) {
                    try {
                        await redis.send_commandAsync('JSON.SET', [pkg, '.', JSON.stringify({
                            definition: null,
                            etag: null,
                            updated: now
                        })]);
                    }
                    catch (e) {
                        logger.error(e);
                    }
                    return null;
                }

                // Error if the status code is otherwise unexpected.
                if (response.statusCode !== status('OK') && response.statusCode !== status('Not Modified')) {

                    throw new Error(JSON.stringify(_.get(response, 'body')));

                }

                // If response modified, cache the new definition
                if (response.statusCode === status('OK')) {

                    definition = _.get(response, 'body');
                    etag = _.get(response, 'headers.etag');
                    logger.info(`Found new etag '${etag}' for '${pkg}'`);

                }
                else {

                    logger.info('Not Modified.');

                }

                // Cache definition
                try {
                    await redis.send_commandAsync('JSON.SET', [pkg, '.', JSON.stringify({
                        definition,
                        etag,
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
     * Get all versions of a package that are available to be installed.
     *
     * @param   {String}                  pkg Package name.
     * @returns {Promise<Array.<String>>}     List of available version specifiers.
     */
    async getAvailablePackageVersions(pkg) {

        // Get package version
        let definition = await this.getPackageDefinition(pkg);

        // Parse all versions and sort in some reasonable order
        return _.keys(_.get(definition, 'releases', {})).sort();

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

        // Generate command
        let cmd = [`'${JSON.stringify(versions)}'`];
        if (cutoff) cmd.push(`--cutoff='${cutoff}'`);
        if (ascending) cmd.push('--ascending');

        // Run sort
        return dockerTools.runDockerContainer('localhost:5000/v2/pip-versions:latest', cmd.reverse().join(' '));

    }

    /**
     * Get default run command.
     *
     * @param   {Object} pkg Package object.
     * @returns {Object}     Run command object.
     */
    getInstallRunCommand(pkg) {

        return {
            command: 'pip',
            args: ['install', pkg.version ? `${pkg.name}==${pkg.version}` : pkg.name]
        };

    }

    /**
     * Normalize a package name. PyPI treats package names as case
     * insensitive, and makes no distinction between _ and -.
     *
     * @param   {String} pkg Package name.
     * @returns {String}     Normalized package name.
     */
    normalizePackageName(pkg) {

        return pkg.toLowerCase().replace('_', '-');

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

        // Get package definition
        let definition = await this.getPackageDefinition(name);

        // If no definition is found, return null
        if (!definition) {
            logger.info(`No definition found for '${name}'`);
            return null;
        }

        // Get releases
        // TODO can filter to releases that support a particular python version
        // may need PEP 440 https://www.python.org/dev/peps/pep-0440/

        // Get releases. If a version is specified, get releases for only that version.
        // Otherwise get releases for all versions.
        let path = version ? `releases['${version}']` : 'releases';
        let releases = _.flattenDeep(_.values(_.get(definition, path, {})));

        // Return if any releases are found
        if (!_.isEmpty(releases)) {
            return {
                name: _.get(definition, 'info.name'),
                version: version || _.get(definition, 'info.version'),
                system: 'pip'
            };
        }
        else {
            logger.info('No releases found for', _.get(definition, 'info.name'));
            return null;
        }

    }

}


// Export
module.exports = PIPStrategy;
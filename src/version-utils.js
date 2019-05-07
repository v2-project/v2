/**
 * Utilities for working with package versions.
 *
 * @module version-utils
 */


// Core/NPM modules
const _      = require('lodash');
const semver = require('semver');


/**
 * Version utilities.
 */
class VersionUtils {

    /**
     * Helper function for coercing values to semver with prerelease values.
     *
     * @param   {String}        val Version string.
     * @returns {semver.SemVer}     Semantic version object.
     */
    coerceSemver(val) {

        // If no value is provided, do nothing.
        if (_.isUndefined(val) || _.isNull(val)) {
            throw new Error('Undefined or null value passed to coerceSemver.');
        }

        // Try to parse directly as a semantic version with prerelease. If that fails, try to coerce.
        try {

            return semver.SemVer(val, { loose: true, includePrerelease: true });

        }
        catch (e) {

            // Coerce value to a version
            const version = semver.coerce(val);

            // Try to parse any parts remaining after the version as a pre-release.
            // SEMVER_COERCE definition taken from the semver module.
            const SEMVER_COERCE = /(?:^|[^\d])(\d{1,16})(?:\.(\d{1,16}))?(?:\.(\d{1,16}))?(?:$|[^\d])/;
            const match = val.match(SEMVER_COERCE);
            const prefix = _.takeWhile(_.slice(match, 1), _.negate(_.isNil)).join('.');
            const prerelease = val.substr(prefix.length);

            // If there no prerelease information can be found, just return the coerced version.
            if (!prerelease) return version;

            // Try to create a version with the prerelease string. If that fails for some reason, return the regular
            // coerced version without prerelease information.
            try {

                return semver.SemVer(`${version.version}-${prerelease}`, { loose: true, includePrerelease: true });

            }
            catch (e) {

                return version;

            }

        }

    }

}


// Export
module.exports = new VersionUtils();

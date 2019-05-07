/**
 * Definition for V2 environment dependency semver version mutation operators.
 *
 * A mutation operator accepts as input an environment specification and a validation result applies a mutation based
 * on some strategy. It returns zero or more new environment specifications.
 *
 * @module mutation/versions
 */


// NPM modules
const _                           = require('lodash');
const semver                      = require('semver');


// Local modules
const factory                     = require('../strategy-factory');
const logger                      = require('../logger');
const Mutator                     = require('./mutator');
const versionUtils                = require('../version-utils');


// Constants
const TYPE_DECREMENT_SEMVER_MAJOR = 'decrement_semver_major';
const TYPE_DECREMENT_SEMVER_MINOR = 'decrement_semver_minor';


class DependencySemverMutator extends Mutator {

    /**
     * Helper function for getting a lookup table containing all available versions for a dependency. Keys are the value
     * coerced to semver.
     *
     * @param   {Dependency}      dependency Dependency to lookup versions for.
     * @returns {Promise<Object>}            Lookup table containing <semver, version> pairs.
     */
    async getSemverLookupTable(dependency) {

        // Get system strategy
        const strategy = await factory.getSystemStrategy(dependency.system);

        // Resolve all available versions
        let availableVersions = await strategy.getAvailablePackageVersions(dependency.name);

        // Force all available versions to semver.
        let semverVersions = _.map(availableVersions, versionUtils.coerceSemver);

        // Pair and remove any versions that could not be parsed as semver (the semver version is null)
        [semverVersions, availableVersions] = _.zip(..._.reject(_.zip(semverVersions, availableVersions), _.partial(_.some, _, _.isNull)));

        // Zip into an object (lookup table)
        return _.zipObject(semverVersions, availableVersions);

    }

    /**
     * Undo the result of a dependency version change by restoring the original version.
     *
     * @param   {Dependency}          dependency Mutated dependency.
     * @param   {Mutation}            mutation   Mutation that was applied to the dependency.
     * @returns {Promise<Dependency>}            Dependency with the original version.
     */
    async undo(dependency, mutation) {

        return _.assign(_.clone(dependency), { version: mutation.changes.from });

    }

}


/**
 * Mutator for dependency semver major versions.
 */
class DecrementSemverMajorVersion extends DependencySemverMutator {

    /**
     * Construct mutator with name.
     */
    constructor() { super(TYPE_DECREMENT_SEMVER_MAJOR); }

    /**
     * Mutate a dependency by decrementing the version to the latest release of the last major version.
     *
     * @param   {Dependency}              dependency Dependency specification to mutate.
     * @returns {Promise<MutationResult>}            Mutation result containing mutated dependency specification.
     */
    async apply(dependency) {

        // Try to coerce version to semver. If it is valid and greater than zero, try to decrement.
        let version = versionUtils.coerceSemver(dependency.version);
        if (version && version.major > 0) {

            // Get lookup table for available versions.
            const lookup = await this.getSemverLookupTable(dependency);

            // Find the last release of the previous major version
            const lastMajorVersion = semver.maxSatisfying(_.keys(lookup), `<${version.major}.0.0`);

            // Lookup original version name
            let newVersion = lookup[lastMajorVersion];

            // If a new version was found, alter the environment and return it.
            if (newVersion) {

                logger.info(`Semver Major: decremented ${dependency.name} version from ${dependency.version} to ${newVersion}`);
                let mutantDependency = _.assign(_.clone(dependency), { version: newVersion });
                let mutation = {
                    type: this.name,
                    changes: {
                        package: dependency.name,
                        from: dependency.version,
                        to: mutantDependency.version
                    }
                };
                return { mutant: mutantDependency, mutation: mutation };

            }
            else {

                logger.info(`No previous major version release found for (${dependency.name}, ${dependency.version})`);

            }

        }

    }

}


/**
 * Mutator for dependency semver minor versions.
 */
class DecrementSemverMinorVersion extends DependencySemverMutator {

    /**
     * Construct mutator with name.
     */
    constructor() { super(TYPE_DECREMENT_SEMVER_MINOR); }

    /**
     * Mutate a dependency by decrementing the version to the latest patch of the last minor version.
     *
     * @param   {Dependency}              dependency Dependency specification to mutate.
     * @returns {Promise<MutationResult>}            Mutation result containing mutated dependency specification.
     */
    async apply(dependency) {

        // Try to coerce version to semver. If it is valid and greater than zero, try to decrement.
        let version = versionUtils.coerceSemver(dependency.version);
        if (version && version.minor > 0) {

            // Get lookup table for available versions.
            const lookup = await this.getSemverLookupTable(dependency);

            // Find the last release of the previous major version
            const lastMajorVersion = semver.maxSatisfying(
                _.keys(lookup),
                `>=${version.major}.0.0 <${version.major}.${version.minor}.0`
            );

            // Lookup original version name
            let newVersion = lookup[lastMajorVersion];

            // If a new version was found, alter the environment and return it.
            if (newVersion) {

                logger.info(`Semver Minor: decremented ${dependency.name} version from ${dependency.version} to ${newVersion}`);
                let mutantDependency = _.assign(_.clone(dependency), { version: newVersion });
                let mutation = {
                    type: this.name,
                    changes: {
                        package: dependency.name,
                        from: dependency.version,
                        to: mutantDependency.version
                    }
                };
                return { mutant: mutantDependency, mutation: mutation };

            }
            else {

                logger.info(`No previous minor version release found for (${dependency.name}, ${dependency.version})`);

            }

        }

    }

}


// Export mutators directly
module.exports.decrementSemverMajor = new DecrementSemverMajorVersion();
module.exports.decrementSemverMinor = new DecrementSemverMinorVersion();

// List of mutators by precedence for iteration.
module.exports.versionMutators = [
    module.exports.decrementSemverMajor,
    module.exports.decrementSemverMinor
];

// Export lookup table
module.exports.lookup = _.zipObject(..._.zip(..._.map(module.exports.versionMutators, (mutator) => [mutator.name, mutator])));

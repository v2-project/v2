/**
 * Mutant generators.
 *
 * @module mutation
 */


// Core/NPM modules
const _                                    = require('lodash');
const Bluebird                             = require('bluebird');


// Local modules
const logger                               = require('../logger');
const factory                              = require('../strategy-factory');
const neo4j                                = require('../neo4j');


// Environment mutators
const semver                               = require('./semver');


// Constants
const FIRST_N                              = 500;
const MAX_LEVEL                            = 10;


// Codes
const TIMEOUT                              = 'Timeout';
const UNKNOWN_EXCEPTION                    = 'UnknownException';
const NOT_REPAIRABLE                       = 'NotRepairable';
const EXHAUSTED_MATRIX_VERSIONS            = 'ExhaustedVersionMatrixVersions';
const EXHAUSTED_SINGLE_DEPENDENCY_VERSIONS = 'ExhaustedSingleDependencyVersions';
const EXHAUSTED_ALL_DEPENDENCY_VERSIONS    = 'ExhaustedAllDependencyVersions';


// Mutation types
const TYPE_VERSION_MATRIX_TO               = 'version_matrix_to_version';
const TYPE_VERSION_MATRIX_FROM             = 'version_matrix_from_version';


// Queries
const HAS_UPGRADES                         = `
MATCH 
    (p :package { name: {name}, system: {system} }),
    (p)-[:version]->(v1 :version),
    (p)-[:version]->(v2 :version)
WHERE exists((v1)-[:upgrade]->(:upgrade)-[:upgrade]->(v2))
RETURN size(collect(p)) > 0 AS has_upgrade
`;
const BREAKING_UPGRADES                    = `
MATCH 
    (p :package { name: {name}, system: {system} }),
    (p)-[:version]->(v1 :version),
    (p)-[:version]->(v2 :version),
    (v1)<-[:upgrade]-(u :upgrade)<-[:upgrade]-(v2)
WHERE u.percent_broken > 0
WITH *
ORDER BY u.percent_broken DESC
RETURN v1, collect(nodes(((u)<--(v2))[0])) AS upgrade
`;


/**
 * Create a generator function that spreads mutations across multiple input environments round robin.
 *
 * @param   {String}            name   Search strategy name.
 * @param   {GeneratorFunction} search Mutation search strategy that accepts an environment and max number to generate.
 * @returns {GeneratorFunction}        Generator function that spreads `search` across multiple environments.
 */
function spreadFirstN(name, search) {

    /**
     * Generate the first n mutations of the input environments using search strategy `search`. Mutations will be
     * applied evenly over the input environments round-robin.
     *
     * @param   {Array.<Environment>}                environments List of environments to mutate.
     * @param   {Number}                             [n=500]      Number of mutations to generate.
     * @returns {AsyncIterableIterator<Environment>}              Environment specification.
     */
    return async function*(environments, n=FIRST_N){

        // Split n over the number of base environments, round up if not evenly divisible..
        n = _.ceil(n / environments.length);
        let total = n * environments.length;

        logger.info(`Starting ${name}. Generating at most ${total} mutations (${n} per environment, ${environments.length} environment(s)).`);

        // Create generators and pair with undefined previous validation result
        let generators = _.map(environments, _.partial(search, _, n));
        generators = _.zip(generators, Array(generators.length));

        // Metadata about why environments were pruned
        let metadata = [];

        // Invoke generators round robin
        while (generators.length) {

            // Get first generator and its last validation result
            let [generator, lastValidation] = generators.shift();

            // Get next, passing last validation to generator
            let control = await generator.next(lastValidation);

            // If not finished, yield environment and place the generator back on the queue.
            // This implicitly prunes generators once they are finished.
            if (!control.done) {
                let validation = yield control.value;
                generators.push([generator, validation]);
            }
            else if (control.value) {
                metadata.push(control.value);
            }

        }

        // Return metadata
        return metadata;

    };

}


/**
 * Generate environment specifications by doing a level-order traversal of the first n levels of the mutation tree.
 *
 * @param   {Array.<Environment>}                environments List of environments to mutate.
 * @param   {Number}                             levels       Number of levels to explore, including the root level.
 * @returns {AsyncIterableIterator<Environment>}              Environment specification.
 */
module.exports.naiveLevelOrderTraversal = async function*(environments, levels=MAX_LEVEL){

    // Start at root level.
    let level = 0;

    // Continue yielding environments while there are any left to yield and we
    // have not exceeded the allowed number of levels.
    while (environments.length && level < levels) {

        // Log
        logger.info(`Starting mutation generation at level: ${level}`);

        // For each environment, yield it for evaluation, then generate its mutations if not on the last level.
        let nextLevelEnvironments = [];
        for (let environment of environments) {

            // Yield environment for evaluation.
            yield environment;

            // Generate mutations when not on the last level
            if (level < (levels - 1)) {

                // Create a new environment for each combination of version mutator and dependency
                let mutatedEnvironments = _.compact(_.flattenDeep(await Bluebird.map(semver.versionMutators, async (versionMutator) => {
                    return await Bluebird.map(environment.dependencies, async (dependency, index) => {

                        // Let the mutator operate on the dependency
                        let mutationResult = await versionMutator.apply(dependency);
                        let mutantDependency = mutationResult.mutant;
                        let mutation = mutationResult.mutation;

                        // If a new dependency was formed, mutate the environment and return it.
                        if (mutantDependency) {

                            // Deep clone the environment to avoid side effects
                            let mutantEnv = _.cloneDeep(environment);
                            mutantEnv.metadata.mutations.push(mutation);
                            mutantEnv.dependencies[index] = mutantDependency;
                            return mutantEnv;

                        }
                        else {

                            return null;

                        }

                    });
                })));

                nextLevelEnvironments = _.concat(nextLevelEnvironments, mutatedEnvironments);

            }

        }

        // Set environments for the next level and increment.
        environments = nextLevelEnvironments;
        level++;

    }

};

/**
 * Perform iterative-deepening depth-first search for a single environment, and yield the first n results.
 *
 * Helper function for {@see firstNIDDFS}.
 *
 * @param   {Environment}                        environment Environment to mutate.
 * @param   {Number}                             n           Number of mutations to generate.
 * @returns {AsyncIterableIterator<Environment>}             Environment specification.
 */
async function*IDDFS(environment, n) {

    // Yield the original environment without any mutations
    logger.info('Yielding initial environment');
    yield environment;

    // Start DFS at a depth of one mutation, since the initial environment has already been yielded.
    let currentDepth = 0;
    let depth = 1;

    // Track the number of total yielded environments and the number at the current depth.
    let totalCount = 0;
    let depthCount = 0;

    // Index of the current dependency
    let index = 0;

    // Index of the current mutator
    let mutatorIndex = 0;

    // Reference environment dependencies and mutations
    let dependencies = environment.dependencies;
    let mutations = environment.metadata.mutations;

    logger.info('Starting iterative-deepening depth-first search');

    // Continue DFS while at most n total environments have been yielded.
    while (totalCount < n) {

        // Pick the next dependency from the dependencies list based on the current index.
        // This will be undefined if index falls off the end of the list.
        logger.info(`Getting dependency at index: ${index}`);
        let dependency = dependencies[index];

        // If there is no next dependency, then all possible mutations have been applied at the current level.
        // If there are mutations that have been made, then backtrack by undoing the last mutation and selecting
        // either the next mutator or the next dependency, if all mutators have been applied. If there are no
        // mutations, then search must be on the root level. Exit if no environments were generated at the previous
        // level, since no new environments can be generated at a lower depth. Otherwise increment depth and reset
        // the depth count and dependency index.
        if (!dependency) {

            // Backtracking case.
            if (currentDepth > 0) {

                logger.info('No dependency found, backtracking');

                // Pop last mutation and get the index of the dependency
                currentDepth--;
                let mutation = mutations.pop();
                mutatorIndex = mutation.iddfs.mutatorIndex;
                index = mutation.iddfs.index;

                // Look up the mutator used to generate the mutation and undo
                dependencies[index] = await semver.lookup[mutation.type].undo(dependencies[index], mutation);

                // If there is another mutator in the list of mutators, increment mutatorIndex and leave index
                // unchanged. This will select the same dependency on the next iteration and attempt to mutate it
                // using the next mutator. Otherwise, reset the mutator index and move on to the next dependency
                // by incrementing index.
                if (semver.versionMutators[mutatorIndex + 1]) {
                    mutatorIndex++;
                }
                else {
                    mutatorIndex = 0;
                    index++;
                }

            }
            else {

                // If no environments have been yielded at the current depth, break IDDFS loop and continue
                // with the next environment.
                if (!depthCount) {

                    logger.info(`Exhausted mutation options at depth ${depth} without generating a new environment`);
                    break;

                }
                // Increment depth and reset counters
                else {

                    logger.info('Incrementing depth');
                    currentDepth = 0;
                    depth++;
                    depthCount = 0;
                    mutatorIndex = 0;
                    index = 0;

                }

            }

        }
        // The next dependency was found.
        else {

            // Apply mutation to the dependency.
            let mutator = semver.versionMutators[mutatorIndex];
            logger.info(`Mutating dependency using mutator: ${mutator.name}`);
            let mutationResult = await mutator.apply(dependency);

            // If the mutation was successful, continue with the search.
            if (mutationResult) {

                // Unpack
                let mutant = mutationResult.mutant;
                let mutation = mutationResult.mutation;

                // Save the index so the next dependency can be selected if/when the mutation is undone.
                mutation.iddfs = { index, mutatorIndex };

                // Add the mutation to the environment
                currentDepth++;
                dependencies[index] = mutant;
                mutations.push(mutation);

                // If the number of mutations is equal to the depth (at a leaf in the tree), then increment the counts
                // and yield the environment. Then backtrack and prepare for the next mutation. If not, do nothing.
                // This leaves the index the same so another mutation can be applied to the same dependency if
                // necessary.
                if (currentDepth === depth) {

                    logger.info('Yielding mutated environment');

                    totalCount++;
                    depthCount++;
                    yield environment;

                    currentDepth--;
                    mutations.pop();
                    dependencies[index] = dependency;

                    // If there is another mutator in the list of mutators, increment mutatorIndex and leave index
                    // unchanged. This will select the same dependency on the next iteration and attempt to mutate it
                    // using the next mutator. Otherwise, reset the mutator index and move on to the next dependency
                    // by incrementing index.
                    if (semver.versionMutators[mutatorIndex + 1]) {
                        mutatorIndex++;
                    }
                    else {
                        mutatorIndex = 0;
                        index++;
                    }

                }

            }
            // If no mutation result is returned, the dependency could not be mutated. Move on to the next.
            else {

                // If there is another mutator in the list of mutators, increment mutatorIndex and leave index
                // unchanged. This will select the same dependency on the next iteration and attempt to mutate it
                // using the next mutator. Otherwise, reset the mutator index and move on to the next dependency
                // by incrementing index.
                if (semver.versionMutators[mutatorIndex + 1]) {

                    logger.info('No mutation found, moving to next mutator.');
                    mutatorIndex++;

                }
                else {

                    logger.info('No mutation found, moving to next dependency.');
                    mutatorIndex = 0;
                    index++;

                }

            }

        }

    }

}


/**
 * Generate the first n mutations of the input using iterative-deepening depth-first search. Mutations will be applied
 * evenly over the input environments round-robin.
 *
 * This will only yield environments the first time they are generated. Any validation result passed as an argument to
 * `next()` will be ignored. This search strategy has much lower memory costs compared to the naive level-order
 * traversal for the trade off of recomputing mutations.
 *
 * @param   {Array.<Environment>}                environments List of environments to mutate.
 * @param   {Number}                             [n=500]      Number of mutations to generate.
 * @returns {AsyncIterableIterator<Environment>}              Environment specification.
 */
module.exports.firstNIDDFS = spreadFirstN('Iterative-Deepening Depth-First Search', IDDFS);


/**
 * Given a dependency, generate a list of mutations to be applied in order based on the dependency's version upgrade
 * matrix. If no breaking breaking upgrades exist, the result will be an empty array. If the dependency does not have
 * an upgrade matrix, return null.
 *
 * @param   {Dependency}                           dependency Dependency for which mutations should be generated.
 * @returns {Promise<Array.<MutationResult>|null>}            List of mutations, or null if no version matrix exists.
 */
async function versionMatrixMutations(dependency) {

    // Open a Neo4j Driver
    logger.info('Searching for upgrade data.');
    return Bluebird.using(neo4j.getDriver(), async (driver) => {

        // Get dependency system strategy
        let strategy = factory.getSystemStrategy(dependency.system);

        // Query to see if any upgrade results are available in the database
        let hasUpgrade = await driver.session().run(HAS_UPGRADES, dependency);
        if (hasUpgrade.records[0].get('has_upgrade')) {

            logger.info('Dependency has upgrade data, using version matrix');

            // If the dependency has any version upgrade results, query for all (v1)->(u)->(v2) sets where
            // v1 <= current and the percent broken is nonzero. This graph may not be connected. Order connected
            // components by maximum version in each component. For each connected component, try all versions in the
            // following manner: Take the natural topological ordering imposed by sorting by descending version number.
            // For each node, explore the node if it has not been explored before (except the node equal to the current
            // version, which has already failed validation), and record that it has been explored. Then sort its
            // unexplored neighbors by decreasing upgrade broken percentage, and explore them too.

            // Search for all breaking upgrades.
            let results = await driver.session().run(BREAKING_UPGRADES, dependency);
            if (results.records.length) {

                logger.info('Breaking upgrades found in version matrix');
                let mutations = [];

                // Get records
                let records = results.records;

                // Convert to a lookup dictionary
                let lookup = {};
                _.each(records, r => {

                    let key = r.get('v1').properties.version;
                    lookup[key] = _.map(r.get('upgrade'), (u) => u[1].properties.version);

                });

                // Sort keys in descending order using the current version as a cutoff
                let sortedVersions = await strategy.sortPackageVersions(_.keys(lookup), false, dependency.version);

                // Push mutations in a correct ordering
                let encountered = new Set();
                let mutation;
                let mutant = dependency;
                _.each(sortedVersions, (to_version) => {

                    // If the new version is not equal to the current version and it has not previously been
                    // explored, set it as explored now.
                    if (to_version !== dependency.version && !encountered.has(to_version)) {

                        encountered.add(to_version);

                    }

                    // Visit immediate neighbors
                    _.each(lookup[to_version], (from_version) => {

                        // Mutate
                        mutant = _.clone(mutant);
                        mutation = {
                            type: 'version_matrix_from_version',
                            changes: {
                                package: dependency.name,
                                from: mutant.version,
                                to: from_version
                            }
                        };
                        mutant.version = from_version;
                        mutations.push({ mutant, mutation });

                        // Add to encountered set
                        encountered.add(from_version);

                    });

                });

                return mutations;

            }
            else {

                logger.info('No breaking upgrades found in version matrix');
                return [];

            }

        }
        else {

            logger.info('Dependency has no upgrade data');
            return null;

        }

    });

}


/**
 * Perform iterative-deepening depth-first search through only the versions of a single dependency.
 *
 * @param   {Environment}                           environment Environment to mutate.
 * @param   {Number}                                index       Index of the dependency in the environment.
 * @returns {AsyncIterableIterator<Environment>}                Mutated environment.
 */
async function*dependencyIDDFS(environment, index) {

    logger.info('Starting dependency based IDDFS');

    // Get dependencies and dependency to mutate
    let dependencies = environment.dependencies;

    // Start with a depth of 1 to mutate at least once before yielding
    let currentDepth = 0;
    let depth = 1;

    // Number of mutations yielded at current depth
    let count = 0;

    // Index of the current mutator
    let mutatorIndex = 0;

    // History of mutations made so they can be undone
    let mutations = environment.metadata.mutations;

    // Continue to try and generate mutations
    while (true) {

        let mutator = semver.versionMutators[mutatorIndex];

        if (!mutator) {

            // Backtracking case.
            if (currentDepth > 0) {

                logger.info('No dependency found, backtracking');

                // Pop last mutation and get the mutator index
                currentDepth--;
                let mutation = mutations.pop();
                mutatorIndex = mutation.iddfs.mutatorIndex;

                // Look up the mutator used to generate the mutation and undo
                dependencies[index] = await semver.lookup[mutation.type].undo(dependencies[index], mutation);

                mutatorIndex++;

            }
            else {

                // If no environments have been yielded at the current depth, break IDDFS loop and continue
                // with the next environment.
                if (!count) {

                    logger.info(`Exhausted mutation options at depth ${depth} without generating a new environment`);
                    break;

                }
                // Increment depth and reset counters
                else {

                    logger.info('Incrementing depth');
                    currentDepth = 0;
                    depth++;
                    count = 0;
                    mutatorIndex = 0;

                }

            }

        }
        else {

            // Apply mutation to the dependency.
            logger.info(`Mutating dependency using mutator: ${mutator.name}`);
            let mutationResult = await mutator.apply(dependencies[index]);

            // If the mutation was successful, continue with the search.
            if (mutationResult) {

                // Unpack
                let mutant = mutationResult.mutant;
                let mutation = mutationResult.mutation;

                // Save the index so the next mutator can be selected if/when the mutation is undone.
                mutation.iddfs = { mutatorIndex };

                // Add the mutation to the environment
                currentDepth++;
                let old = dependencies[index];
                dependencies[index] = mutant;
                mutations.push(mutation);

                // If the number of mutations is equal to the depth (at a leaf in the tree), then increment the counts
                // and yield the environment. Then backtrack and prepare for the next mutation. If not, do nothing.
                if (currentDepth === depth) {

                    logger.info('Yielding mutated environment');

                    count++;
                    yield environment;

                    currentDepth--;
                    mutations.pop();
                    dependencies[index] = old;
                    mutatorIndex++;

                }

            }
            else {

                mutatorIndex++;

            }

        }

    }

}


/**
 * Create a hash suitable for setting/getting from a map. Uses the dependency name and system as a unique identifier.
 *
 * @param   {Dependency} dependency Dependency to hash.
 * @returns {string}                Unique string for dependency.
 */
function dependencyHash(dependency) { return `(${dependency.name}, ${dependency.system})`; }


/**
 * Perform iterative-deepening depth-first search over an environment's dependencies, taking available version matrix
 * information into account. If there is no version matrix information, this is roughly equivalent to {@see IDDFS}.
 * When version matrix information does exist, the next version will be selected from the matrix instead of using one
 * of the other version mutators.
 *
 * @param   {Environment}                        environment Input environment.
 * @returns {AsyncIterableIterator<Environment>}             Mutated environment.
 */
async function*versionMatrixIDDFS(environment) {

    logger.info('Starting version matrix IDDFS.');

    // Initialize metadata object for use during mutation
    let metadata = new Map();

    // Reference to environment objects
    let dependencies = environment.dependencies;
    let mutations = environment.metadata.mutations;

    // Initialize current depth to zero (no mutations) and set the number of generated environments at the current
    // depth to zero.
    let depth = 0;
    let count = 0;

    // Increment the depth (number of mutations allowed) and reset the count, then try to generate new environments.
    // Continue to do this while at least one new environment was generated at the previous depth.
    do {

        // Increment depth
        depth++;

        // Reset count
        count = 0;

        // Start current depth at zero (no mutations)
        let currentDepth = 0;

        // Index of the dependency under consideration
        let index = 0;

        // Index of the current mutator. Ignored if the dependency has a version matrix.
        let mutatorIndex = 0;

        logger.info(`Starting DFS with depth: ${depth}`);

        // We know that all mutations for depth have been attempted when the current depth is zero and the index for
        // the dependency under consideration is past the end of the dependencies list. Continue to generate mutations
        // until all of them have been attempted.
        while (!(currentDepth === 0 && index >= dependencies.length)) {

            // If the dependency index is past the the end of the dependencies list, then there are no more dependencies
            // to be mutated at the current depth. Backtrack.
            if (index >= dependencies.length) {

                logger.info('Backtracking');

                // Pop the last mutation
                currentDepth--;
                let mutation = mutations.pop();

                // Get the index of the modified dependency, and the mutator that was used
                index = mutation.iddfs.index;
                mutatorIndex = mutation.iddfs.mutatorIndex;

                // Undo mutation.
                if (mutation.type === TYPE_VERSION_MATRIX_TO || mutation.type === TYPE_VERSION_MATRIX_FROM) {

                    logger.info('Undoing version matrix mutation and moving to next dependency');

                    // Reset version and move on to the next dependency
                    let dependency = dependencies[index];
                    let hash = dependencyHash(dependency);
                    let mutant = _.clone(dependency);
                    metadata.get(hash).versionMatrixMutations.splice(0, 0, { mutation, mutant });
                    dependency.version = mutation.changes.from;
                    index++;

                }
                else {

                    logger.info('Undoing semver mutation');

                    // Look up the mutator used to generate the mutation and undo
                    dependencies[index] = await semver.lookup[mutation.type].undo(dependencies[index], mutation);

                    // If there is another mutator in the list of mutators, increment mutatorIndex and leave index
                    // unchanged. This will select the same dependency on the next iteration and attempt to mutate it
                    // using the next mutator. Otherwise, reset the mutator index and move on to the next dependency
                    // by incrementing index.
                    if (semver.versionMutators[mutatorIndex + 1]) {
                        logger.info('Moving to the next mutator');
                        mutatorIndex++;
                    }
                    else {
                        logger.info('Moving to the next dependency');
                        mutatorIndex = 0;
                        index++;
                    }

                }

            }
            // Otherwise, pick the dependency at index and mutate it.
            else {

                // Reference the current dependency under consideration.
                let dependency = dependencies[index];
                let hash = dependencyHash(dependency);
                logger.info(`Mutating ${JSON.stringify(dependency, null, 4)}`);

                // Initialize version matrix metadata for the dependency if it hasn't already been explored.
                if (!metadata.has(hash)) {

                    let mutations = await versionMatrixMutations(dependency);
                    metadata.set(hash, {
                        hasVersionMatrix: !!mutations,
                        versionMatrixMutations: mutations
                    });

                }

                // If the dependency has a version matrix, use that to determine the next mutation. Otherwise use the
                // currently selected mutator.
                if (metadata.get(hash).hasVersionMatrix) {

                    logger.info('Dependency has version matrix');

                    // Get the next mutation
                    let mutationResult = metadata.get(hash).versionMatrixMutations.shift();

                    // If there is no mutation result, move on to the next dependency. Otherwise apply the mutation.
                    if (!mutationResult) {

                        logger.info('No more version matrix mutations, moving to the next dependency');
                        index++;

                    }
                    else {

                        // Unpack
                        let mutant = mutationResult.mutant;
                        let mutation = mutationResult.mutation;

                        logger.info(`Applying mutation ${JSON.stringify(mutation, null, 4)}`);

                        // Preserve dependency index for backtracking
                        mutation.iddfs = { index, mutatorIndex };

                        // Apply mutation
                        currentDepth++;
                        mutations.push(mutation);
                        dependencies[index] = mutant;

                        // If at depth, yield, pop, and move to next.
                        if (currentDepth === depth) {

                            // Yield mutated environment
                            logger.info('Yielding mutated environment');
                            count++;
                            yield environment;

                            // Reset dependency
                            currentDepth--;
                            mutations.pop();
                            dependencies[index] = dependency;

                            // Replace the mutation
                            metadata.get(hash).versionMatrixMutations.splice(0, 0, { mutant, mutation });

                            // Move on to the next
                            index++;

                        }

                    }

                }
                else {

                    // Apply mutation to the dependency.
                    let mutator = semver.versionMutators[mutatorIndex];
                    logger.info(`Mutating dependency using mutator: ${mutator.name}`);
                    let mutationResult = await mutator.apply(dependency);

                    // If the mutation was successful, continue with the search.
                    if (mutationResult) {

                        // Unpack
                        let mutant = mutationResult.mutant;
                        let mutation = mutationResult.mutation;

                        logger.info(`Applying mutation ${JSON.stringify(mutation, null, 4)}`);

                        // Save the index so the next dependency can be selected if/when the mutation is undone.
                        mutation.iddfs = { index, mutatorIndex };

                        // Add the mutation to the environment
                        currentDepth++;
                        dependencies[index] = mutant;
                        mutations.push(mutation);

                        // If the number of mutations is equal to the depth (at a leaf in the tree), then increment the
                        // counts and yield the environment. Then backtrack and prepare for the next mutation. If not,
                        // do nothing. This leaves the index the same so another mutation can be applied to the same
                        // dependency if necessary.
                        if (currentDepth === depth) {

                            logger.info('Yielding mutated environment');
                            count++;
                            yield environment;

                            currentDepth--;
                            mutations.pop();
                            dependencies[index] = dependency;

                            // If there is another mutator in the list of mutators, increment mutatorIndex and leave index
                            // unchanged. This will select the same dependency on the next iteration and attempt to mutate it
                            // using the next mutator. Otherwise, reset the mutator index and move on to the next dependency
                            // by incrementing index.
                            if (semver.versionMutators[mutatorIndex + 1]) {
                                logger.info('Moving to next mutator.');
                                mutatorIndex++;
                            }
                            else {
                                logger.info('Moving to next dependency.');
                                mutatorIndex = 0;
                                index++;
                            }

                        }

                    }
                    // If no mutation result is returned, the dependency could not be mutated. Move on to the next.
                    else {

                        // If there is another mutator in the list of mutators, increment mutatorIndex and leave index
                        // unchanged. This will select the same dependency on the next iteration and attempt to mutate
                        // it using the next mutator. Otherwise, reset the mutator index and move on to the next
                        // dependency by incrementing index.
                        if (semver.versionMutators[mutatorIndex + 1]) {

                            logger.info('No mutation found, moving to next mutator.');
                            mutatorIndex++;

                        }
                        else {

                            logger.info('No mutation found, moving to next dependency.');
                            mutatorIndex = 0;
                            index++;

                        }

                    }

                }

            }

        }

    } while(count > 0);

}


/**
 * Explore at most n nodes of the mutation tree for an environment by incorporating feedback from validation execution
 * failures. Exploration focuses on solving the error encountered by the failed execution, and chooses mutations likely
 * to affect the error. It also implements pruning to stop exploration of branches unlikely to lead to a successful
 * environment.
 *
 * @param   {Environment}                        environment Input environment.
 * @param   {Number}                             n           Maximum number of mutations to generate.
 * @returns {AsyncIterableIterator<Environment>}             Environment specification.
 */
async function*feedbackDirectedDFS(environment, n) {

    // Reference environment dependencies and mutations
    let dependencies = environment.dependencies;
    let mutations = environment.metadata.mutations;

    // Initialize fixed validations metadata
    let fixedValidations = environment.metadata.fixedValidations = [];

    // Initialize potential return value for when generator stops
    let returnValue = { id: environment.id, fixedValidations: fixedValidations, mutations: mutations };

    // Yield the initial environment and get the validation result as the first checkpoint
    logger.info('Yielding initial environment');
    let feedbackMetadata = new Map();
    let checkpoint = yield environment;

    // Set the number of yields performed while working on the checkpoint
    checkpoint.validations = 0;

    // Preserve the current validation checkpoint being used to direct feedback
    returnValue.checkpoint = checkpoint;

    // If the validation timed out, it didn't succeed, but there's no error to parse. We don't reasonably have
    // enough information to determine if this means that we fixed the root problem, or if/what mutation should
    // be made next. Stop iteration.
    if (checkpoint.status_code === TIMEOUT) {

        logger.info('Execution timed out, no mutations to be made');
        returnValue.code = TIMEOUT;
        returnValue.message = 'Validation timed out. No known new mutations to try.';
        return returnValue;

    }
    // If the validation has no execution information, or it produced an unknown exception, an error must have occurred
    // at the level of the validation script and there is no information to extract about the status of the execution.
    // This potentially indicates a bug in the validation script.
    else if (!checkpoint.execution || checkpoint.execution.status_code === UNKNOWN_EXCEPTION) {

        logger.info('Execution produced an unknown exception');
        returnValue.code = UNKNOWN_EXCEPTION;
        returnValue.message = 'Validation produced an unknown exception, unsure how to handle.';
        return returnValue;

    }

    // Get language strategy
    let language = factory.getLanguageStrategy(environment.metadata.language);

    // Stop if not potentially repairable
    if (!language.isRepairableVersionError(environment, checkpoint)) {

        logger.info('Execution exception is not a repairable version error');
        returnValue.code = NOT_REPAIRABLE;
        returnValue.message = `Validation exception '${checkpoint.execution.exception_name}' is not repairable.`;
        return returnValue;

    }

    // Find the dependency responsible for producing the checkpoint validation exception.
    let index = language.dependencyProducingException(environment, checkpoint);

    // Reference to IDDFS generator
    let iddfs = null;

    // Continue to yield mutations while we have not exceeded count.
    let count = 0;
    while (count < n) {

        // If a single dependency was found, concentrate on that. Otherwise, fall back to exploration rooted at the
        // current environment.
        if (!_.isNull(index)) {

            logger.info('Found a single dependency');

            // Get the dependency
            let dependency = dependencies[index];
            let hash = dependencyHash(dependency);

            // Get dependency metadata
            if (!feedbackMetadata.has(hash)) feedbackMetadata.set(hash, {});
            let metadata = feedbackMetadata.get(hash);

            // If the dependency has not previously been checked for having a version matrix, check now and get mutations.
            if (_.isUndefined(metadata.hasVersionMatrix)) {

                // Initialize pending mutations from version matrix
                metadata.versionMatrixMutations = await versionMatrixMutations(dependency);
                metadata.hasVersionMatrix = !!metadata.versionMatrixMutations;

            }

            // If there is a version matrix for the dependency, mutate based off of the pending mutations.
            // Otherwise, mutate by picking the next available version from all versions.
            if (metadata.hasVersionMatrix) {

                logger.info('Dependency has version matrix');

                // Get next pending mutation
                let mutationResult = metadata.versionMatrixMutations.shift();

                // Exit if no mutation could be made
                if (!mutationResult) {
                    logger.info('No more mutations can be made');
                    returnValue.code = EXHAUSTED_MATRIX_VERSIONS;
                    returnValue.message = 'Exhausted all version matrix mutations';
                    return returnValue;
                }

                // Unpack
                let mutant = mutationResult.mutant;
                let mutation = mutationResult.mutation;

                logger.info(`Applying mutation: ${JSON.stringify(mutation, null, 4)}`);

                // Mutate the environment and push the mutation record
                dependencies[index] = mutant;
                mutations.push(mutation);

            }
            else {

                logger.info('Dependency does not have a version matrix');

                // Create generator for iddfs exploration of the current dependency in the current environment if
                // exploration is not already in progress.
                if (!iddfs) {
                    logger.info('Creating Dependency IDDFS generator for current environment');
                    iddfs = dependencyIDDFS(environment, index);
                }

                // Get next environment from exploration
                let control = await iddfs.next();
                if (control.done) {
                    returnValue.code = EXHAUSTED_SINGLE_DEPENDENCY_VERSIONS;
                    returnValue.message = 'Exhausted all versions of a single dependency';
                    return returnValue;
                }
                environment = control.value;

            }

        }
        else {

            logger.info('No dependency selected');

            // Create generator for version matrix iddfs exploration at the current environment if exploration is not
            // already in progress
            if (!iddfs) {
                logger.info('Creating version matrix IDDFS generator for current environment.');
                iddfs = versionMatrixIDDFS(environment);
            }

            // Get next environment from exploration
            let control = await iddfs.next();
            if (control.done) {
                returnValue.code = EXHAUSTED_ALL_DEPENDENCY_VERSIONS;
                returnValue.message = 'Exhausted all versions of all dependencies';
                return returnValue;
            }
            environment = control.value;

        }

        // Guess that the changes we've made will fix the validation exception encountered by checkpoint and save it as
        // a fixed validation. It will be removed later if it is not fixed by validation. This allows the last issue
        // fixed to be present in the environment metadata when it is yielded back to the caller. If it is not placed
        // preemptively, then it may never be placed in metadata, since the caller may stop calling the generator.
        fixedValidations.push(checkpoint);

        // Increment count, then yield environment and get validation result.
        logger.info('Yielding mutated environment');
        count++;
        checkpoint.validations++;
        let validation = yield environment;

        // Remove checkpoint from the list of fixed validations. It may have actually been fixed, in which case it will
        // be placed back on the list of fixed validations, but the in most cases removing it is the correct operation
        // so we do so by default.
        fixedValidations.pop();

        // Inspect the validation to determine if mutation has introduced a different execution result that occurs
        // after the the exception encountered during the checkpoint (the checkpoint exception comes first). If it has,
        // set the current validation as the new checkpoint. We only need to check object reference equality for the
        // result of firstExecutionException, not deep equality. This assumes that we've fixed the error and are
        // advancing to work on the next one.
        //
        // If the exceptions are equivalent, or the new one occurs first, do nothing. This assumes that we either did
        // nothing to affect the exception or introduced a new one. In both cases, the next iteration of the loop will
        // continue by picking the next mutation for the checkpoint validation.
        if (!_.isEqual(checkpoint, validation)) {

            // If the validation timed out, it didn't succeed, but there's no error to parse. We don't reasonably have
            // enough information to determine if this means that we fixed the root problem, or if/what mutation should
            // be made next. Stop iteration.
            if (validation.status_code === TIMEOUT) {

                logger.info('Execution timed out, no mutations to be made');
                returnValue.code = TIMEOUT;
                returnValue.message = 'Validation timed out. No known new mutations to try.';
                return returnValue;

            }
            // If the validation has no execution information, or it produced an unknown exception, an error must have occurred
            // at the level of the validation script and there is no information to extract about the status of the execution.
            // This potentially indicates a bug in the validation script.
            else if (!validation.execution || validation.execution.status_code === UNKNOWN_EXCEPTION) {

                logger.info('Execution produced an unknown exception');
                returnValue.code = UNKNOWN_EXCEPTION;
                returnValue.message = 'Validation produced an unknown exception, unsure how to handle.';
                return returnValue;

            }
            else {

                // At this point, we are assuming that checkpoint and validation represent different errors.
                logger.info('Validation produced a new exception');
                let first = language.firstExecutionException(checkpoint, validation);

                // If the exception in checkpoint occurs before the other validation, we assume that we have fixed the
                // problem causing the checkpoint execution failure, revealing the new validation execution failure.
                if (checkpoint === first) {

                    logger.info('Exception occurs later, updating checkpoint');

                    // Keep the old checkpoint on the list of fixed validations. This is the only case in which we
                    // consider the validation fixed and wish to preserve it.
                    fixedValidations.push(checkpoint);

                    // Update checkpoint.
                    checkpoint = validation;
                    checkpoint.validations = 0;

                    // Preserve the current validation checkpoint being used to direct feedback
                    returnValue.checkpoint = checkpoint;

                    // If the new error is not repairable, exit.
                    if (!language.isRepairableVersionError(environment, checkpoint)) {

                        logger.info('Execution exception is not a repairable version error');
                        returnValue.code = NOT_REPAIRABLE;
                        returnValue.message = `Validation exception '${checkpoint.execution.exception_name}' is not repairable.`;
                        return returnValue;

                    }

                    // Get index and reset control variables
                    index = language.dependencyProducingException(environment, checkpoint);
                    feedbackMetadata = new Map();
                    iddfs = null;

                }
                else {

                    if (validation === first) {
                        logger.info('Exception occurs earlier.');
                    }
                    else {
                        logger.info('Exception occurs at the same location.');
                    }

                }

            }

        }
        else {

            logger.info('Validation did not produce a new exception.');

        }

    }

    // TODO return value if count > n

}


/**
 * Generate environment specifications by incorporating feedback to chose the next mutation and when to prune branches.
 *
 * @param   {Array.<Environment>}                environments List of environments to mutate.
 * @returns {AsyncIterableIterator<Environment>}              Environment specification.
 */
module.exports.feedbackDirectedDFS = spreadFirstN('Feedback Directed Search', feedbackDirectedDFS);


// Create lookup table
module.exports.lookup = {
    'level-order': module.exports.naiveLevelOrderTraversal,
    'id-dfs': module.exports.firstNIDDFS,
    'feedback-directed': module.exports.feedbackDirectedDFS,
};

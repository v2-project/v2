/**
 * V2 core.
 *
 * @module v2
 */


// Core/NPM Modules
const _                      = require('lodash');
const Bluebird               = require('bluebird');
const consul                 = require('consul');
const fs                     = require('fs');
const generator              = require('dockerfile-generator');
const path                   = require('path');
const url                    = require('url');


// Local Modules
const errors                 = require('./src/errors');
const factory                = require('./src/strategy-factory');
const logger                 = require('./src/logger');
const tools                  = require('./src/build-tools');
const metadata               = require('./src/metadata');
const mutation               = require('./src/mutation');
const neo4j                  = require('./src/neo4j');


// Constants
const SUCCESS                = 'Success';
const ERRORS_PATH            = 'dependencies.install_errors';
const ENCODING               = 'utf-8';
const TRUNCATE_BYTES         = 1024;
const RESOURCE_LOOKUP        = `
CALL apoc.cypher.run(
    'MATCH (resource :resource)<-[:resource]-(version :version)<-[:version]-(package :package {system: {system}}) ' +
    'WHERE toLower({name}) STARTS WITH toLower(resource.name) ' +
    'RETURN package, version ' +
    'UNION ALL ' +
    'MATCH (package :package {name: {name}, system: {system}})-[:version]->(version :version) ' +
    'RETURN package, version', 
    {name: $name, system: $system}
) YIELD value
WITH value.package AS package, value.version AS version
WITH DISTINCT package AS package, collect(DISTINCT version) AS versions, max(version.version) AS max_version
RETURN package, head([v IN versions WHERE v.version = max_version]) AS version
`;
const RESOURCE_DEP_LOOKUP    = `
MATCH (n :package {name: {name}, system: {system}})-[:version]->(:version)-[:resource_dependency]->(:resource)<-[:resource]-(version :version)<-[:version]-(dependency:package)
WITH DISTINCT dependency AS dependency, collect(DISTINCT version) AS versions, max(version.version) AS max_version
RETURN dependency, head([v IN versions WHERE v.version = max_version]) AS version
`;
const ASSOCIATION_DEP_LOOKUP = `
MATCH (n :package {name: {name}, system: {system}})-[:association]->(e :association)-[:association]->(dependency :package)
WITH dependency
OPTIONAL MATCH (dependency)-[:version]->(version :version)
WITH DISTINCT dependency AS dependency, collect(DISTINCT version) AS versions, max(version.version) AS max_version
RETURN dependency, head([v IN versions WHERE v.version = max_version]) AS version
`;

// Example of filtering associations by confidence and lift values using Cypher
// const ASSOCIATION_DEP_LOOKUP = `
// MATCH (n :package {name: {name}, system: {system}})-[:association]->(e :association)-[:association]->(d :package)
// WITH n, collect((e)-->(d)) AS associations_collection, avg(e.lift) AS avg_lift, stDev(e.lift) AS lift_std
// UNWIND associations_collection AS associations
// UNWIND associations AS association
// WITH n, avg_lift, lift_std, nodes(association) AS association_nodes
// WITH n, avg_lift, lift_std, association_nodes[0] AS e, association_nodes[1] AS d
// WHERE e.confidence >= 0.8 AND e.lift >= avg_lift + (3 * lift_std)
// WITH n, head(collect(e)) AS e, d
// RETURN DISTINCT d
// `;


/**
 * V2. Automatically dockerize applications.
 */
class V2 {

    /**
     * Construct a new V2 instance.
     *
     * @param {Object} [options]                 Options object.
     * @param {String} [options.consul]          Address of a Consul cluster. If provided, results will be stored in the key/value store.
     * @param {String} [options.consulKeyPrefix] Optional key to log metadata under if consul information is provided.
     */
    constructor(options = {}) {

        // Create consul client if a connection option is provided.
        if (options.consul) {

            // Prepend slashes if scheme is missing and get url
            if (!options.consul.match(/^(https?:)?\/\//)) {
                options.consul = `//${options.consul}`;
            }
            let consulInfo = url.parse(options.consul, false, true);

            // Construct consul client
            this.consul = consul(_.omitBy({
                host: consulInfo.hostname,
                port: consulInfo.port || '8500',
                secure: consulInfo.protocol === 'https:',
                promisify: Bluebird.fromCallback
            }, _.isUndefined));

            // Get key prefix
            this.consulKeyPrefix = _.trim(options.consulKeyPrefix || '', '/');

        }

        // Register signal handler
        let codes = { SIGINT: 2, SIGTERM: 15 };
        let handler = async (signal) => {

            // Get signal code
            let code = 128 + codes[signal];

            // Create and log error
            let e = new errors.InferenceTerminatedError(signal, code, `Inference terminated by ${signal}`);
            await this.logConsul('inference', { error: e });
            logger.error(e);

            // Exit
            process.exit(code);

        };
        process.on('SIGTERM', handler);
        process.on('SIGINT', handler);

    }

    /**
     * Log a key/value pair to Consul if a client is available.
     *
     * @param   {String}     key   Consul key.
     * @param   {Object}     value JSON serializable object.
     * @returns {Promise<*>}       API response.
     */
    async logConsul(key, value) {

        // Do nothing if consul is not configured.
        if (!this.consul) return;

        // Trim any leading/trailing separators from the key, then prepend prefix.
        key = `${this.consulKeyPrefix}/${_.trim(key, '/')}`;

        // Try to serialize the value as JSON. If that fails, fall back to forcing to a regular string.
        value = JSON.stringify(value, null, 4) || _.toString(value);

        // Log to consul.
        logger.info(`Logging to consul: ${key}`);
        return this.consul.kv.set(key, value);

    }

    /**
     * Generate a Dockerfile from an environment specification.
     *
     * @param   {Environment}     environment V2 environment specification.
     * @returns {Promise<String>}             Dockerfile contents.
     */
    async generateDockerfile(environment) {

        // Generate dockerfile data object.
        let dockerfileData = _.omitBy(
            {
                imagename: environment.docker.imageName,
                imageversion: environment.docker.imageTag,
                cmd: environment.docker.cmd,
                run: await this.generateInstallCommands(environment),
                copy: [{ src: '.', dst: environment.docker.directory }]
            },
            _.isUndefined
        );

        // Generate dockerfile text from data object
        return Bluebird.fromCallback(
            cb => generator.generate(JSON.stringify(dockerfileData), cb)
        );

    }

    /**
     * Given an environment specification, generate commands to install all resolved dependency.
     *
     * @param   {Environment}              environment Environment specification.
     * @returns {Promise<Array.<Command>>}             Install commands.
     */
    async generateInstallCommands(environment) {

        // Generate all dependency install commands
        let dependencyCommands = await Bluebird.all(_.map(environment.dependencies, async (dependency) => {
            const system = factory.getSystemStrategy(dependency.system);
            return system.getInstallRunCommand(dependency);
        }));

        // Concat and return
        return _.concat(environment.setupCommands, dependencyCommands);

    }

    /**
     * Main inference method. Infer accepts as input a target application and returns an environment specification.
     *
     * @param   {Object}                   [options]                          Inference options.
     * @param   {String}                   [options.only]                     Only use specific rules for generating dependencies.
     * @param   {Boolean}                  [options.noValidate]               Disables validation. Inference will instead return the first environment to successfully parse.
     * @param   {String}                   [options.search=feedback-directed] Search strategy used to generate new environments.
     * @returns {Promise<InferenceResult>}                                    Inference with successful environment specification.
     */
    async infer(options = {}) {

        // Get an environment mutation strategy.
        let searchStrategy = mutation.lookup[options.search || 'feedback-directed'];
        if (!searchStrategy) {
            throw new errors.InferenceError(`Unknown search strategy: ${options.search}`);
        }

        // Get the language strategy for the current language
        const language = factory.getLanguageStrategy(metadata.language);

        // Get default environments
        logger.info('Parsing starting environments');
        let environments = await language.parseAndGenerateDefaultEnvironments();

        // Verify at least one base environment was generated
        if (environments.length === 0) {
            throw new errors.NoBaseEnvironmentsFoundError();
        }
        logger.info(`Generated ${environments.length} starting environments.`);

        // Perform inference for each environment
        await Bluebird.map(environments, async (environment) => {

            // Infer direct dependencies
            logger.info('Resolving direct dependencies.');
            let directLookup = await this.lookupDirectDependencies(environment);
            environment.metadata.directDependencies = directLookup;

            // Look up transitive dependencies and installation order
            if (options.only !== 'none') {
                logger.info('Resolving transitive dependencies.');
                let transitiveLookup = await this.lookupTransitiveDependencies(directLookup.items, options);
                environment.metadata.transitiveDependencies = transitiveLookup;
                environment.dependencies = transitiveLookup.installOrder;
            }
            else {
                logger.info('Not resolving transitive dependencies.');
                environment.dependencies = directLookup.items;
            }

            // Log base environment with resolved packages
            await this.logConsul(`base-environments/${environment.id}`, environment);

        });

        // Create inference metadata
        let inferenceMetadata = {
            start: _.toInteger(Date.now() / 1000),
            failedValidations: [],
            numValidations: 0,
        };

        // If noValidate is specified, immediately return the first environment.
        if (options.noValidate) {

            logger.warn('Validation disabled. Returning first parsed environment.');

            inferenceMetadata.end = _.toInteger(Date.now() / 1000);
            inferenceMetadata.validation = null;
            let environment = _.first(environments);
            return {
                metadata: inferenceMetadata,
                environment: environment,
                installCommands: await this.generateInstallCommands(environment),
                dockerfile: await this.generateDockerfile(environment)
            };

        }

        // Create mutation generator
        let mutantGenerator = searchStrategy(environments);

        // Get the first yielded result from the generator. Continue to validate until the generator finishes.
        let control = await mutantGenerator.next();
        while (!control.done) {

            // Timeout
            let now = _.toInteger(Date.now() / 1000);
            let elapsed = now - inferenceMetadata.start;
            if (elapsed > 3600) {
                throw new errors.InferenceTimeoutError(
                    elapsed,
                    inferenceMetadata.numValidations,
                    'Inference timed out.'
                );
            }

            // Reference the generated environment
            let environment = control.value;

            // Log
            let logValidationData = {
                imageName: environment.docker.imageName,
                imageTag: environment.docker.imageTag,
                mutations: environment.metadata.mutations,
                dependencies: environment.dependencies
            };
            logger.info(`Validating environment:\n${JSON.stringify(logValidationData, null, 4)}`);

            // Validate
            let validation = await language.validateEnvironment(environment);

            // Increment number of validations
            inferenceMetadata.numValidations++;

            // Truncate install error output if necessary
            _.set(validation, ERRORS_PATH, _.map(_.get(validation, ERRORS_PATH), ([out, err]) => [
                Buffer.from(out, ENCODING).toString(ENCODING, 0, TRUNCATE_BYTES),
                Buffer.from(err, ENCODING).toString(ENCODING, 0, TRUNCATE_BYTES)
            ]));

            // If a successful environment is found, return it immediately.
            if (validation.status_code === SUCCESS) {

                // Update successful validation result
                inferenceMetadata.validation = validation;
                inferenceMetadata.end = _.toInteger(Date.now() / 1000);

                // Return inference object
                return {
                    metadata: inferenceMetadata,
                    environment: environment,
                    installCommands: await this.generateInstallCommands(environment),
                    dockerfile: await this.generateDockerfile(environment)
                };

            }
            // Otherwise advance to next environment and validate that.
            else {

                logger.info(`Validation failed\n${JSON.stringify(validation, null, 4)}`);

                // Add to set of failed validations
                inferenceMetadata.failedValidations = _.unionWith(
                    inferenceMetadata.failedValidations,
                    [validation],
                    _.isEqual
                );

                // Advance generator
                control = await mutantGenerator.next(validation);

            }

        }

        // Working environment not found
        let end = _.toInteger(Date.now() / 1000);
        throw new errors.NoWorkingEnvironmentFoundError(
            (end - inferenceMetadata.start),
            inferenceMetadata.numValidations,
            control.value,
            'Unable to find a working environment configuration'
        );

    }

    /**
     * Look for a set of plausible packages corresponding to the resources used in some environment.
     *
     * @param   {Environment}                     environment Environment specification.
     * @returns {Promise<DirectDependencyLookup>}             Possible package dependencies providing imported resources and metadata about lookup.
     */
    async lookupDirectDependencies(environment) {

        // Get neo4j driver using a Bluebird disposer
        return Bluebird.using(neo4j.getDriver(), async (driver) => {

            // Reference metadata
            const system = environment.metadata.system;
            const deps = environment.metadata.importedResources.items;

            // Lookup object template
            const lookup = {
                items: [],
                count: 0,
                nameResolutions: 0,
                resourcePackageMapping: []
            };

            // Start mapping each known resource to a package
            await Bluebird.all(_.map(deps, async (name) => {

                // Query parameters
                let params =  { name, system };

                // Search the database, looking for any package resources with a substring match
                // and any packages with an exact name match. Union and return distinct packages.
                let results = await driver.session().run(RESOURCE_LOOKUP, params);
                if (!results.records.length) logger.info('Could not perform a reverse package lookup for resource:', name);

                // Push discovered packages to the package queue
                await Bluebird.all(_.map(results.records, async (record) => {

                    // Get package and version properties
                    // let p = _.assign(
                    //     record.get('package').properties,
                    //     record.get('version').properties,
                    // );
                    let p = record.get('package').properties;
                    logger.info(`Reverse lookup for ${name} matched package:`, p);

                    // Get package management system strategy
                    let system = factory.getSystemStrategy(p.system);

                    // Search for a record match and save
                    // let match = await system.searchForExactPackageMatch(p.name, p.version);
                    let match = await system.searchForExactPackageMatch(p.name);
                    if (match) {

                        logger.info(`Package ${p.name} resolved by package system as:`, match);
                        if (!_.some(lookup.items, match)) {
                            lookup.nameResolutions++;
                            lookup.items.push(match);
                            lookup.resourcePackageMapping.push({
                                resource: name,
                                package: match.name
                            });
                        }

                    }
                    else {

                        logger.info('Package system could not find package', p);

                    }

                }));

                // If the package queue does not contain a package with an exact name match,
                // this might just be because of an incomplete database. Defer to the system
                // of record. If found, push to the package queue.
                if (!_.some(lookup.items, params)) {

                    logger.info('No exact match in database for resource:', name);
                    let system = factory.getSystemStrategy(environment.metadata.system);
                    let record = await system.searchForExactPackageMatch(name);

                    if (record) {
                        logger.info(`Package ${name} resolved by package system as:`, record);
                        lookup.items.push(record);
                        lookup.resourcePackageMapping.push({
                            resource: name,
                            package: record.name
                        });
                    }
                    else logger.info('No exact match found for resource:', name);

                }
                else {

                    // If an exact name match is already in dependencies, then we've counted it as a name
                    // resolution. Remove it. We only want to count cases where the names do not match.
                    lookup.nameResolutions--;

                }

            }));

            // Set count
            lookup.count = lookup.items.length;

            // Log and return
            logger.info(
                'Imported resources were mapped back to these packages:',
                _.map(lookup.items, d => `(${d.name}, ${d.system})`)
            );

            return lookup;

        });

    }

    /**
     * Look up transitive dependencies and use them to generate an installation order for all packages..
     *
     * @param   {Array.<Dependency>}                  dependencies   Direct dependency list.
     * @param   {Object}                              [options]      Options object.
     * @param   {'assoc'|'deps'}                      [options.only] Only use specific rules for generating dependencies.
     * @returns {Promise<TransitiveDependencyLookup>}                Resolved transitive dependencies, an installation order, and metadata about lookup.
     */
    async lookupTransitiveDependencies(dependencies, options = {}) {

        // Get neo4j driver disposer
        return Bluebird.using(neo4j.getDriver(), async (driver) => {

            // Clone, since lookup will modify the list
            dependencies = _.clone(dependencies);

            // Set of encountered packages during traversal
            let encounteredPackages = new Set();

            // List of transitive and direct dependencies in installation order.
            let lookup = {
                items: [],
                installOrder: [],
                count: 0,
            };

            // Perform DFS to resolve packages and dependencies.
            // This is a reverse topological order if the graph
            // structure is acyclic.
            let root;
            while (root = dependencies.shift()) {

                // Log
                logger.info('Starting DFS rooted from:', root);

                // Perform DFS rooted from this node
                await (async function dfs(node) {

                    // Get node id
                    let system = factory.getSystemStrategy(node.system);
                    let nodeId = `${system.normalizePackageName(node.name)},${node.system}`;

                    // If node has already been encountered, do nothing
                    if (encounteredPackages.has(nodeId)) return;

                    // Set package as encountered
                    logger.info('Exploring node:', node);
                    encounteredPackages.add(nodeId);

                    // Build query. Override default depending on options.
                    let query;
                    if (options.only === 'deps') {
                        query = RESOURCE_DEP_LOOKUP;
                    }
                    else if (options.only === 'assoc') {
                        query = ASSOCIATION_DEP_LOOKUP;
                    }
                    else {
                        query = `${RESOURCE_DEP_LOOKUP}\nUNION\n${ASSOCIATION_DEP_LOOKUP}`;
                    }

                    // Run query
                    let results = await driver.session().run(query, node);

                    // Parse results and recurse
                    for (let record of results.records) {

                        // let dep = _.assign(
                        //     record.get('dependency').properties,
                        //     _.get(record.get('version'), 'properties')  // Use lodash.get because version might be null
                        // );
                        let dep = record.get('dependency').properties;
                        if (!encounteredPackages.has(`${dep.name},${dep.system}`)) {
                            await dfs.bind(this)(dep);
                        }

                    }

                    // Normalize and add to dependencies
                    // let match = await system.searchForExactPackageMatch(node.name, node.version);
                    let match = await system.searchForExactPackageMatch(node.name);
                    if (match) {
                        logger.info(`Package ${node.name} resolved by package system as:`, match);
                        lookup.installOrder.push(match);
                        if (!_.isEqual(root, match)) {
                            lookup.items.push(match);
                            lookup.count++;
                        }
                    }

                }).bind(this)(root);

            }

            logger.info('Resolved dependency ordering:', _.map(lookup.installOrder, d => `(${d.name}, ${d.system})`));
            return lookup;

        });

    }

    // CLI methods

    /**
     * Build all V2 Docker containers.
     *
     * @returns {Promise<void>}
     */
    async build() {

        // Build V2 images
        return Bluebird.map(tools.DOCKER_BUILD_CONTEXTS, tools.buildDockerImage);

    }

    /**
     * Push all V2 Docker images to a local registry. Requires having first run `v2 build` and then
     * `docker-compose up --detach`.
     *
     * @returns {Promise<void>}
     */
    async push() {

        // Push V2 images to registry
        return Bluebird.map(tools.DOCKER_BUILD_CONTEXTS, tools.pushDockerImage);

    }

    /**
     * Dockerize a code snippet using a language pack.
     *
     * @param   {Object}                                     options                   Dockerize options
     * @param   {String}                                     options.pkg               Package name.
     * @param   {String}                                     options.language          Language used to build dockerfile.
     * @param   {String}                                     options.search            Search strategy used to generate new environments.
     * @param   {Object}                                     [options.cmd]             Command to run at startup.
     * @param   {String}                                     options.cmd.command       Run command.
     * @param   {Array.<String>}                             options.cmd.args          Command arguments.
     * @param   {'dockerfile'|'install-commands'|'metadata'} [options.format]          Return format.
     * @param   {String}                                     [options.only]            Only use specific rules for generating dependencies.
     * @param   {boolean}                                    [options.noValidate]      Disables validation. V2 will instead return the first environment to successfully parse.
     * @returns {String}                                                               Dockerfile contents.
     */
    async run(options) {

        // Normalize options and set metadata
        metadata.language = options.language || 'python';
        metadata.path = path.resolve(options.pkg);
        metadata.basename = path.basename(metadata.path);
        metadata.isDir = fs.statSync(metadata.path).isDirectory();

        // Log
        logger.info('Inference metadata: ', metadata);

        // Run inference to determine an environment specification.
        try {

            let inference = await this.infer({
                only: options.only,
                noValidate: options.noValidate,
                search: options.search,
            });

            // Log to consul
            await this.logConsul('timestamp', new Date().toISOString());
            await this.logConsul('inference', inference);

            // Determine correct output format
            switch (options.format) {
                case 'metadata':
                    logger.info('Returning metadata');
                    return inference;
                case 'install-commands':
                    logger.info('Returning install commands');
                    return _.map(inference.installCommands, c => `${c.command} ${c.args.join(' ')}`);
                default:
                    logger.info('Returning Dockerfile');
                    return inference.dockerfile;
            }

        }
        catch (e) {

            // If e is not an inference error, wrap it in an inference error.
            if (!(e instanceof errors.InferenceError)) {
                e = new errors.UnexpectedInferenceError(e);
            }

            // Log and throw
            await this.logConsul('inference', { error: e });
            throw e;

        }

    }

}


// Export
module.exports = V2;

/**
 * @module languages/python/strategy
 */


// Core/NPM Modules
const _                        = require('lodash');
const path                     = require('path');


// Local Modules
const dockerTools              = require('../../docker-tools');
const errors                   = require('../../errors');
const factory                  = require('../../strategy-factory');
const LanguageStrategy         = require('../language-strategy');
const logger                   = require('../../logger');
const metadata                 = require('../../metadata');


// Constants
const ADD_PATH                 = '/app';
const IMPORT_ERRORS            = ['ImportError', 'ModuleNotFoundError'];


// Docker images
const PYTHON2_PARSE            = 'localhost:5000/v2/python2-parse:latest';
const PYTHON3_PARSE            = 'localhost:5000/v2/python3-parse:latest';
const PARSERS                  = [PYTHON3_PARSE, PYTHON2_PARSE];
const PYTHON2_VALIDATE         = 'localhost:5000/v2/python2-validate:latest';
const PYTHON3_VALIDATE         = 'localhost:5000/v2/python3-validate:latest';
const PYTHON2_JUPYTER_VALIDATE = 'localhost:5000/v2/python2-jupyter-validate:latest';
const PYTHON3_JUPYTER_VALIDATE = 'localhost:5000/v2/python3-jupyter-validate:latest';


/**
 * Python strategy class
 */
class PythonStrategy extends LanguageStrategy {

    /**
     * Parse an application and generate a set of potential starting environment configurations.
     *
     * @returns {Promise<Array.<Environment>>}
     */
    async parseAndGenerateDefaultEnvironments() {

        // All starting environments
        let environments = [];
        let id = 0;

        // Parse with Python 2 and Python 3
        for (let parser of PARSERS) {

            try{

                // Parse
                const parse = await dockerTools.runDockerContainerWithDataMount(parser, metadata.path);
                const deps = _.union(..._.map(parse.files, v => v.imports));
                logger.info('Package imports the following resources', deps);

                // Determine executable path
                // If the path is a directory and more than one file was found, specify the added directory.
                // If the path is a directory and one file was found (parse errors if no files are found), specify the
                // file within the added directory.
                // If the path is already a file, just specify the file within the added directory.
                let exec = metadata.isDir
                    ? (parse.num_files > 1
                        ? ADD_PATH
                        : path.join(ADD_PATH, path.basename(parse.files[0].filename)))
                    : path.join(ADD_PATH, metadata.basename);

                // Determine default command and any setup commands based on if Jupyter is detected.
                let cmd;
                let setup = [{ command: 'apt-get', args: [ 'update' ] }];
                if (parse.language.jupyter) {
                    logger.info('Parse found a Jupyter notebook');
                    cmd = {
                        command: 'jupyter',
                        args: [ 'nbconvert', '--to', 'asciidoc', '--execute', '--stdout', exec ]
                    };
                    setup.push({ command: 'pip', args: [ 'install', 'jupyter' ] });
                }
                else {
                    cmd = { command: 'python', args: [ exec ] };
                }

                // Create the environment template
                // TODO Make environment a class so implementations can use `new Environment()` and be consistent.
                environments = _.concat(environments, {
                    id: _.toString(id++),
                    metadata: {
                        importedResources: { items: deps, count: deps.length },
                        directDependencies: { items: [], count: 0, nameResolutions: 0, resourcePackageMapping: [] },
                        transitiveDependencies: { items: [], installOrder: [], count: 0 },
                        parseResult: parse,
                        language: parse.language.name,
                        system: parse.language.system,
                        mutations: []
                    },
                    docker: {
                        imageName: parse.language.name,
                        imageTag: parse.language.version,
                        directory: ADD_PATH,
                        cmd: cmd
                    },
                    setupCommands: setup,
                    dependencies: []
                });

            }
            catch (e) {

                logger.info(`Failed to parse and generate an environment with ${parser}: \n ${e}`);

            }

        }

        // Return all discovered starting environments
        return environments;

    }

    /**
     * Validate an environment specification. An environment is valid if it can execute the application without error.
     *
     * @param   {Environment}                    environment Environment specification.
     * @returns {Promise<EnvironmentValidation>} Validation result.
     */
    async validateEnvironment(environment) {

        // Generate install commands format used by python validate script
        const installCommands = _.map(environment.dependencies, d => {
            const system = factory.getSystemStrategy(d.system);
            const cmd = system.getInstallRunCommand(d);
            return `${cmd.command} ${cmd.args.join(' ')}`
        }).join(',');

        // Get parsing metadata
        let parse = environment.metadata.parseResult;
        let version = parse.language['version_major'];
        let jupyter = parse.language.jupyter;

        // Run correct validate, or error
        switch (version) {

            case 2:
                return dockerTools.runDockerContainerWithDataMount(
                    jupyter ? PYTHON2_JUPYTER_VALIDATE : PYTHON2_VALIDATE,
                    `'${metadata.path}' '${installCommands}'`
                );

            case 3:
                return dockerTools.runDockerContainerWithDataMount(
                    jupyter ? PYTHON3_JUPYTER_VALIDATE : PYTHON3_VALIDATE,
                    `'${metadata.path}' '${installCommands}'`
                );

            default:
                throw new Error(`Unrecognized image tag: ${environment.docker.imageTag}`);

        }

    }

    /**
     * Given two validations for the same environment which produced different exceptions on execution, this method
     * returns the validation for which an exception exception was encountered earlier. If no exception is considered
     * first, return null.
     *
     * @param   {EnvironmentValidation}      v1 First environment validation.
     * @param   {EnvironmentValidation}      v2 Second environment validation.
     * @returns {EnvironmentValidation|null}    The validation with an earlier exception.
     */
    firstExecutionException(v1, v2) {

        logger.info('Comparing Python execution exceptions');

        // Python validation stack traces have the script under validation at the root (validation script stack frames
        // are stripped from the response for execution exceptions). Each stack item is a list of attributes from a
        // FrameSummary: [filename, lineno, name, line]. [0][1] references the lineno of the script under validation.
        let linePath = 'execution.exception_stack[0][1]';

        // Extract the line number from both stack traces
        let line1 = _.get(v1, linePath);
        let line2 = _.get(v2, linePath);

        // Error if not defined.
        if (line1 === undefined || line2 === undefined) {
            throw new Error('Unable to parse a line number from validation execution.')
        }

        logger.info(`Line 1: ${line1}, Line 2: ${line2}`);

        // Return validation.
        if (line1 < line2) return v1;
        else if (line2 < line1) return v2;
        else return null;

    }

    /**
     * Given a line, attempt to extract a module being imported.
     *
     * @param   {String} line Input line.
     * @returns {String}      Module being imported, if found.
     */
    extractImportModule(line) {

        // Can't parse if a line is not provided
        // This can happen in cases such as timeit, where the snippet is doing its own source compilation and execution.
        if (!line) return null;

        // Extract the module being imported
        let match;

        // Try matching import statement
        match = line.match(/^(?:import|from) +(?<resource>[a-zA-z][a-zA-Z0-9.-_]*)(?: .*)?$/);
        if (match) return match.groups.resource;

        // Try matching import function
        match = line.match(/^.*__import__\(['"](?<resource>[a-zA-z][a-zA-Z0-9.-_]*)['"]\).*$/);
        if (match) return match.groups.resource;

        // Unable to extract a single module for import
        return null;

    }

    /**
     * Given an environment and a validation for that environment with an execution exception, return whether or not
     * the exception is potentially repairable by making version modifications.
     *
     * @param   {Environment}           environment Environment specification.
     * @param   {EnvironmentValidation} validation  Environment validation result with an execution exception.
     * @returns {Boolean}                           True if the exception is potentially caused by a version issue.
     */
    isRepairableVersionError(environment, validation) {

        // Get metadata
        let version = environment.metadata.parseResult.language.version;
        let stack = validation.execution.exception_stack;
        let exception = validation.execution.exception_name;

        // Determine if the exception is one of a set of probably unrepairable exceptions (heuristic based)
        let unrepairable = _.includes(
            [

                // Usually caused by not having a file on the local file system.
                'FileNotFoundError',

            ],
            exception
        );
        if (unrepairable) return false;

        // Generate site packages prefix
        let prefix = `/usr/local/lib/python${version}/site-packages/`;

        // Determine if some frame of the stack trace is in a third party library.
        let hasSitePackages = _.some(stack, row => row[0].startsWith(prefix));

        // If some frame was from a third party library, then we assume the issue is reparable by modifying that
        // dependency's version. If the exception did not come from a third party library, it must have come from the
        // snippet or the Python standard library.
        if (hasSitePackages) return true;

        // If the exception is an import error, and it can be mapped to at least one dependency, then it is potentially
        // repairable by modifying those dependencies.
        if (_.includes(IMPORT_ERRORS, exception)) {

            // Get the module that the import was for
            let resource = this.extractImportModule(validation.execution.exception_line);

            // Get all packages the resource was mapped to
            let mappings = environment.metadata.directDependencies.resourcePackageMapping;
            return _.some(mappings, ['resource', resource]);

        }

        // Determine if the exception is one of a set of potentially reparable exceptions (heuristic based).
        return _.includes(
            [

                // Raised by the Python interpreter if a function is called with the wrong number or type of arguments.
                // This can indicate a change in a dependency's API that can be fixed by finding the right version.
                'TypeError',

                // Raised by the Python interpreter if a non-existent object attribute is accessed. This can indicate
                // a change in a dependency's API that can be fixed by finding the right version.
                'AttributeError',

            ],
            exception
        );

    }

    /**
     * Given an environment and a validation for that environment with an execution exception, return the index of the
     * dependency that is responsible for producing the exception. If no such dependency can be found, return null.
     *
     * @param   {Environment}           environment Environment specification.
     * @param   {EnvironmentValidation} validation  Environment validation result with an execution exception.
     * @returns {Number|null}                       Dependency index.
     */
    dependencyProducingException(environment, validation) {

        logger.info('Finding dependency responsible for Python validation execution exception');

        // Get metadata
        let version = environment.metadata.parseResult.language.version;
        let stack = validation.execution.exception_stack;

        // Generate site packages prefix
        let prefix = `/usr/local/lib/python${version}/site-packages/`;

        // Find the all rows in the stack trace where the file comes from site-packages
        let allSitePackages = _.filter(stack, row => row[0].startsWith(prefix));

        // If no item in the stack trace comes from site-packages, the exception must only come from the validation
        // script (if there is a bug), the script under validation, or the standard library. Otherwise, the exception
        // must involve some third party package.
        if (_.isEmpty(allSitePackages)) {

            logger.info('Exception is not from a third party library.');

            // Determine if exception is an import error
            let isImportError = _.includes(IMPORT_ERRORS, validation.execution.exception_name);

            // If exception is a type of import error.
            if (isImportError) {

                logger.info('Exception is an import error');

                // Get the module that the import was for
                let resource = this.extractImportModule(validation.execution.exception_line);

                // Get all packages the resource was mapped to
                let mappings = environment.metadata.directDependencies.resourcePackageMapping;
                let packages = _.filter(mappings, ['resource', resource]);

                // If the resource can be mapped back to a single package dependency, return that. If it cannot be
                // mapped back to any, or it is mapped back to multiple potential packages, return null. In the first
                // case, there is no dependency to choose. This needs to be fixed at the resolution level. In the
                // second case, we don't know which dependency to choose.
                if (packages.length === 1) {

                    let mapping = _.first(packages);
                    let index = _.findIndex(environment.dependencies, { name: mapping.package, system: environment.metadata.system  });

                    let dependency = environment.dependencies[index];
                    logger.info(`Import corresponds to a resource mapped back to the package: ${JSON.stringify(dependency, null, 4)}`);

                    return index;

                }
                else {

                    logger.info(`Import mapped back to ${packages.length} packages`);
                    return null;

                }

            }
            else {

                // Validation exception was caused by an exception that did not occur in a third party library and was
                // not a type of import error. Return no dependency found. Potentially this could be a false negative,
                // but this usually corresponds to an exception caused by the script under validation itself.
                logger.info('Exception is not an import error');
                return null;

            }

        }
        else {

            // Iterate over all frame summaries of dependencies in site-packages in reverse order. Find the index of
            // the last dependency in the stack trace that is managed by V2.
            for (let frame of _.reverse(allSitePackages)) {

                // Get package name from the site-packages path and find index
                let framePath = frame[0].substring(prefix.length).split('/');
                let index = _.findIndex(environment.dependencies, (dependency) => {

                    let resourcePath = _.split(dependency.name, '.');
                    return (dependency.system === environment.metadata.system)
                        && _.isEqual(resourcePath, _.slice(framePath, 0, resourcePath.length));

                });

                // Return index if found
                if (index >= 0) {
                    logger.info(`Exception is from: ${JSON.stringify(environment.dependencies[index], null, 4)}`);
                    return index;
                }

            }

            logger.info(`Exception is from a third party library not managed by V2: ${_.last(allSitePackages)[0]}`);
            return null;

        }

    }

}


// Export
module.exports = PythonStrategy;
/**
 * @module language-strategy
 */


// Constants
const NOT_IMPLEMENTED = 'not implemented';


/**
 * Language strategy class.
 *
 * @property {String} language         Name of strategy language.
 * @property {String} langpackPath     Path to strategy langpack.
 * @property {Object} langpack         Strategy langpack.
 * @property {String} dependencyParser Path to executable that can be used to parse dependencies.
 */
class LanguageStrategy {

    /**
     * Strategy constructor.
     */
    constructor() {}

    // Methods

    /**
     * Parse an application and generate a set of potential starting environment configurations.
     *
     * @returns {Promise<Array.<Environment>>}
     */
    async parseAndGenerateDefaultEnvironments() { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Validate an environment specification. An environment is valid if it can execute the application without error.
     *
     * @param   {Environment}                    environment Environment specification.
     * @returns {Promise<EnvironmentValidation>} Validation result.
     */
    async validateEnvironment(environment) { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Given two validations for the same environment which produced different exceptions on execution, this method
     * returns the validation for which an exception exception was encountered earlier. If no exception is considered
     * first, return null.
     *
     * @param   {EnvironmentValidation} v1 First environment validation.
     * @param   {EnvironmentValidation} v2 Second environment validation.
     * @returns {EnvironmentValidation}    The validation with an earlier exception.
     */
    firstExecutionException(v1, v2) { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Given an environment and a validation for that environment with an execution exception, return whether or not
     * the exception is potentially repairable by making version modifications.
     *
     * @param   {Environment}           environment Environment specification.
     * @param   {EnvironmentValidation} validation  Environment validation result with an execution exception.
     * @returns {Boolean}                           True if the exception is potentially caused by a version issue.
     */
    isRepairableVersionError(environment, validation) { throw new Error(NOT_IMPLEMENTED); }

    /**
     * Given an environment and a validation for that environment with an execution exception, return the index of the
     * dependency that is responsible for producing the exception. If no such dependency can be found, return null.
     *
     * @param   {Environment}           environment Environment specification.
     * @param   {EnvironmentValidation} validation  Environment validation result with an execution exception.
     * @returns {Number|null}                       Dependency index.
     */
    dependencyProducingException(environment, validation) { throw new Error(NOT_IMPLEMENTED); }

}


// Export strategy class
module.exports = LanguageStrategy;
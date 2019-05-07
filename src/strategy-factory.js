/**
 * @module strategy-factory
 */


// Local Modules
const logger = require('./logger');


/**
 * StrategyFactory class
 */
class StrategyFactory {

    /**
     * Construct a new factory.
     */
    constructor() {
        this.languages = new Map();
        this.systems = new Map();
    }

    /**
     * Get a new language strategy.
     *
     * @param   {String}           language Language of the strategy to return.
     * @returns {LanguageStrategy}          Strategy for given language.
     */
     getLanguageStrategy(language) {

        try {

            // Load and init if not already available
            if (!(language in this.languages)) {
                let Strategy = require(`./languages/${language}/strategy.js`);
                this.languages[language] = new Strategy();
            }

            // Return
            return this.languages[language];

        }
        catch(err) {

            logger.error(`Unable to load strategy for language ${language}:`, err.message);
            throw new Error(`Language '${language}' not supported.`);

        }

    }

    /**
     * Get a new system strategy.
     *
     * @param   {String}         system  Language of the strategy to return.
     * @returns {SystemStrategy}         Strategy for given language.
     */
    getSystemStrategy(system) {

        try {

            // Load and init if not already available
            if (!(system in this.systems)) {
                let System = require(`./systems/${system}/strategy.js`);
                this.systems[system] = new System();
            }

            // Return
            return this.systems[system];

        }
        catch(err) {

            logger.error(`Unable to load strategy for system ${system}:`, err.message);
            throw new Error(`System '${system}' not supported.`);

        }

    }

}


// Export factory class
module.exports = new StrategyFactory();
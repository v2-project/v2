/**
 * Neo4j utilities.
 *
 * @module neo4j
 */


// Core/NPM modules
const Bluebird    = require('bluebird');
const neo4j       = require('neo4j-driver').v1;


// Local modules
const dockerTools = require('../docker-tools');


/**
 * Class for interacting with Neo4J.
 */
class Neo4j {

    /**
     * Return a neo4j client.
     *
     * @returns {Promise<neo4j.driver>} Configured Neo4j driver wrapped in a Bluebird disposer.
     */
    async getDriver() {

        // Get correct hostname and init driver
        let hostname = dockerTools.dockerContainer ? 'neo4j' : 'localhost';
        let driver = neo4j.driver(`bolt://${hostname}:7687`);

        // Return as a Bluebird disposer
        return Bluebird.resolve(driver).disposer(driver.close);

    }

}


// Export
module.exports = new Neo4j();

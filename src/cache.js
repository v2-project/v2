/**
 * Redis LFU cache interface.
 *
 * @module v2/cache
 */


// NPM/core modules
const Bluebird    = require('bluebird');
const redis       = require('redis');


// Local modules
const dockerTools = require('./docker-tools');


// Promisify redis client
Bluebird.promisifyAll(redis.RedisClient.prototype);
Bluebird.promisifyAll(redis.Multi.prototype);


// Implementation dbs
const db = new Map([
    ['pip', 1],
    ['apt', 2]
]);


/**
 * Get a redis client configured for an implementation strategy. Each strategy
 * is provided its own database.
 *
 * @param   {String}                name           Implementation name.
 * @returns {Promise.<RedisClient>}                Redis client.
 */
module.exports.getClientFor = (name) => {

    // Verify cache database exists
    if (!db.has(name)) throw new Error(`No cache for ${name}`);

    // Create client
    let hostname = dockerTools.dockerContainer ? 'redis' : 'localhost';
    let client = redis.createClient({
        host: hostname,
        db: db.get(name)
    });

    // Return disposer
    return Bluebird.resolve(client).disposer((c) => c.quit());

};

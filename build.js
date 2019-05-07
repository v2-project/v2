#!/usr/bin/env node

/**
 * A convenience script for building V2 resources without needing to
 * install or configure anything. Cannot use modules from NPM.
 *
 * @module v2-build
 */


// Local modules
const tools = require('./src/build-tools');


// Build
(async () => {

    try {
        await Promise.all(tools.DOCKER_BUILD_CONTEXTS.map(tools.buildDockerImage));
    }
    catch (err) {
        console.error(err);
        process.exit(1);
    }

})();
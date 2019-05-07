/**
 * A collection of tools for interacting with the Docker container system.
 *
 * @module docker-tools
 */


// Core/NPM modules
const _              = require('lodash');
const Bluebird       = require('bluebird');
const child_process  = require('child_process');
const fs             = require('fs');


// Local modules
const logger         = require('../logger');
const metadata       = require('../metadata');


// Constants
const MAX_BUFFER     = 10 * 1024 * 1024;  // 10 MB (node default is 200 KB)

/**
 * DockerTools bundles functionality for detecting, running, and interacting with Docker containers.
 *
 * @property {Object} dockerContainer Metadata for the Docker container V2 is running inside of.
 */
class DockerTools {

    /**
     * Metadata for the Docker container the process is running inside of, if any. If the process is not running inside
     * of a Docker container, this will be `null`. Detection is performed once the first time the attribute is accessed
     * and cached. The Docker container object is parsed from the output given by running
     * `docker inspect <container id>`, where the container id is extracted from /proc/self/cgroup.
     *
     * @returns {Object|null} Docker container metadata.
     */
    get dockerContainer() {

        // If docker container is undefined, then it has not checked. Check now.
        if (this._dockerContainer === undefined) {

            try {

                // cgroup file path
                let cgroup = '/proc/self/cgroup';

                // Check for access
                fs.accessSync(cgroup, fs.F_OK | fs.R_OK);

                // Read cgroup file
                let contents = fs.readFileSync(cgroup, 'utf8');

                // Match for cid
                let match = contents.match(/\d+:pids:\/docker\/(\w+)/);
                if (match) {

                    // Parse and log CID
                    let cid = match[1];
                    logger.info(`Detected Docker cid: ${match}`);

                    // Get Docker container
                    let stdout = child_process.execSync(`docker inspect ${cid}`);
                    this._dockerContainer = JSON.parse(stdout)[0];

                }
                else {

                    // No CID found, not running inside docker
                    logger.info('No Docker CID found.');
                    this._dockerContainer = null;

                }

            }
            catch (e) {

                // Error reading cgroup file or communicating with Docker. Assume not running inside container.
                logger.info(`Assuming not running inside Docker due to the following reason:\n---> ${e}`);
                this._dockerContainer = null;

            }

        }

        // Return
        return this._dockerContainer;

    }

    /**
     * Run a Docker container with optional arguments. The container must print a JSON value to stdout, which will be
     * parsed and returned. It may print logging information to stderr, which will be logged to the user.
     *
     * @param   {String}                  image     Image to create the container from.
     * @param   {String}                  command   Command run when starting the container.
     * @param   {Array.<String>}          [args]    Optional docker arguments.
     * @returns {Promise<Object>}                   Execution result object.
     */
    async runDockerContainer(image, command, args=[]) {

        // Join arguments for a full arguments string
        let argsString = args.join(' ');

        // Generate the docker run command
        let cmd = `docker run --rm ${argsString} ${image} ${command}`;
        logger.info(`Docker run command: ${cmd}`);

        // Run
        let [stdout, stderr] = await Bluebird.fromCallback(cb => child_process.exec(cmd, {maxBuffer: MAX_BUFFER}, cb), { multiArgs: true });

        // Parse
        logger.info(`Parsing output:\n${stderr}`);
        logger.info(`Parsing result: \n${stdout}`);
        return JSON.parse(stdout);

    }


    /**
     * Run a Docker container with a data mount. Data mount will either come from the current container using the
     * Docker `--volumes-from` flag or from the Docker `-v` flag with the directory containing the software package.
     * The container must print a JSON object to stdout, which will be parsed as a result object. It may print logging
     * information to stderr, which will be logged to the user.
     *
     * @param   {String}          image   Image to create the container from.
     * @param   {String}          command Command run when starting the container.
     * @returns {Promise<Object>}         Execution result object.
     */
    async runDockerContainerWithDataMount(image, command) {

        // Detect docker and determine which mount to use
        let dataMount = this.dockerContainer
            ? `--volumes-from='${this.dockerContainer.Id}'`
            : `--mount='type=bind,source=${metadata.path},target=${metadata.path},readonly'`;

        // Run docker container with data mount arguments
        return this.runDockerContainer(image, command, [dataMount]);

    }

}


// Export singleton instance
module.exports = new DockerTools();
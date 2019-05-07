/**
 * Build tools for V2. Build tools are designed to work without
 * needing to install dependencies and cannot use modules from NPM.
 */


// Core modules
const child_process          = require('child_process');
const path                   = require('path');

// Constants
const PROJECT_ROOT = path.resolve(path.join(__dirname, '../../'));


// V2 Docker build contexts
module.exports.DOCKER_BUILD_CONTEXTS = [
    {
        context: PROJECT_ROOT,
        tags: ['localhost:5000/v2/v2:latest']
    },
    {
        context: path.join(PROJECT_ROOT, 'src/neo4j'),
        tags: ['localhost:5000/v2/neo4j:latest']
    },
    {
        context: path.join(PROJECT_ROOT, 'src/languages/python/parsing'),
        tags: ['localhost:5000/v2/python2-parse:latest'],
        dockerfile: 'Python2Dockerfile'
    },
    {
        context: path.join(PROJECT_ROOT, 'src/languages/python/parsing'),
        tags: ['localhost:5000/v2/python3-parse:latest'],
        dockerfile: 'Python3Dockerfile'
    },
    {
        context: path.join(PROJECT_ROOT, 'src/languages/python/validation'),
        tags: ['localhost:5000/v2/python2-validate:latest'],
        dockerfile: 'Python2Dockerfile'
    },
    {
        context: path.join(PROJECT_ROOT, 'src/languages/python/validation'),
        tags: ['localhost:5000/v2/python3-validate:latest'],
        dockerfile: 'Python3Dockerfile'
    },
    {
        context: path.join(PROJECT_ROOT, 'src/languages/python/validation'),
        tags: ['localhost:5000/v2/python2-jupyter-validate:latest'],
        dockerfile: 'Python2JupyterDockerfile'
    },
    {
        context: path.join(PROJECT_ROOT, 'src/languages/python/validation'),
        tags: ['localhost:5000/v2/python3-jupyter-validate:latest'],
        dockerfile: 'Python3JupyterDockerfile'
    },
    {
        context: path.join(PROJECT_ROOT, 'src/systems/apt/versions'),
        tags: ['localhost:5000/v2/apt-versions:latest'],
    },
    {
        context: path.join(PROJECT_ROOT, 'src/systems/pip/versions'),
        tags: ['localhost:5000/v2/pip-versions:latest'],
    },
];


/**
 * Build a Docker image.
 *
 * @param   {Object}         options                         Options object.
 * @param   {String}         options.context                 Docker build context (path to directory).
 * @param   {Array.<String>} options.tags                    Docker image tags.
 * @param   {String}         [options.dockerfile=Dockerfile] Name of the Dockerfile that will be built. Dockerfile must be inside build context.
 * @returns {Promise<void>}                                  Promise fulfills when Docker build completes.
 */
module.exports.buildDockerImage = async (options) => {

    // Normalize options
    options.context = path.resolve(options.context);
    options.dockerfile = path.join(options.context, options.dockerfile || 'Dockerfile');

    // Generate docker build command
    let cmd = [
        'docker', 'build',
        ...options.tags.map(t => `-t ${t}`),
        `-f '${options.dockerfile}'`,
        options.context
    ].join(' ');

    // Build Docker image
    return new Promise(((resolve, reject) => {

        console.log(`Executing Docker build command:\n    ${cmd}`);
        child_process.exec(cmd, (err, stdout, stderr) => {

            if (err) {
                reject(err);
            }
            else {
                console.log(`Done building Dockerfile '${options.dockerfile}'.`);
                resolve([stdout, stderr]);
            }

        });

    }));

};

/**
 * Push a Docker image.
 *
 * @param   {Object}         options                         Options object.
 * @param   {String}         options.context                 Docker build context (path to directory).
 * @param   {Array.<String>} options.tags                    Docker image tags.
 * @param   {String}         [options.dockerfile=Dockerfile] Name of the Dockerfile that will be built. Dockerfile must be inside build context.
 * @returns {Promise<void>}                                  Promise fulfills when Docker build completes.
 */
module.exports.pushDockerImage = async (options) => {

    // Push all tags
    return Promise.all(options.tags.map((tag) => {

        // Construct command
        let cmd = ['docker', 'push', tag].join(' ');

        // Push
        return new Promise(((resolve, reject) => {

            console.log(`Executing Docker push command:\n    ${cmd}`);
            child_process.exec(cmd, (err, stdout, stderr) => {

                if (err) {
                    reject(err);
                }
                else {
                    console.log(`Done pushing docker image: ${tag}`);
                    resolve([stdout, stderr]);
                }

            });

        }));

    }));

};

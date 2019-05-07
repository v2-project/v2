#!/usr/bin/env node

/**
 * Run dockerize against a language pack.
 *
 * @module dockerize/bin
 */


// Core/NPM Modules
const _           = require('lodash');
const yargs       = require('yargs');


// Local modules
const V2 = require('./index');
const errors      = require('./src/errors');
const logger      = require('./src/logger');


// Dockerize
let argv = yargs
    .command(
        'build',
        'Build all V2 Docker images.',
        (yargs) => {},
        async (argv) => {

            // Enable full logging for building Docker
            logger.level = 'silly';

            // Build
            return (new V2).build();

        }
    )
    .command(
        'push',
        'Push all V2 Docke images to the local registry. Requires having run `v2 build` and `docker-compose up --detach`.',
        (yargs) => {},
        async (argv) => {

            // Enable full logging
            logger.level = 'silly';

            // Push
            return (new V2()).push();

        }
    )
    .command(
        'run [package]',
        'Dockerize a package',
        (yargs) => {

            yargs.option('language', {
                type: 'string',
                describe: 'Source language',
                default: 'python'
            });

            yargs.option('search', {
                type: 'string',
                describe: 'Search strategy.',
                default: 'feedback-directed',
                choices: ['level-order', 'id-dfs', 'feedback-directed']
            });

            yargs.option('cmd', {
                type: 'string',
                describe: 'CMD executable for the final Dockerfile.'
            });

            yargs.option('arg', {
                type: 'array',
                describe: 'CMD arguments for the final Dockerfile.'
            });

            yargs.option('format', {
                type: 'string',
                describe: 'Output format: either a valid dockerfile, a semicolon delimited list of install commands, or JSON metadata about inference.',
                default: 'dockerfile',
                choices: ['dockerfile', 'install-commands', 'metadata']
            });

            yargs.option('verbose', {
                type: 'boolean',
                describe: 'Enable logging to stderr.',
                default: false
            });

            yargs.option('only', {
                type: 'string',
                describe: 'Rules to use for transitive dependency resolution. Known transitive dependencies are used to generate installation order. Restricting lookup may change the final order.',
                choices: ['deps', 'assoc', 'none']
            });

            yargs.option('consul', {
                type: 'string',
                describe: 'Address of a consul cluster. If provided, metadata results will be pushed to the key/value store.'
            });

            yargs.option('consul-key-prefix', {
                type: 'string',
                describe: 'Optional key prefix to log metadata under if consul information is provided.',
                default: 'v2'
            });

            yargs.option('no-validate', {
                type: 'boolean',
                describe: 'Do not run validation. Using this option will cause V2 to return the first environment it successfully parses.',
                default: false,
            });

            yargs.positional('package', {
                type: 'string',
                describe: 'Path to the code package to be dockerized. Can be relative to cwd.',
                default: '.'
            });

        },
        async (argv) => {

            // If verbose, enable logging
            if (argv.verbose) {
                logger.level = 'silly';
                logger.info('Verbose mode enabled. Logging to stderr.');
            }

            // Get command
            let cmd;
            if (argv.cmd) {
                cmd = _.omitBy({
                    command: argv.cmd,
                    args: _.isArray(argv.arg) ? argv.arg : [ argv.arg ]
                }, _.isUndefined);
            }

            // Get language, package name, and version
            let language = argv.language;
            let only = argv.only;
            let pkg = argv.package;
            let format = argv.format;

            // Create v2 with consul options, if any
            let v2 = new V2(_.omitBy({
                consul: argv.consul,
                consulKeyPrefix: argv.consulKeyPrefix
            }, _.isUndefined));

            // Dockerize
            let contents = await v2.run(_.omitBy({
                pkg,
                language,
                search: argv.search,
                cmd,
                format,
                only,
                noValidate: argv.noValidate,
            }, _.isUndefined));

            // Print
            if (_.isObject(contents)) {
                console.log(JSON.stringify(contents, null, 4));
            }
            else {
                console.log(contents);
            }

        }
    )
    .fail((msg, err, yargs) => {

        if (msg) {
            yargs.showHelp();
            console.log(msg);
        }
        else {
            if (err instanceof errors.InferenceError) {
                err = err.toJSON();
            }
            else {
                err = { name: err.name, message: err.message, stack: err.stack };
            }
            logger.error(JSON.stringify(err, null, 4));
        }
        process.exit(1);

    })
    .demandCommand()
    .recommendCommands()
    .strict()
    .wrap(yargs.terminalWidth())
    .help()
    .argv;

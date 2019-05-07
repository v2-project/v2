#!/usr/bin/env bash

# Exit on failure
set -e

# Create database from backup file
# Done at runtime because the /data volume from the base neo4j image
# wont have build time modifications persisted.
mkdir -p /data/databases/graph.db
neo4j-admin load --force --from=/build-files/database.dump

# Start neo4j
/docker-entrypoint.sh neo4j

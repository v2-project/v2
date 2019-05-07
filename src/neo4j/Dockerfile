FROM neo4j:3.5.3

ADD https://github.com/neo4j-contrib/neo4j-graph-algorithms/releases/download/3.5.3.1/graph-algorithms-algo-3.5.3.1.jar $NEO4J_HOME/plugins
ADD https://github.com/neo4j-contrib/neo4j-apoc-procedures/releases/download/3.5.0.2/apoc-3.5.0.2-all.jar $NEO4J_HOME/plugins

ENV NEO4J_AUTH=none
COPY database.dump /build-files/database.dump
COPY load-and-start.sh /build-files/load-and-start.sh

ENTRYPOINT ["/sbin/tini", "-s", "-g", "--"]
CMD ["/build-files/load-and-start.sh"]

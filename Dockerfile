# Dockerfile creates a Docker image capable of running the main
# V2 executable. It is based off of the official NodeJS v10 image.


# Add the stable docker image for a multistage build
FROM docker:stable AS docker


# Start using Node v10
FROM node:10


# Declare build arguments
ARG V2_DIR=/v2


# Copy docker executable from docker image
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker


# Copy the v2 source into the build directory, install dependencies,
# link the executable, then reset the working directory.
COPY . $V2_DIR
WORKDIR $V2_DIR
RUN npm install
RUN npm link
WORKDIR /


# Default command
CMD v2
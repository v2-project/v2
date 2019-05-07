# Use Debian stretch (Debian 9) as the base. The Python docker image is also based off of Debian.
FROM debian:stretch-slim


# Add versions script
COPY list-versions.sh /scripts/list-versions.sh


# Update cache
RUN apt-get update


# Set versions script as entrypoint.
ENTRYPOINT ["/scripts/list-versions.sh"]

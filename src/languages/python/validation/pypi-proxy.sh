#!/usr/bin/env bash

PROXY_PORT="$1"
HOST_IP="$(ip route| awk '/^default/ {print $3}')"

mkdir -p ~/.pip
cat << EOF > ~/.pip/pip.conf
[global]
timeout = 600
no-cache-dir = false
index-url = http://$HOST_IP:$PROXY_PORT/root/pypi/+simple/

[install]
trusted-host = $HOST_IP
EOF

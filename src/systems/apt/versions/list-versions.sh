#!/bin/bash


# Error if there isn't exactly one provided argument
if [[ $# -ne 1 ]]
then
    echo 'Usage: list-versions <package>' >&2
    exit 1
fi


# Get argument as package name
PACKAGE=$1


# Search apt-cache for package information, then print the second `|` delimited column without leading/trailing
# whitespace. Save the result as an array.
versions=( $(apt-cache madison "$PACKAGE" | awk -F '|' '{ gsub(/^ +/, "", $2); gsub(/ +$/, "", $2); print $2 }') )

# Format output as a JSON array. Serialize the versions as quoted comma-separated values, then remove the last comma.
# The guard around versions length protects against the case where no versions were returned, in which case printf
# would format an empty string.
if [[ ${#versions[@]} > 0 ]]
then
    printf -v version_list '"%s",' "${versions[@]}"
    version_list=${version_list%?}
else
    version_list=''
fi

# Print inside of square brackets.
echo "[${version_list}]"

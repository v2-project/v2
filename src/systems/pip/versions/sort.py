"""Utility for sorting Python package versions."""


# Imports
import argparse
import bisect
import json
import sys

from packaging import version


def sort(versions, ascending=False, cutoff=None):
    """Sort a list of versions.

    Parameters
    ----------
    versions : list
        List of versions to be sorted.
    ascending : bool
        Whether sorting should be done in ascending or descending order.
        Defaults to false (descending order).
    cutoff : str
        Version cutoff. Only include versions less than or equal to cutoff if
        sorting descending, or greater than or equal to cutoff if sorting
        ascending. Include all versions if not specified.

    Returns
    -------
    list
        Sorted versions.
    """
    # Parse as versions and sort
    versions = list(sorted(map(version.parse, versions)))

    # Filter by cutoff if specified
    if cutoff:
        cutoff = version.parse(cutoff)
        if ascending:
            versions = versions[bisect.bisect_left(versions, cutoff):]
        else:
            versions = versions[:bisect.bisect_right(versions, cutoff)]

    # Reverse if descending
    if not ascending:
        versions = list(reversed(versions))

    # Return versions
    return list(map(str, versions))


def main():
    """Parse a list of versions and return the result of sorting."""
    # Parse arguments
    parser = argparse.ArgumentParser()
    parser.add_argument('--ascending', action='store_true',)
    parser.add_argument('--cutoff', nargs='?',)
    parser.add_argument('versions',)
    argv = parser.parse_args()

    # Parse versions as a list
    versions = list(json.loads(argv.versions))

    # Sort and print
    json.dump(sort(versions, argv.ascending, argv.cutoff), sys.stdout)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()

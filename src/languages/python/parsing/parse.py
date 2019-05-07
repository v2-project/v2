#!/usr/bin/env python2

"""Parse python scripts.

See https://greentreesnakes.readthedocs.io/en/latest/ for wonderful
documentation on python ast parsing.
"""


# Imports
from __future__ import with_statement
import ast
import getopt
import json
import os
import sys
from itertools import chain
from visitor import ParserVisitor

# Constants
BASE_PATH = os.path.dirname(os.path.abspath(__file__))
LANGUAGE = 'python'
PYTHON_MAJOR, PYTHON_MINOR, _, _, _ = sys.version_info
NBFORMAT_V3 = 3
NBFORMAT_V4 = 4
PYTHON_EXT = '.py'
JUPYTER_EXT = '.ipynb'
EXTENSIONS = (PYTHON_EXT, JUPYTER_EXT)
SYSTEM = 'pip'


def parse_method_call_tokens(snippet):
    """Parse method call tokens.

    Use the ast package to parse method call tokens from a snippet of python.

    Parameters
    ----------
    snippet : string
        Snippet of python code.

    Returns
    -------
    dict
        JSON serializable dictionary containing the following keys

        imports - All imports made by the parsed snippet
        calls   - All method calls made by the parsed snippet, traced back to its
                  associated library if possible.
    """
    # Parse snippet into an abstract syntax tree
    tree = ast.parse(str(snippet))

    # Parse the ast
    visitor = ParserVisitor()
    visitor.visit(tree)

    # Get imports and calls
    imports = list(visitor.import_libraries)
    calls = list(visitor.calls)

    # Return
    return {'imports': imports, 'calls': calls}


def parse_file(filename):
    """Load and parse a file.

    Parameters
    ----------
    filename : string
        Filename or path relative to parse.py.

    Returns
    -------
    dict
        JSON serializable dictionary containing the following keys

        imports - All imports made by the parsed snippet
        calls   - All method calls made by the parsed snippet, traced back to its
                  associated library if possible.
    """
    # Get file extension
    _, fext = os.path.splitext(filename)
    if fext not in EXTENSIONS:
        raise ValueError('Unsupported file type: {}'.format(fext))

    # Open file
    with open(os.path.abspath(filename), 'r') as input_file:

        # Parse python
        if fext == '.py':

            parse = parse_method_call_tokens(input_file.read())

        # Parse notebook
        elif fext == '.ipynb':

            notebook_contents = input_file.read().strip()
            if not notebook_contents:
                raise ValueError('Notebook is empty.')

            # Parse as JSON
            notebook_json = json.loads(notebook_contents)

            # Get the notebook nbformat version. We support v3 and v4, as they
            # have readily available schemas.
            notebook_version = notebook_json.get('nbformat')

            # Parse source lines based on the notebook version
            if notebook_version == NBFORMAT_V3:
                source_lines = get_v3_source_lines(notebook_json)
            elif notebook_version == NBFORMAT_V4:
                source_lines = get_v4_source_lines(notebook_json)
            else:
                raise ValueError(
                    'Unsupported notebook version: {}'.format(notebook_version)
                )

            # Filter magic
            source_lines = filter(
                lambda l: not l.startswith('%') and not l.startswith('!'),
                source_lines
            )

            # Concatenate to form code snippet
            code = ''.join(source_lines)

            # Parse
            parse = parse_method_call_tokens(code)

        # Set parse filename and return
        parse['filename'] = filename
        return parse


def get_v3_source_lines(notebook):
    """Parse source lines from a notebook in the v3 schema.

    https://github.com/jupyter/nbformat/blob/master/nbformat/v3/nbformat.v3.schema.json

    By the v3 schema documentation, all source code should be Python. Double
    check and fail if this isn't the case.
    https://github.com/jupyter/nbformat/blob/master/nbformat/v3/nbformat.v3.schema.json#L174

    Parameters
    ----------
    notebook : dict
        Python dictionary conforming to the iPython v4 notebook schema

    Returns
    -------
    iterable<str>
        Iterable of source code lines from the input notebook

    Raises
    ------
    ValueError
        Raised if the notebook language is not Python. Currently only Python
        notebooks are supported.
    """
    # Get notebook cells from all worksheets
    cells = chain.from_iterable(map(
        lambda w: w.get('cells', []),
        notebook.get('worksheets', [])
    ))

    # Filter to only code cells
    code_cells = list(filter(lambda c: c.get('cell_type') == 'code', cells))

    # Error if some cell is not Python, as the schema declares it must be
    if any(map(lambda c: c.get('language') != 'python', code_cells)):
        raise ValueError(
            'Notebook code cell language was invalid for schema '
            '(v3 only allows Python)'
        )

    # Parse source lines. The code_cell source property is a multiline string,
    # defined in the schema to either be a string or an array of string.
    source_lines = chain(map(
        lambda c: c.get('input', []) + ['\n'],
        code_cells
    ))

    # Convert to a flattened list of string
    return chain.from_iterable(map(
        lambda s: (s,) if type(s) == str else s,
        source_lines
    ))


def get_v4_source_lines(notebook):
    """Parse source lines from a notebook in the v4 schema.

    https://github.com/jupyter/nbformat/blob/master/nbformat/v4/nbformat.v4.schema.json

    Currently only supports Python notebooks. The language_info field isn't
    required, so default to assuming Python if it isn't provided.

    Parameters
    ----------
    notebook : dict
        Python dictionary conforming to the iPython v4 notebook schema

    Returns
    -------
    iterable<str>
        Iterable of source code lines from the input notebook

    Raises
    ------
    ValueError
        Raised if the notebook language is not Python. Currently only Python
        notebooks are supported.
    """
    # Parse language from the notebook and error if it is not supported.
    language = (
        notebook
        .get('metadata', {})
        .get('language_info', {})
        .get('name', 'python')
    )
    if language != 'python':
        raise ValueError('Notebook is in an unsupported language: ' + language)

    # Get all code cells
    code_cells = filter(
        lambda c: c.get('cell_type') == 'code',
        notebook.get('cells', [])
    )

    # Parse source lines. The code_cell source property is an multiline string,
    # defined in the schema to either be a string or an array of string.
    source_lines = chain(map(
        lambda c: c.get('source', []) + ['\n'],
        code_cells
    ))

    # Convert to a flattened list of string
    return chain.from_iterable(map(
        lambda s: (s,) if type(s) == str else s,
        source_lines
    ))


def main():
    """Main function.

    This function parses command line arguments for parameters.
    If no file is provided, it will parse example.py.

    Usage
    -----
    python parse.py <filename>
    """

    # Get command line arguments
    opts, args = getopt.getopt(sys.argv[1:], '', [])

    # Generate absolute path name
    if not args:
        raise Exception('Usage: python parse.py <filename>')
    pathname = os.path.abspath(args[0])

    # If pathname is a directory, iterate over all top level python files
    if os.path.isdir(pathname):
        data = [
            parse_file(filename)
            for filename in map(
                lambda f: os.path.join(pathname, f),
                os.listdir(pathname)
            )
            if os.path.isfile(filename)
            and os.path.splitext(filename)[1] in EXTENSIONS
        ]
    # If pathname is a file, attempt to parse it
    elif os.path.isfile(pathname):
        data = [parse_file(pathname)]
    else:
        raise Exception('{} is not a directory or file.'.format(pathname))

    # Raise exception if no files found.
    if not data:
        raise Exception('No files found to parse.')

    # Print to stdout
    print(json.dumps({
        'language': {
            'name': LANGUAGE,
            'version_major': PYTHON_MAJOR,
            'version_minor': PYTHON_MINOR,
            'version': '{}.{}'.format(PYTHON_MAJOR, PYTHON_MINOR),
            'system': 'pip',
            'jupyter': any(
                parse['filename'].endswith(JUPYTER_EXT) for parse in data
            ),
        },
        'num_files': len(data),
        'files': data
    }))


# If name is main, run main func
if __name__ == '__main__':
    main()

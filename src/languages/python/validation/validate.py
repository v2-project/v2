"""Validate a Python snippet with a given set of dependencies."""


# Future
from __future__ import with_statement


# Imports
from contextlib import contextmanager
from copy import deepcopy
from glob import glob
from itertools import chain
from pprint import pformat
import argparse
import ast
import json
import logging
import os
import signal
import subprocess
import sys
import traceback


# Configure logging
logging.basicConfig(format='%(asctime)-15s %(message)s', stream=sys.stderr)
logger = logging.getLogger('test_gist')
logger.setLevel(logging.INFO)


# Constants
PYTHON_MAJOR = sys.version_info[0]


# Timeouts
SNIPPET_TIMEOUT_SECONDS = 60
JUPYTER_BASE_TIMEOUT_SECONDS = 120
JUPYTER_CELL_TIMEOUT_SECONDS = 60


# Supported file extensions
EXTENSIONS = ('.py', '.ipynb')


# Status codes
SUCCESS = 'Success'
FAILED = 'Failed'
TIMEOUT = 'Timeout'
UNKNOWN_EXCEPTION = 'UnknownException'
EXCEPTION = 'Exception'


# Jupyter constants
NBFORMAT_V4 = 4
KERNEL = 'python{}'.format(PYTHON_MAJOR)
CELLS = 'cells'
CELL_TYPE = 'cell_type'
CODE = 'code'
EXECUTION_COUNT = 'execution_count'
METADATA = 'metadata'
OUTPUTS = 'outputs'
OUTPUT_TYPE = 'output_type'
SOURCE = 'source'
ERROR = 'error'
TRACEBACK = 'traceback'
ENAME = 'ename'
EVALUE = 'evalue'


# Result keys
STATUS_CODE = 'status_code'
EXCEPTION_NAME = 'exception_name'
EXCEPTION_MESSAGE = 'exception_message'
EXCEPTION_FILE_NAME = 'exception_file_name'
EXCEPTION_LINE_NUMBER = 'exception_line_number'
EXCEPTION_LINE = 'exception_line'
EXCEPTION_STACK = 'exception_stack'
INSTALL_ERRORS = 'install_errors'
DEPENDENCIES = 'dependencies'
EXECUTION = 'execution'


class Timeout:
    """Timeout class.

    Taken from StackOverflow: https://stackoverflow.com/a/22348885
    """

    def __init__(self, seconds=SNIPPET_TIMEOUT_SECONDS, error_message=TIMEOUT):
        self.seconds = seconds
        self.error_message = error_message

    def handle_timeout(self, signum, frame):
        logger.info('Timeout encountered')
        raise TimeoutError(self.error_message)

    def __enter__(self):
        signal.signal(signal.SIGALRM, self.handle_timeout)
        signal.alarm(self.seconds)

    def __exit__(self, type, value, traceback):
        signal.alarm(0)


# If TimeoutError is not already defined (Python 2), create it.
try:
    TimeoutError
except NameError:
    class TimeoutError(OSError):
        """Exception class representing a timeout."""


@contextmanager
def exec_stdio():
    """Redirect stdout to stderr.

    Context manager used when invoking exec to redirect the executed code's
    stdout to stderr for logging.
    """
    # Save reference to standard out
    stdout = sys.stdout

    # Redirect to stderr and yield
    sys.stdout = sys.stderr

    # Yield, then reset to original
    try:
        yield
    finally:
        sys.stdout = stdout


def _get_exception_information(code=UNKNOWN_EXCEPTION, no_validation=False):
    """Get current exception information.

    Parameters
    ----------
    code : str
        Exception status code
    no_validation : bool
        If True, leading stack frames belonging to the validation script will
        be removed.

    Returns
    -------
    dict
        JSON serializable exception information.
    """
    # Define traceback for deletion in case sys.exc_info()
    # somehow raises an exception
    e_traceback = None

    try:

        # Get current exception information
        e_type, e_value, e_traceback = sys.exc_info()

        # Get a stack summary for the exception traceback
        stack_summary = list(map(list, traceback.extract_tb(e_traceback)))

        # If no validation is requested, remove all leading stack frames
        # belonging to the validation script.
        if no_validation:
            while stack_summary and stack_summary[0][0] == __file__:
                stack_summary.pop(0)

        # SyntaxError happens in the interpreter and has metadata attached to
        # it, so it's parsed differently than other exceptions.
        # https://docs.python.org/3.7/library/exceptions.html#SyntaxError
        if isinstance(e_value, SyntaxError):

            # Get metadata directly from exception
            filename = e_value.filename
            lineno = e_value.lineno
            line = e_value.text

            # Push metadata to stack summary. This simulates the exception
            # being produced by the module containing the syntax error. While,
            # this is not technically how Python operates, it is useful for
            # our purposes to treat it like this.
            stack_summary.append([filename, lineno, '<module>', line])

        # Otherwise, get information from the traceback.
        else:

            filename, lineno, name, line = stack_summary[-1]

        # Return parsed exception
        return {
            STATUS_CODE: code,
            EXCEPTION_NAME: e_type.__name__,
            EXCEPTION_MESSAGE: _string(e_value),
            EXCEPTION_FILE_NAME: filename,
            EXCEPTION_LINE_NUMBER: lineno,
            EXCEPTION_LINE: line,
            EXCEPTION_STACK: stack_summary
        }

    finally:

        # Delete circular reference (Python 2). See traceback warning
        # https://docs.python.org/2/library/sys.html#sys.exc_info
        del e_traceback


def _string(data, encoding='utf-8'):
    """Coerce input into a string."""
    if isinstance(data, str):
        return data
    if isinstance(data, bytes):
        return bytes.decode(data, encoding=encoding)
    else:
        return str(data)


def run_install_commands(commands):
    """Run install commands."""
    # Log
    logger.info('Executing run commands to install dependencies.')

    # Execute each command
    try:

        # Build result object
        result = {STATUS_CODE: SUCCESS, INSTALL_ERRORS: []}

        for command_str in commands:

            # Log
            logger.info('Executing command: {}'.format(command_str))

            # Run install command
            command = command_str.split()
            proc = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            stdout, stderr = map(_string, proc.communicate())

            # If a command fails, note the exception
            if proc.returncode:

                logger.info('Install failed with the following output.')
                logger.info('Stdout:\n{}'.format(stdout))
                logger.info('Stderr:\n{}'.format(stderr))

                result['status_code'] = 'Exception'
                result['install_errors'].append((stdout, stderr))

        return result

    except BaseException as e:

        logger.info('Unknown error on install')
        logger.error(e)

        return _get_exception_information(code=UNKNOWN_EXCEPTION)


def execute_python_snippet(snippet):
    """Execute a snippet and return the execution result."""
    # Log
    logger.info('Executing snippet')

    # Execute
    try:

        # Open snippet, set timeout, redirect stdio, compile, and execute.
        with open(snippet) as snippet_fd, Timeout(), exec_stdio():
            # TODO When specifying a new globals dict, Python executes the code
            #      as a new module, not __main__. This is usually fine, but can
            #      break `from __main__ import *`, which is common for timeit.
            code = compile(snippet_fd.read(), mode='exec', filename=snippet)
            exec(code, {'__name__': '__main__'})

    except TimeoutError:

        logger.info('Execution timed out')
        return {STATUS_CODE: TIMEOUT}

    except BaseException as e:

        logger.info('Execution produced an exception.')
        logger.error(e)
        return _get_exception_information(code=EXCEPTION, no_validation=True)

    else:

        # Log
        logger.info('Execution succeeded')
        return {STATUS_CODE: SUCCESS}


def execute_jupyter_notebook(notebook):
    """Execute a jupyter notebook and return the execution result."""
    # Import Jupyter tools. Done in Jupyter scope so that they do not need to
    # be installed while validating plain Python snippets.
    import nbformat
    from nbconvert.preprocessors import CellExecutionError, ExecutePreprocessor

    # Execute
    try:

        # Open notebook file and read into a notebook object
        # The notebook object is automatically converted to version 4 because
        # nbconvert will only handle the most recent notebook format
        # https://github.com/ipython/ipython/issues/6992#issuecomment-63746907
        with open(notebook, 'r') as fd:
            original_nb = nbformat.read(fd, as_version=NBFORMAT_V4)

        # Make sure that cells exists
        if CELLS not in original_nb:
            original_nb[CELLS] = []

        # Create a copy of the original notebook and clean any previous
        # execution outputs and metadata from cells. We do this so that after
        # execution, we're guaranteed that the outputs present are from us
        # running the cells in order, not old execution results.
        nb = deepcopy(original_nb)
        for cell in nb[CELLS]:
            if cell[CELL_TYPE] == CODE:
                cell[EXECUTION_COUNT] = None
                cell[METADATA] = {}
                cell[OUTPUTS] = []

        # Create execution preprocessor.
        # timeout=None disables cell execution timeout. We disable cell timeout
        # in Jupyter because we want to measure timeout of the entire notebook.
        preprocessor = ExecutePreprocessor(
            kernel_name=KERNEL,
            timeout=None,
            extra_arguments=[
                '--InteractiveShellApp.extra_extension=exception_handler',
                '--colors=NoColor',
            ]
        )

        # Run notebook
        try:

            # Set allowed timeout seconds to be JUPYTER_BASE_TIMEOUT_SECONDS
            # plus an additional JUPYTER_CELL_TIMEOUT_SECONDS for each cell.
            # Jupyter notebooks often take longer to run that snippets.
            seconds = (
                JUPYTER_BASE_TIMEOUT_SECONDS
                + JUPYTER_CELL_TIMEOUT_SECONDS * len(nb[CELLS])
            )

            # Execute with timeout.
            logger.info(
                'Running ExecutePreprocessor on notebook with {} '
                'second timeout.'.format(seconds)
            )
            with Timeout(seconds=seconds):
                preprocessor.preprocess(nb, {})

            # Return success
            logger.info('Execution succeeded')
            return {STATUS_CODE: SUCCESS}

        except TimeoutError:

            logger.info('Execution timed out')
            return {STATUS_CODE: TIMEOUT}

        except CellExecutionError:

            # CellExecutionError indicates that one of the cells from
            # the notebook has an error output. Look for the first error
            # output from an executed code cell. We do this to get the
            # error name, message, and traceback in a structured format.
            logger.info('CellExecutionError, parsing root error')

            # Get all notebook code cells
            code_cells = list(
                cell
                for cell in nb[CELLS]
                if cell[CELL_TYPE] == CODE
            )

            # Find the first error output
            lines = 0
            error = None
            for cell in code_cells:

                # Look for an error output from the cell
                error_output = next(
                    (o for o in cell[OUTPUTS] if o[OUTPUT_TYPE] == ERROR),
                    None
                )

                # If there was an error output, save it. Otherwise, increment
                # the total number of source lines seen.
                if error_output:
                    error = error_output
                    break
                else:
                    lines += len(cell[SOURCE].split('\n'))

            # Raise exception if unable to find the error output.
            if not error:
                raise Exception('Unable to find notebook error output')

            # And parse the stack
            stack = list(map(ast.literal_eval, error[TRACEBACK]))

            # Override the file name for the input script
            stack[0][0] = notebook

            # Increment the line number to include all lines in earlier cells
            stack[0][1] += lines

            # Get the summary for the line that raised the exception
            e_filename, e_lineno, _, e_line = stack[-1]

            # Return status
            return {
                STATUS_CODE: EXCEPTION,
                EXCEPTION_NAME: error[ENAME],
                EXCEPTION_MESSAGE: error[EVALUE],
                EXCEPTION_FILE_NAME: e_filename,
                EXCEPTION_LINE_NUMBER: e_lineno,
                EXCEPTION_LINE: e_line,
                EXCEPTION_STACK: stack
            }

    except BaseException as e:

        logger.info('Execution produced an exception.')
        logger.error(e)
        return _get_exception_information(code=UNKNOWN_EXCEPTION)


def validate(snippet, dependencies):
    """Run gist tests"""
    # If the snippet path provided is a directory, look for an executable
    # entrypoint. We can infer one under two cases.
    # 1. There is only one file within the directory.
    # 2. There is a __main__.py file within the directory.
    if os.path.isdir(snippet):

        logger.info('Snippet path is a directory, searching for files')
        files = list(chain.from_iterable(
            glob(os.path.join(snippet, '*' + extension))
            for extension in EXTENSIONS)
        )
        logger.info(files)

        if len(files) == 1:
            logger.info('Found exactly one file.')
            snippet = files[0]
        elif any(filter(lambda f: f.endswith('__main__.py'), files)):
            logger.info('Found a main module')
            snippet = os.path.join(snippet, '__main__.py')
        else:
            raise ValueError(
                'Snippet path is a directory without an obvious entrypoint '
                '(a single file or a __main__.py).'
            )

    # Get snippet extension.
    _, fext = os.path.splitext(snippet)
    if fext not in EXTENSIONS:
        raise ValueError('Unsupported file type')

    # Log snippet
    logger.info('Running tests on: {}'.format(snippet))
    logger.info('Dependencies: \n{}'.format(pformat(dependencies, indent=4)))

    # Run tests
    try:

        # Run install commands for all dependencies
        install_result = run_install_commands(dependencies)

        # Execute the snippet
        if fext == '.py':
            exec_result = execute_python_snippet(snippet)
        else:
            exec_result = execute_jupyter_notebook(snippet)

        # Determine evaluation status code
        if exec_result[STATUS_CODE] == SUCCESS:
            status = SUCCESS
        elif exec_result[STATUS_CODE] == TIMEOUT:
            status = TIMEOUT
        else:
            status = FAILED

        # Return result dictionary
        return {
            STATUS_CODE: status,
            DEPENDENCIES: install_result,
            EXECUTION: exec_result
        }

    except BaseException as e:

        # Log error
        logger.error('Unknown Error: ' + type(e).__name__)
        return _get_exception_information(code=UNKNOWN_EXCEPTION)


def main():
    """Parse arguments and run snippet tests."""
    # Get argv
    parser = argparse.ArgumentParser()
    parser.add_argument(
        'snippet',
        type=str,
        help='Path to Python snippet under test'
    )
    parser.add_argument(
        'dependencies',
        type=str,
        help='Semicolon delimited list of install '
             'commands for snippet dependencies'
    )
    argv = parser.parse_args()

    # Convert dependencies to a list
    argv.dependencies = list(filter(
        lambda v: v,
        map(lambda d: d.strip(), argv.dependencies.split(','))
    ))

    # Run snippet test
    result = validate(snippet=argv.snippet, dependencies=argv.dependencies)

    # Print result to stdout
    logger.info('Printing to stdout.')
    print(json.dumps(result))


# Invoke main
if __name__ == '__main__':
    main()

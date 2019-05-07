"""Exception handler for formatting IPython tracebacks."""


# Imports
import sys
import traceback


# IPython path prefix
IPYTHON = (
    '/usr/local/lib/python{}.{}/site-packages/IPython'
    .format(sys.version_info.major, sys.version_info.minor)
)


def handler(self, etype, value, tb, tb_offset=None):
    """Handle exceptions by generating a parseable traceback.

    IPython requires the traceback to be a list of string. This method formats
    a stack summary as a list where each frame summary object has been cast to
    a list and serialized using repr so it can be reconstructed using
    ast.literal_eval.

    The formatted traceback is passed along to self._showtraceback to delegate
    to the original message passing behavior for Jupyter.

    Internally, Jupyter is running an instance of ZMQShell.
    https://github.com/ipython/ipykernel/blob/f0f6cd8b8c9f74ea8b2c5e37b6132212ce661c28/ipykernel/zmqshell.py#L538

    The overridden _showtraceback method is originally called via
    InteractiveShell.showtraceback during its cell execution:
    run_cell > run_ast_nodes > run_code
    """
    stack_summary = list(map(list, traceback.extract_tb(tb)))

    # Augment syntax error information if available.
    if isinstance(value, SyntaxError):
        stack_summary.append(
            [value.filename, value.lineno, '<module>', value.text]
        )

    # Remove leading IPython stack frames
    while stack_summary and stack_summary[0][0].startswith(IPYTHON):
        stack_summary.pop(0)

    # Format and show structured traceback
    stb = list(map(lambda f: repr(list(f)), stack_summary))
    self._showtraceback(etype, value, stb)


def load_ipython_extension(ipython):
    """Load IPython extension.

    Register a custom exception handler for BaseException to handle all
    exceptions that occur during execution.

    https://ipython.readthedocs.io/en/stable/config/extensions/#writing-extensions
    """
    ipython.set_custom_exc((BaseException,), handler)


def unload_ipython_extension(ipython):
    """Unload IPython extension.

    Unregister the custom exception handler. IPython doesn't appear to have
    built in support for this, so we set the custom function and exception
    attributes to none.

    https://github.com/ipython/ipython/blob/f0f6cd8b8c9f74ea8b2c5e37b6132212ce661c28/IPython/core/interactiveshell.py#L1921
    """
    ipython.CustomTB = None
    ipython.custom_exceptions = None

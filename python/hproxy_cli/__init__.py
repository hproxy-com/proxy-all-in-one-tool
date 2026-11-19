"""The hproxy command-line tool, installed with pip.

The wheel carries the tool itself, one program for your system, installed as the command `hproxy`
beside your environment's other scripts. From Python, find_hproxy_bin() gives its path, and
`python -m hproxy_cli` runs it:

    import subprocess
    from hproxy_cli import find_hproxy_bin

    subprocess.run([find_hproxy_bin(), "check", "--file", "proxies.txt", "--alive"], check=True)
"""

import os
import sys
import sysconfig

__version__ = "@VERSION@"

__all__ = ["find_hproxy_bin", "__version__"]


def _user_scheme() -> str:
    if sys.version_info >= (3, 10):
        return sysconfig.get_preferred_scheme("user")
    if os.name == "nt":
        return "nt_user"
    if sys.platform == "darwin" and getattr(sys, "_framework", None):
        return "osx_framework_user"
    return "posix_user"


def _places(exe: str):
    # Where pip puts scripts: the environment, then a --user install.
    yield os.path.join(sysconfig.get_path("scripts"), exe)
    try:
        yield os.path.join(sysconfig.get_path("scripts", scheme=_user_scheme()), exe)
    except KeyError:
        pass
    # pip install --target <dir>: the scripts land in <dir>/bin, beside this package.
    yield os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", exe)


def find_hproxy_bin() -> str:
    """The path of the hproxy program this package installed."""
    exe = "hproxy.exe" if sys.platform == "win32" else "hproxy"
    for path in _places(exe):
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(
        f"the {exe} program of hproxy-cli {__version__} is missing; reinstall the package, or get the "
        "tool from https://github.com/hproxy-com/proxy-all-in-one-tool#command-line"
    )

"""python -m hproxy_cli: runs the hproxy program with the same arguments."""

import os
import subprocess
import sys

from hproxy_cli import find_hproxy_bin


def main() -> None:
    hproxy = find_hproxy_bin()
    if sys.platform == "win32":
        # Windows has no exec: run it, and hand its exit code on.
        sys.exit(subprocess.call([hproxy, *sys.argv[1:]]))
    os.execv(hproxy, [hproxy, *sys.argv[1:]])


if __name__ == "__main__":
    main()

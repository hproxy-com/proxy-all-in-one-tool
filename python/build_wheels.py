#!/usr/bin/env python3
"""Wheels of the hproxy command-line tool for pip, made from the files of one release.

The tool is one Rust program per system and processor, built and proven by cli-release.yml and
published as the release cli-v<version> with its SHA-256 sums. A wheel carries one of those files
unchanged, which pip installs as the command `hproxy` beside the environment's other scripts, and
the small package hproxy_cli, which finds it (`python -m hproxy_cli` runs it). pip picks the wheel
for the machine it runs on by the platform tag in the wheel's name. The Linux files are static
(they carry their own C library), so the same file serves glibc systems (manylinux) and Alpine
(musllinux), each through a wheel of its own.

    python3 build_wheels.py <version> <release-dir> <out-dir>

<release-dir> holds the release's files and its SHA256SUMS; a file whose sum differs stops the
build. Standard library only: the build needs nothing installed. The wheels are reproducible: the
same release gives the same bytes.
"""

import base64
import hashlib
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAME = "hproxy-cli"  # the name on PyPI
NORMAL = "hproxy_cli"  # the same, as wheel file names spell it
STAMP = (1980, 1, 1, 0, 0, 0)  # every file's date in the zip, so a build is reproducible

# A release file, and the platform tags of the wheels that carry it (PEP 425, 600, 656).
WHEELS = {
    "hproxy-cli-linux-x86_64": ["manylinux_2_17_x86_64.manylinux2014_x86_64", "musllinux_1_1_x86_64"],
    "hproxy-cli-linux-arm64": ["manylinux_2_17_aarch64.manylinux2014_aarch64", "musllinux_1_1_aarch64"],
    # Built for ARMv6, so it runs on every 32-bit Raspberry Pi; PyPI knows no ARMv6 tag, so pip on
    # ARMv7 takes it, and a Pi Zero or Pi 1 installs the tool with install.sh instead.
    "hproxy-cli-linux-armv6": ["manylinux_2_17_armv7l.manylinux2014_armv7l", "musllinux_1_1_armv7l"],
    "hproxy-cli-linux-i686": ["manylinux_2_17_i686.manylinux2014_i686", "musllinux_1_1_i686"],
    "hproxy-cli-macos-arm64": ["macosx_11_0_arm64"],
    "hproxy-cli-macos-x86_64": ["macosx_10_13_x86_64"],
    "hproxy-cli-windows-x86_64.exe": ["win_amd64"],
    "hproxy-cli-windows-arm64.exe": ["win_arm64"],
    "hproxy-cli-windows-x86.exe": ["win32"],
}

SUMMARY = (
    "The hproxy command-line tool: check proxies, run a rotating proxy over your own list, "
    "and switch it to a new IP from any script."
)

CLASSIFIERS = [
    "Development Status :: 4 - Beta",
    "Environment :: Console",
    "Intended Audience :: Developers",
    "License :: OSI Approved :: MIT License",
    "Operating System :: MacOS",
    "Operating System :: Microsoft :: Windows",
    "Operating System :: POSIX :: Linux",
    "Programming Language :: Rust",
    "Topic :: Internet :: Proxy Servers",
    "Topic :: Internet :: WWW/HTTP",
]


def metadata(version: str) -> str:
    lines = [
        "Metadata-Version: 2.1",
        f"Name: {NAME}",
        f"Version: {version}",
        f"Summary: {SUMMARY}",
        "Home-page: https://hproxy.com",
        "Author: HProxy",
        "Author-email: HProxy <support@hproxy.com>",
        "License: MIT",
        "Project-URL: Source, https://github.com/hproxy-com/proxy-all-in-one-tool/tree/main/python",
        "Project-URL: Documentation, https://github.com/hproxy-com/proxy-all-in-one-tool/blob/main/source-code/README.md#command-line",
        "Project-URL: Releases, https://github.com/hproxy-com/proxy-all-in-one-tool/releases",
        "Keywords: proxy,proxy-checker,rotating-proxy,socks5,http-proxy,web-scraping,cli",
        *(f"Classifier: {c}" for c in CLASSIFIERS),
        "Requires-Python: >=3.8",
        "Description-Content-Type: text/markdown",
    ]
    readme = (HERE / "README.md").read_text(encoding="utf-8")
    return "\n".join(lines) + "\n\n" + readme


def wheel_file(platform: str) -> str:
    tags = [f"Tag: py3-none-{p}" for p in platform.split(".")]
    return "\n".join(["Wheel-Version: 1.0", "Generator: hproxy build_wheels.py", "Root-Is-Purelib: false", *tags]) + "\n"


def record_line(path: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(data)}"


def build_wheel(version: str, binary: bytes, exe: str, platform: str, out: Path) -> Path:
    dist_info = f"{NORMAL}-{version}.dist-info"
    package = HERE / "hproxy_cli"
    init = (package / "__init__.py").read_text(encoding="utf-8").replace("@VERSION@", version)
    files = [
        ("hproxy_cli/__init__.py", init.encode(), 0o644),
        ("hproxy_cli/__main__.py", (package / "__main__.py").read_bytes(), 0o644),
        (f"{NORMAL}-{version}.data/scripts/{exe}", binary, 0o755),
        (f"{dist_info}/METADATA", metadata(version).encode(), 0o644),
        (f"{dist_info}/WHEEL", wheel_file(platform).encode(), 0o644),
        (f"{dist_info}/LICENSE", (HERE.parent / "LICENSE").read_bytes(), 0o644),
    ]
    record = "\n".join([*(record_line(p, d) for p, d, _ in files), f"{dist_info}/RECORD,,"]) + "\n"
    files.append((f"{dist_info}/RECORD", record.encode(), 0o644))

    path = out / f"{NORMAL}-{version}-py3-none-{platform}.whl"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as whl:
        for name, data, mode in files:
            info = zipfile.ZipInfo(name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100000 | mode) << 16  # a regular file, with its permissions
            whl.writestr(info, data)
    return path


def sums(release: Path) -> dict:
    out = {}
    for line in (release / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        if line.strip():
            digest, name = line.split(maxsplit=1)
            out[name.lstrip("*")] = digest.lower()
    return out


def main(argv) -> int:
    if len(argv) != 4:
        print(__doc__)
        return 2
    version, release, out = argv[1], Path(argv[2]), Path(argv[3])
    known = sums(release)
    out.mkdir(parents=True, exist_ok=True)
    for name, platforms in WHEELS.items():
        binary = (release / name).read_bytes()
        if hashlib.sha256(binary).hexdigest() != known.get(name):
            print(f"{name}: its SHA-256 is not the one in SHA256SUMS; nothing is built", file=sys.stderr)
            return 1
        exe = "hproxy.exe" if name.endswith(".exe") else "hproxy"
        for platform in platforms:
            wheel = build_wheel(version, binary, exe, platform, out)
            print(f"{wheel.name}  ({len(binary) // 1024} KB tool)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

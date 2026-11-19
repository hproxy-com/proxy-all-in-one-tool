# hproxy for Nix

The hproxy command-line tool as a Nix flake: the very file of the GitHub release for your system, fetched by
its SHA-256. Check proxies in any shape a provider prints, run a rotating proxy on your machine over your own
list, and switch it to a new IP from any script.

```sh
nix run 'github:hproxy-com/proxy-all-in-one-tool?dir=nix' -- check --file proxies.txt --alive
nix profile install 'github:hproxy-com/proxy-all-in-one-tool?dir=nix'
```

In your own flake, for NixOS or Home Manager:

```nix
{
  inputs.hproxy.url = "github:hproxy-com/proxy-all-in-one-tool?dir=nix";
  inputs.hproxy.inputs.nixpkgs.follows = "nixpkgs";

  # then, in a module: environment.systemPackages = [ inputs.hproxy.packages.${pkgs.system}.default ];
}
```

| System | Processors |
| --- | --- |
| Linux | x86_64, ARM64, 32-bit ARM, 32-bit x86, RISC-V |
| macOS | Apple Silicon |

Nixpkgs 26.11 no longer supports Intel Macs. There, `brew install hproxy-com/tap/hproxy` installs the same
program, or [the installer](../macOS/).

The version and the hashes in [flake.nix](flake.nix) change with every
[command-line release](https://github.com/hproxy-com/proxy-all-in-one-tool/releases). Each time,
[the workflow](../.github/workflows/nix.yml) has Nix check the flake for every system, build and run it on Linux
and macOS, and compare the program with the release's file. The commands are in
[source-code/README.md](../source-code/README.md#command-line).

MIT license.

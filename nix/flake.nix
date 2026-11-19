# hproxy for Nix: the hproxy command-line tool, the very file of the GitHub release cli-v0.4.9 for each system,
# fetched by its SHA-256. Rewritten for every command-line release from that release's SHA256SUMS
# (https://github.com/hproxy-com/proxy-all-in-one-tool/releases/tag/cli-v0.4.9); changes by hand are replaced.
#
#   nix run 'github:hproxy-com/proxy-all-in-one-tool?dir=nix' -- --help
#   nix profile install 'github:hproxy-com/proxy-all-in-one-tool?dir=nix'
{
  description = "hproxy: check proxies, run a rotating proxy over your own list, switch it to a new IP from any script";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      version = "0.4.9";
      release = "https://github.com/hproxy-com/proxy-all-in-one-tool/releases/download/cli-v${version}";
      files = {
        x86_64-linux = {
          name = "hproxy-cli-linux-x86_64";
          hash = "sha256-yxftEo3y2OhRsqUPxz1QgWrqGgTRlZmjtUjNxXm/07Q=";
        };
        aarch64-linux = {
          name = "hproxy-cli-linux-arm64";
          hash = "sha256-admbtQS4/PvV48vx3tr+FZhTjRUR+Fz262vDeVOawew=";
        };
        armv7l-linux = {
          name = "hproxy-cli-linux-armv6";
          hash = "sha256-VJJx0klBObkA3OEv+pKqL9F14uabW782cv16Pr2kD6Y=";
        };
        armv6l-linux = {
          name = "hproxy-cli-linux-armv6";
          hash = "sha256-VJJx0klBObkA3OEv+pKqL9F14uabW782cv16Pr2kD6Y=";
        };
        i686-linux = {
          name = "hproxy-cli-linux-i686";
          hash = "sha256-jAyGwXc0caZHtIsn8J2ANxYo6HQwbGw28bu072+GeFk=";
        };
        riscv64-linux = {
          name = "hproxy-cli-linux-riscv64";
          hash = "sha256-iINd3dAJiWFk73ybdh4ZUqbxTIVxzHnNM6YH3KZFqSE=";
        };
        x86_64-darwin = {
          name = "hproxy-cli-macos-x86_64";
          hash = "sha256-NXHwBL7SiAWd04cn4Q1d93WgY0CfvT5oGzpya2ruqwc=";
        };
        aarch64-darwin = {
          name = "hproxy-cli-macos-arm64";
          hash = "sha256-APM2NS4YjAaTqu3DDaICz38fkBPodDsczqEOMoFds4Y=";
        };
      };
      forEachSystem =
        f: nixpkgs.lib.genAttrs (builtins.attrNames files) (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forEachSystem (
        system: pkgs: rec {
          hproxy = pkgs.stdenvNoCC.mkDerivation {
            pname = "hproxy";
            inherit version;
            src = pkgs.fetchurl {
              url = "${release}/${files.${system}.name}";
              inherit (files.${system}) hash;
            };
            dontUnpack = true;
            # The release's file as it was built and checked: no strip, no patch.
            dontFixup = true;
            installPhase = ''
              runHook preInstall
              install -Dm755 "$src" "$out/bin/hproxy"
              runHook postInstall
            '';
            meta = {
              description = "Proxy checker and rotating local proxy over your own proxy list, with a new IP from any script";
              homepage = "https://github.com/hproxy-com/proxy-all-in-one-tool";
              changelog = "https://github.com/hproxy-com/proxy-all-in-one-tool/releases/tag/cli-v${version}";
              license = nixpkgs.lib.licenses.mit;
              sourceProvenance = [ nixpkgs.lib.sourceTypes.binaryNativeCode ];
              platforms = builtins.attrNames files;
              mainProgram = "hproxy";
            };
          };
          default = hproxy;
        }
      );
    };
}

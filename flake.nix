{
  description = "Better Trove Tools + the Python deps it needs that aren't in nixpkgs yet";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";

      # Inject the not-yet-in-nixpkgs Python modules into *every* interpreter's
      # package set, so `python3Packages.eel` etc. resolve. This is exactly the
      # shape you'd upstream: each file below can be dropped into
      # pkgs/development/python-modules/<name>/package.nix unchanged.
      overlay = final: prev: {
        pythonPackagesExtensions = prev.pythonPackagesExtensions ++ [
          (pyfinal: pyprev: {
            gevent-websocket = pyfinal.callPackage ./pkgs/gevent-websocket.nix { };
            bottle-websocket = pyfinal.callPackage ./pkgs/bottle-websocket.nix { };
            eel = pyfinal.callPackage ./pkgs/eel.nix { };
            binary-reader = pyfinal.callPackage ./pkgs/binary-reader.nix { };
          })
        ];
      };

      pkgs = import nixpkgs {
        inherit system;
        overlays = [ overlay ];
      };
    in
    {
      packages.${system} = {
        default = self.packages.${system}.better-trove-tools;

        # `src = self` builds whatever ref you point the flake at:
        # `github:AallynReed/BetterTroveTools` builds the branch tip,
        # `github:AallynReed/BetterTroveTools/2026.07.03` builds that tag.
        # No fetchFromGitHub hash to bump on every release.
        better-trove-tools = pkgs.callPackage ./pkgs/better-trove-tools.nix { src = self; };

        # Handy for testing the deps in isolation: `nix build .#eel` etc.
        inherit (pkgs.python3Packages)
          eel
          bottle-websocket
          gevent-websocket
          binary-reader
          ;
      };
    };
}

{
  description = "Better Trove Tools: a desktop companion for Trove (Rust + Tauri)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      packages.${system} = {
        default = self.packages.${system}.better-trove-tools;

        # `src = self` builds whatever ref the flake points at (branch tip or a release tag).
        better-trove-tools = pkgs.callPackage ./pkgs/better-trove-tools.nix { src = self; };
      };
    };
}

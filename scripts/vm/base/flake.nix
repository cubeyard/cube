{
  # The cube BASE image: the entire OS layer as a declarative NixOS
  # config, built reproducibly by CI/dev with `nix build`.
  #
  # Built with systemd-repart (nixos/modules/image/repart.nix), NOT
  # nixos-generators: the latter builds the disk inside a QEMU VM, so its
  # derivation carries requiredSystemFeatures=["kvm"] and cannot run on a
  # GitHub arm64 runner (those have no /dev/kvm). repart assembles the
  # image in an ordinary sandbox, so every artifact is CI-buildable on
  # the runner of its own architecture.
  description = "cube base image (NixOS, repart-built)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = nixpkgs.lib.genAttrs systems;

      cubeSystem = system: nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          "${nixpkgs}/nixos/modules/image/repart.nix"
          ./configuration.nix
        ];
      };
    in
    {
      nixosConfigurations = forAll cubeSystem;

      # The launcher and the dev loop boot qcow2, so convert here — a
      # plain derivation (qemu-img on a file), no VM, no KVM.
      packages = forAll (system:
        let
          nixos = cubeSystem system;
          pkgs = nixpkgs.legacyPackages.${system};
          raw = nixos.config.system.build.image;
        in
        {
          image = pkgs.runCommand "cube-base.qcow2"
            { nativeBuildInputs = [ pkgs.qemu-utils ]; }
            ''
              mkdir -p $out
              qemu-img convert -f raw -O qcow2 \
                ${raw}/${nixos.config.image.filePath} $out/cube-base.qcow2
            '';
          default = self.packages.${system}.image;
        });
    };
}

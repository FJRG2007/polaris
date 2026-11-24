{
  description = "Rook is an agentic development environment, born out of the terminal (Experimental Nix Support, Linux-only).";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    crane.url = "github:ipetkov/crane";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      crane,
      rust-overlay,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
          lib = pkgs.lib;
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
          rustPlatform = pkgs.makeRustPlatform {
            cargo = rustToolchain;
            rustc = rustToolchain;
          };
          craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
          appCargoToml = builtins.fromTOML (builtins.readFile ./app/Cargo.toml);
          version = "${appCargoToml.package.version}+${self.shortRev or "dirty"}";
          src = self;
          cargoLock = ./Cargo.lock;
          # Match Zed's approach: derive the main app vendor directory from
          # Cargo.lock instead of maintaining a top-level cargoVendorHash.
          cargoVendorDir =
            let
              craneVendorDir = craneLib.vendorCargoDeps {
                inherit src cargoLock;
                overrideVendorGitCheckout =
                  crates: drv:
                  let
                    hasCrate = crateName: builtins.any (crate: crate.name == crateName) crates;
                  in
                  drv.overrideAttrs (old: {
                    postPatch = (old.postPatch or "") + ''
                      find . -name 'Cargo.toml.orig' -delete

                      ${lib.optionalString (hasCrate "warp_multi_agent_api") ''
                        mkdir -p apis/multi_agent/v1/gen/rust/nix-vendored-protos
                        cp apis/multi_agent/v1/*.proto \
                          apis/multi_agent/v1/gen/rust/nix-vendored-protos/
                        substituteInPlace apis/multi_agent/v1/gen/rust/build.rs \
                          --replace-fail \
                            'let proto_path = manifest_dir.parent().unwrap().parent().unwrap();' \
                            'let proto_path = manifest_dir.join("nix-vendored-protos");'
                      ''}

                      ${lib.optionalString (hasCrate "warp-workflows") ''
                        mkdir -p workflows/nix-vendored-specs
                        cp -R specs/. workflows/nix-vendored-specs/
                        substituteInPlace workflows/build.rs \
                          --replace-fail \
                            'println!("cargo:rerun-if-changed=../specs");' \
                            'println!("cargo:rerun-if-changed=nix-vendored-specs");' \
                          --replace-fail \
                            'for entry in WalkDir::new("../specs") {' \
                            'for entry in WalkDir::new("nix-vendored-specs") {'
                      ''}
                    '';
                  });
              };
            in
            # crane writes a root config.toml; buildRustPackage expects the
            # cargoDeps layout to include .cargo/config.toml and Cargo.lock.
            pkgs.runCommand "rook-terminal-experimental-${version}-cargo-vendor" { } ''
              cp -R ${craneVendorDir}/. "$out"
              chmod u+w "$out"
              mkdir -p "$out/.cargo"
              sed 's|${craneVendorDir}|@vendor@|g' \
                "$out/config.toml" > "$out/.cargo/config.toml"
              rm "$out/config.toml"
              cp ${cargoLock} "$out/Cargo.lock"
            '';

          linuxRuntimeLibraries = with pkgs; [
            alsa-lib
            curl
            dbus
            expat
            fontconfig
            freetype
            libGL
            libgit2
            libxkbcommon
            openssl
            stdenv.cc.cc.lib
            udev
            vulkan-loader
            wayland
            libx11
            libxscrnsaver
            libxcursor
            libxext
            libxfixes
            libxi
            libxrandr
            libxrender
            libxcb
            zlib
          ];

          buildFeatures = [
            "release_bundle"
            "gui"
          ];

          rook-terminal-experimental = rustPlatform.buildRustPackage {
            pname = "rook-terminal-experimental";
            inherit version;

            inherit src;
            cargoDeps = cargoVendorDir;

            nativeBuildInputs = with pkgs; [
              brotli
              cargo-about
              clang
              cmake
              jq
              makeWrapper
              patchelf
              pkg-config
              protobuf
              python3
            ];

            buildInputs = linuxRuntimeLibraries;

            cargoBuildFlags = [
              "-p"
              "rook"
              "--bin"
              "rook-oss"
            ];
            inherit buildFeatures;

            # The application test suite is large and GUI/integration-heavy; this
            # flake's package check is the Nix build plus a launch smoke test.
            doCheck = false;

            env = {
              APPIMAGE_NAME = "RookOss-${pkgs.stdenv.hostPlatform.parsed.cpu.name}.AppImage";
              LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
              PROTOC = "${pkgs.protobuf}/bin/protoc";
              PROTOC_INCLUDE = "${pkgs.protobuf}/include";
              CARGO_PROFILE_RELEASE_DEBUG = "false";
            };
            postInstall =
              let
                installDir = "$out/opt/warpdotdev/warp-terminal-experimental";
                resourcesDir = "${installDir}/resources";
                releaseChannel = "oss";
                libraryPath = lib.makeLibraryPath linuxRuntimeLibraries;
                executablePath = lib.makeBinPath (with pkgs; [ xdg-utils ]);
              in
              ''
                install -Dm755 "$out/bin/rook-oss" "${installDir}/rook-oss"
                rm -f "$out/bin/rook-oss"

                patchShebangs \
                  ./script/prepare_bundled_resources \
                  ./script/copy_conditional_skills

                SETTINGS_SCHEMA_EXECUTABLE="${installDir}/rook-oss" ./script/prepare_bundled_resources \
                  "${resourcesDir}" \
                  "${releaseChannel}"

                install -Dm644 \
                  "${resourcesDir}/THIRD_PARTY_LICENSES.txt" \
                  "$out/share/licenses/rook-terminal-experimental/THIRD_PARTY_LICENSES.txt"

                install -Dm644 LICENSE-AGPL "$out/share/licenses/rook-terminal-experimental/LICENSE-AGPL"
                install -Dm644 LICENSE-MIT "$out/share/licenses/rook-terminal-experimental/LICENSE-MIT"

                install -Dm644 app/channels/oss/dev.rook.RookOss.desktop \
                  "$out/share/applications/dev.rook.RookOss.desktop"
                substituteInPlace "$out/share/applications/dev.rook.RookOss.desktop" \
                  --replace-fail "Exec=rook-terminal-oss %U" "Exec=rook-terminal-experimental %U"

                for size in 16x16 32x32 64x64 128x128 256x256 512x512; do
                  icon="app/channels/oss/icon/no-padding/$size.png"
                  if [ -f "$icon" ]; then
                    install -Dm644 "$icon" \
                      "$out/share/icons/hicolor/$size/apps/dev.rook.RookOss.png"
                  fi
                done

                wrapProgram "${installDir}/rook-oss" \
                  --prefix LD_LIBRARY_PATH : "${libraryPath}" \
                  --prefix PATH : "${executablePath}"

                mkdir -p "$out/bin"
                ln -s "${installDir}/rook-oss" "$out/bin/rook-oss"
                ln -s "${installDir}/rook-oss" "$out/bin/rook-terminal-experimental"
              '';

            postFixup = lib.optionalString pkgs.stdenv.isLinux ''
              wrapped="/opt/warpdotdev/warp-terminal-experimental/.rook-oss-wrapped"
              if [ -e "$out$wrapped" ] && ! patchelf --print-needed "$out$wrapped" | grep -q '^libfontconfig\.so\.1$'; then
                patchelf --add-needed libfontconfig.so.1 "$out$wrapped"
              fi
            '';

            meta = {
              description = "Rook is an agentic development environment, born out of the terminal (Experimental Nix Support, Linux-only).";
              homepage = "https://www.rook.dev";
              license = lib.licenses.agpl3Only;
              mainProgram = "rook-terminal-experimental";
              platforms = systems;
              sourceProvenance = with lib.sourceTypes; [ fromSource ];
            };
          };
        in
        {
          inherit rook-terminal-experimental;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
          lib = pkgs.lib;
          rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
          nativeBuildInputs = with pkgs; [
            brotli
            cargo-about
            cargo-nextest
            clang
            cmake
            jq
            lld
            makeWrapper
            patchelf
            pkg-config
            protobuf
            python3
            rustToolchain
            rust-analyzer
          ];
          buildInputs = with pkgs; [
            alsa-lib
            curl
            dbus
            expat
            fontconfig
            freetype
            libGL
            libgit2
            libxkbcommon
            openssl
            stdenv.cc.cc.lib
            udev
            vulkan-loader
            wayland
            libx11
            libxscrnsaver
            libxcursor
            libxext
            libxfixes
            libxi
            libxrandr
            libxrender
            libxcb
            zlib
          ];
        in
        {
          default = pkgs.mkShell {
            inherit nativeBuildInputs buildInputs;
            APPIMAGE_NAME = "RookOss-${pkgs.stdenv.hostPlatform.parsed.cpu.name}.AppImage";
            LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
            PROTOC = "${pkgs.protobuf}/bin/protoc";
            PROTOC_INCLUDE = "${pkgs.protobuf}/include";
            LD_LIBRARY_PATH = lib.makeLibraryPath buildInputs;
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}

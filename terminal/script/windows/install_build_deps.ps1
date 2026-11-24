#!/usr/bin/env powershell
#
# Install all dependencies required to build Rook on Windows.

# Install Rust + cargo.
bash (($PWD.Path) + '\script\install_rust')

# Install various build-time dependencies through cargo.
bash (($PWD.Path) + '\script\install_cargo_build_deps')

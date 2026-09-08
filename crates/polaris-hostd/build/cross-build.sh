#!/usr/bin/env bash
# Cross-compile the host daemon to a static musl binary.
#
# Polaris hosts span both common server arches, so both targets are built by
# default. Uses `cross` (Docker) so no target C toolchain is needed on the host.
#
#   Prereqs: Docker running + `cargo install cross`
#   Usage:   ./cross-build.sh [target ...]
#            (default: aarch64-unknown-linux-musl x86_64-unknown-linux-musl)
set -euo pipefail

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
    TARGETS=("aarch64-unknown-linux-musl" "x86_64-unknown-linux-musl")
fi
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$REPO_ROOT"
for target in "${TARGETS[@]}"; do
    echo "Building polaris-hostd for $target ..."
    cross build --release --target "$target" -p polaris-hostd

    BIN="target/$target/release/polaris-hostd"
    echo "Built: $BIN"
    file "$BIN" 2>/dev/null || true
    ls -lh "$BIN"
done

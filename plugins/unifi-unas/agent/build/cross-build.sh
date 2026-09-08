#!/usr/bin/env bash
# Cross-compile the on-device agent to a static musl binary.
#
# The UNAS Pro line and the UNVR variants are aarch64. Uses `cross` (Docker) so
# no target C toolchain is needed on the host.
#
#   Prereqs: Docker running + `cargo install cross`
#   Usage:   ./cross-build.sh [target]   (default: aarch64-unknown-linux-musl)
set -euo pipefail

TARGET="${1:-aarch64-unknown-linux-musl}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

cd "$REPO_ROOT"
echo "Building polaris-unas-agent for $TARGET ..."
cross build --release --target "$TARGET" -p polaris-unas-agent

BIN="target/$TARGET/release/polaris-unas-agent"
echo "Built: $BIN"
file "$BIN" 2>/dev/null || true
ls -lh "$BIN"

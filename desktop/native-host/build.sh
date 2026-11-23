#!/usr/bin/env bash
# Builds the browser extension's native messaging host (crates/polaris-native-host)
# and stages it for the packager in native-host/stage/native-host. Run from
# `desktop/`, with TARGET naming a Rust target or empty for this machine's own;
# --test runs its tests first. A package made without it still runs: only
# pairing with the extension on the same computer is off.

set -euo pipefail

TOOLCHAIN=1.97.1
TARGET="${TARGET:-}"

rustup toolchain install "$TOOLCHAIN" --profile minimal
[ -z "$TARGET" ] || rustup target add "$TARGET" --toolchain "$TOOLCHAIN"
if [ "${1:-}" = --test ]; then
    (cd .. && cargo "+$TOOLCHAIN" test --locked -p polaris-native-host)
fi
(cd .. && cargo "+$TOOLCHAIN" build --release --locked -p polaris-native-host ${TARGET:+--target "$TARGET"})

name=polaris-native-host
[ "${RUNNER_OS:-}" != Windows ] && [ "${OS:-}" != Windows_NT ] || name=polaris-native-host.exe
stage=native-host/stage/native-host
rm -rf "$stage"
mkdir -p "$stage"
cp "../target/${TARGET:+$TARGET/}release/$name" "$stage/$name"

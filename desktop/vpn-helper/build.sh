#!/usr/bin/env bash
# Builds the VPN service and stages it for the packager. Run from `desktop/`, with
# TARGET naming a Rust target or empty for this machine's own; --test runs its
# tests first. The driver on Windows comes from a fixed release, checked against
# its digest, and is shipped untouched beside its licence.

set -euo pipefail

TOOLCHAIN=1.97.1
TARGET="${TARGET:-}"

rustup toolchain install "$TOOLCHAIN" --profile minimal
[ -z "$TARGET" ] || rustup target add "$TARGET" --toolchain "$TOOLCHAIN"
if [ "${1:-}" = --test ]; then
    (cd vpn-helper && cargo "+$TOOLCHAIN" test --locked)
fi
(cd vpn-helper && cargo "+$TOOLCHAIN" build --release --locked ${TARGET:+--target "$TARGET"})

if [ "$RUNNER_OS" = Windows ]; then
    driver="$RUNNER_TEMP/wireguard-nt.zip"
    curl -fsSL -o "$driver" https://download.wireguard.com/wireguard-nt/wireguard-nt-1.1.zip
    echo "dceb30a9bc4be48cce0f74160fc88a585a2c2627366e8f846fc6658f9038dace  $driver" | sha256sum -c -
    unzip -q "$driver" -d "$RUNNER_TEMP/wireguard-nt"
    node vpn-helper/stage.mjs "$TARGET" "$RUNNER_TEMP/wireguard-nt/wireguard-nt"
else
    node vpn-helper/stage.mjs "$TARGET"
fi

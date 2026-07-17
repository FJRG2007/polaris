# Agent binaries

At runtime the integration uploads the prebuilt on-device agent from this
directory, picking `polaris-unas-agent-<arch>` by the device's `uname -m`
(currently `aarch64` and `x86_64`).

The binaries are **not** committed. They are built and placed here by the release
workflow (`.github/workflows/release-unifi-unas.yml`) and bundled into the HACS
release ZIP. For local testing, build one and drop it here:

```sh
plugins/unifi-unas/agent/build/cross-build.sh aarch64-unknown-linux-musl
cp target/aarch64-unknown-linux-musl/release/polaris-unas-agent \
   plugins/unifi-unas/homeassistant/custom_components/unifi_unas/bin/polaris-unas-agent-aarch64
```

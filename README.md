# Polaris

Home lab control plane. The long-term goal is a Home Assistant-class dashboard
to monitor and control everything in one place. Polaris grows plugin by plugin;
each plugin ships as a Home Assistant integration today and feeds the native
Polaris dashboard tomorrow, sharing the same Rust core.

## Why Rust-first

Each integration has three execution contexts:

1. **Home Assistant process** (`plugins/<name>/homeassistant/`) - loaded in-process
   by HA, so it must be Python. Kept as thin glue: config flow, MQTT-backed
   entities, and pushing the agent binary over SSH.
2. **On-device agent** (`plugins/<name>/agent/`) - runs on the device itself. This
   is where Rust pays off: a single static `musl` binary replaces interpreted
   scripts and removes runtime dependencies from the device.
3. **Polaris dashboard** (future) - native Rust, reuses the same domain crate
   directly with no Home Assistant or MQTT in the path.

The shared logic lives in `plugins/<name>/core/` (a plain Rust library) so all
three contexts behave identically.

## Plugins

### UniFi UNAS - monitoring and fan control

Drive SMART data, system metrics, storage pools, shares and fan control for
UniFi UNAS. Install and setup instructions: [`plugins/unifi-unas`](plugins/unifi-unas/README.md).

## Layout

```
polaris/
├── Cargo.toml                 # Rust workspace
├── rust-toolchain.toml        # pinned toolchain + musl cross targets
├── plugins/
│   └── unifi-unas/            # first plugin: UniFi UNAS monitoring + fan control
│       ├── core/              # polaris-unas-core  (Rust lib, reusable)
│       ├── agent/             # polaris-unas-agent (Rust bin, on-device)
│       ├── homeassistant/     # HACS-installable integration (Python glue)
│       ├── README.md
│       └── ROADMAP.md         # per-plugin coverage ledger
└── references/                # upstream repos studied locally (gitignored)
```

Cross-plugin Rust code graduates to a top-level `crates/` only once a second
plugin actually needs it (not before).

## Distribution

Plugins are installed manually from this repository's GitHub Releases: a release
workflow builds the on-device agent and attaches an installable ZIP. HACS is not
used - it installs one integration per repository from the repo root, which a
monorepo subdirectory cannot satisfy. See each plugin's README for its install
instructions.

## Development

```sh
cargo test                     # run all workspace tests
cargo clippy --all-targets     # lint
```

Plugins are independent; work on one without touching the others.

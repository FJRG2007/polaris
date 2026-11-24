# Polaris Terminal (`clients/terminal/`)

The engineering guide for this tree is `CLAUDE.md` in this folder, together
with the repository root `CLAUDE.md`. Read both before changing anything here;
they apply to every agent, not only Claude.

- This folder is its own Cargo workspace with its own `Cargo.lock` and
  `rust-toolchain.toml`. Run every `cargo` command from inside it; the root
  workspace excludes it.
- Agent skills for this tree are mirrored in `.agents/skills/`.

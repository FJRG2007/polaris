# Windows renders on the integrated GPU

**Symptom.** Typing lags behind the keyboard. Scrolling stutters. Selecting text, copying and pasting are slow. Switching panes or tabs pauses. All of it on a machine with a fast discrete GPU.

## Evidence

From `warp.log` on the machine this was diagnosed on, adapters in the order the renderer resolved them:

```
Available wgpu adapters (in priority order):
  IntegratedGpu: AMD Radeon(TM) Graphics   (Dx12)   <- selected
  IntegratedGpu: AMD Radeon(TM) Graphics   (Vulkan)
  DiscreteGpu:   NVIDIA GeForce RTX 5090   (Dx12)   <- supported, can present, ranked below
  DiscreteGpu:   NVIDIA GeForce RTX 5090   (Vulkan)
Using Dx12 IntegratedGpu (AMD Radeon(TM) Graphics) for rendering new window.
```

The discrete adapter was present, supported, and able to present. It was simply ranked lower.

Two things confirm this was the default rather than a local misconfiguration: the user's `settings.toml` contained no GPU setting at all, and `power_preference_adapter_sort_func` scores `IntegratedGpu` 0 and `DiscreteGpu` 1 under `LowPower`.

## Cause

`app/src/settings/gpu.rs` defaulted `prefer_low_power_gpu` to true on Windows:

```rust
default: cfg!(any(target_os = "linux", target_os = "freebsd", windows)),
```

Every one of the symptoms is a repaint, so all of them were paid for on the slower adapter.

The comment justifying it cited unstable discrete drivers. That reasoning did not hold up: `app/src/crash_recovery.rs` already recovered from a GPU crash by switching **to** the discrete GPU, the opposite direction.

## Fix

Windows now defaults to the discrete GPU. Crash recovery was inverted to match: an unstable discrete driver now recovers onto the integrated GPU, through a new `RecoveryMechanism::IntegratedGpu`, while the platforms that still start integrated keep recovering onto the discrete one. Fast path by default, safe path as the fallback.

Linux and FreeBSD keep the upstream default.

Override with `system.prefer_low_power_gpu` in settings.

`app/src/settings/gpu.rs`, `app/src/crash_recovery.rs`, `crates/rook_cli/src/lib.rs`, `app/src/workspace/view/crash_recovery.rs`.

## Verification

The cause is confirmed end to end: the log shows the selection, the sort function explains it, and the setting that drives it was at its default. The improvement itself has not been measured on a running build - to check it, open Rook and confirm the log reads `Using Dx12 DiscreteGpu (NVIDIA GeForce RTX 5090)`.

## What this does not cover

Upstream has reports of crashes on some discrete drivers ([#10046](https://github.com/warpdotdev/warp/issues/10046), [#12132](https://github.com/warpdotdev/warp/issues/12132)). That risk is why the crash fallback exists. A user who hits it lands on the integrated GPU automatically and stays there.

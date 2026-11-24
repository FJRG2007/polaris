use rookui::platform::GraphicsBackend;
use settings::macros::define_settings_group;
use settings::{SupportedPlatforms, SyncToCloud};

define_settings_group!(GPUSettings, settings: [
   prefer_low_power_gpu: PreferLowPowerGPU {
       type: bool,
       // Opt for the low power (integrated) GPU on Linux since discrete GPUs tend to be more
       // unstable there.
       //
       // Windows defaults to the discrete GPU instead. Preferring the integrated one means a
       // machine with a discrete card renders the terminal on the iGPU, which shows up as
       // sluggish scrolling and input latency under heavy output. Crash recovery covers the
       // unstable-driver case by falling back to the integrated GPU (see `crash_recovery`), so
       // the fast path can be the default and the safe path the fallback.
       default: cfg!(any(target_os = "linux", target_os = "freebsd")),
       supported_platforms: SupportedPlatforms::ALL,
       sync_to_cloud: SyncToCloud::Never,
       surface: settings::SettingSurfaces::GUI,
       private: false,
       toml_path: "system.prefer_low_power_gpu",
       description: "Whether to prefer the integrated (low-power) GPU.",
   },
   preferred_backend: PreferredGraphicsBackend {
       type: Option<GraphicsBackend>,
       default: None,
       supported_platforms: SupportedPlatforms::WINDOWS,
       sync_to_cloud: SyncToCloud::Never,
       surface: settings::SettingSurfaces::GUI,
       private: false,
       toml_path: "system.preferred_graphics_backend",
       description: "The preferred graphics backend on Windows.",
   },
]);

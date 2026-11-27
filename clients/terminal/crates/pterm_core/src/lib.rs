pub mod app_id;
pub mod assertions;
pub mod r#async;
pub mod channel;
pub mod cli_agent_protocol;
pub mod command;
pub mod context_flag;
pub mod execution_mode;
pub mod features;
pub mod interval_timer;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod operating_system_info;
pub mod paths;
pub mod platform;
pub mod rook_migration;
pub mod safe_log;
pub mod semantic_selection;
pub use settings;
// Re-export settings macros for backward compatibility
pub use settings::{
    define_setting, define_settings_group, implement_setting_for_enum, maybe_define_setting,
};
pub mod session_id;
pub mod sync_queue;
pub mod telemetry;
pub mod ui;
pub mod user_preferences;

#[doc(hidden)]
pub use anyhow as __anyhow;
pub use app_id::AppId;
#[doc(hidden)]
pub use pterm_errors as __pterm_errors;
pub use pterm_util::host_id::HostId;
pub use session_id::SessionId;
// Re-export ptermui_core so that it can be referenced safely from the
// telemetry macros.
pub use ptermui_core;

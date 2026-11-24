pub(crate) mod action_sidecar;
pub mod branch_picker;
pub mod new_worktree_modal;
pub mod params_modal;
pub(crate) mod remove_confirmation_dialog;
pub mod repo_picker;
pub mod session_config;
pub mod session_config_modal;
pub mod session_config_rendering;
pub mod tab_config;
pub mod telemetry;

pub use new_worktree_modal::{NewWorktreeModal, NewWorktreeModalEvent};
pub use params_modal::{TabConfigParamsModal, TabConfigParamsModalEvent};
use rook_core::ui::theme::Fill;
#[cfg(feature = "local_fs")]
pub(crate) use tab_config::build_worktree_config_toml;
pub use tab_config::{
    TabConfig, TabConfigError, TabConfigParam, TabConfigParamType, render_tab_config,
};

/// Optional visual overrides for BranchPicker / RepoPicker dropdowns.
pub struct PickerStyle {
    pub width: f32,
    pub background: Option<Fill>,
}

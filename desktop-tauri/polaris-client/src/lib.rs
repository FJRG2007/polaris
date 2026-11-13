//! The part of a Polaris desktop client that is not a window: the instance's
//! address, whether it really is a Polaris, and the API-key calls.
//!
//! Kept free of any UI toolkit so the Tauri shell (and any later native shell)
//! shares it. Each module names the Electron file it mirrors; the two must say
//! the same thing until the Electron app is retired.

pub mod adb_client;
pub mod adb_pairing;
pub mod adb_spake2;
pub mod address;
pub mod api;
pub mod app_badge;
pub mod context_menu;
pub mod host_list;
pub mod hotkeys;
pub mod identity;
pub mod keys;
pub mod net;
pub mod notice;
pub mod tv_address;
pub mod tv_mdns;
pub mod tv_path;
pub mod tv_wait;

pub use address::{AddressError, ApiKey, InstanceUrl};
pub use api::{ApiClient, ApiError, DeploymentState, ImageTarget, Me, MeUser, Started};
pub use identity::{probe, probe_client, Verdict};
pub use net::NetFailure;

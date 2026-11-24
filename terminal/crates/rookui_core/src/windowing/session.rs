//! Whether the operating system has announced that the user's session is ending - a logout,
//! a restart or a shutdown that is under way but has not reached this process yet.

use std::sync::atomic::{AtomicBool, Ordering};

static OS_SESSION_ENDING: AtomicBool = AtomicBool::new(false);

/// Whether the OS is ending the session. Only Windows reports it, from
/// `WM_QUERYENDSESSION`, and clears it again if another application cancels the shutdown.
///
/// Anything that dies in this window is being taken down by the OS, not by the user, so it
/// should not change what the next launch restores.
pub fn is_os_session_ending() -> bool {
    OS_SESSION_ENDING.load(Ordering::SeqCst)
}

/// Records whether the OS is ending the session. Called by the platform layer.
pub fn set_os_session_ending(ending: bool) {
    OS_SESSION_ENDING.store(ending, Ordering::SeqCst);
}

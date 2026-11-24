//! Hears Windows end the session - a logout, a restart or a shutdown - which winit does not
//! pass on.
//!
//! Csrss ends a session one process at a time, from the highest shutdown level down, and
//! every process starts at the same level. Nothing put Rook ahead of the shells in its own
//! tabs, so they were often killed first: each one's exit closed its tab, and the autosave
//! then stored a session with the tabs already gone. Rook now asks to go before them, marks
//! the session as ending the moment Windows asks whether it may end, and quits through the
//! same path a macOS logout takes. See `docs/bugs/session-not-saved-on-shutdown.md`.

use std::cell::OnceCell;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::SetProcessShutdownParameters;
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION};
use winit::event_loop::EventLoopProxy;
use winit::window::Window as WinitWindow;

use super::window_attribute::to_hwnd;
use crate::windowing::set_os_session_ending;
use crate::windowing::winit::app::CustomEvent;

/// Every process starts at 0x280, the shells in Rook's tabs included. Anything above it puts
/// Rook ahead of them; 0x300 is the bottom of the range Windows reserves for applications
/// that want to go first.
const SHUTDOWN_LEVEL: u32 = 0x300;

/// Identifies this subclass among any others installed on the same window.
const SUBCLASS_ID: usize = 0x526f_6f6b;

thread_local! {
    /// Windows delivers both messages on the thread that owns the window, which is the one
    /// running the event loop.
    static EVENT_LOOP_PROXY: OnceCell<EventLoopProxy<CustomEvent>> = const { OnceCell::new() };
}

/// Puts Rook ahead of its shells in the shutdown order, and gives the window procedure a way
/// to reach the event loop. Call once, on the event loop thread, before any window opens.
pub fn watch_session_end(proxy: EventLoopProxy<CustomEvent>) {
    if let Err(err) = unsafe { SetProcessShutdownParameters(SHUTDOWN_LEVEL, 0) } {
        log::warn!("Could not move ahead of the shells in the shutdown order: {err:?}");
    }
    EVENT_LOOP_PROXY.with(|cell| {
        let _ = cell.set(proxy);
    });
}

/// Routes `window`'s session messages through [`session_end_proc`]. Windows sends them to
/// every top-level window, hidden ones included, so any window of Rook's will do.
pub fn subclass_for_session_end(window: &WinitWindow) {
    let hwnd = match to_hwnd(window) {
        Ok(hwnd) => hwnd,
        Err(err) => {
            log::warn!("Could not listen for the session ending: {err:?}");
            return;
        }
    };
    if !unsafe { SetWindowSubclass(hwnd, Some(session_end_proc), SUBCLASS_ID, 0) }.as_bool() {
        log::warn!("Could not listen for the session ending on this window");
    }
}

unsafe extern "system" fn session_end_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    match msg {
        WM_QUERYENDSESSION => {
            set_os_session_ending(true);
            LRESULT(1)
        }
        WM_ENDSESSION => {
            if wparam.0 == 0 {
                // Another application refused, and the session goes on.
                set_os_session_ending(false);
            } else {
                // The process can be ended any time after this returns, so the event loop may
                // never see this. Nothing depends on it: Windows has not reached the shells
                // yet, so the last autosave holds every tab. It only lets Rook save once more
                // and stop the writer cleanly when Windows gives it the time.
                EVENT_LOOP_PROXY.with(|cell| {
                    if let Some(proxy) = cell.get() {
                        let _ = proxy.send_event(CustomEvent::SessionEnded);
                    }
                });
            }
            LRESULT(0)
        }
        WM_NCDESTROY => unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(session_end_proc), SUBCLASS_ID);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        },
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}

#[cfg(test)]
#[path = "session_end_tests.rs"]
mod tests;

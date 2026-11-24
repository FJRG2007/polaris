use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{WM_ENDSESSION, WM_QUERYENDSESSION};

use super::session_end_proc;
use crate::windowing::{is_os_session_ending, set_os_session_ending};

fn send(msg: u32, wparam: usize) -> LRESULT {
    // Neither message reaches `DefSubclassProc`, so no real window is needed.
    unsafe { session_end_proc(HWND::default(), msg, WPARAM(wparam), LPARAM(0), 0, 0) }
}

// One test, because the flag is process-wide and tests run in parallel.
#[test]
fn session_end_is_flagged_until_a_shutdown_is_cancelled() {
    set_os_session_ending(false);

    assert_eq!(
        send(WM_QUERYENDSESSION, 0),
        LRESULT(1),
        "never block the shutdown"
    );
    assert!(is_os_session_ending());

    // Another application refused: the session goes on, and so do exits.
    assert_eq!(send(WM_ENDSESSION, 0), LRESULT(0));
    assert!(!is_os_session_ending());

    // Ending for real, with no event loop to tell, keeps the flag and does not panic.
    send(WM_QUERYENDSESSION, 0);
    assert_eq!(send(WM_ENDSESSION, 1), LRESULT(0));
    assert!(is_os_session_ending());

    set_os_session_ending(false);
}

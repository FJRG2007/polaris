//! Where the main window goes when the app opens: where it was, unless that
//! place no longer exists (`desktop/src/shared/window-place.ts`). A monitor can
//! be unplugged between runs, and a window restored onto it would be open and
//! impossible to reach, so what was saved is only used while its title bar can
//! still be grabbed on some display.

/// A rectangle on the desktop, in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// Where the window was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowPlace {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub maximized: bool,
}

/// What to open with. No `x` and `y` leaves the system to centre it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Restored {
    pub width: i64,
    pub height: i64,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub maximized: bool,
}

/// How much of the top of a window has to be on a display to reach it, in pixels.
const GRAB_WIDTH: i64 = 120;
const GRAB_HEIGHT: i64 = 32;

fn overlap(from: i64, size: i64, area_from: i64, area_size: i64) -> i64 {
    (from + size).min(area_from + area_size) - from.max(area_from)
}

fn reachable_on(place: &WindowPlace, area: &Area) -> bool {
    overlap(place.x, place.width, area.x, area.width) >= GRAB_WIDTH
        && overlap(place.y, GRAB_HEIGHT, area.y, area.height) >= GRAB_HEIGHT
}

/// Where the window opens (`restoredPlace`).
pub fn restored_place(saved: &WindowPlace, displays: &[Area], primary: &Area) -> Restored {
    if displays.iter().any(|area| reachable_on(saved, area)) {
        return Restored {
            width: saved.width,
            height: saved.height,
            x: Some(saved.x),
            y: Some(saved.y),
            maximized: saved.maximized,
        };
    }
    Restored {
        width: saved.width.min(primary.width),
        height: saved.height.min(primary.height),
        x: None,
        y: None,
        maximized: saved.maximized,
    }
}

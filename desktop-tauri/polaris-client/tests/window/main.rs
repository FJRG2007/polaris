//! `desktop/test/shared/window-place.test.ts`, ported.

use polaris_client::window_place::{restored_place, Area, Restored, WindowPlace};

const LEFT: Area = Area {
    x: 0,
    y: 0,
    width: 1920,
    height: 1040,
};
const RIGHT: Area = Area {
    x: 1920,
    y: -200,
    width: 2560,
    height: 1400,
};

fn place(x: i64, y: i64, width: i64, height: i64, maximized: bool) -> WindowPlace {
    WindowPlace {
        x,
        y,
        width,
        height,
        maximized,
    }
}

#[test]
fn goes_back_to_the_second_monitor_where_it_was() {
    let saved = place(2200, 100, 1000, 700, false);
    assert_eq!(
        restored_place(&saved, &[LEFT, RIGHT], &LEFT),
        Restored {
            x: Some(2200),
            y: Some(100),
            width: 1000,
            height: 700,
            maximized: false
        }
    );
}

#[test]
fn keeps_being_maximized() {
    let saved = place(100, 100, 1000, 700, true);
    assert!(restored_place(&saved, &[LEFT], &LEFT).maximized);
}

#[test]
fn comes_back_to_a_monitor_that_exists_when_its_own_is_gone() {
    let saved = place(3000, 100, 2400, 1300, false);
    assert_eq!(
        restored_place(&saved, &[LEFT], &LEFT),
        Restored {
            x: None,
            y: None,
            width: 1920,
            height: 1040,
            maximized: false
        }
    );
}

#[test]
fn will_not_leave_the_title_bar_out_of_reach_above_a_screen() {
    let saved = place(100, -600, 1000, 700, false);
    assert_eq!(restored_place(&saved, &[LEFT], &LEFT).x, None);
}

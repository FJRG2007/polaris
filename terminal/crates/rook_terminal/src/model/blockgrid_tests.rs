use rook_core::features::FeatureFlag;

use crate::SizeInfo;
use crate::event_listener::ChannelEventListener;
use crate::model::ansi::{self, Handler};
use crate::model::blockgrid::{BlockGrid, CursorDisplayPoint};
use crate::model::grid::Dimensions;
use crate::model::grid::grid_handler::PerformResetGridChecks;
use crate::model::index::{Point, VisibleRow};
use crate::model::kitty::{CursorMovementPolicy, KittyAction};
use crate::model::secrets::ObfuscateSecrets;
use crate::test_util::{
    mock_blockgrid, test_kitty_image_metadata_map, test_kitty_store_and_display_action,
};

#[test]
pub fn test_finish_truncates_grid_basic() {
    let size = SizeInfo::new_without_font_metrics(10, 7);
    let mut block_grid = BlockGrid::new(
        size,
        1000, /* max_scroll_limit */
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );

    for c in "hello".chars() {
        block_grid.input(c);
    }
    block_grid.linefeed();
    block_grid.finish();

    assert_eq!(block_grid.len(), 2);
    assert_eq!(block_grid.grid_handler().total_rows(), 2);
    assert_eq!(block_grid.grid_handler().columns(), size.columns);
}

#[test]
pub fn test_finish_truncates_grid_cursor_at_bottom() {
    let size = SizeInfo::new_without_font_metrics(10, 7);
    let mut block_grid = BlockGrid::new(
        size,
        1000, /* max_scroll_limit */
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );

    for _ in 0..300 {
        block_grid.input('a');
        block_grid.linefeed();
        block_grid.carriage_return();
    }

    block_grid.finish();

    assert_eq!(block_grid.len(), 300);
    assert_eq!(block_grid.grid_handler().total_rows(), 301);
    assert_eq!(block_grid.grid_handler().columns(), size.columns);
}

#[test]
pub fn test_resize_finished_block() {
    let size = SizeInfo::new_without_font_metrics(10, 7);
    let mut block_grid = BlockGrid::new(
        size,
        1000, /* max_scroll_limit */
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );

    for _ in 0..5 {
        for c in "hello".chars() {
            block_grid.input(c);
        }

        block_grid.linefeed();
        block_grid.carriage_return();
    }

    block_grid.finish();

    assert_eq!(block_grid.len(), 5);
    assert_eq!(block_grid.grid_handler().total_rows(), 6);

    block_grid.resize(SizeInfo::new_without_font_metrics(10, 10));

    // The len and total rows of the grid should be unchanged even after resize.
    assert_eq!(block_grid.len(), 5);
    assert_eq!(block_grid.grid_handler().total_rows(), 6);

    // Resize so that the contents of can no longer fit on one line. The length of the grid
    // should increase because each row is now soft-wrapped.
    block_grid.resize(SizeInfo::new_without_font_metrics(10, 3));
    assert_eq!(block_grid.len(), 10);
    // Each of the 5 "hello" rows should be split into "hel" and "lo" (for a total
    // of 10 rows), plus one final empty row at the end.
    assert_eq!(block_grid.grid_handler().total_rows(), 11);

    // Resizing the height in either direction should have no effect on the total grid height.
    block_grid.resize(SizeInfo::new_without_font_metrics(3, 7));
    assert_eq!(block_grid.len(), 5);
    assert_eq!(block_grid.grid_handler().total_rows(), 6);

    block_grid.resize(SizeInfo::new_without_font_metrics(300, 7));
    assert_eq!(block_grid.len(), 5);
    assert_eq!(block_grid.grid_handler().total_rows(), 6);
}

#[test]
pub fn test_resize_finished_softwrapped_block() {
    let size = SizeInfo::new_without_font_metrics(10, 3);
    let mut block_grid = BlockGrid::new(
        size,
        1000, /* max_scroll_limit */
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );

    for _ in 0..5 {
        for c in "hello".chars() {
            block_grid.input(c);
        }

        block_grid.linefeed();
        block_grid.carriage_return();
    }

    block_grid.finish();

    assert_eq!(block_grid.len(), 10);
    assert_eq!(block_grid.grid_handler().total_rows(), 11);

    // Resize so each item can only fit on a given line.
    block_grid.resize(SizeInfo::new_without_font_metrics(10, 10));

    assert_eq!(block_grid.len(), 5);
    assert_eq!(block_grid.grid_handler().total_rows(), 6);
}

#[test]
pub fn test_content_summary() {
    let blockgrid = mock_blockgrid("1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n9\r\n10\r\n");

    // Test a summary that omits the middle of the grid.
    let summary = blockgrid.content_summary(1, 2, false);
    assert_eq!(summary, "1\n...(truncated)...\n9\n10\n");

    // Test a summary that perfectly covers the entire grid.
    let summary = blockgrid.content_summary(7, 3, false);
    assert_eq!(summary, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");

    // Test a summary where the total range exceeds the grid size.
    let summary = blockgrid.content_summary(7, 6, false);
    assert_eq!(summary, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
}

#[test]
pub fn test_trim_trailing_blank_rows_uses_active_floor_for_blank_started_grid() {
    let size = SizeInfo::new_without_font_metrics(10, 10);
    let mut block_grid = BlockGrid::new(
        size,
        1000,
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );

    block_grid.start();
    block_grid.goto(VisibleRow(4), 0);
    block_grid.on_finish_byte_processing(&ansi::ProcessorInput::new(&[]));
    block_grid.set_trim_trailing_blank_rows(true);

    assert_eq!(block_grid.len(), 5);
    assert_eq!(block_grid.len_displayed(), 1);
    assert_eq!(
        block_grid.cursor_display_point(),
        Some(CursorDisplayPoint::HiddenCache(Point::new(0, 0)))
    );
}

#[test]
pub fn test_non_moving_kitty_image_keeps_finished_grid_visible() {
    let _kitty_images = FeatureFlag::KittyImages.override_enabled(true);
    let size = SizeInfo::new_without_font_metrics(10, 10);
    let mut block_grid = BlockGrid::new(
        size,
        1000,
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );
    let mut metadata = test_kitty_image_metadata_map(1);
    let mut action = test_kitty_store_and_display_action(1, 1);
    let KittyAction::StoreAndDisplay(store_and_display) = &mut action else {
        panic!("expected StoreAndDisplay action");
    };
    store_and_display.placement_data.cursor_movement_policy = CursorMovementPolicy::DoNotMoveCursor;

    block_grid
        .handle_completed_kitty_action(action, &mut metadata)
        .expect("kitty action should be handled")
        .expect("kitty image should render");

    assert_eq!(block_grid.grid_handler().cursor_point(), Point::new(0, 0));
    assert!(block_grid.grid_handler().has_visible_images());
    assert!(!block_grid.should_show_as_empty_when_finished());
}

#[test]
pub fn test_cursor_display_point_hidden_when_cursor_below_trimmed_content() {
    let size = SizeInfo::new_without_font_metrics(10, 10);
    let mut block_grid = BlockGrid::new(
        size,
        1000,
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );

    block_grid.start();
    block_grid.input('a');
    block_grid.input('b');
    block_grid.input('c');
    block_grid.on_finish_byte_processing(&ansi::ProcessorInput::new(&[]));
    block_grid.set_trim_trailing_blank_rows(true);

    assert_eq!(block_grid.len_displayed(), 1);
    assert_eq!(
        block_grid.cursor_display_point(),
        Some(CursorDisplayPoint::Visible(Point::new(0, 3)))
    );

    block_grid.goto(VisibleRow(4), 2);
    block_grid.on_finish_byte_processing(&ansi::ProcessorInput::new(&[]));

    assert_eq!(block_grid.len(), 5);
    assert_eq!(block_grid.len_displayed(), 1);
    assert_eq!(
        block_grid.cursor_display_point(),
        Some(CursorDisplayPoint::HiddenCache(Point::new(0, 2)))
    );
}

#[test]
pub fn test_cursor_display_point_not_clipped_when_trimming_disabled() {
    let size = SizeInfo::new_without_font_metrics(10, 10);
    let mut block_grid = BlockGrid::new(
        size,
        1000,
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );

    block_grid.start();
    block_grid.input('a');
    block_grid.input('b');
    block_grid.input('c');
    block_grid
        .grid_handler_mut()
        .set_marked_text("12345678", &(0..0));

    assert_eq!(block_grid.len_displayed(), 1);
    assert_eq!(
        block_grid.cursor_display_point(),
        Some(CursorDisplayPoint::Visible(Point::new(1, 1)))
    );

    block_grid.set_trim_trailing_blank_rows(true);

    assert_eq!(block_grid.len_displayed(), 1);
    assert_eq!(
        block_grid.cursor_display_point(),
        Some(CursorDisplayPoint::HiddenCache(Point::new(0, 1)))
    );
}

/// Builds a finished block of `lines` rows, with grid compaction on or off,
/// and returns the block alongside what it costs in memory.
fn finished_block_with_compaction(maximize: bool, lines: usize) -> (Vec<String>, usize) {
    let _guard = FeatureFlag::MaximizeFlatStorage.override_enabled(maximize);
    let size = SizeInfo::new_without_font_metrics(200, 50);
    let mut block_grid = BlockGrid::new(
        size,
        10_000, /* max_scroll_limit */
        ChannelEventListener::new_for_test(),
        ObfuscateSecrets::No,
        PerformResetGridChecks::default(),
    );

    for i in 0..lines {
        for c in format!("line {i} of some fairly typical terminal output").chars() {
            block_grid.input(c);
        }
        block_grid.linefeed();
        block_grid.carriage_return();
    }
    block_grid.finish();

    let handler = block_grid.grid_handler();
    let rows = (0..handler.total_rows())
        .map(|row| match handler.row(row) {
            Some(row) => (0..row.len())
                .map(|col| row[col].content_for_display().to_string())
                .collect(),
            None => String::new(),
        })
        .collect();
    let bytes =
        block_grid.grid_storage().estimated_memory_usage_bytes() + block_grid.flat_storage_bytes();

    (rows, bytes)
}

/// A finished block keeps its output in the grid's dense per-cell storage,
/// which costs 24 bytes a cell whether or not the cell holds anything. Moving
/// it into flat storage once the block can no longer change is what
/// [`FeatureFlag::MaximizeFlatStorage`] does, and it is the difference between
/// a long session growing without bound and not.
///
/// The content has to survive the move untouched: flat storage is read back by
/// materializing rows on demand, so a bug here would silently corrupt
/// scrollback rather than fail loudly.
#[test]
fn test_finishing_a_block_compacts_it_without_changing_its_content() {
    let (uncompacted_rows, uncompacted_bytes) = finished_block_with_compaction(false, 300);
    let (compacted_rows, compacted_bytes) = finished_block_with_compaction(true, 300);

    assert_eq!(
        compacted_rows, uncompacted_rows,
        "compaction must not alter a single row of output"
    );

    // Measured at 8.4x on this input; asserting 4x leaves room for the ratio to
    // move with the storage formats without the test going green on a
    // regression that undoes the fix.
    assert!(
        compacted_bytes * 4 < uncompacted_bytes,
        "compaction should cut memory several-fold,          but {compacted_bytes} bytes is not far below {uncompacted_bytes}"
    );
}

/// What reaches the database is the block's text with its escape sequences, not
/// its storage layout, so compaction must not change a byte of it. A drift here
/// would not show up until a session was restored from disk.
#[test]
fn test_compaction_does_not_change_what_gets_persisted() {
    fn serialized(maximize: bool) -> String {
        let _guard = FeatureFlag::MaximizeFlatStorage.override_enabled(maximize);
        let size = SizeInfo::new_without_font_metrics(200, 50);
        let mut block_grid = BlockGrid::new(
            size,
            10_000, /* max_scroll_limit */
            ChannelEventListener::new_for_test(),
            ObfuscateSecrets::No,
            PerformResetGridChecks::default(),
        );

        for i in 0..120 {
            for c in format!("[3{}mline {i}[0m of coloured output", i % 8).chars() {
                block_grid.input(c);
            }
            block_grid.linefeed();
            block_grid.carriage_return();
        }
        block_grid.finish();

        block_grid.contents_to_string(true /* include_escape_sequences */, None)
    }

    assert_eq!(serialized(true), serialized(false));
}

/// Compaction is skipped for blocks too short to benefit, so a session full of
/// one-line commands is not made worse by it.
#[test]
fn test_a_short_block_is_left_uncompacted() {
    for lines in 0..3 {
        let (_, uncompacted) = finished_block_with_compaction(false, lines);
        let (_, compacted) = finished_block_with_compaction(true, lines);
        assert_eq!(
            compacted, uncompacted,
            "a {lines}-line block should be left alone"
        );
    }
}

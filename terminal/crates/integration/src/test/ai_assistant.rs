use rook::integration_testing::step::new_step_with_default_assertions;
use rook::integration_testing::terminal::util::ExpectedExitStatus;
use rook::integration_testing::terminal::{
    assert_selected_block_index_is_last_renderable, execute_command_for_single_terminal_in_tab,
    wait_until_bootstrapped_single_pane_for_tab,
};
use rook::integration_testing::view_getters::ai_assistant_panel_view;
use rookui_core::async_assert;

use super::new_builder;
use crate::Builder;

/// Checks if the Ask Rook AI keybinding works correctly when a block is selected.
/// This is a regression test: https://linear.app/warpdotdev/issue/WAR-6758/rook-ai-ask-from-block-keybinding-doesnt-work-as-expected.
pub fn test_ask_rook_ai_keybinding_for_selected_block() -> Builder {
    new_builder()
        .with_step(wait_until_bootstrapped_single_pane_for_tab(0))
        .with_step(execute_command_for_single_terminal_in_tab(
            0,
            String::from("echo foo"),
            ExpectedExitStatus::Success,
            "foo",
        ))
        .with_step(
            new_step_with_default_assertions("select block")
                .with_keystrokes(&["cmdorctrl-up"])
                .add_named_assertion(
                    "ensure block is selected",
                    assert_selected_block_index_is_last_renderable(),
                ),
        )
        .with_step(
            new_step_with_default_assertions("select block")
                .with_keystrokes(&["ctrl-shift-space"])
                .add_named_assertion("ask rook ai from selected block", |app, window_id| {
                    let ai_assistant_panel = ai_assistant_panel_view(app, window_id);
                    ai_assistant_panel.read(app, |view, ctx| {
                        let expected_code_block = "```rook\nfoo\n```";
                        let editor_content = view.editor().as_ref(ctx).buffer_text(ctx);
                        async_assert!(editor_content.contains(expected_code_block))
                    })
                }),
        )
}

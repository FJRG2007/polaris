use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use itertools::Itertools;
use lazy_static::lazy_static;
use rook_completer::completer::TopLevelCommandCaseSensitivity;
use rook_completer::parsers::classify_command;
use rook_completer::parsers::hir::{Command, Expression};
use rook_completer::parsers::simple::all_parsed_commands;
use rook_completer::signatures::CommandRegistry;
use rook_errors::report_if_error;
use rook_util::path::EscapeChar;
use rookui::accessibility::{AccessibilityContent, ActionAccessibilityContent, RookA11yRole};
use rookui::{SingletonEntity, ViewContext};
use settings::Setting as _;

use super::{Event, InlineBannerItem, InlineBannerType, TerminalView};
#[cfg(feature = "local_fs")]
use crate::code::editor_management::CodeSource;
use crate::terminal::event::UserBlockCompleted;
use crate::terminal::general_settings::GeneralSettings;
use crate::terminal::model::session::Session;
use crate::terminal::view::inline_banner::{OpenInRookBannerAction, OpenInRookBannerState};
use crate::util::openable_file_type::{
    OpenableFileType, is_file_openable_in_rook, renders_in_rook_notebook_viewer,
};

#[cfg(test)]
#[path = "open_in_rook_tests.rs"]
mod tests;

const LEARN_MORE_MARKDOWN_URL: &str =
    "https://docs.rook.dev/terminal/more-features/markdown-viewer";
const LEARN_MORE_CODE_URL: &str = "https://docs.rook.dev/code/overview#built-in-code-editor";

/// A path to a file that can be opened in Rook, along with its type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenablePath {
    pub path: PathBuf,
    pub file_type: OpenableFileType,
}

impl TerminalView {
    pub(super) fn maybe_suggest_open_in_rook(
        &mut self,
        block_completed: &UserBlockCompleted,
        ctx: &mut ViewContext<TerminalView>,
    ) {
        if let Some(active_block_metadata) = self.active_block_metadata.as_ref() {
            let Some(session) = active_block_metadata
                .session_id()
                .and_then(|id| self.sessions.as_ref(ctx).get(id))
            else {
                return;
            };
            if !session.is_local() {
                return;
            }

            let command = block_completed
                .command
                .get_with(|compute| {
                    let model = self.model.lock();
                    compute(model.block_list())
                })
                .to_owned();
            let working_directory = active_block_metadata
                .current_working_directory()
                .map(Into::into);
            let command_case_sensitivity = session.command_case_sensitivity();
            let escape_char = session.shell_family().escape_char();
            ctx.spawn(
                async move {
                    check_openable_in_rook(
                        command,
                        working_directory,
                        command_case_sensitivity,
                        escape_char,
                    )
                    .await
                },
                move |view, maybe_match, ctx| {
                    if let Some(openable_path) = maybe_match
                        && (renders_in_rook_notebook_viewer(&openable_path.path)
                            || matches!(openable_path.file_type, OpenableFileType::Code))
                    {
                        view.suggest_open_in_rook(openable_path, session, ctx);
                    }
                },
            );
        }
    }

    /// Whether or not the "Open in Rook" banner is open.
    #[cfg(feature = "integration_tests")]
    pub fn is_open_in_rook_banner_open(&self) -> bool {
        self.inline_banners_state.open_in_rook_banner.is_some()
    }

    fn close_open_in_rook_banner(&mut self, banner_id: usize) {
        self.model
            .lock()
            .block_list_mut()
            .remove_inline_banner(banner_id);
    }

    fn open_in_rook_banner_type_dismissed(
        &self,
        openable_path: &OpenablePath,
        ctx: &ViewContext<Self>,
    ) -> bool {
        let general_settings = GeneralSettings::as_ref(ctx);
        if renders_in_rook_notebook_viewer(&openable_path.path) {
            *general_settings.open_in_rook_banner_dismissed_for_markdown
        } else {
            *general_settings.open_in_rook_banner_dismissed_for_code_and_text
        }
    }

    /// Insert a suggestion banner for opening the file `openable_path`, originating from
    /// `session`, in a Rook pane.
    fn suggest_open_in_rook(
        &mut self,
        openable_path: OpenablePath,
        session: Arc<Session>,
        ctx: &mut ViewContext<Self>,
    ) {
        if self.open_in_rook_banner_type_dismissed(&openable_path, ctx) {
            return;
        }

        // We only show a banner for the most recent command.
        if let Some(prev_state) = &self.inline_banners_state.open_in_rook_banner {
            self.close_open_in_rook_banner(prev_state.id);
        }

        let banner_id = self.inline_banners_state.next_banner_id();
        self.inline_banners_state.open_in_rook_banner = Some(OpenInRookBannerState::new(
            banner_id,
            openable_path,
            session,
        ));
        self.model
            .lock()
            .block_list_mut()
            .append_inline_banner(InlineBannerItem::new(
                banner_id,
                InlineBannerType::OpenInRook,
            ));
        ctx.notify();
    }

    pub fn handle_open_in_rook_banner_action(
        &mut self,
        action: OpenInRookBannerAction,
        ctx: &mut ViewContext<Self>,
    ) {
        match action {
            OpenInRookBannerAction::OpenFile => {
                if let Some(banner_state) = self.inline_banners_state.open_in_rook_banner.take() {
                    if renders_in_rook_notebook_viewer(&banner_state.target.path) {
                        // Markdown and Jupyter notebooks open in the notebook viewer.
                        ctx.emit(Event::OpenFileInRook {
                            path: banner_state.target.path,
                            session: banner_state.session,
                        });
                    } else {
                        // Code and other text files open in the code editor.
                        #[cfg(feature = "local_fs")]
                        ctx.emit(Event::OpenCodeInRook {
                            source: CodeSource::Link {
                                path: banner_state.target.path,
                                range_start: None,
                                range_end: None,
                            },
                            layout: *crate::terminal::view::EditorSettings::as_ref(ctx)
                                .open_file_layout
                                .value(),
                        });
                    }
                    self.close_open_in_rook_banner(banner_state.id);
                    ctx.notify();
                }
            }
            OpenInRookBannerAction::LearnMore => {
                if let Some(banner_state) = &self.inline_banners_state.open_in_rook_banner {
                    let url = if renders_in_rook_notebook_viewer(&banner_state.target.path) {
                        LEARN_MORE_MARKDOWN_URL
                    } else {
                        LEARN_MORE_CODE_URL
                    };
                    ctx.open_url(url);
                }
            }
            OpenInRookBannerAction::Close => {
                if let Some(banner_state) = self.inline_banners_state.open_in_rook_banner.take() {
                    self.close_open_in_rook_banner(banner_state.id);
                    if renders_in_rook_notebook_viewer(&banner_state.target.path) {
                        GeneralSettings::handle(ctx).update(ctx, |settings, ctx| {
                            report_if_error!(
                                settings
                                    .open_in_rook_banner_dismissed_for_markdown
                                    .set_value(true, ctx)
                            );
                        });
                    } else {
                        GeneralSettings::handle(ctx).update(ctx, |settings, ctx| {
                            report_if_error!(
                                settings
                                    .open_in_rook_banner_dismissed_for_code_and_text
                                    .set_value(true, ctx)
                            );
                        });
                    }
                    ctx.notify();
                }
            }
        }
    }

    pub fn open_in_rook_banner_accessibility_content(
        &self,
        action: OpenInRookBannerAction,
    ) -> ActionAccessibilityContent {
        match action {
            OpenInRookBannerAction::OpenFile => {
                match &self.inline_banners_state.open_in_rook_banner {
                    Some(banner_state) => {
                        ActionAccessibilityContent::Custom(AccessibilityContent::new_without_help(
                            format!("Open {} in Rook", banner_state.target.path.display()),
                            RookA11yRole::UserAction,
                        ))
                    }
                    None => ActionAccessibilityContent::Empty,
                }
            }
            OpenInRookBannerAction::Close => {
                ActionAccessibilityContent::Custom(AccessibilityContent::new_without_help(
                    "Close View in Rook banner",
                    RookA11yRole::UserAction,
                ))
            }
            OpenInRookBannerAction::LearnMore => {
                ActionAccessibilityContent::Custom(AccessibilityContent::new(
                    "Learn more",
                    "Learn more about opening Markdown files in Rook",
                    RookA11yRole::UserAction,
                ))
            }
        }
    }
}

lazy_static! {
    static ref FILE_VIEWER_COMMANDS: HashSet<&'static str> =
        HashSet::from(["bat", "cat", "glow", "less", "open"]);
}

/// Examines `command` for a file openable in Rook, returning the resolved path and type if found.
async fn check_openable_in_rook(
    command: String,
    working_directory: Option<String>,
    command_case_sensitivity: TopLevelCommandCaseSensitivity,
    escape_char: EscapeChar,
) -> Option<OpenablePath> {
    // We can use PathBuf/Path here because, at the moment, only local sessions are supported.
    let working_directory = working_directory.map(PathBuf::from);
    for command in all_parsed_commands(command, escape_char) {
        // We want to parse the command enough to distinguish file names from arguments, but no
        // more than necessary.
        // TODO(ben): Expand aliases as well.
        let mut tokens = command.parts.iter().map(|s| s.as_str()).collect_vec();
        let command_registry = CommandRegistry::global_instance();
        let Some(classified_command) = classify_command(
            command.clone(),
            &mut tokens,
            &command_registry,
            command_case_sensitivity,
        ) else {
            continue;
        };
        if !FILE_VIEWER_COMMANDS.contains(classified_command.command.command_name_span().item) {
            continue;
        }

        // All the supported viewers take files as positional arguments.
        let positionals = match classified_command.command {
            Command::Classified(shell_command) => shell_command.args.positionals,
            Command::Unclassified(command) => command.args.positionals,
        };

        if let Some(positionals) = positionals {
            for arg in positionals.iter() {
                // Skip commands and environment variables.
                if !matches!(
                    arg.expression(),
                    Expression::Literal | Expression::ValidatableArgument(_) | Expression::Unknown
                ) {
                    continue;
                }

                let relative_path = Path::new(arg.value().as_str());

                let Some(file_type) = is_file_openable_in_rook(relative_path) else {
                    continue;
                };

                let resolved = working_directory.as_ref().map_or_else(
                    || relative_path.to_path_buf(),
                    |cwd| cwd.join(relative_path),
                );

                if async_fs::metadata(&resolved).await.is_ok() {
                    // We've found a file that exists and can be opened in Rook.
                    return Some(OpenablePath {
                        path: resolved,
                        file_type,
                    });
                }
            }
        }
    }
    None
}

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Display;

use markdown_parser::{FormattedText, FormattedTextFragment, FormattedTextLine};
use regex::Regex;
use rook_core::features::FeatureFlag;
use rook_errors::report_if_error;
use rookui::elements::{
    Container, Flex, FormattedTextElement, HighlightedHyperlink, MouseStateHandle, ParentElement,
};
use rookui::keymap::ContextPredicate;
use rookui::presenter::ChildView;
use rookui::ui_components::components::{Coords, UiComponent, UiComponentStyles};
use rookui::ui_components::switch::SwitchStateHandle;
use rookui::{
    Action, AppContext, Element, Entity, ModelHandle, SingletonEntity, TypedActionView, View,
    ViewContext, ViewHandle,
};
use settings::{Setting, ToggleableSetting};
use strum::IntoEnumIterator;

use super::search::SearchQuery;
use super::settings_page::{
    Category, CategoryHeader, HEADER_FONT_SIZE, HEADER_PADDING, LocalOnlyIconState, MatchData,
    PageType, SettingsPageEvent, SettingsPageMeta, SettingsPageViewHandle, SettingsWidget,
    ToggleState, add_setting, render_alternating_color_list, render_body_item,
    render_dropdown_item, render_page_title,
};
use super::{SettingsAction, SettingsSection, ToggleSettingActionPair, flags};
use crate::appearance::Appearance;
use crate::send_telemetry_from_ctx;
use crate::server::telemetry::TelemetryEvent;
use crate::settings::{ReuseExistingSshControlMaster, SshSettings};
use crate::terminal::rookify::settings::{
    EnableSshRookification, RookifySettings, RookifySettingsChangedEvent, SshExtensionInstallMode,
    SshExtensionInstallModeSetting,
};
use crate::ui_components::blended_colors;
use crate::view_components::dropdown::{Dropdown, DropdownItem};
use crate::view_components::{SubmittableTextInput, SubmittableTextInputEvent};

pub fn init_actions_from_parent_view<T: Action + Clone>(
    app: &mut AppContext,
    context: &ContextPredicate,
    builder: fn(SettingsAction) -> T,
) {
    // Add all of the toggle settings from the Rookify Page that you want to show up on the Command Palette here.
    let mut toggle_binding_pairs = vec![];
    if RookifySettings::as_ref(app)
        .enable_ssh_rookification
        .is_supported_on_current_platform()
    {
        toggle_binding_pairs.push(ToggleSettingActionPair::new(
            "SSH Rookification",
            builder(SettingsAction::RookifyPageToggle(
                RookifyPageAction::ToggleSshRookification,
            )),
            context,
            flags::SSH_ROOKIFICATION_CONTEXT_FLAG,
        ));
    }

    ToggleSettingActionPair::add_toggle_setting_action_pairs_as_bindings(toggle_binding_pairs, app);
}

const CONTENT_FONT_SIZE: f32 = 12.;
const ITEM_VERTICAL_SPACING: f32 = 24.;
/// There's a built-in 10px margin below the text input.
const BUILT_IN_TEXT_INPUT_MARGIN: f32 = 10.;
const SPACE_AFTER_TEXT_INPUT: f32 = ITEM_VERTICAL_SPACING - BUILT_IN_TEXT_INPUT_MARGIN;

const SSH_REUSE_CONTROL_MASTER_DESCRIPTION: &str = "Attach to a live SSH ControlMaster you already have configured for the destination host instead of creating a Rook-owned one. Takes effect in new tabs.";

const SSH_EXTENSION_INSTALL_MODE_DESCRIPTION: &str = "Controls the installation behavior for Rook's SSH extension when a remote host doesn't have it installed.";

/// This page lets users configure when they get asked to rookify a session. Some shell commands
/// are recognized by default. Users can add new shell commands, or prevent the default ones from
/// asking. Users can also enable the SSH wrapper, and add hosts to a denylist.
/// This page is essentially the View for the SubshellSettings model, as well as the SshSettings
/// related to rookification.
pub struct RookifyPageView {
    page: PageType<Self>,
    /// This needs to mirror the length of SubshellSettings::added_remove_button_states.
    remove_added_command_button_states: Vec<MouseStateHandle>,
    add_added_commands_editor: ViewHandle<SubmittableTextInput>,
    /// This needs to mirror the length of SubshellSettings::denylisted_remove_button_states.
    remove_denylisted_command_button_states: Vec<MouseStateHandle>,
    add_denylisted_commands_editor: ViewHandle<SubmittableTextInput>,

    ssh_extension_install_mode_dropdown: ViewHandle<Dropdown<RookifyPageAction>>,
}

impl RookifyPageView {
    pub fn new(ctx: &mut ViewContext<Self>) -> Self {
        let rookify_settings_handle = RookifySettings::handle(ctx);

        ctx.observe(&rookify_settings_handle, Self::update_button_states);
        ctx.subscribe_to_model(&rookify_settings_handle, move |me, model, event, ctx| {
            me.update_button_states(model, ctx);
            if matches!(
                event,
                RookifySettingsChangedEvent::SshExtensionInstallModeSetting { .. }
            ) {
                me.update_dropdown(ctx);
            }
            ctx.notify();
        });

        // Added commands can be specified by regex, while denied commands are strictly exact
        // match.
        let add_added_commands_editor = ctx.add_typed_action_view(|ctx| {
            let mut input =
                SubmittableTextInput::new(ctx).validate_on_edit(|regex| Regex::new(regex).is_ok());
            input.set_placeholder_text("command (supports regex)", ctx);
            input
        });

        ctx.subscribe_to_view(
            &add_added_commands_editor,
            Self::handle_added_command_editor_event,
        );

        let add_denylisted_commands_editor = ctx.add_typed_action_view(|ctx| {
            let mut input = SubmittableTextInput::new(ctx);
            input.set_placeholder_text("command (supports regex)", ctx);
            input
        });

        ctx.subscribe_to_view(
            &add_denylisted_commands_editor,
            Self::handle_denylisted_command_editor_event,
        );

        let ssh_extension_install_mode_dropdown =
            Self::create_ssh_extension_install_mode_dropdown(ctx);

        let mut instance = Self {
            page: Self::build_page(ctx),
            remove_added_command_button_states: Default::default(),
            add_added_commands_editor,
            remove_denylisted_command_button_states: Default::default(),
            add_denylisted_commands_editor,
            ssh_extension_install_mode_dropdown,
        };

        instance.update_button_states(rookify_settings_handle, ctx);
        instance
    }

    fn build_page(ctx: &mut ViewContext<Self>) -> PageType<Self> {
        let mut categories = vec![
            Category::new("", vec![Box::new(TitleWidget::default())]),
            Category::with_header(
                CategoryHeader::new("Subshells")
                    .with_subtitle("Subshells supported: bash, zsh, and fish."),
                vec![Box::new(SubshellsWidget::default())],
            ),
        ];

        let rookify_settings = RookifySettings::as_ref(ctx);
        if rookify_settings
            .enable_ssh_rookification
            .is_supported_on_current_platform()
        {
            categories.push(Category::with_header(
                CategoryHeader::new("SSH").with_subtitle("Rookify your interactive SSH sessions."),
                vec![Box::new(SSHWidget::default())],
            ));
        }
        PageType::new_categorized(categories, None)
    }

    /// This method ensures each command in the SubshellSettings has a matching button state for
    /// its delete button in the View.
    fn update_button_states(
        &mut self,
        rookify_settings_handle: ModelHandle<RookifySettings>,
        ctx: &mut ViewContext<Self>,
    ) {
        let rookify_settings = rookify_settings_handle.as_ref(ctx);
        self.remove_denylisted_command_button_states = rookify_settings
            .subshell_command_denylist
            .iter()
            .map(|_| Default::default())
            .collect();
        self.remove_added_command_button_states = rookify_settings
            .added_subshell_commands
            .iter()
            .map(|_| Default::default())
            .collect();
        ctx.notify();
    }

    /// Syncs the install-mode dropdown selection with the current
    /// `RookifySettings::ssh_extension_install_mode` value (e.g. after it
    /// was changed from the SSH remote server choice view).
    fn update_dropdown(&mut self, ctx: &mut ViewContext<Self>) {
        let current_mode = *RookifySettings::as_ref(ctx)
            .ssh_extension_install_mode
            .value();
        self.ssh_extension_install_mode_dropdown
            .update(ctx, |dropdown, ctx| {
                dropdown.set_selected_by_action(
                    RookifyPageAction::SetSshExtensionInstallMode(current_mode),
                    ctx,
                );
            });
    }

    fn handle_added_command_editor_event(
        &mut self,
        _handle: ViewHandle<SubmittableTextInput>,
        event: &SubmittableTextInputEvent,
        ctx: &mut ViewContext<Self>,
    ) {
        match event {
            SubmittableTextInputEvent::Submit(new_command) => {
                RookifySettings::handle(ctx).update(ctx, |rookify_settings, ctx| {
                    rookify_settings.add_subshell_command(new_command, ctx);
                });

                send_telemetry_from_ctx!(TelemetryEvent::AddAddedSubshellCommand, ctx);
            }
            SubmittableTextInputEvent::Escape => ctx.emit(SettingsPageEvent::FocusModal),
        }
    }

    fn handle_denylisted_command_editor_event(
        &mut self,
        _handle: ViewHandle<SubmittableTextInput>,
        event: &SubmittableTextInputEvent,
        ctx: &mut ViewContext<Self>,
    ) {
        match event {
            SubmittableTextInputEvent::Submit(new_command) => {
                RookifySettings::handle(ctx).update(ctx, |rookify_settings, ctx| {
                    rookify_settings.denylist_subshell_command(new_command, ctx);
                });

                send_telemetry_from_ctx!(TelemetryEvent::AddDenylistedSubshellCommand, ctx);
            }
            SubmittableTextInputEvent::Escape => ctx.emit(SettingsPageEvent::FocusModal),
        }
    }

    fn remove_denylisted_command(&self, index: usize, ctx: &mut ViewContext<Self>) {
        send_telemetry_from_ctx!(TelemetryEvent::RemoveDenylistedSubshellCommand, ctx);
        RookifySettings::handle(ctx).update(ctx, |rookify, ctx| {
            rookify.remove_denylisted_subshell_command(index, ctx)
        });
    }

    fn remove_added_command(&self, index: usize, ctx: &mut ViewContext<Self>) {
        send_telemetry_from_ctx!(TelemetryEvent::RemoveAddedSubshellCommand, ctx);
        RookifySettings::handle(ctx).update(ctx, |rookify, ctx| {
            rookify.remove_added_subshell_command(index, ctx)
        });
    }
}

impl Entity for RookifyPageView {
    type Event = SettingsPageEvent;
}

fn build_sub_sub_title(title: &str, appearance: &Appearance) -> Container {
    appearance
        .ui_builder()
        .span(title.to_string())
        .with_style(UiComponentStyles {
            font_size: Some(CONTENT_FONT_SIZE),
            ..Default::default()
        })
        .build()
}

const SSH_EXTENSION_DROPDOWN_WIDTH: f32 = 250.;

impl RookifyPageView {
    fn create_ssh_extension_install_mode_dropdown(
        ctx: &mut ViewContext<Self>,
    ) -> ViewHandle<Dropdown<RookifyPageAction>> {
        let items: Vec<DropdownItem<RookifyPageAction>> = SshExtensionInstallMode::iter()
            .map(|mode| {
                DropdownItem::new(
                    mode.display_name(),
                    RookifyPageAction::SetSshExtensionInstallMode(mode),
                )
            })
            .collect();

        let current_mode = *RookifySettings::as_ref(ctx)
            .ssh_extension_install_mode
            .value();
        let enable_ssh_rookification = *RookifySettings::as_ref(ctx)
            .enable_ssh_rookification
            .value();

        ctx.add_typed_action_view(move |ctx| {
            let mut dropdown = Dropdown::new(ctx);
            dropdown.set_top_bar_max_width(SSH_EXTENSION_DROPDOWN_WIDTH);
            dropdown.set_menu_width(SSH_EXTENSION_DROPDOWN_WIDTH, ctx);
            dropdown.add_items(items, ctx);
            dropdown.set_selected_by_action(
                RookifyPageAction::SetSshExtensionInstallMode(current_mode),
                ctx,
            );
            if !enable_ssh_rookification {
                dropdown.set_disabled(ctx);
            }
            dropdown
        })
    }

    /// Renders a title, a list of items that can be removed, and an input field to add new items.
    fn build_input_list<
        ListItem: Display,
        SettingsPageAction: Action + Clone,
        F: Fn(usize) -> SettingsPageAction,
        T: View,
    >(
        &self,
        title: &str,
        patterns: &[ListItem],
        mouse_states: &[MouseStateHandle],
        create_action: F,
        handle: &ViewHandle<T>,
        appearance: &Appearance,
    ) -> Container {
        let mut column = Flex::column();
        let mut title = build_sub_sub_title(title, appearance);

        if !patterns.is_empty() {
            title = title.with_padding_bottom(BUILT_IN_TEXT_INPUT_MARGIN);
        }

        column.add_child(title.finish());

        render_alternating_color_list(
            &mut column,
            patterns,
            mouse_states,
            create_action,
            appearance,
        );

        Container::new(
            column
                .with_child(
                    Container::new(ChildView::new(handle).finish())
                        .with_margin_bottom(SPACE_AFTER_TEXT_INPUT)
                        .finish(),
                )
                .finish(),
        )
    }
}

impl View for RookifyPageView {
    fn ui_name() -> &'static str {
        "RookifyPageView"
    }

    fn render(&self, app: &AppContext) -> Box<dyn Element> {
        self.page.render(self, app)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum RookifyPageAction {
    RemoveAddedCommand(usize),
    RemoveDenylistedCommand(usize),
    ToggleSshRookification,
    /// Toggles whether the legacy SSH wrapper attaches to an existing
    /// ControlMaster for the destination host instead of creating its own.
    ToggleReuseSshControlMaster,
    /// Set the SSH extension installation mode (always ask / always install / always skip).
    SetSshExtensionInstallMode(SshExtensionInstallMode),
    OpenUrl(String),
}

impl TypedActionView for RookifyPageView {
    type Action = RookifyPageAction;

    fn handle_action(&mut self, action: &Self::Action, ctx: &mut ViewContext<Self>) {
        use RookifyPageAction::*;
        match action {
            RemoveDenylistedCommand(index) => self.remove_denylisted_command(*index, ctx),
            RemoveAddedCommand(index) => self.remove_added_command(*index, ctx),
            ToggleSshRookification => {
                RookifySettings::handle(ctx).update(ctx, |ssh_settings, ctx| {
                    report_if_error!(
                        ssh_settings
                            .enable_ssh_rookification
                            .toggle_and_save_value(ctx)
                    );
                    send_telemetry_from_ctx!(
                        TelemetryEvent::ToggleSshRookification {
                            enabled: *ssh_settings.enable_ssh_rookification.value(),
                        },
                        ctx
                    );
                });
                let enabled = *RookifySettings::as_ref(ctx)
                    .enable_ssh_rookification
                    .value();
                self.ssh_extension_install_mode_dropdown
                    .update(ctx, |dropdown, ctx| {
                        if enabled {
                            dropdown.set_enabled(ctx);
                        } else {
                            dropdown.set_disabled(ctx);
                        }
                    });
            }
            ToggleReuseSshControlMaster => {
                SshSettings::handle(ctx).update(ctx, |ssh_settings, ctx| {
                    report_if_error!(
                        ssh_settings
                            .reuse_existing_control_master
                            .toggle_and_save_value(ctx)
                    );
                    send_telemetry_from_ctx!(
                        TelemetryEvent::FeaturesPageAction {
                            action: "ToggleSshReuseControlMaster".to_string(),
                            value: ssh_settings
                                .reuse_existing_control_master
                                .value()
                                .to_string(),
                        },
                        ctx
                    );
                });
            }
            SetSshExtensionInstallMode(mode) => {
                RookifySettings::handle(ctx).update(ctx, |rookify_settings, ctx| {
                    report_if_error!(
                        rookify_settings
                            .ssh_extension_install_mode
                            .set_value(*mode, ctx)
                    );
                    send_telemetry_from_ctx!(
                        TelemetryEvent::SetSshExtensionInstallMode {
                            mode: mode.display_name(),
                        },
                        ctx
                    );
                });
            }
            OpenUrl(url) => {
                ctx.open_url(url.as_str());
            }
        }
    }
}

impl SettingsPageMeta for RookifyPageView {
    fn section() -> SettingsSection {
        SettingsSection::Rookify
    }

    fn should_render(&self, _ctx: &AppContext) -> bool {
        true
    }

    fn update_filter(&mut self, query: &SearchQuery, ctx: &mut ViewContext<Self>) -> MatchData {
        self.page.update_filter(query, ctx)
    }

    fn scroll_to_widget(&mut self, widget_id: &'static str) {
        self.page.scroll_to_widget(widget_id)
    }

    fn clear_highlighted_widget(&mut self) {
        self.page.clear_highlighted_widget();
    }
}

impl From<ViewHandle<RookifyPageView>> for SettingsPageViewHandle {
    fn from(view_handle: ViewHandle<RookifyPageView>) -> Self {
        SettingsPageViewHandle::Rookify(view_handle)
    }
}

#[derive(Default)]
struct TitleWidget {
    learn_more_highlight_index: HighlightedHyperlink,
}

impl TitleWidget {
    fn render_top_of_page(&self, appearance: &Appearance, _app: &AppContext) -> Box<dyn Element> {
        let rookify_description = vec![
            FormattedTextFragment::plain_text(
                "Configure whether Rook attempts to “Rookify” (add support for blocks, \
                    input modes, etc) certain shells. ",
            ),
            FormattedTextFragment::hyperlink(
                "Learn more",
                "https://docs.rook.dev/terminal/rookify/subshells",
            ),
        ];

        let rookify_description = FormattedTextElement::new(
            FormattedText::new([FormattedTextLine::Line(rookify_description)]),
            CONTENT_FONT_SIZE,
            appearance.ui_font_family(),
            appearance.ui_font_family(),
            blended_colors::text_sub(appearance.theme(), appearance.theme().surface_1()),
            self.learn_more_highlight_index.clone(),
        )
        .with_hyperlink_font_color(appearance.theme().accent().into_solid())
        .register_default_click_handlers(|url, _, ctx| {
            ctx.open_url(&url.url);
        })
        .finish();

        Flex::column()
            .with_child(render_page_title("Rookify", HEADER_FONT_SIZE, appearance))
            .with_child(rookify_description)
            .finish()
    }
}

impl SettingsWidget for TitleWidget {
    type View = RookifyPageView;

    fn search_terms(&self) -> &str {
        "ssh subshell rookify session"
    }

    fn render(
        &self,
        _view: &Self::View,
        appearance: &Appearance,
        app: &AppContext,
    ) -> Box<dyn Element> {
        Container::new(self.render_top_of_page(appearance, app))
            .with_margin_bottom(ITEM_VERTICAL_SPACING)
            .finish()
    }
}

#[derive(Default)]
struct SubshellsWidget {}

impl SubshellsWidget {
    fn render_subshells_section(
        &self,
        view: &RookifyPageView,
        appearance: &Appearance,
        app: &AppContext,
    ) -> Box<dyn Element> {
        let mut column = Flex::column();

        let rookify_settings = RookifySettings::as_ref(app);

        column.add_child(
            view.build_input_list(
                "Added commands",
                &rookify_settings.added_subshell_commands,
                &view.remove_added_command_button_states,
                RookifyPageAction::RemoveAddedCommand,
                &view.add_added_commands_editor,
                appearance,
            )
            .finish(),
        );

        column.add_child(
            view.build_input_list(
                "Denylisted commands",
                &rookify_settings.subshell_command_denylist,
                &view.remove_denylisted_command_button_states,
                RookifyPageAction::RemoveDenylistedCommand,
                &view.add_denylisted_commands_editor,
                appearance,
            )
            .with_margin_bottom(-BUILT_IN_TEXT_INPUT_MARGIN)
            .finish(),
        );

        column.finish()
    }
}

impl SettingsWidget for SubshellsWidget {
    type View = RookifyPageView;

    fn search_terms(&self) -> &str {
        "rookify subshell"
    }

    fn render(
        &self,
        view: &Self::View,
        appearance: &Appearance,
        app: &AppContext,
    ) -> Box<dyn Element> {
        Container::new(self.render_subshells_section(view, appearance, app))
            .with_margin_bottom(ITEM_VERTICAL_SPACING)
            .finish()
    }
}

#[derive(Default)]
struct SSHWidget {
    enable_ssh_rookification_switch_state: SwitchStateHandle,
    reuse_control_master_switch_state: SwitchStateHandle,
    local_only_icon_tooltip_states: RefCell<HashMap<String, MouseStateHandle>>,
}

impl SettingsWidget for SSHWidget {
    type View = RookifyPageView;

    fn search_terms(&self) -> &str {
        "rookify ssh sessions install extension reuse controlmaster"
    }

    fn render(
        &self,
        view: &Self::View,
        appearance: &Appearance,
        app: &AppContext,
    ) -> Box<dyn Element> {
        let mut column = Flex::column();
        let ui_builder = appearance.ui_builder();
        let description_text_color = appearance
            .theme()
            .sub_text_color(appearance.theme().surface_2());

        let enable_ssh_rookification = *RookifySettings::as_ref(app)
            .enable_ssh_rookification
            .value();

        add_setting(
            &mut column,
            &RookifySettings::as_ref(app).enable_ssh_rookification,
            move || {
                render_body_item::<RookifyPageAction>(
                    "Rookify SSH Sessions".into(),
                    None,
                    LocalOnlyIconState::for_setting(
                        EnableSshRookification::storage_key(),
                        EnableSshRookification::sync_to_cloud(),
                        &mut self.local_only_icon_tooltip_states.borrow_mut(),
                        app,
                    ),
                    ToggleState::Enabled,
                    appearance,
                    ui_builder
                        .switch(self.enable_ssh_rookification_switch_state.clone())
                        .check(enable_ssh_rookification)
                        .build()
                        .on_click(move |ctx, _, _| {
                            ctx.dispatch_typed_action(RookifyPageAction::ToggleSshRookification);
                        })
                        .finish(),
                    None,
                )
            },
        );

        if FeatureFlag::SshRemoteServer.is_enabled() {
            let label_color_override = if !enable_ssh_rookification {
                Some(appearance.theme().disabled_ui_text_color())
            } else {
                None
            };
            add_setting(
                &mut column,
                &RookifySettings::as_ref(app).ssh_extension_install_mode,
                move || {
                    Container::new(render_dropdown_item(
                        appearance,
                        "Install SSH extension",
                        Some(SSH_EXTENSION_INSTALL_MODE_DESCRIPTION),
                        None,
                        LocalOnlyIconState::for_setting(
                            SshExtensionInstallModeSetting::storage_key(),
                            SshExtensionInstallModeSetting::sync_to_cloud(),
                            &mut self.local_only_icon_tooltip_states.borrow_mut(),
                            app,
                        ),
                        label_color_override,
                        &view.ssh_extension_install_mode_dropdown,
                    ))
                    .with_padding_bottom(HEADER_PADDING)
                    .finish()
                },
            );
        }

        let reuse_existing_control_master = *SshSettings::as_ref(app)
            .reuse_existing_control_master
            .value();
        add_setting(
            &mut column,
            &SshSettings::as_ref(app).reuse_existing_control_master,
            move || {
                let mut column = Flex::column();
                column.add_child(render_body_item::<RookifyPageAction>(
                    "Reuse existing SSH ControlMaster".into(),
                    None,
                    LocalOnlyIconState::for_setting(
                        ReuseExistingSshControlMaster::storage_key(),
                        ReuseExistingSshControlMaster::sync_to_cloud(),
                        &mut self.local_only_icon_tooltip_states.borrow_mut(),
                        app,
                    ),
                    enable_ssh_rookification.into(),
                    appearance,
                    ui_builder
                        .switch(self.reuse_control_master_switch_state.clone())
                        .check(reuse_existing_control_master)
                        .with_disabled(!enable_ssh_rookification)
                        .build()
                        .on_click(move |ctx, _, _| {
                            if !enable_ssh_rookification {
                                return;
                            }
                            ctx.dispatch_typed_action(
                                RookifyPageAction::ToggleReuseSshControlMaster,
                            );
                        })
                        .finish(),
                    None,
                ));
                column.add_child(
                    ui_builder
                        .paragraph(SSH_REUSE_CONTROL_MASTER_DESCRIPTION.to_owned())
                        .with_style(UiComponentStyles {
                            font_color: Some(description_text_color.into_solid()),
                            margin: Some(
                                Coords::default()
                                    .top(styles::DESCRIPTION_NEGATIVE_MARGIN_OFFSET)
                                    .bottom(styles::DESCRIPTION_LINE_MARGIN_BOTTOM),
                            ),
                            ..Default::default()
                        })
                        .build()
                        .finish(),
                );
                column.finish()
            },
        );

        column.finish()
    }
}

mod styles {
    // Apply a negative margin to the description text so it appears closer to the main
    // settings option text.
    pub const DESCRIPTION_NEGATIVE_MARGIN_OFFSET: f32 = -8.;

    /// The space after a description.
    pub const DESCRIPTION_LINE_MARGIN_BOTTOM: f32 = 18.;
}

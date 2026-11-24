//! Settings UI for local scripting and Polaris Terminal control permissions.
use std::cell::RefCell;
use std::collections::HashMap;

#[cfg(target_os = "macos")]
use pterm_core::channel::ChannelState;
use pterm_errors::report_if_error;
use ptermui::elements::{ChildView, Element, MouseStateHandle};
#[cfg(target_os = "macos")]
use ptermui::ui_components::button::ButtonVariant;
#[cfg(target_os = "macos")]
use ptermui::ui_components::components::UiComponent;
use ptermui::{
    AppContext, Entity, SingletonEntity, TypedActionView, View, ViewContext, ViewHandle,
};
use settings::Setting as _;

use super::search::SearchQuery;
use super::settings_page::{
    LocalOnlyIconState, MatchData, PageTitle, PageType, SettingsPageMeta, SettingsPageViewHandle,
    SettingsWidget, render_body_item,
};
use super::{SettingsSection, ToggleState};
use crate::appearance::Appearance;
use crate::features::FeatureFlag;
use crate::settings::{LocalControlMode, LocalControlModeSetting, LocalControlSettings};
#[cfg(target_os = "macos")]
use crate::view_components::DismissibleToast;
use crate::view_components::{Dropdown, DropdownItem};
#[cfg(target_os = "macos")]
use crate::workspace::{ToastStack, cli_install};

#[derive(Clone, Debug, PartialEq)]
pub enum ScriptingSettingsPageAction {
    SetLocalControlMode(LocalControlMode),
    #[cfg(target_os = "macos")]
    InstallPtermControlCli,
}

pub struct ScriptingSettingsPageView {
    page: PageType<Self>,
    local_only_icon_tooltip_states: RefCell<HashMap<String, MouseStateHandle>>,
    local_control_mode_dropdown: ViewHandle<Dropdown<ScriptingSettingsPageAction>>,
    #[cfg(target_os = "macos")]
    ptermctrl_installing: bool,
}

impl ScriptingSettingsPageView {
    pub fn new(ctx: &mut ViewContext<Self>) -> Self {
        let local_control_mode_dropdown = ctx.add_typed_action_view(|ctx| {
            let mut dropdown = Dropdown::new(ctx);
            dropdown.set_top_bar_max_width(360.);
            dropdown
        });
        Self::update_local_control_mode_dropdown(local_control_mode_dropdown.clone(), ctx);

        if FeatureFlag::PtermControlCli.is_enabled() {
            ctx.subscribe_to_model(&LocalControlSettings::handle(ctx), |view, _, _, ctx| {
                Self::update_local_control_mode_dropdown(
                    view.local_control_mode_dropdown.clone(),
                    ctx,
                );
                ctx.notify();
            });
        }

        #[cfg(target_os = "macos")]
        let widgets: Vec<Box<dyn SettingsWidget<View = Self>>> = vec![
            Box::new(PtermControlCliInstallWidget::default()),
            Box::new(LocalControlModeWidget),
        ];
        #[cfg(not(target_os = "macos"))]
        let widgets: Vec<Box<dyn SettingsWidget<View = Self>>> =
            vec![Box::new(LocalControlModeWidget)];

        Self {
            page: PageType::new_uncategorized(widgets, Some(PageTitle::new("Scripting"))),
            local_only_icon_tooltip_states: RefCell::new(HashMap::new()),
            local_control_mode_dropdown,
            #[cfg(target_os = "macos")]
            ptermctrl_installing: false,
        }
    }

    fn update_local_control_mode_dropdown(
        dropdown: ViewHandle<Dropdown<ScriptingSettingsPageAction>>,
        ctx: &mut ViewContext<Self>,
    ) {
        let current_mode = LocalControlSettings::as_ref(ctx).mode();
        dropdown.update(ctx, |dropdown, ctx| {
            dropdown.set_items(
                LocalControlMode::ALL
                    .into_iter()
                    .map(|mode| {
                        DropdownItem::new(
                            mode.as_dropdown_label(),
                            ScriptingSettingsPageAction::SetLocalControlMode(mode),
                        )
                    })
                    .collect(),
                ctx,
            );
            dropdown.set_selected_by_action(
                ScriptingSettingsPageAction::SetLocalControlMode(current_mode),
                ctx,
            );
        });
    }

    #[cfg(target_os = "macos")]
    fn install_ptermctrl(&mut self, ctx: &mut ViewContext<Self>) {
        if self.ptermctrl_installing || cli_install::is_ptermctrl_installed() {
            return;
        }

        self.ptermctrl_installing = true;
        ctx.notify();
        let window_id = ctx.window_id();
        ctx.spawn(
            async { cli_install::install_ptermctrl() },
            move |view, result, ctx| {
                view.ptermctrl_installing = false;
                match result {
                    Ok(()) => {
                        let command_name = ChannelState::channel().ptermctrl_command_name();
                        let message = format!(
                            "Successfully installed the Polaris Terminal Control CLI! You can now run '{command_name}' from the command line."
                        );
                        ToastStack::handle(ctx).update(ctx, |toast_stack, ctx| {
                            toast_stack.add_ephemeral_toast(
                                DismissibleToast::success(message),
                                window_id,
                                ctx,
                            );
                        });
                    }
                    Err(error) => {
                        let message = format!("Failed to install Polaris Terminal Control command: {error}");
                        log::warn!("{message}");
                        ToastStack::handle(ctx).update(ctx, |toast_stack, ctx| {
                            toast_stack.add_persistent_toast(
                                DismissibleToast::error(message),
                                window_id,
                                ctx,
                            );
                        });
                    }
                }
                ctx.notify();
            },
        );
    }
}

impl Entity for ScriptingSettingsPageView {
    type Event = ();
}

impl TypedActionView for ScriptingSettingsPageView {
    type Action = ScriptingSettingsPageAction;

    fn handle_action(&mut self, action: &Self::Action, ctx: &mut ViewContext<Self>) {
        match action {
            ScriptingSettingsPageAction::SetLocalControlMode(mode) => {
                LocalControlSettings::handle(ctx).update(ctx, |settings, ctx| {
                    report_if_error!(settings.local_control_mode.set_value(*mode, ctx));
                });
                ctx.notify();
            }
            #[cfg(target_os = "macos")]
            ScriptingSettingsPageAction::InstallPtermControlCli => self.install_ptermctrl(ctx),
        }
    }
}

impl View for ScriptingSettingsPageView {
    fn ui_name() -> &'static str {
        "ScriptingSettingsPage"
    }

    fn render(&self, app: &AppContext) -> Box<dyn Element> {
        self.page.render(self, app)
    }
}

impl SettingsPageMeta for ScriptingSettingsPageView {
    fn section() -> SettingsSection {
        SettingsSection::Scripting
    }

    fn should_render(&self, _ctx: &AppContext) -> bool {
        cfg!(not(target_family = "wasm")) && FeatureFlag::PtermControlCli.is_enabled()
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

impl From<ViewHandle<ScriptingSettingsPageView>> for SettingsPageViewHandle {
    fn from(view_handle: ViewHandle<ScriptingSettingsPageView>) -> Self {
        SettingsPageViewHandle::Scripting(view_handle)
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct PtermControlCliInstallWidget {
    install_button_mouse_state: MouseStateHandle,
}

#[cfg(target_os = "macos")]
impl SettingsWidget for PtermControlCliInstallWidget {
    type View = ScriptingSettingsPageView;

    fn search_terms(&self) -> &str {
        "polaris-terminal control cli command ptermctrl install scripting"
    }

    fn render(
        &self,
        view: &Self::View,
        appearance: &Appearance,
        _app: &AppContext,
    ) -> Box<dyn Element> {
        let installed = cli_install::is_ptermctrl_installed();
        let disabled = view.ptermctrl_installing || installed;
        let label = if view.ptermctrl_installing {
            "Installing…"
        } else if installed {
            "Installed"
        } else {
            "Install"
        };
        let mut button = appearance
            .ui_builder()
            .button(
                ButtonVariant::Secondary,
                self.install_button_mouse_state.clone(),
            )
            .with_text_label(label.to_owned());
        if disabled {
            button = button.disabled();
        }
        let button = if disabled {
            button.build().finish()
        } else {
            button
                .build()
                .on_click(|ctx, _, _| {
                    ctx.dispatch_typed_action(ScriptingSettingsPageAction::InstallPtermControlCli);
                })
                .finish()
        };

        render_body_item::<ScriptingSettingsPageAction>(
            "Polaris Terminal Control CLI command".into(),
            None,
            LocalOnlyIconState::Hidden,
            ToggleState::Enabled,
            appearance,
            button,
            Some(
                "Install the ptermctrl command for scripting Polaris Terminal from your terminal."
                    .to_owned(),
            ),
        )
    }
}
struct LocalControlModeWidget;

impl SettingsWidget for LocalControlModeWidget {
    type View = ScriptingSettingsPageView;

    fn search_terms(&self) -> &str {
        "scripting polaris-terminal control automation ptermctrl local cli scripts disabled enabled"
    }

    fn render(
        &self,
        view: &Self::View,
        appearance: &Appearance,
        app: &AppContext,
    ) -> Box<dyn Element> {
        render_body_item::<ScriptingSettingsPageAction>(
            "ptermctrl CLI".into(),
            None,
            LocalOnlyIconState::for_setting(
                LocalControlModeSetting::storage_key(),
                LocalControlModeSetting::sync_to_cloud(),
                &mut view.local_only_icon_tooltip_states.borrow_mut(),
                app,
            ),
            ToggleState::Enabled,
            appearance,
            ChildView::new(&view.local_control_mode_dropdown).finish(),
            Some("ptermctrl allows for scripting Polaris Terminal's UI. Use with care.".to_owned()),
        )
    }
}

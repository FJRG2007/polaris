use std::sync::Arc;

use parking_lot::FairMutex;
use rookui::elements::{
    ChildView, Container, CrossAxisAlignment, Expanded, Flex, MainAxisSize, ParentElement,
};
use rookui::prelude::Empty;
use rookui::{AppContext, Element, Entity, TypedActionView, View, ViewContext, ViewHandle};

use super::{AgentFooterButtonTheme, USE_AGENT_KEYSTROKE};
use crate::terminal::view::{PADDING_LEFT, TerminalModel};
use crate::ui_components::icons::Icon;
use crate::view_components::action_button::{
    ActionButton, ButtonSize, KeystrokeSource, TooltipAlignment,
};

/// Footer view rendered for detected subshell commands, offering both
/// "Rookify" and "Use agent" buttons in a horizontal row.
pub(super) struct RookifyFooterView {
    terminal_model: Arc<FairMutex<TerminalModel>>,
    rookify_button: ViewHandle<ActionButton>,
    use_agent_button: ViewHandle<ActionButton>,
    dismiss_button: ViewHandle<ActionButton>,
    /// Whether the footer is currently offering subshell rookification.
    is_active: bool,
}

impl RookifyFooterView {
    pub fn new(terminal_model: Arc<FairMutex<TerminalModel>>, ctx: &mut ViewContext<Self>) -> Self {
        let button_size = ButtonSize::XSmall;

        let rookify_button = ctx.add_typed_action_view(|_ctx| {
            ActionButton::new("Rookify subshell", AgentFooterButtonTheme::new(None))
                .with_icon(Icon::Rook)
                .with_size(button_size)
                .with_tooltip("Enable Rook shell integration in this session")
                .with_tooltip_alignment(TooltipAlignment::Left)
                .on_click(|ctx| {
                    ctx.dispatch_typed_action(RookifyFooterViewAction::Rookify);
                })
        });

        let use_agent_button = ctx.add_typed_action_view(|ctx| {
            ActionButton::new("Use agent", AgentFooterButtonTheme::new(None))
                .with_icon(Icon::Agent)
                .with_keybinding(KeystrokeSource::Fixed(USE_AGENT_KEYSTROKE.clone()), ctx)
                .with_size(button_size)
                .with_tooltip("Ask the Rook agent to assist")
                .with_tooltip_alignment(TooltipAlignment::Left)
                .on_click(|ctx| {
                    ctx.dispatch_typed_action(RookifyFooterViewAction::UseAgent);
                })
        });

        let dismiss_button = ctx.add_typed_action_view(|_ctx| {
            ActionButton::new("Dismiss", AgentFooterButtonTheme::new(None))
                .with_size(button_size)
                .on_click(|ctx| {
                    ctx.dispatch_typed_action(RookifyFooterViewAction::Dismiss);
                })
        });

        Self {
            terminal_model,
            rookify_button,
            use_agent_button,
            dismiss_button,
            is_active: false,
        }
    }

    /// Activates the footer so it offers subshell rookification.
    pub fn show(&mut self, ctx: &mut ViewContext<Self>) {
        self.rookify_button.update(ctx, |button, ctx| {
            button.set_keybinding(
                Some(KeystrokeSource::Binding("terminal:rookify_subshell")),
                ctx,
            );
        });
        self.is_active = true;
        ctx.notify();
    }

    /// Returns whether the footer is currently offering subshell rookification.
    pub fn is_active(&self) -> bool {
        self.is_active
    }

    /// Deactivates the footer.
    pub fn clear(&mut self, ctx: &mut ViewContext<Self>) {
        self.is_active = false;
        self.rookify_button.update(ctx, |button, ctx| {
            button.set_keybinding(None, ctx);
        });
        ctx.notify();
    }
}

#[derive(Debug, Clone)]
pub enum RookifyFooterViewAction {
    Rookify,
    UseAgent,
    Dismiss,
}

pub enum RookifyFooterViewEvent {
    Rookify,
    UseAgent,
    Dismiss,
}

impl Entity for RookifyFooterView {
    type Event = RookifyFooterViewEvent;
}

impl View for RookifyFooterView {
    fn ui_name() -> &'static str {
        "RookifyFooterView"
    }

    fn render(&self, _app: &AppContext) -> Box<dyn Element> {
        let terminal_model = self.terminal_model.lock();

        let button_row = Flex::row()
            .with_spacing(4.)
            .with_main_axis_size(MainAxisSize::Max)
            .with_cross_axis_alignment(CrossAxisAlignment::Center)
            .with_child(ChildView::new(&self.rookify_button).finish())
            .with_child(ChildView::new(&self.use_agent_button).finish())
            .with_child(Expanded::new(1., Empty::new().finish()).finish())
            .with_child(ChildView::new(&self.dismiss_button).finish());

        let mut container = Container::new(button_row.finish())
            .with_horizontal_padding(*PADDING_LEFT)
            .with_vertical_padding(4.);

        if terminal_model.is_alt_screen_active()
            && let Some(bg_color) = terminal_model.alt_screen().inferred_bg_color()
        {
            container = container.with_background(bg_color);
        }

        container.finish()
    }
}

impl TypedActionView for RookifyFooterView {
    type Action = RookifyFooterViewAction;

    fn handle_action(&mut self, action: &Self::Action, ctx: &mut ViewContext<Self>) {
        match action {
            RookifyFooterViewAction::Rookify => {
                if self.is_active {
                    self.clear(ctx);
                    ctx.emit(RookifyFooterViewEvent::Rookify);
                }
            }
            RookifyFooterViewAction::UseAgent => {
                self.clear(ctx);
                ctx.emit(RookifyFooterViewEvent::UseAgent);
            }
            RookifyFooterViewAction::Dismiss => {
                self.clear(ctx);
                ctx.emit(RookifyFooterViewEvent::Dismiss);
            }
        }
    }
}

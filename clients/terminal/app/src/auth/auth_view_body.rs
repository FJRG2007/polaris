use lazy_static::lazy_static;
use pterm_core::features::FeatureFlag;
use pterm_core::ui::appearance::DEFAULT_COMMAND_PALETTE_FONT_SIZE;
use pterm_core::ui::builder::UiBuilder;
use ptermui::accessibility::{AccessibilityContent, PtermA11yRole};
use ptermui::color::ColorU;
use ptermui::elements::{
    Align, Border, Container, CornerRadius, CrossAxisAlignment, Dismiss, Fill, Flex,
    MainAxisAlignment, MainAxisSize, MouseStateHandle, ParentElement, Radius, Stack,
};
use ptermui::fonts::Weight;
use ptermui::keymap::FixedBinding;
use ptermui::ui_components::components::{Coords, UiComponent, UiComponentStyles};
use ptermui::{
    AppContext, Element, Entity, FocusContext, SingletonEntity, TypedActionView, UpdateModel, View,
    ViewContext,
};

use super::auth_view_modal::AuthViewVariant;
use super::auth_view_shared_helpers::{
    PrivacySettingsActions, PrivacySettingsHandles, action_button_color_and_variant,
    render_offline_info_overlay_body, render_overlay, render_privacy_settings_overlay_body,
    render_square_logo,
};
use crate::appearance::Appearance;
use crate::auth::auth_view_shared_helpers::render_offline_contents;
use crate::modal::MODAL_CORNER_RADIUS;
use crate::network::NetworkStatus;
use crate::server::telemetry::{LoginEventSource, TelemetryEvent};
use crate::settings::{AISettings, PrivacySettings};
use crate::util::color::{darken, lighten};
use crate::{send_telemetry_from_ctx, send_telemetry_sync_from_ctx};

const TOS_URL: &str = "https://fjrg2007.github.io/polaris";

const COMMON_BODY_UI_FONT_SIZE: f32 = 12.;
const AUTH_MODAL_GAP: f32 = 16.;

lazy_static! {
    static ref BODY_TEXT_COLOR: ColorU = ColorU::new(157, 157, 157, 255);
    static ref HOVERED_BODY_TEXT_COLOR: ColorU = lighten(*BODY_TEXT_COLOR);
}

pub fn init(app: &mut AppContext) {
    use ptermui::keymap::macros::*;

    app.register_fixed_bindings([FixedBinding::new(
        "enter",
        AuthViewBodyAction::Signup,
        id!("AuthViewBody"),
    )]);
    app.register_fixed_bindings([FixedBinding::new(
        "escape",
        AuthViewBodyAction::Close,
        id!("AuthViewBody"),
    )]);
}

#[derive(Default)]
struct MouseStateHandles {
    enter_login_later_mouse_state_handle: MouseStateHandle,
    confirm_login_later_mouse_state_handle: MouseStateHandle,
    tos_mouse_state_handle: MouseStateHandle,
    sign_up_mouse_state_handle: MouseStateHandle,
    learn_more_mouse_state_handle: MouseStateHandle,
    privacy_settings_mouse_state_handle: MouseStateHandle,
    close_button_mouse_state_handle: MouseStateHandle,
}

#[derive(Copy, Clone, Debug)]
pub enum AuthViewOverlay {
    PrivacySettings,
    OfflineInfo,
}

pub struct AuthViewBody {
    variant: AuthViewVariant,
    mouse_state_handles: MouseStateHandles,
    privacy_settings_handles: PrivacySettingsHandles,
    active_overlay: Option<AuthViewOverlay>,
    loginless_step: LoginlessStep,
    allow_loginless: bool,
}

/// State for two-step loginless flow for anonymous users
enum LoginlessStep {
    /// Initial state: user has not yet clicked "sign up later" entrypoint
    Start,
    /// Confirmation state: user has clicked "sign up later" and is now in confirmation view
    Initiated,
}

#[derive(Clone, Copy, Debug)]
pub enum AuthViewBodyAction {
    InitiateLoginLater,
    LoginLater,
    Signup,
    ShowOverlay(AuthViewOverlay),
    HideOverlay,
    ToggleTelemetry,
    ToggleCrashReporting,
    ToggleCloudConversationStorage,
    Close,
}

impl AuthViewBody {
    pub fn new(variant: AuthViewVariant, ctx: &mut ViewContext<Self>) -> Self {
        let allow_loginless = !FeatureFlag::ForceLogin.is_enabled();

        let network_status = NetworkStatus::handle(ctx);
        ctx.subscribe_to_model(&network_status, |_, _, _, ctx| {
            ctx.notify();
        });

        AuthViewBody {
            variant,
            mouse_state_handles: Default::default(),
            privacy_settings_handles: Default::default(),
            active_overlay: None,
            loginless_step: LoginlessStep::Start,
            allow_loginless,
        }
    }

    pub fn reset_login_screen(&mut self) {
        self.loginless_step = LoginlessStep::Start;
    }

    pub fn set_variant(&mut self, variant: AuthViewVariant) {
        self.variant = variant;
    }

    fn privacy_settings_actions(&self) -> PrivacySettingsActions<AuthViewBodyAction> {
        PrivacySettingsActions {
            toggle_telemetry: AuthViewBodyAction::ToggleTelemetry,
            toggle_crash_reporting: AuthViewBodyAction::ToggleCrashReporting,
            toggle_cloud_conversation_storage: AuthViewBodyAction::ToggleCloudConversationStorage,
            hide_overlay: AuthViewBodyAction::HideOverlay,
        }
    }

    fn render_privacy_information(
        &self,
        appearance: &Appearance,
        ui_builder: &UiBuilder,
    ) -> Vec<Box<dyn Element>> {
        let disclaimer_color = appearance
            .theme()
            .sub_text_color(appearance.theme().background())
            .into();

        let disclaimer_styles = UiComponentStyles {
            font_color: Some(disclaimer_color),
            ..Default::default()
        };

        let link_styles = UiComponentStyles {
            font_color: Some(disclaimer_color),
            border_color: Some(Fill::Solid(disclaimer_color)),
            ..Default::default()
        };

        let disclaimer_line_1 = Container::new(
            Flex::row()
                .with_child(
                    ui_builder
                        .span("By continuing, you agree to Polaris Terminal's ")
                        .with_style(disclaimer_styles)
                        .build()
                        .finish(),
                )
                .with_child(
                    ui_builder
                        .link(
                            "Terms of Service".into(),
                            Some(TOS_URL.into()),
                            None,
                            self.mouse_state_handles.tos_mouse_state_handle.clone(),
                        )
                        .soft_wrap(false)
                        .with_style(link_styles)
                        .build()
                        .finish(),
                )
                .finish(),
        )
        .with_margin_top(AUTH_MODAL_GAP)
        .with_margin_bottom(8.)
        .finish();

        let disclaimer_line_2 = if FeatureFlag::GlobalAIAnalyticsBanner.is_enabled() {
            Align::new(
                ui_builder
                    .link(
                        "Privacy Settings".into(),
                        None,
                        Some(Box::new(|ctx| {
                            ctx.dispatch_typed_action(AuthViewBodyAction::ShowOverlay(
                                AuthViewOverlay::PrivacySettings,
                            ));
                        })),
                        self.mouse_state_handles
                            .privacy_settings_mouse_state_handle
                            .clone(),
                    )
                    .soft_wrap(false)
                    .build()
                    .finish(),
            )
            .left()
            .finish()
        } else {
            Flex::column()
                .with_child(
                    ui_builder
                        .paragraph("If you'd like to opt out of analytics and AI features,")
                        .with_style(disclaimer_styles)
                        .build()
                        .finish(),
                )
                .with_child(
                    Flex::row()
                        .with_child(
                            ui_builder
                                .paragraph("you can adjust your ")
                                .with_style(disclaimer_styles)
                                .build()
                                .finish(),
                        )
                        .with_child(
                            ui_builder
                                .link(
                                    "Privacy Settings".into(),
                                    None,
                                    Some(Box::new(|ctx| {
                                        ctx.dispatch_typed_action(AuthViewBodyAction::ShowOverlay(
                                            AuthViewOverlay::PrivacySettings,
                                        ));
                                    })),
                                    self.mouse_state_handles
                                        .privacy_settings_mouse_state_handle
                                        .clone(),
                                )
                                .soft_wrap(false)
                                .with_style(link_styles)
                                .build()
                                .finish(),
                        )
                        .finish(),
                )
                .finish()
        };

        vec![disclaimer_line_1, disclaimer_line_2]
    }

    fn render_sign_up_button(
        &self,
        appearance: &Appearance,
        ui_builder: &UiBuilder,
    ) -> Box<dyn Element> {
        let (button_color, button_variant) = action_button_color_and_variant(appearance);
        let button_styles = UiComponentStyles {
            font_size: Some(14.),
            font_family_id: Some(appearance.ui_font_family()),
            font_weight: Some(Weight::Bold),
            background: Some(Fill::Solid(button_color)),
            border_width: Some(2.),
            border_color: Some(Fill::Solid(ColorU::transparent_black())),
            border_radius: Some(CornerRadius::with_all(Radius::Pixels(4.))),
            padding: Some(Coords {
                top: 0.,
                bottom: 0.,
                left: 12., // Unequal padding for optical centering
                right: 8.,
            }),
            height: Some(40.),
            ..Default::default()
        };

        let hover_button_style = UiComponentStyles {
            border_color: Some(Fill::Solid(lighten(button_color))),
            ..button_styles
        };

        let click_button_style = UiComponentStyles {
            background: Some(Fill::Solid(darken(button_color))),
            ..hover_button_style
        };

        let on_click_action = AuthViewBodyAction::Signup;

        ui_builder
            .button_with_custom_styles(
                button_variant,
                self.mouse_state_handles.sign_up_mouse_state_handle.clone(),
                button_styles,
                Some(hover_button_style),
                Some(click_button_style),
                None,
            )
            .with_centered_text_label("Sign in to your Polaris".into())
            .build()
            .on_click(move |ctx, _, _| {
                ctx.dispatch_typed_action(on_click_action);
            })
            .finish()
    }

    fn render_sign_up_later_row(&self, ui_builder: &UiBuilder) -> Box<dyn Element> {
        Container::new(
            Flex::row()
                .with_child(
                    ui_builder
                        .span("Don't want to sign in right now? ")
                        .build()
                        .finish(),
                )
                .with_child(
                    ui_builder
                        .link(
                            "Skip for now".into(),
                            None,
                            Some(Box::new(|ctx| {
                                ctx.dispatch_typed_action(AuthViewBodyAction::InitiateLoginLater);
                            })),
                            self.mouse_state_handles
                                .enter_login_later_mouse_state_handle
                                .clone(),
                        )
                        .soft_wrap(false)
                        .build()
                        .finish(),
                )
                .finish(),
        )
        .with_margin_top(8.)
        .finish()
    }

    fn render_sign_in_later_confirm_row(&self, ui_builder: &UiBuilder) -> Box<dyn Element> {
        Container::new(
            Flex::column()
                .with_child(
                    ui_builder
                        .paragraph("Are you sure you want to skip login?")
                        .build()
                        .finish(),
                )
                .with_child(
                    ui_builder
                        .paragraph("You can sign up later, but some features, such as AI,")
                        .build()
                        .finish(),
                )
                .with_child(
                    Flex::row()
                        .with_child(
                            ui_builder
                                .span("are only available to logged-in users. ")
                                .build()
                                .finish(),
                        )
                        .with_child(
                            ui_builder
                                .link(
                                    "Yes, skip login".into(),
                                    None,
                                    Some(Box::new(|ctx| {
                                        ctx.dispatch_typed_action(AuthViewBodyAction::LoginLater);
                                    })),
                                    self.mouse_state_handles
                                        .confirm_login_later_mouse_state_handle
                                        .clone(),
                                )
                                .soft_wrap(false)
                                .build()
                                .finish(),
                        )
                        .finish(),
                )
                .finish(),
        )
        .with_margin_top(8.)
        .finish()
    }

    fn render_force_login_disclaimer(
        &self,
        appearance: &Appearance,
        ui_builder: &UiBuilder,
    ) -> Box<dyn Element> {
        let disclaimer_color = appearance
            .theme()
            .sub_text_color(appearance.theme().background())
            .into();

        let disclaimer_styles = UiComponentStyles {
            font_color: Some(disclaimer_color),
            ..Default::default()
        };

        let text = match self.variant {
            AuthViewVariant::RequireLoginCloseable => {
                "In order to use Polaris Terminal’s AI features or collaborate with others, please create an account."
            }
            AuthViewVariant::HitDriveObjectLimitCloseable => {
                "In order to create more objects in Polaris Terminal Drive, please create an account."
            }
            AuthViewVariant::ShareRequirementCloseable => {
                "In order to share, please create an account."
            }
            _ => "",
        };

        Container::new(
            ui_builder
                .paragraph(text)
                .with_style(disclaimer_styles)
                .build()
                .finish(),
        )
        .with_margin_bottom(AUTH_MODAL_GAP)
        .finish()
    }

    fn render_header(&self, appearance: &Appearance, ui_builder: &UiBuilder) -> Box<dyn Element> {
        let header_styles = UiComponentStyles {
            font_family_id: Some(appearance.header_font_family()),
            font_color: Some(appearance.theme().active_ui_text_color().into()),
            font_size: Some(20.),
            font_weight: Some(Weight::Semibold),
            ..Default::default()
        };

        let text = match self.variant {
            AuthViewVariant::Initial => "Welcome to Polaris Terminal!",
            AuthViewVariant::RequireLoginCloseable
            | AuthViewVariant::HitDriveObjectLimitCloseable
            | AuthViewVariant::ShareRequirementCloseable => "Sign in to your Polaris",
        };

        ui_builder
            .span(text)
            .with_style(header_styles)
            .build()
            .finish()
    }

    fn render_logo_row(&self, appearance: &Appearance, ui_builder: &UiBuilder) -> Box<dyn Element> {
        let logo = render_square_logo(appearance);
        let mut row = Flex::row()
            .with_main_axis_size(MainAxisSize::Max)
            .with_main_axis_alignment(MainAxisAlignment::SpaceBetween)
            .with_child(logo);

        if matches!(
            self.variant,
            AuthViewVariant::RequireLoginCloseable
                | AuthViewVariant::HitDriveObjectLimitCloseable
                | AuthViewVariant::ShareRequirementCloseable
        ) {
            let close_button = ui_builder
                .close_button(
                    24.,
                    self.mouse_state_handles
                        .close_button_mouse_state_handle
                        .clone(),
                )
                .build()
                .on_click(|ctx, _, _| ctx.dispatch_typed_action(AuthViewBodyAction::Close))
                .finish();
            row = row.with_child(close_button)
        };

        row.finish()
    }

    fn render_select_auth_pathway_content(
        &self,
        appearance: &Appearance,
        ui_builder: &UiBuilder,
        app: &AppContext,
    ) -> Vec<Box<dyn Element>> {
        let logo = Container::new(self.render_logo_row(appearance, ui_builder))
            .with_margin_bottom(AUTH_MODAL_GAP)
            .finish();
        let header = Container::new(self.render_header(appearance, ui_builder))
            .with_margin_bottom(AUTH_MODAL_GAP)
            .finish();
        let sign_up_button = self.render_sign_up_button(appearance, ui_builder);
        let force_login_disclaimer = self.render_force_login_disclaimer(appearance, ui_builder);

        match self.variant {
            AuthViewVariant::Initial => {
                if !NetworkStatus::as_ref(app).is_online() {
                    let offline_contents = render_offline_contents(
                        appearance,
                        ui_builder,
                        self.mouse_state_handles
                            .learn_more_mouse_state_handle
                            .clone(),
                        AuthViewBodyAction::ShowOverlay(AuthViewOverlay::OfflineInfo),
                    );
                    vec![logo, header, offline_contents]
                } else if self.active_overlay.is_none() {
                    let mut contents = if self.allow_loginless {
                        let sign_up_later_row = match self.loginless_step {
                            LoginlessStep::Start => self.render_sign_up_later_row(ui_builder),
                            LoginlessStep::Initiated => {
                                self.render_sign_in_later_confirm_row(ui_builder)
                            }
                        };
                        vec![logo, header, sign_up_button, sign_up_later_row]
                    } else {
                        vec![logo, header, sign_up_button]
                    };

                    contents.append(&mut self.render_privacy_information(appearance, ui_builder));
                    contents
                } else {
                    vec![]
                }
            }
            AuthViewVariant::RequireLoginCloseable
            | AuthViewVariant::HitDriveObjectLimitCloseable
            | AuthViewVariant::ShareRequirementCloseable => {
                vec![logo, header, force_login_disclaimer, sign_up_button]
            }
        }
    }
}

pub enum AuthViewBodyEvent {
    /// The person asked to sign in; the Polaris sign-in lives in Settings > Account.
    PolarisSignInRequested,
    LoginLaterClicked,
    Close,
}

impl Entity for AuthViewBody {
    type Event = AuthViewBodyEvent;
}

impl TypedActionView for AuthViewBody {
    type Action = AuthViewBodyAction;

    fn handle_action(&mut self, action: &AuthViewBodyAction, ctx: &mut ViewContext<Self>) {
        match action {
            AuthViewBodyAction::InitiateLoginLater => {
                send_telemetry_from_ctx!(
                    TelemetryEvent::LoginLaterButtonClicked {
                        source: LoginEventSource::AuthModal,
                    },
                    ctx
                );
                self.loginless_step = LoginlessStep::Initiated;
            }
            AuthViewBodyAction::LoginLater => {
                // Send synchronously since this is an important event in the sign up funnel and we
                // don't want to lose events if the user quits before the event queue is flushed.
                send_telemetry_sync_from_ctx!(
                    TelemetryEvent::LoginLaterConfirmationButtonClicked {
                        source: LoginEventSource::AuthModal,
                    },
                    ctx
                );
                ctx.emit(AuthViewBodyEvent::LoginLaterClicked);
            }
            AuthViewBodyAction::Signup => {
                // Send synchronously since this is an important event in the sign up funnel and we
                // don't want to lose events if the user quits before the event queue is flushed.
                send_telemetry_sync_from_ctx!(TelemetryEvent::SignUpButtonClicked, ctx);
                ctx.emit(AuthViewBodyEvent::PolarisSignInRequested);
            }
            AuthViewBodyAction::ShowOverlay(overlay) => {
                if let AuthViewOverlay::PrivacySettings = overlay {
                    send_telemetry_sync_from_ctx!(
                        TelemetryEvent::OpenAuthPrivacySettings {
                            source: LoginEventSource::AuthModal,
                        },
                        ctx
                    );
                }
                self.active_overlay = Some(*overlay);
                ctx.notify();
            }
            AuthViewBodyAction::HideOverlay => {
                self.active_overlay = None;
                ctx.notify();
            }
            AuthViewBodyAction::ToggleTelemetry => {
                let privacy_settings_handle = PrivacySettings::handle(ctx);
                ctx.update_model(&privacy_settings_handle, |privacy_settings, ctx| {
                    privacy_settings
                        .set_is_telemetry_enabled(!privacy_settings.is_telemetry_enabled, ctx);
                });
                ctx.notify();
            }
            AuthViewBodyAction::ToggleCrashReporting => {
                let privacy_settings_handle = PrivacySettings::handle(ctx);
                ctx.update_model(&privacy_settings_handle, |privacy_settings, ctx| {
                    privacy_settings.set_is_crash_reporting_enabled(
                        !privacy_settings.is_crash_reporting_enabled,
                        ctx,
                    );
                });
                ctx.notify();
            }
            AuthViewBodyAction::ToggleCloudConversationStorage => {
                let privacy_settings_handle = PrivacySettings::handle(ctx);
                ctx.update_model(&privacy_settings_handle, |privacy_settings, ctx| {
                    privacy_settings.set_is_cloud_conversation_storage_enabled(
                        !privacy_settings.is_cloud_conversation_storage_enabled,
                        ctx,
                    );
                });
                ctx.notify();
            }
            AuthViewBodyAction::Close => {
                ctx.emit(AuthViewBodyEvent::Close);
            }
        }
    }
}

impl View for AuthViewBody {
    fn ui_name() -> &'static str {
        "AuthViewBody"
    }

    fn accessibility_contents(&self, _: &AppContext) -> Option<AccessibilityContent> {
        Some(AccessibilityContent::new(
            "Welcome to Polaris Terminal!",
            "Press enter to sign in to your Polaris.",
            PtermA11yRole::HelpRole,
        ))
    }

    fn on_focus(&mut self, focus_ctx: &FocusContext, ctx: &mut ViewContext<Self>) {
        if focus_ctx.is_self_focused() {
            ctx.notify();
        }
    }

    fn render(&self, app: &AppContext) -> Box<dyn Element> {
        let appearance = Appearance::as_ref(app);
        let ui_builder = UiBuilder::new(
            appearance.theme().clone(),
            appearance.ui_font_family(),
            COMMON_BODY_UI_FONT_SIZE,
            DEFAULT_COMMAND_PALETTE_FONT_SIZE,
            appearance.line_height_ratio(),
        );

        let mut content = Flex::column().with_cross_axis_alignment(CrossAxisAlignment::Stretch);
        content = content.with_children(self.render_select_auth_pathway_content(
            appearance,
            &ui_builder,
            app,
        ));

        let content = content.finish();

        let mut stack = Stack::new();
        stack.add_child(
            Container::new(content)
                .with_background(appearance.theme().surface_1())
                .with_border(Border::all(1.).with_border_fill(appearance.theme().outline()))
                .with_corner_radius(CornerRadius::with_all(MODAL_CORNER_RADIUS))
                .with_uniform_padding(32.)
                .finish(),
        );

        if let Some(overlay) = &self.active_overlay {
            match overlay {
                AuthViewOverlay::PrivacySettings => {
                    // The `is_any_ai_enabled` helper also accounts for login /
                    // remote-session gating, so the cloud-conversation toggle
                    // hides whenever AI isn't effectively available.
                    let is_ai_enabled = AISettings::as_ref(app).is_any_ai_enabled(app);
                    stack.add_child(
                        Dismiss::new(render_overlay(
                            render_privacy_settings_overlay_body(
                                appearance,
                                app,
                                &self.privacy_settings_handles,
                                &self.privacy_settings_actions(),
                                is_ai_enabled,
                            ),
                            appearance,
                        ))
                        .on_dismiss(|ctx, _app| {
                            ctx.dispatch_typed_action(AuthViewBodyAction::HideOverlay)
                        })
                        .finish(),
                    );
                }
                AuthViewOverlay::OfflineInfo => {
                    stack.add_child(
                        Dismiss::new(render_overlay(
                            render_offline_info_overlay_body(
                                appearance,
                                self.privacy_settings_handles.close_button_mouse.clone(),
                                AuthViewBodyAction::HideOverlay,
                            ),
                            appearance,
                        ))
                        .on_dismiss(|ctx, _app| {
                            ctx.dispatch_typed_action(AuthViewBodyAction::HideOverlay)
                        })
                        .finish(),
                    );
                }
            }
        }

        stack.finish()
    }
}

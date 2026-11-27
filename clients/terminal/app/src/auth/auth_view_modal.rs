use std::collections::HashMap;

use anyhow::Result;
use pathfinder_color::ColorU;
use pathfinder_geometry::vector::vec2f;
use pterm_core::features::FeatureFlag;
use pterm_core::safe_anyhow;
use pterm_errors::{ErrorExt, report_error};
use ptermui::elements::{
    ChildAnchor, ChildView, Container, Fill, HighlightedHyperlink, MouseStateHandle,
    OffsetPositioning, ParentAnchor, ParentElement, ParentOffsetBounds, Stack,
};
use ptermui::ui_components::components::{Coords, UiComponentStyles};
use ptermui::{
    AppContext, Element, Entity, FocusContext, SingletonEntity, TypedActionView, View, ViewContext,
    ViewHandle,
};
use url::Url;

use super::UserUid;
use super::auth_manager::{AuthManager, AuthManagerEvent};
use super::auth_view_body::AuthViewBodyEvent;
use super::credentials::RefreshToken;
use super::login_failure_notification::{self, LoginFailureReason};
use crate::appearance::Appearance;
use crate::auth::auth_view_body::AuthViewBody;
use crate::modal::Modal;
use crate::root_view::unthemed_window_border;
use crate::server::server_api::auth::UserAuthenticationError;

#[derive(Clone, Debug)]
pub enum AuthViewAction {
    DismissErrorNotification,
}

pub struct AuthView {
    auth_screen_modal: ViewHandle<Modal<AuthViewBody>>,

    // Reason for failing the most recent attempt to login, if any. When this is set, a
    // notification containing the reason's error message is shown to the user.
    pub last_login_failure_reason: Option<LoginFailureReason>,
    close_login_notification_mouse_state: MouseStateHandle,
    highlighted_hyperlink_state: HighlightedHyperlink,
    auth_view_variant: AuthViewVariant,
}

const AUTH_URL_HOST: &str = "auth";
const AUTH_URL_REFRESH_TOKEN_QUERY_PARAM: &str = "refresh_token";
const AUTH_URL_NEW_USER_UID_QUERY_PARAM: &str = "user_uid";
const AUTH_URL_DELETED_ANON_USER_QUERY_PARAM: &str = "deleted_anonymous_user";
const AUTH_URL_STATE_QUERY_PARAM: &str = "state";

// `AuthRedirectPayload` is returned from the incoming redirect url.
#[derive(Debug, Clone)]
pub struct AuthRedirectPayload {
    pub refresh_token: RefreshToken,
    pub user_uid: Option<UserUid>,
    pub deleted_anonymous_user: Option<bool>,
    pub state: Option<String>,
}

impl AuthRedirectPayload {
    /// Attempts to parse the `AuthRedirectPayload` from URL sent to Polaris Terminal. To parse successfully, the URL
    /// must be of format {scheme}://auth/desktop_redirect?refresh_token={token}.
    pub fn from_url(url: Url) -> Result<Self> {
        if url.host_str() != Some(AUTH_URL_HOST) {
            return Err(safe_anyhow!(
                safe: ("Auth redirect URL has unexpected host"),
                full: ("Received URL with unexpected host: {} ", url)
            ));
        }
        let query_params: HashMap<_, _> = url.query_pairs().into_owned().collect();
        if let Some(token) = query_params.get(AUTH_URL_REFRESH_TOKEN_QUERY_PARAM) {
            let user_uid = query_params
                .get(AUTH_URL_NEW_USER_UID_QUERY_PARAM)
                .map(|uid| UserUid::new(uid));

            Ok(Self {
                refresh_token: RefreshToken::new(token),
                user_uid,
                deleted_anonymous_user: query_params
                    .get(AUTH_URL_DELETED_ANON_USER_QUERY_PARAM)
                    .map(|value| value == "true"),
                state: query_params.get(AUTH_URL_STATE_QUERY_PARAM).cloned(),
            })
        } else {
            Err(safe_anyhow!(
                safe: ("Auth redirect URL is missing required credential"),
                full: ("Received URL without refresh token query param: {}", url)
            ))
        }
    }
}

const MODAL_WIDTH: f32 = 352.;

#[derive(Clone, Copy, Debug)]
pub enum AuthViewVariant {
    Initial,
    RequireLoginCloseable,
    HitDriveObjectLimitCloseable,
    ShareRequirementCloseable,
}

impl AuthView {
    pub fn new(variant: AuthViewVariant, ctx: &mut ViewContext<Self>) -> Self {
        let auth_screen_view = ctx.add_typed_action_view(|ctx| AuthViewBody::new(variant, ctx));
        ctx.subscribe_to_view(&auth_screen_view, |me, _, event, ctx| match event {
            AuthViewBodyEvent::Close => me.close(ctx),
            AuthViewBodyEvent::SignUpButtonClicked => {
                me.dismiss_error_notification(ctx);
            }
            AuthViewBodyEvent::PolarisSignInRequested => {
                me.open_polaris_sign_in(ctx);
            }
            AuthViewBodyEvent::LoginLaterClicked => {
                me.handle_login_later(ctx);
            }
        });

        let auth_screen_modal = ctx.add_typed_action_view(|ctx| {
            Modal::new(None, auth_screen_view, ctx)
                .with_body_style(UiComponentStyles {
                    padding: Some(Coords::uniform(0.)),
                    ..Default::default()
                })
                .with_modal_style(UiComponentStyles {
                    width: Some(MODAL_WIDTH),
                    border_color: Some(Fill::from(ColorU::transparent_black())), // override default modal border color
                    ..Default::default()
                })
        });

        let auth_manager = AuthManager::handle(ctx);
        ctx.subscribe_to_model(&auth_manager, |me, _, event, ctx| {
            me.handle_auth_manager_event(event, ctx);
        });

        Self {
            auth_screen_modal,
            last_login_failure_reason: None,
            close_login_notification_mouse_state: Default::default(),
            highlighted_hyperlink_state: Default::default(),
            auth_view_variant: variant,
        }
    }

    pub fn set_variant(&mut self, ctx: &mut ViewContext<Self>, variant: AuthViewVariant) {
        self.auth_view_variant = variant;
        self.update_auth_body(
            ctx,
            |body: &mut AuthViewBody, _: &mut ViewContext<'_, AuthViewBody>| {
                body.set_variant(variant)
            },
        );
    }

    fn focus(&self, ctx: &mut ViewContext<Self>) {
        ctx.focus(&self.auth_screen_modal);
        ctx.notify();
    }

    fn dismiss_error_notification(&mut self, ctx: &mut ViewContext<Self>) {
        self.last_login_failure_reason = None;
        ctx.notify();
    }

    fn close(&mut self, ctx: &mut ViewContext<Self>) {
        self.update_auth_body(
            ctx,
            |body: &mut AuthViewBody, _: &mut ViewContext<'_, AuthViewBody>| {
                body.reset_login_screen()
            },
        );
        self.dismiss_error_notification(ctx);
        ctx.emit(AuthViewEvent::Close);
    }

    /// The Polaris sign-in lives in Settings > Account. Before the first
    /// workspace exists, the sign-in screen is skipped so there is one to open
    /// it in; a closeable prompt just closes.
    fn open_polaris_sign_in(&mut self, ctx: &mut ViewContext<Self>) {
        match self.auth_view_variant {
            AuthViewVariant::Initial => self.handle_login_later(ctx),
            AuthViewVariant::RequireLoginCloseable
            | AuthViewVariant::HitDriveObjectLimitCloseable
            | AuthViewVariant::ShareRequirementCloseable => self.close(ctx),
        }
        ctx.emit(AuthViewEvent::OpenPolarisSignIn);
    }

    fn update_auth_body<S, F>(&mut self, ctx: &mut ViewContext<Self>, cb: F) -> S
    where
        F: FnOnce(&mut AuthViewBody, &mut ViewContext<'_, AuthViewBody>) -> S,
    {
        self.auth_screen_modal
            .update(ctx, |modal, ctx| modal.body().update(ctx, cb))
    }

    pub fn handle_login_later(&mut self, ctx: &mut ViewContext<Self>) {
        if FeatureFlag::SkipFirebaseAnonymousUser.is_enabled() {
            AuthManager::handle(ctx).update(ctx, |_, ctx| {
                ctx.emit(AuthManagerEvent::SkippedLogin);
            });
        } else {
            AuthManager::handle(ctx).update(ctx, |auth_manager, ctx| {
                auth_manager.create_anonymous_user(None, ctx)
            });
        }
    }

    fn handle_auth_manager_event(&mut self, event: &AuthManagerEvent, ctx: &mut ViewContext<Self>) {
        match event {
            AuthManagerEvent::AuthComplete | AuthManagerEvent::SkippedLogin => {
                self.close(ctx);
            }
            AuthManagerEvent::AuthFailed(err) => {
                if err.is_actionable() {
                    report_error!(err);
                }

                if let UserAuthenticationError::InvalidStateParameter = err {
                    self.last_login_failure_reason =
                        Some(LoginFailureReason::InvalidStateParameter);
                } else if let UserAuthenticationError::MissingStateParameter = err {
                    self.last_login_failure_reason =
                        Some(LoginFailureReason::MissingStateParameter);
                } else {
                    self.last_login_failure_reason =
                        Some(LoginFailureReason::FailedUserAuthentication);
                }
            }
            AuthManagerEvent::CreateAnonymousUserFailed => {
                self.last_login_failure_reason = Some(LoginFailureReason::FailedUserAuthentication);
            }
            AuthManagerEvent::MintCustomTokenFailed(_err) => {
                self.last_login_failure_reason = Some(LoginFailureReason::FailedMintCustomToken);
            }
            _ => {}
        }
        ctx.notify();
    }
}

#[derive(PartialEq, Eq)]
pub enum AuthViewEvent {
    Close,
    /// Open Settings > Account, where the Polaris sign-in is.
    OpenPolarisSignIn,
}

impl Entity for AuthView {
    type Event = AuthViewEvent;
}

impl View for AuthView {
    fn ui_name() -> &'static str {
        "AuthView"
    }

    fn on_focus(&mut self, focus_ctx: &FocusContext, ctx: &mut ViewContext<Self>) {
        if focus_ctx.is_self_focused() {
            self.focus(ctx);
        }
    }

    fn render(&self, ctx: &AppContext) -> Box<dyn Element> {
        let appearance = Appearance::as_ref(ctx);
        let mut stack = Stack::new();
        stack.add_child(ChildView::new(&self.auth_screen_modal).finish());

        if let Some(login_failure_reason) = &self.last_login_failure_reason {
            let login_failure_notification = login_failure_notification::render(
                login_failure_reason,
                self.close_login_notification_mouse_state.clone(),
                self.highlighted_hyperlink_state.clone(),
                AuthViewAction::DismissErrorNotification,
                ctx,
            );
            stack.add_positioned_overlay_child(
                login_failure_notification,
                OffsetPositioning::offset_from_parent(
                    vec2f(0., 40.),
                    ParentOffsetBounds::ParentBySize,
                    ParentAnchor::TopMiddle,
                    ChildAnchor::TopMiddle,
                ),
            );
        }

        let background_color = match self.auth_view_variant {
            AuthViewVariant::Initial => appearance.theme().background().into(),
            AuthViewVariant::RequireLoginCloseable
            | AuthViewVariant::HitDriveObjectLimitCloseable
            | AuthViewVariant::ShareRequirementCloseable => ColorU::transparent_black(),
        };

        // TODO(liam): use theme colors for background and window border
        Container::new(stack.finish())
            .with_background_color(background_color)
            .with_corner_radius(ctx.windows().window_corner_radius())
            .with_border(unthemed_window_border())
            .finish()
    }
}

impl TypedActionView for AuthView {
    type Action = AuthViewAction;

    fn handle_action(&mut self, action: &AuthViewAction, ctx: &mut ViewContext<Self>) {
        match action {
            AuthViewAction::DismissErrorNotification => {
                self.dismiss_error_notification(ctx);
            }
        }
    }
}

//! Shimmering Polaris Terminal loading text - renders Polaris Terminal logo with shimmering text for loading states.

use pterm_core::ui::appearance::Appearance;
use ptermui::elements::Element;
use ptermui::elements::shimmering_text::{
    ShimmerConfig, ShimmeringTextElement, ShimmeringTextStateHandle,
};
use ptermui::{AppContext, SingletonEntity};

/// Polaris Terminal icon glyph character
const POLARIS_TERMINAL_GLYPH: &str = "\u{E500}";

/// Creates a shimmering text element with the Polaris Terminal glyph.
pub fn shimmering_pterm_loading_text(
    text: impl Into<String>,
    font_size: f32,
    shimmer_handle: ShimmeringTextStateHandle,
    app: &AppContext,
) -> Box<dyn Element> {
    let appearance = Appearance::as_ref(app);
    let theme = appearance.theme();

    // Use same colors as common.rs for consistency
    let base_color = theme.disabled_text_color(theme.surface_1()).into_solid();
    let shimmer_color = theme.main_text_color(theme.surface_1()).into_solid();

    // Hardcoded shimmer config for consistent animation
    let config = ShimmerConfig::default();

    // Create a single shimmering element with glyph and text
    ShimmeringTextElement::new(
        format!("{} {}", POLARIS_TERMINAL_GLYPH, text.into()),
        appearance.ui_font_family(),
        font_size,
        base_color,
        shimmer_color,
        config,
        shimmer_handle,
    )
    .finish()
}

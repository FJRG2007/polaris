//! How the screen looks: its colours, its label size, a background picture
//! and a picture per knob, and the palette all of it is drawn with.
//!
//! The panel takes 256 RGB565 colours ([`crate::display`]). The palette is a
//! function of the look alone, never of what a page shows, so a redraw never
//! changes it: changing it remaps every pixel already on the panel at once,
//! which is a whole screen of wrong colours until the new tiles land. Its
//! first entries are the page's own colours, then shades of each text colour
//! over the background (so smooth letters keep their edges), then, with a
//! picture, that picture's own colours (median cut).
//!
//! Every value has a default that draws today's page, so an install that
//! never set any of it looks the same.

use crate::display::{self, PALETTE_COLORS};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// How a picture fills its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Fit {
    /// The whole box, cropped to keep the picture's shape.
    #[default]
    Cover,
    /// The whole picture, inside the box.
    Contain,
}

impl Fit {
    pub fn from_value(value: &str) -> Option<Self> {
        match value {
            "cover" => Some(Fit::Cover),
            "contain" => Some(Fit::Contain),
            _ => None,
        }
    }
}

/// How large the knobs' names are drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LabelSize {
    Small,
    #[default]
    Medium,
    Large,
}

impl LabelSize {
    pub fn from_value(value: &str) -> Option<Self> {
        match value {
            "small" => Some(LabelSize::Small),
            "medium" => Some(LabelSize::Medium),
            "large" => Some(LabelSize::Large),
            _ => None,
        }
    }

    /// The height of a capital letter, in pixels.
    pub fn cap_height(self) -> usize {
        match self {
            LabelSize::Small => 11,
            LabelSize::Medium => 14,
            LabelSize::Large => 18,
        }
    }
}

/// The longest picture value read, as a `data:` URL (a few megabytes of
/// base64): anything larger is ignored, not decoded.
pub const MAX_PICTURE_TEXT: usize = 8 * 1024 * 1024;
/// The largest picture decoded, either side.
pub const MAX_PICTURE_SIDE: u32 = 4096;

/// The look as stored: plain values, empty meaning "the default".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Look {
    /// `#rrggbb`.
    pub background_color: String,
    pub text_color: String,
    /// The volume bars and the idle page's bars.
    pub accent_color: String,
    pub label_size: LabelSize,
    /// A `data:image/png;base64,...` or `data:image/jpeg;base64,...` URL.
    pub background_image: String,
    pub background_fit: Fit,
    /// A picture above each knob's column, as `background_image`.
    pub knob_images: [String; 4],
    pub knob_image_fit: Fit,
}

impl Default for Look {
    fn default() -> Self {
        Self {
            background_color: String::new(),
            text_color: String::new(),
            accent_color: String::new(),
            label_size: LabelSize::Medium,
            background_image: String::new(),
            background_fit: Fit::Cover,
            knob_images: Default::default(),
            // An icon is shown whole; a photo for the screen fills it.
            knob_image_fit: Fit::Contain,
        }
    }
}

impl Look {
    /// The same look with every value that does not read dropped to its default.
    pub fn clamped(mut self) -> Self {
        for color in [
            &mut self.background_color,
            &mut self.text_color,
            &mut self.accent_color,
        ] {
            if parse_color(color).is_none() {
                color.clear();
            }
        }
        for picture in
            std::iter::once(&mut self.background_image).chain(self.knob_images.iter_mut())
        {
            if picture.len() > MAX_PICTURE_TEXT || !is_picture_url(picture) {
                picture.clear();
            }
        }
        self
    }
}

fn is_picture_url(value: &str) -> bool {
    value.starts_with("data:image/png;base64,")
        || value.starts_with("data:image/jpeg;base64,")
        || value.starts_with("data:image/jpg;base64,")
}

/// `#rrggbb` (or `rrggbb`) as RGB.
pub fn parse_color(value: &str) -> Option<(u8, u8, u8)> {
    let hex = value.trim().strip_prefix('#').unwrap_or(value.trim());
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    Some((byte(0)?, byte(2)?, byte(4)?))
}

/// A decoded picture, RGBA, row-major.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picture {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

/// Decodes a `data:` picture, within [`MAX_PICTURE_SIDE`]. `None` for
/// anything that is not a PNG or JPEG that decodes.
pub fn decode_picture(value: &str) -> Option<image::RgbaImage> {
    if value.len() > MAX_PICTURE_TEXT || !is_picture_url(value) {
        return None;
    }
    let (_, data) = value.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .ok()?;
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_PICTURE_SIDE);
    limits.max_image_height = Some(MAX_PICTURE_SIDE);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    Some(reader.decode().ok()?.to_rgba8())
}

/// `source` fitted into `width x height` at that exact size: scaled once,
/// with a Catmull-Rom filter (sharp edges, no blocks), from the source's own
/// pixels. `Contain` leaves the uncovered part transparent.
pub fn fit_picture(source: &image::RgbaImage, width: usize, height: usize, fit: Fit) -> Picture {
    let mut out = Picture {
        width,
        height,
        rgba: vec![0; width * height * 4],
    };
    let (sw, sh) = (source.width() as f64, source.height() as f64);
    if sw < 1.0 || sh < 1.0 || width == 0 || height == 0 {
        return out;
    }
    let scale = match fit {
        Fit::Cover => (width as f64 / sw).max(height as f64 / sh),
        Fit::Contain => (width as f64 / sw).min(height as f64 / sh),
    };
    let scaled_w = ((sw * scale).round() as u32).max(1);
    let scaled_h = ((sh * scale).round() as u32).max(1);
    let scaled = image::imageops::resize(
        source,
        scaled_w,
        scaled_h,
        image::imageops::FilterType::CatmullRom,
    );
    let (scaled_w, scaled_h) = (scaled_w as i64, scaled_h as i64);
    let left = (width as i64 - scaled_w) / 2;
    let top = (height as i64 - scaled_h) / 2;
    for y in 0..height as i64 {
        let sy = y - top;
        if !(0..scaled_h).contains(&sy) {
            continue;
        }
        for x in 0..width as i64 {
            let sx = x - left;
            if !(0..scaled_w).contains(&sx) {
                continue;
            }
            let pixel = scaled.get_pixel(sx as u32, sy as u32).0;
            let at = (y as usize * width + x as usize) * 4;
            out.rgba[at..at + 4].copy_from_slice(&pixel);
        }
    }
    out
}

/// Palette slots of the page's own colours, by role.
pub const BACKGROUND: usize = 0;
pub const TEXT: usize = 1;
pub const DIM: usize = 2;
pub const TRACK: usize = 3;
pub const FILL: usize = 4;
pub const MUTED: usize = 5;
pub const DIVIDER: usize = 6;
/// The page's colours.
pub const ROLES: usize = 7;
/// Shades between the background and each text colour, the two ends left out.
pub const SHADES: usize = 14;
/// The colours whose edges are smoothed over the background.
const SMOOTHED: [usize; 4] = [TEXT, DIM, FILL, MUTED];
/// The first slot a picture's colours take.
pub const PICTURE_SLOTS_FROM: usize = ROLES + SMOOTHED.len() * SHADES;

/// Today's colours, by role.
pub const DEFAULT_COLORS: [(u8, u8, u8); ROLES] = [
    (16, 18, 22),
    (240, 242, 245),
    (140, 146, 156),
    (48, 52, 60),
    (64, 150, 255),
    (235, 80, 80),
    (36, 40, 46),
];

/// The look ready to draw with.
#[derive(Debug)]
pub struct Theme {
    look: Look,
    pub colors: [(u8, u8, u8); ROLES],
    pub label_size: LabelSize,
    /// The background picture, fitted to the whole screen, when there is one.
    pub background: Option<Picture>,
    pub knob_images: [Option<Picture>; 4],
    pub palette: [u16; PALETTE_COLORS],
    /// The RGB each palette slot shows.
    shown: Vec<(u8, u8, u8)>,
    /// Nearest palette slot per RGB565 colour, filled as colours come up.
    nearest: Mutex<Vec<u16>>,
}

impl PartialEq for Theme {
    fn eq(&self, other: &Self) -> bool {
        self.look == other.look
    }
}

impl Eq for Theme {}

impl Default for Theme {
    fn default() -> Self {
        Theme::new(&Look::default())
    }
}

/// The side of the square each knob's picture is fitted into.
pub const KNOB_IMAGE_SIDE: usize = 40;

fn shift(color: (u8, u8, u8), by: i16) -> (u8, u8, u8) {
    let move_by = |c: u8| (i16::from(c) + by).clamp(0, 255) as u8;
    (move_by(color.0), move_by(color.1), move_by(color.2))
}

fn luma(color: (u8, u8, u8)) -> u32 {
    (299 * u32::from(color.0) + 587 * u32::from(color.1) + 114 * u32::from(color.2)) / 1000
}

/// `a` blended toward `b` by `amount` (0-255).
pub fn mix(a: (u8, u8, u8), b: (u8, u8, u8), amount: u8) -> (u8, u8, u8) {
    let blend = |x: u8, y: u8| {
        let (x, y, t) = (u32::from(x), u32::from(y), u32::from(amount));
        ((x * (255 - t) + y * t + 127) / 255) as u8
    };
    (blend(a.0, b.0), blend(a.1, b.1), blend(a.2, b.2))
}

/// RGB565 back to the RGB the panel shows.
fn shown_color(color: u16) -> (u8, u8, u8) {
    let red = ((color >> 11) & 0x1f) as u8;
    let green = ((color >> 5) & 0x3f) as u8;
    let blue = (color & 0x1f) as u8;
    (
        (red << 3) | (red >> 2),
        (green << 2) | (green >> 4),
        (blue << 3) | (blue >> 2),
    )
}

impl Theme {
    pub fn new(look: &Look) -> Self {
        let look = look.clone().clamped();
        let mut colors = DEFAULT_COLORS;
        if let Some(background) = parse_color(&look.background_color) {
            let toward = if luma(background) > 140 { -1 } else { 1 };
            colors[BACKGROUND] = background;
            colors[TRACK] = shift(background, 34 * toward);
            colors[DIVIDER] = shift(background, 22 * toward);
        }
        if let Some(text) = parse_color(&look.text_color) {
            colors[TEXT] = text;
            colors[DIM] = mix(text, colors[BACKGROUND], 110);
        }
        if let Some(accent) = parse_color(&look.accent_color) {
            colors[FILL] = accent;
        }
        let background = decode_picture(&look.background_image).map(|picture| {
            let fitted = fit_picture(
                &picture,
                display::WIDTH,
                display::HEIGHT,
                look.background_fit,
            );
            flatten(fitted, colors[BACKGROUND])
        });
        let knob_images = std::array::from_fn(|knob| {
            decode_picture(&look.knob_images[knob]).map(|picture| {
                fit_picture(
                    &picture,
                    KNOB_IMAGE_SIDE,
                    KNOB_IMAGE_SIDE,
                    look.knob_image_fit,
                )
            })
        });
        let mut slots: Vec<(u8, u8, u8)> = colors.to_vec();
        for role in SMOOTHED {
            for shade in 1..=SHADES {
                let amount = (shade * 255 / (SHADES + 1)) as u8;
                slots.push(mix(colors[BACKGROUND], colors[role], amount));
            }
        }
        let mut samples = Vec::new();
        for picture in background.iter().chain(knob_images.iter().flatten()) {
            samples.extend(opaque_samples(picture));
        }
        slots.extend(median_cut(
            &mut samples,
            PALETTE_COLORS - PICTURE_SLOTS_FROM,
        ));
        let mut palette = [0u16; PALETTE_COLORS];
        for (entry, (red, green, blue)) in palette.iter_mut().zip(&slots) {
            *entry = display::rgb565(*red, *green, *blue);
        }
        let shown = palette[..slots.len()]
            .iter()
            .map(|c| shown_color(*c))
            .collect();
        Self {
            colors,
            label_size: look.label_size,
            background,
            knob_images,
            palette,
            shown,
            nearest: Mutex::new(vec![u16::MAX; 1 << 16]),
            look,
        }
    }

    /// The look this theme was built from.
    pub fn look(&self) -> &Look {
        &self.look
    }

    /// The palette slot that shows `color` best: the page's own colours
    /// exactly, anything else the nearest slot.
    pub fn index_of(&self, color: (u8, u8, u8)) -> u8 {
        let key = usize::from(display::rgb565(color.0, color.1, color.2));
        let mut nearest = match self.nearest.lock() {
            Ok(nearest) => nearest,
            Err(poisoned) => poisoned.into_inner(),
        };
        if nearest[key] == u16::MAX {
            let target = shown_color(key as u16);
            let best = self
                .shown
                .iter()
                .enumerate()
                .min_by_key(|(_, slot)| distance(**slot, target))
                .map_or(0, |(index, _)| index);
            nearest[key] = best as u16;
        }
        nearest[key] as u8
    }
}

fn distance(a: (u8, u8, u8), b: (u8, u8, u8)) -> u32 {
    let d = |x: u8, y: u8| {
        let v = i32::from(x) - i32::from(y);
        (v * v) as u32
    };
    // Green weighs most to the eye.
    2 * d(a.0, b.0) + 4 * d(a.1, b.1) + 3 * d(a.2, b.2)
}

/// A picture laid over a solid colour, so it has no transparent part left.
fn flatten(mut picture: Picture, under: (u8, u8, u8)) -> Picture {
    for pixel in picture.rgba.chunks_exact_mut(4) {
        let (red, green, blue) = mix(under, (pixel[0], pixel[1], pixel[2]), pixel[3]);
        pixel.copy_from_slice(&[red, green, blue, 255]);
    }
    picture
}

/// Up to 65536 of a picture's visible pixels, evenly spread.
fn opaque_samples(picture: &Picture) -> Vec<(u8, u8, u8)> {
    let count = picture.width * picture.height;
    let step = count.div_ceil(65_536).max(1);
    picture
        .rgba
        .chunks_exact(4)
        .step_by(step)
        .filter(|pixel| pixel[3] >= 128)
        .map(|pixel| (pixel[0], pixel[1], pixel[2]))
        .collect()
}

/// At most `count` colours standing for `samples`: the box of colours with
/// the widest spread is cut at its median along that channel until there
/// are `count` boxes, and each box gives its mean (Heckbert's median cut).
pub fn median_cut(samples: &mut [(u8, u8, u8)], count: usize) -> Vec<(u8, u8, u8)> {
    if samples.is_empty() || count == 0 {
        return Vec::new();
    }
    let channel = |c: &(u8, u8, u8), axis: usize| match axis {
        0 => c.0,
        1 => c.1,
        _ => c.2,
    };
    let spread = |part: &[(u8, u8, u8)]| -> (u8, usize) {
        (0..3)
            .map(|axis| {
                let (low, high) = part.iter().fold((255u8, 0u8), |(low, high), c| {
                    let v = channel(c, axis);
                    (low.min(v), high.max(v))
                });
                (high - low, axis)
            })
            .max()
            .unwrap_or((0, 0))
    };
    let mut boxes: Vec<std::ops::Range<usize>> = Vec::with_capacity(count);
    boxes.push(0..samples.len());
    while boxes.len() < count {
        let Some((at, (_, axis))) = boxes
            .iter()
            .enumerate()
            .map(|(at, range)| (at, spread(&samples[range.clone()])))
            .filter(|(at, (width, _))| *width > 0 && boxes[*at].len() > 1)
            .max_by_key(|(_, (width, _))| *width)
        else {
            break;
        };
        let range = boxes.swap_remove(at);
        let part = &mut samples[range.clone()];
        part.sort_unstable_by_key(|c| channel(c, axis));
        let middle = range.start + part.len() / 2;
        boxes.push(range.start..middle);
        boxes.push(middle..range.end);
    }
    boxes
        .into_iter()
        .filter(|range| !range.is_empty())
        .map(|range| {
            let part = &samples[range];
            let n = part.len() as u32;
            let sum = part.iter().fold((0u32, 0u32, 0u32), |s, c| {
                (
                    s.0 + u32::from(c.0),
                    s.1 + u32::from(c.1),
                    s.2 + u32::from(c.2),
                )
            });
            ((sum.0 / n) as u8, (sum.1 / n) as u8, (sum.2 / n) as u8)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_url(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> String {
        let picture = image::RgbaImage::from_fn(width, height, |x, y| image::Rgba(paint(x, y)));
        let mut bytes = Vec::new();
        picture
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn the_default_look_is_todays_palette() {
        let theme = Theme::default();
        assert_eq!(theme.colors, DEFAULT_COLORS);
        for (slot, (red, green, blue)) in DEFAULT_COLORS.iter().enumerate() {
            assert_eq!(theme.palette[slot], display::rgb565(*red, *green, *blue));
            assert_eq!(usize::from(theme.index_of((*red, *green, *blue))), slot);
        }
        assert_eq!(theme.label_size, LabelSize::Medium);
        assert!(theme.background.is_none());
    }

    #[test]
    fn colours_that_do_not_read_keep_their_default() {
        let look = Look {
            background_color: "#ffffff".into(),
            text_color: "red".into(),
            accent_color: "#00ff00".into(),
            background_image: "https://example.invalid/a.png".into(),
            ..Look::default()
        };
        let theme = Theme::new(&look);
        assert_eq!(theme.colors[BACKGROUND], (255, 255, 255));
        assert_eq!(theme.colors[TEXT], DEFAULT_COLORS[TEXT]);
        assert_eq!(theme.colors[FILL], (0, 255, 0));
        // A light background darkens its track instead of clipping it.
        assert!(luma(theme.colors[TRACK]) < 255);
        assert!(theme.look().background_image.is_empty());
    }

    #[test]
    fn a_picture_is_fitted_at_the_box_size_without_blocks() {
        // A 2x2 checker scaled up 20 times: a smooth filter leaves in-between
        // shades at the edges, where a nearest-neighbour one leaves none.
        let source = image::RgbaImage::from_fn(2, 2, |x, y| {
            if (x + y) % 2 == 0 {
                image::Rgba([0, 0, 0, 255])
            } else {
                image::Rgba([255, 255, 255, 255])
            }
        });
        let fitted = fit_picture(&source, 40, 40, Fit::Cover);
        assert_eq!((fitted.width, fitted.height), (40, 40));
        let greys = fitted
            .rgba
            .chunks_exact(4)
            .filter(|p| p[0] > 20 && p[0] < 235)
            .count();
        assert!(greys > 0);

        // Contain keeps the shape: a wide picture leaves bands above and below.
        let wide = image::RgbaImage::from_pixel(80, 20, image::Rgba([10, 200, 30, 255]));
        let contained = fit_picture(&wide, 40, 40, Fit::Contain);
        assert_eq!(contained.rgba[3], 0, "top-left is uncovered");
        let middle = (20 * 40 + 20) * 4;
        assert_eq!(&contained.rgba[middle..middle + 4], &[10, 200, 30, 255]);
        let covered = fit_picture(&wide, 40, 40, Fit::Cover);
        assert!(covered.rgba.chunks_exact(4).all(|p| p[3] == 255));
    }

    #[test]
    fn a_background_picture_brings_its_colours_and_keeps_the_page_ones() {
        let url = png_url(64, 36, |x, _| [(x * 4) as u8, 40, 200, 255]);
        assert!(decode_picture(&url).is_some());
        let theme = Theme::new(&Look {
            background_image: url,
            ..Look::default()
        });
        let background = theme.background.as_ref().expect("decoded");
        assert_eq!(
            (background.width, background.height),
            (display::WIDTH, display::HEIGHT)
        );
        assert_eq!(theme.palette[TEXT], display::rgb565(240, 242, 245));
        let blueish = theme.index_of((128, 40, 200));
        assert!(usize::from(blueish) >= PICTURE_SLOTS_FROM);
        // The same look gives the same palette: a redraw never resends it.
        let again = Theme::new(theme.look());
        assert_eq!(again.palette, theme.palette);
        assert_eq!(again, theme);
    }

    #[test]
    fn what_is_not_a_picture_is_not_decoded() {
        assert!(decode_picture("data:image/png;base64,not-base64!").is_none());
        assert!(decode_picture("data:image/png;base64,aGVsbG8=").is_none());
        assert!(decode_picture("data:image/svg+xml;base64,PHN2Zz4=").is_none());
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_PICTURE_TEXT));
        assert!(decode_picture(&huge).is_none());
    }

    #[test]
    fn median_cut_keeps_distinct_colours_apart() {
        let mut samples: Vec<_> = (0..1000)
            .map(|i| if i % 2 == 0 { (250, 0, 0) } else { (0, 0, 250) })
            .collect();
        let colors = median_cut(&mut samples, 8);
        assert!(colors.contains(&(250, 0, 0)) && colors.contains(&(0, 0, 250)));
        assert!(colors.len() <= 8);
    }
}

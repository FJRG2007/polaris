//! Writes the mixer page as the panel shows it, to look at without the device:
//!
//!   cargo run -q -p polaris-stream100 --example screen_png -- <out.png>

use polaris_stream100::display::{IndexedFrame, HEIGHT, WIDTH};
use polaris_stream100::plugin::Locale;
use polaris_stream100::screen::{render, Knob, Screen};
use polaris_stream100::settings::DisplayMode;

fn knob(label: &str, volume: Option<u8>, muted: bool) -> Knob {
    Knob {
        label: label.to_owned(),
        volume,
        muted,
    }
}

/// The RGB the panel shows for each pixel of `frame`.
fn rgb(frame: &IndexedFrame) -> Vec<u8> {
    frame
        .pixels
        .iter()
        .flat_map(|index| {
            let color = frame.palette[usize::from(*index)];
            let red = ((color >> 11) & 0x1f) as u8;
            let green = ((color >> 5) & 0x3f) as u8;
            let blue = (color & 0x1f) as u8;
            [
                red << 3 | red >> 2,
                green << 2 | green >> 4,
                blue << 3 | blue >> 2,
            ]
        })
        .collect()
}

fn main() {
    let out = std::env::args().nth(1).expect("an output path");
    let screen = Screen {
        mode: DisplayMode::Mixer,
        brightness: 80,
        knobs: [
            knob("Calls", Some(64), false),
            knob("Music", Some(100), true),
            knob("Games", None, false),
            knob("Output", Some(35), false),
        ],
        buttons: ["Mute mic", "Deafen", "Camera", "Hang up"].map(String::from),
        locale: Locale::EnUs,
        call: None,
        playing: None,
        idle: None,
        theme: Default::default(),
    };
    let frame = render(&screen).expect("the mixer page draws");
    image::RgbImage::from_raw(WIDTH as u32, HEIGHT as u32, rgb(&frame))
        .expect("a whole frame")
        .save(out)
        .expect("the PNG is written");
}

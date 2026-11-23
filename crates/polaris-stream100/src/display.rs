//! The display: `SM` messages, their checksum, and the 480x272 framebuffer.
//!
//! The display is driven over interface 1, alternate setting 1, isochronous
//! OUT endpoint `0x01`, in 952-byte packets. Every command travels inside an
//! `SM` message:
//!
//! | Offset | Size | Meaning |
//! | ------ | ---- | ------- |
//! | 0      | 2    | `"SM"` |
//! | 2      | 2    | message length, header included, little-endian |
//! | 4      | 2    | checksum ([`checksum`]), little-endian |
//! | 6      | 2    | sequence number, little-endian, one per message |
//! | 8      | ..   | one or more commands |
//!
//! A message longer than one packet continues in the next ones, zero-padded.
//!
//! The image is 8-bit indexed: a 256-entry RGB565 palette and one byte per
//! pixel, sent as 32 chunks of 4080 bytes (480 x 272 = 32 x 4080).

/// Display size in pixels.
pub const WIDTH: usize = 480;
pub const HEIGHT: usize = 272;
/// One isochronous packet.
pub const PACKET_SIZE: usize = 952;
/// Pixels per framebuffer message.
pub const CHUNK_SIZE: usize = 4080;
/// Framebuffer messages per image.
pub const CHUNK_COUNT: usize = WIDTH * HEIGHT / CHUNK_SIZE;
/// Palette entries, two bytes each.
pub const PALETTE_COLORS: usize = 256;

const HEADER_LEN: usize = 8;
const CMD_BRIGHTNESS: u8 = 0x31;
const CMD_PALETTE: [u8; 7] = [0x33, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00];
const CMD_PIXELS: [u8; 9] = [0x37, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x0f];

/// The message checksum: a 16-bit CRC over every byte except the checksum
/// field itself (offsets 4 and 5), shifted right with the constant `0x8005`
/// and starting from zero. That pairing is unusual (no standard CRC uses it)
/// but it is what the controller verifies.
pub fn checksum(message: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for (offset, byte) in message.iter().enumerate() {
        if offset == 4 || offset == 5 {
            continue;
        }
        crc ^= u16::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0x8005
            } else {
                crc >> 1
            };
        }
    }
    crc
}

/// Numbers messages. The controller expects one sequence across a session,
/// so a single `Sequence` is shared by everything sent to one device.
#[derive(Debug, Default, Clone)]
pub struct Sequence(u16);

impl Sequence {
    pub fn starting_at(next: u16) -> Self {
        Self(next)
    }

    fn take(&mut self) -> u16 {
        let value = self.0;
        self.0 = self.0.wrapping_add(1);
        value
    }
}

/// Wraps commands into one framed `SM` message.
pub fn message(body: &[u8], sequence: &mut Sequence) -> Vec<u8> {
    let length = HEADER_LEN + body.len();
    assert!(
        length <= usize::from(u16::MAX),
        "an SM message holds at most 65535 bytes"
    );
    let mut out = Vec::with_capacity(length);
    out.extend_from_slice(b"SM");
    out.extend_from_slice(&(length as u16).to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&sequence.take().to_le_bytes());
    out.extend_from_slice(body);
    let crc = checksum(&out);
    out[4..6].copy_from_slice(&crc.to_le_bytes());
    out
}

/// The keep-alive the controller expects between images.
pub fn heartbeat(sequence: &mut Sequence) -> Vec<u8> {
    message(&[0], sequence)
}

/// Backlight brightness, 0-100.
pub fn brightness(percent: u8, sequence: &mut Sequence) -> Vec<u8> {
    message(&[CMD_BRIGHTNESS, 0x01, 0x00, percent.min(100)], sequence)
}

/// Checks a received or recorded message: magic, length and checksum.
pub fn is_valid(message: &[u8]) -> bool {
    if message.len() < HEADER_LEN || &message[..2] != b"SM" {
        return false;
    }
    let length = usize::from(u16::from_le_bytes([message[2], message[3]]));
    if length < HEADER_LEN || length > message.len() {
        return false;
    }
    let stored = u16::from_le_bytes([message[4], message[5]]);
    stored == checksum(&message[..length])
}

/// Splits a message into zero-padded isochronous packets.
pub fn packets(message: &[u8]) -> Vec<[u8; PACKET_SIZE]> {
    message
        .chunks(PACKET_SIZE)
        .map(|chunk| {
            let mut packet = [0u8; PACKET_SIZE];
            packet[..chunk.len()].copy_from_slice(chunk);
            packet
        })
        .collect()
}

/// RGB565 as the palette stores it.
pub fn rgb565(red: u8, green: u8, blue: u8) -> u16 {
    (u16::from(red >> 3) << 11) | (u16::from(green >> 2) << 5) | u16::from(blue >> 3)
}

/// An image ready to send: palette and one palette index per pixel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedFrame {
    pub palette: [u16; PALETTE_COLORS],
    pub pixels: Vec<u8>,
}

impl IndexedFrame {
    /// Converts RGB pixels (row-major, 3 bytes each, `WIDTH x HEIGHT`).
    ///
    /// An image of at most 256 distinct colours (the usual case for a mixer
    /// page: flat backgrounds, text, icons) keeps every colour exactly. Above
    /// that it falls back to a fixed 3-3-2 palette, which is lossy but needs
    /// no search and never varies between two renders of the same image.
    pub fn from_rgb(rgb: &[u8]) -> Option<Self> {
        if rgb.len() != WIDTH * HEIGHT * 3 {
            return None;
        }
        Some(Self::exact(rgb).unwrap_or_else(|| Self::uniform(rgb)))
    }

    fn exact(rgb: &[u8]) -> Option<Self> {
        let mut palette = [0u16; PALETTE_COLORS];
        let mut used = 0usize;
        let mut index_of = std::collections::HashMap::with_capacity(PALETTE_COLORS);
        let mut pixels = Vec::with_capacity(WIDTH * HEIGHT);
        for pixel in rgb.chunks_exact(3) {
            let color = rgb565(pixel[0], pixel[1], pixel[2]);
            let index = match index_of.get(&color) {
                Some(index) => *index,
                None => {
                    if used == PALETTE_COLORS {
                        return None;
                    }
                    palette[used] = color;
                    index_of.insert(color, used as u8);
                    used += 1;
                    (used - 1) as u8
                }
            };
            pixels.push(index);
        }
        Some(Self { palette, pixels })
    }

    fn uniform(rgb: &[u8]) -> Self {
        let mut palette = [0u16; PALETTE_COLORS];
        for (index, entry) in palette.iter_mut().enumerate() {
            let red = ((index >> 5) & 0x7) * 255 / 7;
            let green = ((index >> 2) & 0x7) * 255 / 7;
            let blue = (index & 0x3) * 255 / 3;
            *entry = rgb565(red as u8, green as u8, blue as u8);
        }
        let pixels = rgb
            .chunks_exact(3)
            .map(|pixel| (pixel[0] & 0xe0) | ((pixel[1] & 0xe0) >> 3) | (pixel[2] >> 6))
            .collect();
        Self { palette, pixels }
    }

    /// The 32 framebuffer messages for this image.
    ///
    /// `setup`, when given, is the display-configuration command the first
    /// message carries ahead of the palette. It comes from the controller's
    /// initialization (see the protocol document): it is sent with the first
    /// image after connecting, not with every redraw, because re-sending it
    /// visibly disturbs the panel.
    pub fn messages(&self, setup: Option<&[u8]>, sequence: &mut Sequence) -> Vec<Vec<u8>> {
        (0..CHUNK_COUNT)
            .map(|chunk| {
                let mut body = Vec::with_capacity(CHUNK_SIZE + 600);
                if chunk == 0 {
                    if let Some(setup) = setup {
                        body.extend_from_slice(setup);
                        body.extend_from_slice(&CMD_PALETTE);
                        for color in self.palette {
                            body.extend_from_slice(&color.to_le_bytes());
                        }
                    }
                }
                let mut header = CMD_PIXELS;
                header[2] = chunk as u8;
                body.extend_from_slice(&header);
                body.extend_from_slice(&self.pixels[chunk * CHUNK_SIZE..(chunk + 1) * CHUNK_SIZE]);
                body.push(0);
                message(&body, sequence)
            })
            .collect()
    }
}

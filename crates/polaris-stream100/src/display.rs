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
//! A message longer than one packet continues in the next ones, zero-padded,
//! and every isochronous transfer starts with one sync packet (`"HERCULES"`,
//! then zeros) ahead of the message ([`transfer`]). A message sent without
//! it is never read.
//!
//! The image is 8-bit indexed: a 256-entry RGB565 palette and one byte per
//! pixel, sent as 32 tiles of 4080 samples. A tile is not a band of rows:
//! tile `t` holds the pixels at `(8 * column + dx, 4 * row + dy)` for its
//! [`TILE_OFFSETS`] entry, 60 columns by 68 rows, so the panel refines the
//! picture tile after tile (CataclysmX/New-Hera-lunx, `docs/protocol/commands.md`,
//! read from the controller's firmware and the official SDK).

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

/// The most packets one transfer carries, sync packet included (the most
/// the official SDK sends; the firmware's ring holds 34).
pub const MAX_TRANSFER_PACKETS: usize = 10;
/// The longest message one transfer carries.
pub const MAX_MESSAGE_LEN: usize = (MAX_TRANSFER_PACKETS - 1) * PACKET_SIZE;

const HEADER_LEN: usize = 8;
const CMD_BRIGHTNESS: u8 = 0x31;
const CMD_PALETTE: [u8; 7] = [0x33, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00];
const CMD_PIXELS: [u8; 9] = [0x37, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x0f];

/// Ends a list of commands.
pub const END: u8 = 0x00;
/// Acknowledges the device-information message the controller repeats
/// while a host is present ([`asks_for_ack`]). The firmware drops a host
/// that never acknowledges it after a few seconds: the Hercules logo, then
/// a dark screen.
pub const ACK: u8 = 0x14;
/// Screen on, at the stored brightness.
pub const SCREEN_ON: [u8; 5] = [0x12, 0, 0, 0, 0];
/// Screen off (standby).
pub const SCREEN_OFF: [u8; 5] = [0x13, 0, 0, 0, 0];
/// Screen configuration showing the host's own background: screen type 0,
/// background type `0xff`, then colours and an action-zone style that a
/// custom background does not use.
pub const CUSTOM_BACKGROUND: [u8; 16] = [0x38, 0x00, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/// The keep-alive the official SDK sends every 500 ms: `0x10 0x01`, the
/// host's OS version as four `u16` (10.0.26100.712), the SDK version (1.51,
/// BCD minor first), twelve zeros, then `0x11 0x00` ("host present"). The
/// firmware keeps a session while it keeps coming.
pub const HOST_KEEPALIVE: [u8; 26] = [
    0x10, 0x01, 0x0a, 0x00, 0x00, 0x00, 0xf4, 0x65, 0xc8, 0x02, 0x51, 0x01, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0x11, 0x00,
];
/// The sync packet every transfer starts with, zero-padded to a packet.
pub const SYNC: [u8; 8] = *b"HERCULES";

/// `(dx, dy)` of each tile: tile `t` carries the pixels at
/// `(8 * column + dx, 4 * row + dy)`. Ordered coarse to fine: the firmware
/// fills a block around each sample of the early tiles, so they must go first.
pub const TILE_OFFSETS: [(u8, u8); CHUNK_COUNT] = [
    (0, 0),
    (4, 0),
    (0, 2),
    (4, 2),
    (2, 0),
    (6, 0),
    (2, 2),
    (6, 2),
    (0, 1),
    (2, 1),
    (4, 1),
    (6, 1),
    (0, 3),
    (2, 3),
    (4, 3),
    (6, 3),
    (1, 0),
    (3, 0),
    (5, 0),
    (7, 0),
    (1, 2),
    (3, 2),
    (5, 2),
    (7, 2),
    (1, 1),
    (3, 1),
    (5, 1),
    (7, 1),
    (1, 3),
    (3, 3),
    (5, 3),
    (7, 3),
];

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

/// The backlight command, 0-100.
pub fn brightness_command(percent: u8) -> [u8; 4] {
    [CMD_BRIGHTNESS, 0x01, 0x00, percent.min(100)]
}

/// Backlight brightness, 0-100, as a message of its own.
pub fn brightness(percent: u8, sequence: &mut Sequence) -> Vec<u8> {
    let command = brightness_command(percent);
    message(&[&command[..], &[END]].concat(), sequence)
}

/// One isochronous transfer: the sync packet, then the message in
/// zero-padded packets. `None` for a message longer than a transfer holds.
pub fn transfer(message: &[u8]) -> Option<Vec<u8>> {
    if message.len() > MAX_MESSAGE_LEN {
        return None;
    }
    let mut out = vec![0u8; PACKET_SIZE * (1 + message.len().div_ceil(PACKET_SIZE))];
    out[..SYNC.len()].copy_from_slice(&SYNC);
    out[PACKET_SIZE..PACKET_SIZE + message.len()].copy_from_slice(message);
    Some(out)
}

/// Whether an input report carries the controller's device-information
/// message, which the host answers with [`ACK`]. After the controls block
/// (its length in byte 0) a report may carry a lowercase `sm` message:
/// `"sm"`, its length (header included), and its type at offset 6
/// (1 = device information, 2 = status); its bytes sum to 0 mod 256.
pub fn asks_for_ack(report: &[u8]) -> bool {
    let Some(&start) = report.first() else {
        return false;
    };
    let rest = report.get(usize::from(start)..).unwrap_or_default();
    if rest.len() < 7 || &rest[..2] != b"sm" {
        return false;
    }
    let length = usize::from(rest[2]);
    if length < 7 || length > rest.len() {
        return false;
    }
    let sum = rest[..length]
        .iter()
        .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
    sum == 0 && rest[6] == 1
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

    /// The samples of tile `tile` (0-31), 4080 bytes.
    pub fn tile(&self, tile: usize) -> Vec<u8> {
        let (dx, dy) = TILE_OFFSETS[tile % CHUNK_COUNT];
        let mut out = Vec::with_capacity(CHUNK_SIZE);
        for row in 0..HEIGHT / 4 {
            let y = row * 4 + usize::from(dy);
            for column in 0..WIDTH / 8 {
                out.push(self.pixels[y * WIDTH + column * 8 + usize::from(dx)]);
            }
        }
        out
    }

    /// The command list of each of the 32 tile messages, unframed: the
    /// sender numbers and frames each one as it goes out ([`message`]), so
    /// keep-alives can go out between them in the same sequence.
    ///
    /// `setup`, when given, travels in the first one ahead of the palette,
    /// as the official software sends screen configuration, palette and tile
    /// 0 together; without it the palette already on the panel is kept.
    pub fn bodies(&self, setup: Option<&[u8]>) -> Vec<Vec<u8>> {
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
                body.extend_from_slice(&self.tile(chunk));
                body.push(END);
                body
            })
            .collect()
    }

    /// The 32 tile messages for this image, framed in `sequence`.
    pub fn messages(&self, setup: Option<&[u8]>, sequence: &mut Sequence) -> Vec<Vec<u8>> {
        self.bodies(setup)
            .iter()
            .map(|body| message(body, sequence))
            .collect()
    }
}

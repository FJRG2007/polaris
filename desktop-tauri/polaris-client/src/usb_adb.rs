//! ADB over a USB cable: find the ADB interface, claim it, and move packets over
//! its two bulk endpoints. The packets are the same as over TCP - `adb_client`
//! speaks them; this only carries them.
//!
//! As AOSP's adb (client/usb_libusb.cpp) and Tango (@yume-chan/adb-daemon-webusb)
//! do it: the interface is class 0xFF, subclass 0x42, protocol 0x01; adbd sends
//! each packet as two transfers, the 24-byte header then the payload; and a
//! transfer out that fills its last USB packet exactly is followed by an empty
//! one, since a short packet is what ends a transfer.
//!
//! The Rust twin of `desktop/src/shared/usb-adb.ts`. The device is a trait so an
//! in-process fake stands in for a TV in tests; `usb_link` implements it with
//! `nusb`, with no hidden WebUSB page.

use std::future::Future;
use std::time::Duration;

use serde::Serialize;

use crate::adb_client::{AdbError, AdbLink, HEADER_BYTES};
use crate::adb_pairing::TlsIdentity;

const MAX_PAYLOAD: usize = 1024 * 1024;
const NAME_LIMIT: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsbDirection {
    In,
    Out,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsbTransferType {
    Bulk,
    Interrupt,
    Isochronous,
    Control,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsbEndpoint {
    /// The address, direction bit included (0x81 is endpoint 1 in).
    pub address: u8,
    pub direction: UsbDirection,
    pub kind: UsbTransferType,
    pub packet_size: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbAlternate {
    pub alternate_setting: u8,
    pub class: u8,
    pub subclass: u8,
    pub protocol: u8,
    pub endpoints: Vec<UsbEndpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbInterface {
    pub interface_number: u8,
    pub alternates: Vec<UsbAlternate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbConfiguration {
    pub configuration_value: u8,
    pub interfaces: Vec<UsbInterface>,
}

/// What a device says about itself before it is opened for transfers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsbDescription {
    pub vendor_id: u16,
    pub product_id: u16,
    pub serial_number: Option<String>,
    pub product_name: Option<String>,
    pub manufacturer_name: Option<String>,
    /// The configuration in use, when the device is configured.
    pub configuration: Option<UsbConfiguration>,
    pub configurations: Vec<UsbConfiguration>,
}

/// The device's ADB interface and its bulk endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdbUsbInterface {
    pub configuration: u8,
    pub interface_number: u8,
    pub alternate: u8,
    pub input: UsbEndpoint,
    pub output: UsbEndpoint,
}

/// The device's ADB interface and its bulk endpoints, or None when it has none.
pub fn adb_interface(device: &UsbDescription) -> Option<AdbUsbInterface> {
    let configurations = device
        .configuration
        .iter()
        .chain(device.configurations.iter());
    for configuration in configurations {
        for interface in &configuration.interfaces {
            for alternate in &interface.alternates {
                if alternate.class != 0xff || alternate.subclass != 0x42 {
                    continue;
                }
                if alternate.protocol != 0x01 {
                    continue;
                }
                let bulk = |direction: UsbDirection| {
                    alternate
                        .endpoints
                        .iter()
                        .find(|one| one.kind == UsbTransferType::Bulk && one.direction == direction)
                        .copied()
                };
                let (Some(input), Some(output)) = (bulk(UsbDirection::In), bulk(UsbDirection::Out))
                else {
                    continue;
                };
                return Some(AdbUsbInterface {
                    configuration: configuration.configuration_value,
                    interface_number: interface.interface_number,
                    alternate: alternate.alternate_setting,
                    input,
                    output,
                });
            }
        }
    }
    None
}

/// A TV plugged in by USB that offers ADB, as the install screen lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TvUsbDevice {
    pub id: String,
    pub name: String,
}

fn readable(text: Option<&str>) -> String {
    text.unwrap_or_default()
        .chars()
        .filter(|character| !matches!(*character as u32, 0..=0x1f | 0x7f))
        .collect::<String>()
        .trim()
        .to_owned()
}

fn first_chars(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

/// The devices offering ADB, each under an id that stays the same while it is
/// plugged in, with the index of the device it came from.
pub fn describe_devices(devices: &[UsbDescription]) -> Vec<(usize, TvUsbDevice)> {
    devices
        .iter()
        .enumerate()
        .filter(|(_, device)| adb_interface(device).is_some())
        .enumerate()
        .map(|(index, (at, device))| {
            let serial = readable(device.serial_number.as_deref());
            let id = if serial.is_empty() {
                format!(
                    "d:{:04x}:{:04x}:{index}",
                    device.vendor_id, device.product_id
                )
            } else {
                format!("s:{serial}")
            };
            let label = [
                readable(device.manufacturer_name.as_deref()),
                readable(device.product_name.as_deref()),
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            let name = if label.is_empty() {
                "Android device".to_owned()
            } else {
                label
            };
            (
                at,
                TvUsbDevice {
                    id: first_chars(&id, NAME_LIMIT * 2),
                    name: first_chars(&name, NAME_LIMIT),
                },
            )
        })
        .collect()
}

/// Why a device could not be opened: the only two things the screen can say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum UsbOpenError {
    #[error("busy")]
    Busy,
    #[error("gone")]
    Gone,
}

impl From<UsbOpenError> for AdbError {
    /// A USB failure carries the outcome code `connect_failure` reads.
    fn from(reason: UsbOpenError) -> Self {
        match reason {
            UsbOpenError::Busy => AdbError::Usb {
                code: "USB_BUSY",
                message: "usb-busy".to_owned(),
            },
            UsbOpenError::Gone => AdbError::Usb {
                code: "USB_GONE",
                message: "usb-gone".to_owned(),
            },
        }
    }
}

/// A transfer failed: the cable was pulled, or the device stalled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsbTransferFailed;

/// The ADB interface once claimed: its two bulk endpoints.
pub trait UsbBulk: Send {
    /// One transfer in of at most `length` bytes. Must be safe to drop and call
    /// again: a transfer under way is the one the next call completes.
    fn transfer_in(
        &mut self,
        length: usize,
    ) -> impl Future<Output = Result<Vec<u8>, UsbTransferFailed>> + Send;
    fn transfer_out(
        &mut self,
        data: &[u8],
    ) -> impl Future<Output = Result<(), UsbTransferFailed>> + Send;
    /// Releases the interface and closes the device.
    fn release(&mut self) -> impl Future<Output = ()> + Send;
}

/// A device that can be opened for ADB.
pub trait UsbDevice: Send {
    type Bulk: UsbBulk;
    fn description(&self) -> &UsbDescription;
    /// Opens the device, selects `found`'s configuration when it is not the one
    /// in use, claims the interface and selects its alternate setting.
    fn claim(
        &self,
        found: &AdbUsbInterface,
    ) -> impl Future<Output = Result<Self::Bulk, UsbOpenError>> + Send;
}

/// A packet read part way: its header, and the payload so far.
struct Partial {
    packet: Vec<u8>,
    at: usize,
}

/// ADB packets over the claimed interface: an `AdbLink` for `adb_client`.
pub struct UsbAdbPipe<B: UsbBulk> {
    bulk: Option<B>,
    found: AdbUsbInterface,
    partial: Option<Partial>,
}

/// Opens and claims the device's ADB interface.
pub async fn open_adb_pipe<D: UsbDevice>(device: &D) -> Result<UsbAdbPipe<D::Bulk>, UsbOpenError> {
    let found = adb_interface(device.description()).ok_or(UsbOpenError::Gone)?;
    let bulk = device.claim(&found).await?;
    Ok(UsbAdbPipe {
        bulk: Some(bulk),
        found,
        partial: None,
    })
}

fn lost() -> AdbError {
    AdbError::ClosedByTv
}

impl<B: UsbBulk> UsbAdbPipe<B> {
    async fn lose(&mut self) -> AdbError {
        if let Some(mut bulk) = self.bulk.take() {
            bulk.release().await;
        }
        lost()
    }

    async fn transfer(&mut self, bytes: &[u8]) -> Result<(), UsbTransferFailed> {
        if bytes.is_empty() {
            return Ok(());
        }
        let zero_mask = self.found.output.packet_size.saturating_sub(1);
        let bulk = self.bulk.as_mut().ok_or(UsbTransferFailed)?;
        bulk.transfer_out(bytes).await?;
        if zero_mask > 0 && bytes.len() & zero_mask == 0 {
            bulk.transfer_out(&[]).await?;
        }
        Ok(())
    }

    async fn read_packet(&mut self) -> Result<Vec<u8>, UsbTransferFailed> {
        let packet_size = self.found.input.packet_size.max(1);
        if self.partial.is_none() {
            let bulk = self.bulk.as_mut().ok_or(UsbTransferFailed)?;
            let head = bulk.transfer_in(packet_size.max(HEADER_BYTES)).await?;
            if head.len() != HEADER_BYTES {
                return Err(UsbTransferFailed);
            }
            let length = u32::from_le_bytes([head[12], head[13], head[14], head[15]]) as usize;
            if length > MAX_PAYLOAD {
                return Err(UsbTransferFailed);
            }
            let mut packet = vec![0; HEADER_BYTES + length];
            packet[..HEADER_BYTES].copy_from_slice(&head);
            self.partial = Some(Partial {
                packet,
                at: HEADER_BYTES,
            });
        }
        loop {
            let (left, done) = match &self.partial {
                Some(partial) => (
                    partial.packet.len() - partial.at,
                    partial.at >= partial.packet.len(),
                ),
                None => return Err(UsbTransferFailed),
            };
            if done {
                return Ok(self
                    .partial
                    .take()
                    .map(|partial| partial.packet)
                    .unwrap_or_default());
            }
            let bulk = self.bulk.as_mut().ok_or(UsbTransferFailed)?;
            let body = bulk.transfer_in(left).await?;
            if body.is_empty() {
                return Err(UsbTransferFailed);
            }
            if let Some(partial) = self.partial.as_mut() {
                let piece = body.len().min(left);
                partial.packet[partial.at..partial.at + piece].copy_from_slice(&body[..piece]);
                partial.at += piece;
            }
        }
    }
}

impl<B: UsbBulk> AdbLink for UsbAdbPipe<B> {
    async fn send(&mut self, header: &[u8], data: &[u8]) -> Result<(), AdbError> {
        if self.bulk.is_none() {
            return Err(lost());
        }
        let sent = match self.transfer(header).await {
            Ok(()) => self.transfer(data).await,
            failed => failed,
        };
        match sent {
            Ok(()) => Ok(()),
            Err(UsbTransferFailed) => Err(self.lose().await),
        }
    }

    async fn receive(&mut self) -> Result<Vec<u8>, AdbError> {
        match self.read_packet().await {
            Ok(packet) => Ok(packet),
            Err(UsbTransferFailed) => Err(self.lose().await),
        }
    }

    fn can_start_tls(&self) -> bool {
        false
    }

    async fn start_tls(
        &mut self,
        _identity: &TlsIdentity,
        _timeout: Duration,
    ) -> Result<(), AdbError> {
        Err(AdbError::TlsNotOffered)
    }

    async fn close(&mut self) {
        self.partial = None;
        if let Some(mut bulk) = self.bulk.take() {
            bulk.release().await;
        }
    }
}

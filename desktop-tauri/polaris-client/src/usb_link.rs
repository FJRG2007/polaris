//! A TV's USB connection, as an `AdbLink` for `adb_client`, over the `nusb`
//! crate. The Rust twin of `desktop/src/main/usb-link.ts`.
//!
//! The Electron app holds the device in a hidden WebUSB page because WebUSB is
//! only in pages. Here the app talks to the device itself: there is no page, no
//! session to keep apart and no window that could keep the app from quitting.
//! On Windows the ADB interface needs the WinUSB driver, as it does for WebUSB;
//! a TV whose interface has another driver, or one a running `adb` server holds,
//! answers busy.

use std::time::Duration;

use nusb::descriptors::TransferType;
use nusb::transfer::{Bulk, Direction, In, Out};
use nusb::{DeviceInfo, Endpoint, ErrorKind, Interface};

use crate::adb_client::AdbError;
use crate::usb_adb::{
    describe_devices, open_adb_pipe, AdbUsbInterface, TvUsbDevice, UsbAdbPipe, UsbAlternate,
    UsbBulk, UsbConfiguration, UsbDescription, UsbDevice, UsbDirection, UsbEndpoint, UsbInterface,
    UsbOpenError, UsbTransferFailed, UsbTransferType,
};

/// How long one listing or open may take, as the hidden page's requests could.
const REQUEST: Duration = Duration::from_secs(15);

/// Whether the system lists an interface with ADB's class triple, read without opening the device.
fn offers_adb(info: &DeviceInfo) -> bool {
    info.interfaces()
        .any(|one| one.class() == 0xff && one.subclass() == 0x42 && one.protocol() == 0x01)
}

fn configuration_of(
    descriptor: &nusb::descriptors::ConfigurationDescriptor<'_>,
) -> UsbConfiguration {
    UsbConfiguration {
        configuration_value: descriptor.configuration_value(),
        interfaces: descriptor
            .interfaces()
            .map(|interface| UsbInterface {
                interface_number: interface.interface_number(),
                alternates: interface
                    .alt_settings()
                    .map(|alternate| UsbAlternate {
                        alternate_setting: alternate.alternate_setting(),
                        class: alternate.class(),
                        subclass: alternate.subclass(),
                        protocol: alternate.protocol(),
                        endpoints: alternate
                            .endpoints()
                            .map(|endpoint| UsbEndpoint {
                                address: endpoint.address(),
                                direction: match endpoint.direction() {
                                    Direction::In => UsbDirection::In,
                                    Direction::Out => UsbDirection::Out,
                                },
                                kind: match endpoint.transfer_type() {
                                    TransferType::Bulk => UsbTransferType::Bulk,
                                    TransferType::Interrupt => UsbTransferType::Interrupt,
                                    TransferType::Isochronous => UsbTransferType::Isochronous,
                                    TransferType::Control => UsbTransferType::Control,
                                },
                                packet_size: endpoint.max_packet_size(),
                            })
                            .collect(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

/// A device on this computer, opened to read its descriptors.
pub struct NusbDevice {
    device: nusb::Device,
    description: UsbDescription,
}

async fn described(info: &DeviceInfo) -> Option<NusbDevice> {
    let device = info.open().await.ok()?;
    let configurations: Vec<UsbConfiguration> = device
        .configurations()
        .map(|one| configuration_of(&one))
        .collect();
    let configuration = device
        .active_configuration()
        .ok()
        .map(|one| configuration_of(&one));
    let description = UsbDescription {
        vendor_id: info.vendor_id(),
        product_id: info.product_id(),
        serial_number: info.serial_number().map(str::to_owned),
        product_name: info.product_string().map(str::to_owned),
        manufacturer_name: info.manufacturer_string().map(str::to_owned),
        configuration,
        configurations,
    };
    Some(NusbDevice {
        device,
        description,
    })
}

/// Every plugged-in device that offers ADB, with its descriptors.
async fn adb_devices() -> Result<Vec<NusbDevice>, AdbError> {
    let listed = nusb::list_devices()
        .await
        .map_err(|_| AdbError::from(UsbOpenError::Busy))?;
    let mut devices = Vec::new();
    for info in listed.filter(offers_adb) {
        if let Some(device) = described(&info).await {
            devices.push(device);
        }
    }
    Ok(devices)
}

/// The TVs plugged in now that offer ADB.
pub async fn usb_devices() -> Result<Vec<TvUsbDevice>, AdbError> {
    let devices = tokio::time::timeout(REQUEST, adb_devices())
        .await
        .map_err(|_| AdbError::from(UsbOpenError::Busy))??;
    let descriptions: Vec<UsbDescription> =
        devices.iter().map(|one| one.description.clone()).collect();
    Ok(describe_devices(&descriptions)
        .into_iter()
        .map(|(_, info)| info)
        .collect())
}

/// The link to the device `id` from `usb_devices`.
pub async fn usb_link(id: &str) -> Result<UsbAdbPipe<NusbBulk>, AdbError> {
    let open = async {
        let mut devices = adb_devices().await?;
        let descriptions: Vec<UsbDescription> =
            devices.iter().map(|one| one.description.clone()).collect();
        let at = describe_devices(&descriptions)
            .into_iter()
            .find(|(_, info)| info.id == id)
            .map(|(at, _)| at)
            .ok_or(UsbOpenError::Gone)?;
        let device = devices.swap_remove(at);
        open_adb_pipe(&device).await.map_err(AdbError::from)
    };
    tokio::time::timeout(REQUEST, open)
        .await
        .map_err(|_| AdbError::from(UsbOpenError::Busy))?
}

fn open_failure(error: &nusb::Error) -> UsbOpenError {
    match error.kind() {
        ErrorKind::NotFound | ErrorKind::Disconnected => UsbOpenError::Gone,
        _ => UsbOpenError::Busy,
    }
}

impl UsbDevice for NusbDevice {
    type Bulk = NusbBulk;

    fn description(&self) -> &UsbDescription {
        &self.description
    }

    async fn claim(&self, found: &AdbUsbInterface) -> Result<NusbBulk, UsbOpenError> {
        let active = self
            .description
            .configuration
            .as_ref()
            .map(|one| one.configuration_value);
        if active != Some(found.configuration) {
            self.device
                .set_configuration(found.configuration)
                .await
                .map_err(|error| open_failure(&error))?;
        }
        // On Windows a claimed interface - a running adb server holds it - or one
        // with no WinUSB driver fails here.
        let interface = self
            .device
            .claim_interface(found.interface_number)
            .await
            .map_err(|error| open_failure(&error))?;
        if found.alternate != 0 {
            interface
                .set_alt_setting(found.alternate)
                .await
                .map_err(|error| open_failure(&error))?;
        }
        let input = interface
            .endpoint::<Bulk, In>(found.input.address)
            .map_err(|error| open_failure(&error))?;
        let output = interface
            .endpoint::<Bulk, Out>(found.output.address)
            .map_err(|error| open_failure(&error))?;
        Ok(NusbBulk {
            interface: Some(interface),
            input,
            output,
        })
    }
}

/// The claimed ADB interface's two bulk endpoints.
pub struct NusbBulk {
    interface: Option<Interface>,
    input: Endpoint<Bulk, In>,
    output: Endpoint<Bulk, Out>,
}

impl UsbBulk for NusbBulk {
    async fn transfer_in(&mut self, length: usize) -> Result<Vec<u8>, UsbTransferFailed> {
        // A transfer left by a dropped call is the one this completes.
        if self.input.pending() == 0 {
            let packet = self.input.max_packet_size().max(1);
            let requested = length.max(1).div_ceil(packet) * packet;
            self.input.submit(nusb::transfer::Buffer::new(requested));
        }
        let done = self.input.next_complete().await;
        done.status.map_err(|_| UsbTransferFailed)?;
        Ok(done.buffer.into_vec())
    }

    async fn transfer_out(&mut self, data: &[u8]) -> Result<(), UsbTransferFailed> {
        // One left by a dropped call finishes first, so transfers keep their order.
        while self.output.pending() > 0 {
            self.output
                .next_complete()
                .await
                .status
                .map_err(|_| UsbTransferFailed)?;
        }
        self.output.submit(data.to_vec().into());
        self.output
            .next_complete()
            .await
            .status
            .map_err(|_| UsbTransferFailed)
    }

    async fn release(&mut self) {
        self.input.cancel_all();
        self.output.cancel_all();
        if let Some(interface) = self.interface.take() {
            drop(interface);
        }
    }
}

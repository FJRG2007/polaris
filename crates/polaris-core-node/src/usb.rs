//! Which USB devices are plugged in, and word when that changes, for the
//! desktop's device add-ons (docs/device-addons.md): an add-on whose device is
//! unplugged has no process, and the plug event starts it.
//!
//! Vendor and product ids only - nothing is opened, so this never takes a
//! device from its driver. Built on `nusb`, the same library and version as
//! crates/polaris-stream100, so the workspace carries one USB stack.

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{bindgen_prelude::Unknown, Status};
use napi_derive::napi;
use futures_core::Stream;
use nusb::MaybeFuture;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread::Thread;

/// The plugged devices as `[{"vendorId":1784,"productId":57427}, ...]`.
#[napi(catch_unwind)]
pub fn usb_devices_json() -> napi::Result<String> {
    let devices = nusb::list_devices()
        .wait()
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let list: Vec<serde_json::Value> = devices
        .map(|device| serde_json::json!({ "vendorId": device.vendor_id(), "productId": device.product_id() }))
        .collect();
    Ok(serde_json::Value::Array(list).to_string())
}

/// Wakes the watcher thread when the operating system reports a change.
struct ThreadWaker(Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// A running watch; `close` stops word reaching JavaScript.
#[napi]
pub struct UsbWatch {
    closed: Arc<AtomicBool>,
}

#[napi]
impl UsbWatch {
    #[napi]
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

/// The JavaScript callback: weak, so a watch never keeps the process alive.
type OnChange = ThreadsafeFunction<u32, Unknown<'static>, u32, Status, false, true>;

/// Call `on_change` (with a running count) after each plug or unplug; the
/// caller lists the devices again with `usbDevicesJson`. One native thread
/// that sleeps until the operating system wakes it - nothing polls.
#[napi(catch_unwind)]
pub fn watch_usb(on_change: OnChange) -> napi::Result<UsbWatch> {
    let mut watch = nusb::watch_devices().map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let closed = Arc::new(AtomicBool::new(false));
    let stop = closed.clone();
    std::thread::Builder::new()
        .name("polaris-usb-watch".into())
        .spawn(move || {
            let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
            let mut context = Context::from_waker(&waker);
            let mut count: u32 = 0;
            loop {
                match Pin::new(&mut watch).poll_next(&mut context) {
                    Poll::Ready(Some(_)) => {
                        if stop.load(Ordering::SeqCst) {
                            return;
                        }
                        count = count.wrapping_add(1);
                        if on_change.call(count, ThreadsafeFunctionCallMode::NonBlocking) == Status::Closing {
                            return;
                        }
                    }
                    Poll::Ready(None) => return,
                    Poll::Pending => {
                        if stop.load(Ordering::SeqCst) {
                            return;
                        }
                        std::thread::park();
                    }
                }
            }
        })
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    Ok(UsbWatch { closed })
}

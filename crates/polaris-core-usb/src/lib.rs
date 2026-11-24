//! Which USB devices are plugged in, and word when that changes, for the
//! desktop's device add-ons (docs/device-addons.md): an add-on whose device is
//! unplugged has no process, and the plug event starts it.
//!
//! Vendor and product ids only - nothing is opened, so this never takes a
//! device from its driver. Built on `nusb`, the same library and version as
//! crates/polaris-stream100, so the workspace carries one USB stack.
//!
//! This is platform I/O, so it lives outside polaris-core's pure domains
//! (docs/rust-core-plan.md, 3.1); polaris-core re-exports it as
//! `polaris_core::usb` behind its `usb` feature, which only the Node binding
//! turns on, and the binding only converts types.

use futures_core::Stream;
use nusb::MaybeFuture;
use std::fmt;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::thread::Thread;

/// Why the operating system could not list or watch the devices.
#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

fn error(cause: impl ToString) -> Error {
    Error(cause.to_string())
}

/// `[{"vendorId":1784,"productId":57427}, ...]` for the given `(vendor, product)` ids.
pub fn ids_json(ids: impl IntoIterator<Item = (u16, u16)>) -> String {
    let list: Vec<serde_json::Value> = ids
        .into_iter()
        .map(|(vendor, product)| serde_json::json!({ "vendorId": vendor, "productId": product }))
        .collect();
    serde_json::Value::Array(list).to_string()
}

/// The plugged devices as `[{"vendorId":1784,"productId":57427}, ...]`.
pub fn devices_json() -> Result<String, Error> {
    let devices = nusb::list_devices().wait().map_err(error)?;
    Ok(ids_json(
        devices.map(|device| (device.vendor_id(), device.product_id())),
    ))
}

/// Wakes the watcher thread when the operating system reports a change.
struct ThreadWaker(Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// A running watch; `close` stops word reaching the callback.
pub struct Watch {
    closed: Arc<AtomicBool>,
}

impl Watch {
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

/// Drive `events` on the current thread, calling `on_change` with a running
/// count after each one, until the stream ends, `stop` is set, or `on_change`
/// answers `false`. Sleeps between events; `waker` must unpark this thread.
fn run<S: Stream + Unpin>(
    mut events: S,
    stop: &AtomicBool,
    waker: &Waker,
    mut on_change: impl FnMut(u32) -> bool,
) {
    let mut context = Context::from_waker(waker);
    let mut count: u32 = 0;
    loop {
        match Pin::new(&mut events).poll_next(&mut context) {
            Poll::Ready(Some(_)) => {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                count = count.wrapping_add(1);
                if !on_change(count) {
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
}

/// Call `on_change` (with a running count) after each plug or unplug; the
/// caller lists the devices again with [`devices_json`]. `on_change` answers
/// `false` to stop. One native thread that sleeps until the operating system
/// wakes it - nothing polls.
pub fn watch(on_change: impl FnMut(u32) -> bool + Send + 'static) -> Result<Watch, Error> {
    let events = nusb::watch_devices().map_err(error)?;
    let closed = Arc::new(AtomicBool::new(false));
    let stop = closed.clone();
    std::thread::Builder::new()
        .name("polaris-usb-watch".into())
        .spawn(move || {
            let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
            run(events, &stop, &waker, on_change);
        })
        .map_err(error)?;
    Ok(Watch { closed })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stream that yields `remaining` events, then ends.
    struct Events {
        remaining: u32,
    }

    impl Stream for Events {
        type Item = ();

        fn poll_next(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<()>> {
            if self.remaining == 0 {
                return Poll::Ready(None);
            }
            self.remaining -= 1;
            Poll::Ready(Some(()))
        }
    }

    fn waker() -> Waker {
        Waker::from(Arc::new(ThreadWaker(std::thread::current())))
    }

    #[test]
    fn ids_json_has_the_shape_presence_reads() {
        let parsed: serde_json::Value =
            serde_json::from_str(&ids_json([(1784, 57427), (0, 65535)])).unwrap();
        assert_eq!(
            parsed,
            serde_json::json!([{ "vendorId": 1784, "productId": 57427 }, { "vendorId": 0, "productId": 65535 }])
        );
        assert_eq!(ids_json([]), "[]");
    }

    #[test]
    fn counts_every_event_until_the_stream_ends() {
        let mut seen = Vec::new();
        run(
            Events { remaining: 3 },
            &AtomicBool::new(false),
            &waker(),
            |count| {
                seen.push(count);
                true
            },
        );
        assert_eq!(seen, [1, 2, 3]);
    }

    #[test]
    fn stops_when_the_callback_says_so() {
        let mut seen = Vec::new();
        run(
            Events { remaining: 5 },
            &AtomicBool::new(false),
            &waker(),
            |count| {
                seen.push(count);
                count < 2
            },
        );
        assert_eq!(seen, [1, 2]);
    }

    #[test]
    fn a_closed_watch_reports_nothing() {
        let watch = Watch {
            closed: Arc::new(AtomicBool::new(false)),
        };
        watch.close();
        let mut seen = 0;
        run(Events { remaining: 3 }, &watch.closed, &waker(), |_| {
            seen += 1;
            true
        });
        assert_eq!(seen, 0);
    }
}

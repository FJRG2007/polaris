//! Polaris Desktop's native messaging host.
//!
//! A browser starts this program when the Polaris extension calls
//! `runtime.sendNativeMessage`, hands it one message on stdin, and reads one
//! reply from stdout. It relays the extension's pairing nonce to the running
//! desktop app over a per-user local socket (`ipc`) and passes the answer back.
//! It does nothing else: one message in, one reply out, then it exits. When the
//! desktop app is not running it answers `no-desktop` at once.
//!
//! The design follows Bitwarden's desktop proxy (`apps/desktop/desktop_native/proxy`):
//! a small separate binary, so the Electron executable never has to run as Node.

mod framing;
mod ipc;
mod message;

use framing::{read_message, write_message, HOST_TO_BROWSER_MAX, INBOUND_MAX};
use serde_json::Value;
use std::io::{self, Read};
use std::sync::mpsc;
use std::time::Duration;

/// How long the desktop app has to answer: its own call to the server gives up
/// after 20 seconds.
const DESKTOP_TIMEOUT: Duration = Duration::from_secs(30);

fn relay(message: Value) -> Value {
    let mut stream = match ipc::connect() {
        Ok(stream) => stream,
        Err(ipc::IpcError::Absent) => return message::failure("no-desktop"),
        Err(ipc::IpcError::Untrusted(why)) => {
            eprintln!("polaris-native-host: {why}; nothing was sent");
            return message::failure("no-desktop");
        }
    };
    if let Err(e) = write_message(&mut stream, &message, INBOUND_MAX) {
        eprintln!("polaris-native-host: could not reach the desktop app: {e}");
        return message::failure("no-desktop");
    }
    match read_message(&mut stream, INBOUND_MAX) {
        Ok(Some(answer)) => message::reply_for_browser(&answer),
        Ok(None) => message::failure("no-desktop"),
        Err(e) => {
            eprintln!("polaris-native-host: the desktop app's answer was unreadable: {e}");
            message::failure("refused")
        }
    }
}

/// The reply for one run, or `None` when the browser closed stdin without a message.
fn run<R: Read>(
    args: &[String],
    stdin: &mut R,
    relay: impl FnOnce(Value) -> Value + Send + 'static,
) -> Option<Value> {
    let request = match read_message(stdin, INBOUND_MAX) {
        Ok(Some(request)) => request,
        Ok(None) => return None,
        Err(e) => {
            eprintln!("polaris-native-host: {e}");
            return Some(message::failure("bad-request"));
        }
    };
    let Some(caller) = message::caller_from_args(args) else {
        eprintln!("polaris-native-host: the browser did not say which extension called");
        return Some(message::failure("bad-request"));
    };
    let Some(pairing) = message::pairing_for_desktop(&request, &caller) else {
        return Some(message::failure("bad-request"));
    };
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(relay(pairing));
    });
    Some(
        receive
            .recv_timeout(DESKTOP_TIMEOUT)
            .unwrap_or_else(|_| message::failure("no-desktop")),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(reply) = run(&args, &mut io::stdin().lock(), relay) else {
        return;
    };
    if let Err(e) = write_message(&mut io::stdout().lock(), &reply, HOST_TO_BROWSER_MAX) {
        eprintln!("polaris-native-host: could not answer the browser: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
    const NONCE: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

    fn framed(value: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        write_message(&mut out, value, INBOUND_MAX).unwrap();
        out
    }

    #[test]
    fn relays_a_pairing_and_returns_the_desktops_answer() {
        let input =
            framed(&json!({ "type": "pair", "server": "https://p.example", "nonce": NONCE }));
        let reply = run(&[ORIGIN.into()], &mut input.as_slice(), |sent| {
            assert_eq!(sent["caller"]["browser"], "chromium");
            json!({ "ok": true })
        });
        assert_eq!(reply, Some(json!({ "ok": true })));
    }

    #[test]
    fn a_bad_message_never_reaches_the_desktop() {
        let input = framed(&json!({ "type": "pair", "server": "https://p.example", "nonce": "x" }));
        let reply = run(&[ORIGIN.into()], &mut input.as_slice(), |_| {
            panic!("relayed")
        });
        assert_eq!(reply, Some(message::failure("bad-request")));
        let garbage = [3u8, 0, 0, 0, b'{', b'{', b'{'];
        let reply = run(&[ORIGIN.into()], &mut garbage.as_slice(), |_| {
            panic!("relayed")
        });
        assert_eq!(reply, Some(message::failure("bad-request")));
    }

    #[test]
    fn an_unnamed_caller_is_refused() {
        let input =
            framed(&json!({ "type": "pair", "server": "https://p.example", "nonce": NONCE }));
        let reply = run(&[], &mut input.as_slice(), |_| panic!("relayed"));
        assert_eq!(reply, Some(message::failure("bad-request")));
    }

    #[test]
    fn an_empty_stdin_answers_nothing() {
        let reply = run(&[ORIGIN.into()], &mut [].as_slice(), |_| panic!("relayed"));
        assert_eq!(reply, None);
    }
}

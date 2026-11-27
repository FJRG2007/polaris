use std::time::Duration;

use base64::Engine;

use super::*;

const T0: Duration = Duration::ZERO;

fn decoded(frames: &[Outgoing], pane: &str) -> Vec<u8> {
    frames
        .iter()
        .filter_map(|frame| match frame {
            Outgoing::Output { pane: p, data } if p == pane => Some(
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap(),
            ),
            _ => None,
        })
        .flatten()
        .collect()
}

#[test]
fn reads_the_relay_frames() {
    assert_eq!(
        parse_incoming(r#"{"type":"attach","pane":"p1"}"#),
        Some(Incoming::Attach { pane: "p1".into() })
    );
    assert_eq!(
        parse_incoming(r#"{"type":"detach","pane":"p1"}"#),
        Some(Incoming::Detach { pane: "p1".into() })
    );
    assert_eq!(
        parse_incoming(r#"{"type":"request","id":"r1","envelope":{"kind":"app.ping"}}"#),
        Some(Incoming::Request {
            id: "r1".into(),
            envelope: serde_json::json!({ "kind": "app.ping" })
        })
    );
    assert_eq!(
        parse_incoming(r#"{"type":"ready","instance":"i"}"#),
        Some(Incoming::Ready {
            instance: "i".into()
        })
    );
    assert_eq!(parse_incoming(r#"{"type":"pong"}"#), Some(Incoming::Pong));
    assert_eq!(
        parse_incoming(r#"{"type":"later"}"#),
        Some(Incoming::Unknown)
    );
    assert_eq!(parse_incoming("not json"), None);
}

#[test]
fn writes_the_frames_the_relay_reads() {
    let hello = Outgoing::Hello {
        name: Some("desk".into()),
        os: None,
        version: Some("0.2026.11.27".into()),
    };
    assert_eq!(
        serde_json::to_value(&hello).unwrap(),
        serde_json::json!({ "type": "hello", "name": "desk", "version": "0.2026.11.27" })
    );
    assert_eq!(
        serde_json::to_value(Outgoing::Output {
            pane: "p".into(),
            data: "AA==".into()
        })
        .unwrap(),
        serde_json::json!({ "type": "output", "pane": "p", "data": "AA==" })
    );
    assert_eq!(
        serde_json::to_value(Outgoing::Response {
            id: "r".into(),
            envelope: serde_json::json!({})
        })
        .unwrap(),
        serde_json::json!({ "type": "response", "id": "r", "envelope": {} })
    );
    assert_eq!(
        serde_json::to_value(Outgoing::Ping).unwrap(),
        serde_json::json!({ "type": "ping" })
    );
}

#[test]
fn the_screen_goes_first_then_the_live_output() {
    let mut output = PaneOutput::new();
    output.attach("p", b"screen;", T0).unwrap();
    output.push("p", b"live");

    assert_eq!(decoded(&output.drain(T0), "p"), b"screen;live");
}

#[test]
fn nothing_is_sent_for_a_pane_that_is_not_attached() {
    let mut output = PaneOutput::new();
    output.push("p", b"before");
    assert!(output.drain(T0).is_empty());

    output.attach("p", b"", T0).unwrap();
    output.detach("p");
    output.push("p", b"after");
    assert!(output.drain(T0).is_empty());
    assert!(!output.is_attached("p"));
}

#[test]
fn frames_carry_at_most_64_kib() {
    let mut output = PaneOutput::new();
    let bytes = vec![7u8; MAX_CHUNK_BYTES * 2 + 10];
    output.attach("p", &bytes, T0).unwrap();

    let frames = output.drain(T0);

    assert_eq!(frames.len(), 3);
    for frame in &frames {
        let Outgoing::Output { data, .. } = frame else {
            panic!("output only")
        };
        let raw = base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap();
        assert!(raw.len() <= MAX_CHUNK_BYTES);
    }
    assert_eq!(decoded(&frames, "p"), bytes);
}

#[test]
fn at_most_16_panes_are_attached() {
    let mut output = PaneOutput::new();
    for index in 0..MAX_ATTACHED_PANES {
        output.attach(&format!("p{index}"), b"", T0).unwrap();
    }
    assert_eq!(
        output.attach("one-more", b"", T0),
        Err(AttachRefused::TooManyPanes)
    );
    // Attaching one already attached again is a restart, not a new pane.
    assert_eq!(output.attach("p0", b"again", T0), Ok(()));

    output.detach("p1");
    assert_eq!(output.attach("one-more", b"", T0), Ok(()));
}

#[test]
fn stays_within_the_relays_meter_and_sends_the_rest_later() {
    let mut output = PaneOutput::new();
    output.attach("p", b"", T0).unwrap();
    // More than the burst allows at once, less than the wait holds.
    output.push("p", &vec![1u8; 900 * 1024]);

    let first = output.drain(T0);
    let sent: usize = first
        .iter()
        .map(|frame| match frame {
            Outgoing::Output { data, .. } => data.len(),
            _ => 0,
        })
        .sum();
    assert!(sent as u64 <= OUTPUT_BURST_BYTES);
    assert!(output.has_pending());

    // Nothing more until the meter refills.
    assert!(output.drain(T0).is_empty());

    let later = output.drain(Duration::from_secs(2));
    assert!(!later.is_empty());
    assert!(!output.has_pending());
    let total = decoded(&first, "p").len() + decoded(&later, "p").len();
    assert_eq!(total, 900 * 1024);
}

#[test]
fn a_flood_keeps_the_newest_bytes() {
    let mut output = PaneOutput::new();
    output.attach("p", b"", T0).unwrap();
    output.push("p", &vec![0u8; MAX_PENDING_BYTES]);
    output.push("p", b"newest");

    let mut all = Vec::new();
    let mut at = T0;
    while output.has_pending() {
        all.extend(decoded(&output.drain(at), "p"));
        at += Duration::from_secs(1);
    }
    assert_eq!(all.len(), MAX_PENDING_BYTES);
    assert!(all.ends_with(b"newest"));
}

#[test]
fn a_reconnect_forgets_every_attachment() {
    let mut output = PaneOutput::new();
    output.attach("p", b"screen", T0).unwrap();
    output.reset();

    assert!(!output.is_attached("p"));
    assert_eq!(output.attached().count(), 0);
    assert!(output.drain(T0).is_empty());
}

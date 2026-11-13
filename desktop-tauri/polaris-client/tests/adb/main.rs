//! The TV install stack's protocol pieces, with no network and no TV: SPAKE2
//! known answers, the ADB and pairing framing, and exchanges against an
//! in-process fake device over in-memory streams. Real TV sets are not
//! exercised here.

mod client;
mod fake;
mod pairing;
mod spake2;

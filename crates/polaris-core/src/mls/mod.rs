//! The MLS domain (RFC 9420): the group key agreement under end-to-end
//! encrypted Polaris Chat (docs/chat-e2ee-proposal.md, docs/rust-core-plan.md
//! Phase 2, unit E1), over OpenMLS 0.9.2 - the library phase 0 chose
//! (docs/chat-e2ee-phase0.md).
//!
//! What this module adds on top of OpenMLS is policy, not cryptography: one
//! fixed group configuration, the cipher suites Polaris accepts, randomness
//! the caller injects, storage the caller injects, and inputs that cross the
//! boundary as RFC 9420 wire bytes (`MLSMessage`) so every target - native,
//! Node and WebAssembly - speaks the same format.
//!
//! # Cipher suites
//!
//! [`POLARIS_CIPHERSUITE`] is `0x004F`, OpenMLS 0.9.2's
//! `MLS_128_MLKEM768X25519_AES128GCM_SHA256_Ed25519`: HPKE with the X-Wing
//! hybrid KEM (ML-KEM-768 + X25519), AES-128-GCM, SHA-256 and Ed25519
//! signatures. That is the owner's decision 6 (docs/chat-e2ee-proposal.md,
//! section 13: post-quantum hybrid with ML-KEM-768 from day one) for
//! confidentiality, which is what "harvest now, decrypt later" threatens;
//! authentication stays classical Ed25519, as in that suite.
//!
//! Sources and their limits, checked on 2026-11-23:
//!
//! - OpenMLS enables the suite behind its `draft-ietf-mls-pq-ciphersuites`
//!   feature (openmls_traits 0.6.0, `types.rs`, documented there as "TBD1
//!   (provisional code point)"), and `openmls_rust_crypto` 0.6.0 lists it in
//!   `supports()`. Its KEM is hpke-rs 0.7.0's `XWingDraft06`, HPKE KEM id
//!   `0x647a`, implemented by the `x-wing` 0.1.1 crate (X-Wing draft 06).
//! - draft-ietf-mls-pq-ciphersuites-08 (2026-11-19), section 6, registers the
//!   same suite as `0x0010` with KEM `0x647a`. So the HPKE KEM id agrees with
//!   the draft, but the MLS cipher suite value OpenMLS 0.9.2 puts on the wire
//!   (`0x004F`) does not: a group created here does not interoperate with an
//!   implementation of draft 08, and when OpenMLS adopts the registered value
//!   the stored groups keep `0x004F` in their GroupContext. Polaris runs every
//!   client itself, so interoperability with other MLS implementations is not
//!   required; moving to the registered value is a group re-initialisation
//!   (RFC 9420 section 11.2), to be done in the same release that upgrades
//!   OpenMLS. There are no IETF interoperability vectors for any
//!   post-quantum suite (github.com/mlswg/mls-implementations covers suites
//!   1-7), so this suite is covered by this crate's own tests only.
//!
//! [`CLASSIC_CIPHERSUITE`] (`0x0001`, RFC 9420 section 17.1, mandatory to
//! implement) is accepted too: it is the suite the RFC 9420 vectors exercise.
//!
//! # Randomness
//!
//! Every [`Member`] takes a 32-byte seed for a ChaCha20 generator that feeds
//! OpenMLS's `OpenMlsRand` (leaf, path, init and epoch secrets) and the
//! Ed25519 signature key. In production the seed must come from the
//! platform's CSPRNG and is never stored. Two sources stay outside the seed
//! because `openmls_rust_crypto` 0.6.0 gives a caller no way to seed them: the
//! ephemeral randomness of HPKE encapsulation (hpke-rs draws its own PRNG) and
//! the generator `RustCrypto` builds with `from_entropy` (provider.rs,
//! `impl Default`). Wire output is therefore not byte-reproducible; the plan's
//! bar for randomized formats is decryption parity (plan 3.1, 1.3).
//!
//! # Storage
//!
//! Group state lives only in the injected OpenMLS `StorageProvider`: each call
//! loads the group from it and OpenMLS writes every change back, so a member
//! rebuilt from the same storage carries on where the last one stopped.

mod journal;
mod member;
mod provider;

pub use journal::{Journal, StoreChange};
pub use member::{CommitOutput, GroupMember, Member, Processed, ProcessedKind};
pub use openmls_memory_storage::MemoryStorage;
pub use provider::{Provider, SeededRand};

use std::fmt;

/// `MLS_128_MLKEM768X25519_AES128GCM_SHA256_Ed25519` as OpenMLS 0.9.2 encodes
/// it; see the module documentation for the code point caveat.
pub const POLARIS_CIPHERSUITE: u16 = 0x004F;

/// `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (RFC 9420, section 17.1).
pub const CLASSIC_CIPHERSUITE: u16 = 0x0001;

/// The cipher suites a [`Member`] may be created with.
pub const SUPPORTED_CIPHERSUITES: [u16; 2] = [POLARIS_CIPHERSUITE, CLASSIC_CIPHERSUITE];

/// How many past epochs keep their message secrets, so an application message
/// sent just before a commit still opens after it. Forward secrecy holds for
/// anything older: those secrets are deleted (RFC 9420, section 9.2).
pub const MAX_PAST_EPOCHS: usize = 2;

/// Why an MLS operation was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The bytes are not a well-formed MLS structure.
    Malformed,
    /// Well-formed, but the protocol refuses it: a bad signature, the wrong
    /// epoch, a replay, a key package already used, a Welcome for someone
    /// else, a commit that does not verify.
    Rejected,
    /// A well-formed message of a type this operation does not take.
    WrongMessageType,
    /// No group with that id in this member's storage.
    UnknownGroup,
    /// The cipher suite is not one Polaris accepts.
    UnsupportedCiphersuite,
    /// The storage provider failed.
    Storage,
    /// OpenMLS reported an internal error.
    Internal,
}

impl ErrorKind {
    /// The code an error carries across the bindings.
    pub fn code(self) -> &'static str {
        match self {
            ErrorKind::Malformed => "MlsMalformed",
            ErrorKind::Rejected => "MlsRejected",
            ErrorKind::WrongMessageType => "MlsWrongMessageType",
            ErrorKind::UnknownGroup => "MlsUnknownGroup",
            ErrorKind::UnsupportedCiphersuite => "MlsUnsupportedCiphersuite",
            ErrorKind::Storage => "MlsStorage",
            ErrorKind::Internal => "MlsInternal",
        }
    }
}

/// An MLS operation's refusal: what kind, and OpenMLS's own explanation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MlsError {
    pub kind: ErrorKind,
    pub message: String,
}

impl MlsError {
    pub(crate) fn new(kind: ErrorKind, message: impl fmt::Display) -> Self {
        Self {
            kind,
            message: message.to_string(),
        }
    }

    /// The code an error carries across the bindings ([`ErrorKind::code`]).
    pub fn code(&self) -> &'static str {
        self.kind.code()
    }
}

impl fmt::Display for MlsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind.code(), self.message)
    }
}

impl std::error::Error for MlsError {}

pub type Result<T> = std::result::Result<T, MlsError>;

//! The OpenMLS provider: RustCrypto's primitives, a generator seeded by the
//! caller, and whatever storage the caller hands in.

use openmls_rust_crypto::RustCrypto;
use openmls_traits::random::OpenMlsRand;
use openmls_traits::storage::{StorageProvider, CURRENT_VERSION};
use openmls_traits::OpenMlsProvider;
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use std::fmt;
use std::sync::Mutex;

/// OpenMLS's randomness, drawn from ChaCha20 over a caller-provided seed.
pub struct SeededRand(Mutex<ChaCha20Rng>);

impl SeededRand {
    pub fn new(seed: [u8; 32]) -> Self {
        Self(Mutex::new(ChaCha20Rng::from_seed(seed)))
    }

    pub(crate) fn fill(&self, out: &mut [u8]) -> Result<(), RandError> {
        let mut rng = self.0.lock().map_err(|_| RandError)?;
        rng.fill_bytes(out);
        Ok(())
    }
}

/// The generator's lock was poisoned by a panic in another call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RandError;

impl fmt::Display for RandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the random generator is unavailable after an earlier panic")
    }
}

impl std::error::Error for RandError {}

impl OpenMlsRand for SeededRand {
    type Error = RandError;

    fn random_array<const N: usize>(&self) -> Result<[u8; N], Self::Error> {
        let mut out = [0u8; N];
        self.fill(&mut out)?;
        Ok(out)
    }

    fn random_vec(&self, len: usize) -> Result<Vec<u8>, Self::Error> {
        let mut out = vec![0u8; len];
        self.fill(&mut out)?;
        Ok(out)
    }
}

/// What OpenMLS calls through: crypto, randomness and storage.
pub struct Provider<S> {
    crypto: RustCrypto,
    rand: SeededRand,
    storage: S,
}

impl<S> Provider<S> {
    pub fn new(seed: [u8; 32], storage: S) -> Self {
        Self {
            crypto: RustCrypto::default(),
            rand: SeededRand::new(seed),
            storage,
        }
    }
}

impl<S: StorageProvider<CURRENT_VERSION>> OpenMlsProvider for Provider<S> {
    type CryptoProvider = RustCrypto;
    type RandProvider = SeededRand;
    type StorageProvider = S;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.rand
    }
}

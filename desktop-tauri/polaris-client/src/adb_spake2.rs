//! SPAKE2 over Ed25519 exactly as BoringSSL's `spake25519.cc` speaks it, which
//! is what adbd uses to check a Wireless debugging pairing code (AOSP
//! packages/modules/adb, pairing_auth/pairing_auth.cpp).
//!
//! The Rust twin of `desktop/src/main/adb-spake2.ts`. Only the group arithmetic
//! comes from a library (`curve25519-dalek`); the steps, names and transcript
//! order follow BoringSSL line by line, including its "password scalar hack":
//! the password scalar is moved to a multiple of eight by adding multiples of
//! the group order, so the peer's small-order components cancel the same way
//! they do there.
//!
//! BoringSSL multiplies by scalars that are multiples of eight below eight times
//! the order. `s * P` for such an `s` is `(s / 8) * (8 * P)`, and `s / 8` is
//! below the order, so it is an ordinary canonical scalar here: for the password
//! it is `(h mod l) * 8^-1 mod l`, and for the private key it is the reduced
//! random scalar itself.

use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;
use sha2::{Digest, Sha512};

/// BoringSSL's fixed points, decoded from the first entry of `kSpakeMSmallPrecomp` / `kSpakeNSmallPrecomp`.
const M_BYTES: [u8; 32] = hex32("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e");
const N_BYTES: [u8; 32] = hex32("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778");

/// adbd's names for the two sides; `sizeof` in C, so the trailing NUL is part of each.
pub const CLIENT_NAME: &[u8] = b"adb pair client\0";
pub const SERVER_NAME: &[u8] = b"adb pair server\0";

/// Which side of the exchange this is: the pairing client is Alice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Spake2Role {
    Alice,
    Bob,
}

/// Why an exchange could not go on, in the TypeScript module's words.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Spake2Error {
    #[error("SPAKE2 drew a zero scalar.")]
    ZeroScalar,
    #[error("This SPAKE2 exchange is already finished.")]
    AlreadyFinished,
    #[error("The SPAKE2 message is not 32 bytes.")]
    MessageLength,
    #[error("The SPAKE2 message is not a point on the curve.")]
    NotAPoint,
}

const fn hex32(text: &str) -> [u8; 32] {
    const fn nibble(byte: u8) -> u8 {
        match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => panic!("not hex"),
        }
    }
    let bytes = text.as_bytes();
    let mut out = [0u8; 32];
    let mut index = 0;
    while index < 32 {
        out[index] = (nibble(bytes[index * 2]) << 4) | nibble(bytes[index * 2 + 1]);
        index += 1;
    }
    out
}

fn fixed_point(bytes: &[u8; 32]) -> EdwardsPoint {
    CompressedEdwardsY(*bytes)
        .decompress()
        .expect("BoringSSL's SPAKE2 points are on the curve")
}

/// The password after BoringSSL's reduction and hack.
#[derive(Clone)]
pub struct PasswordScalar {
    /// SHA-512 of the password, the last part of the transcript.
    pub hash: [u8; 64],
    /// The hacked scalar divided by eight: `scalar = 8 * eighth`.
    eighth: Scalar,
    /// The hacked scalar itself, little-endian, as BoringSSL holds it.
    scalar: [u8; 33],
}

impl PasswordScalar {
    /// The hacked scalar, little-endian: always a multiple of eight below eight times the order.
    pub fn scalar_le(&self) -> &[u8; 33] {
        &self.scalar
    }

    /// `scalar * point`, as BoringSSL multiplies.
    fn times(&self, point: &EdwardsPoint) -> EdwardsPoint {
        point.mul_by_cofactor() * self.eighth
    }
}

/// SHA-512 of the password, and the password scalar after BoringSSL's reduction and hack.
pub fn password_scalar(password: &[u8]) -> PasswordScalar {
    let hash: [u8; 64] = Sha512::digest(password).into();
    let reduced = Scalar::from_bytes_mod_order_wide(&hash);
    let eighth = reduced * Scalar::from(8u8).invert();
    // `reduced + k * order` with the low three bits cleared is `8 * eighth`, below eight times the order.
    let mut scalar = [0u8; 33];
    let mut carry = 0u16;
    for (index, byte) in eighth.to_bytes().iter().enumerate() {
        let value = (u16::from(*byte) << 3) | carry;
        scalar[index] = (value & 0xff) as u8;
        carry = value >> 8;
    }
    scalar[32] = carry as u8;
    PasswordScalar {
        hash,
        eighth,
        scalar,
    }
}

fn with_length(hash: &mut Sha512, data: &[u8]) {
    hash.update((data.len() as u64).to_le_bytes());
    hash.update(data);
}

/// One side of one exchange.
pub struct Spake2 {
    role: Spake2Role,
    my_name: Vec<u8>,
    their_name: Vec<u8>,
    /// The private scalar divided by the cofactor BoringSSL keeps it multiplied by.
    secret: Scalar,
    password: PasswordScalar,
    message: [u8; 32],
    done: bool,
}

impl Spake2 {
    /// A new exchange with fresh randomness.
    pub fn new(
        role: Spake2Role,
        my_name: &[u8],
        their_name: &[u8],
        password: &[u8],
    ) -> Result<Self, Spake2Error> {
        let mut random = [0u8; 64];
        getrandom::fill(&mut random).expect("the operating system's random source works");
        Self::with_random(role, my_name, their_name, password, &random)
    }

    /// `random` stands in for RAND_bytes(64), for known-answer tests.
    pub fn with_random(
        role: Spake2Role,
        my_name: &[u8],
        their_name: &[u8],
        password: &[u8],
        random: &[u8; 64],
    ) -> Result<Self, Spake2Error> {
        let reduced = Scalar::from_bytes_mod_order_wide(random);
        if reduced == Scalar::ZERO {
            return Err(Spake2Error::ZeroScalar);
        }
        let password = password_scalar(password);
        let mask = password.times(&fixed_point(match role {
            Spake2Role::Alice => &M_BYTES,
            Spake2Role::Bob => &N_BYTES,
        }));
        let public = (ED25519_BASEPOINT_POINT * reduced).mul_by_cofactor() + mask;
        Ok(Self {
            role,
            my_name: my_name.to_vec(),
            their_name: their_name.to_vec(),
            secret: reduced,
            password,
            message: public.compress().to_bytes(),
            done: false,
        })
    }

    /// Our 32-byte message for the peer.
    pub fn message(&self) -> &[u8; 32] {
        &self.message
    }

    /// The 64-byte shared key from the peer's message. Both sides get the same one only with the same password.
    pub fn finish(&mut self, their_message: &[u8]) -> Result<[u8; 64], Spake2Error> {
        if self.done {
            return Err(Spake2Error::AlreadyFinished);
        }
        let bytes: [u8; 32] = their_message
            .try_into()
            .map_err(|_| Spake2Error::MessageLength)?;
        let theirs = CompressedEdwardsY(bytes)
            .decompress()
            .ok_or(Spake2Error::NotAPoint)?;
        self.done = true;
        let their_mask = self.password.times(&fixed_point(match self.role {
            Spake2Role::Alice => &N_BYTES,
            Spake2Role::Bob => &M_BYTES,
        }));
        let unmasked = theirs - their_mask;
        let shared = if self.secret == Scalar::ZERO {
            EdwardsPoint::identity()
        } else {
            unmasked.mul_by_cofactor() * self.secret
        };
        let shared = shared.compress().to_bytes();
        let (first, second, first_message, second_message): (&[u8], &[u8], &[u8], &[u8]) =
            match self.role {
                Spake2Role::Alice => (
                    &self.my_name,
                    &self.their_name,
                    &self.message,
                    their_message,
                ),
                Spake2Role::Bob => (
                    &self.their_name,
                    &self.my_name,
                    their_message,
                    &self.message,
                ),
            };
        let mut hash = Sha512::new();
        for part in [
            first,
            second,
            first_message,
            second_message,
            &shared,
            &self.password.hash,
        ] {
            with_length(&mut hash, part);
        }
        Ok(hash.finalize().into())
    }
}

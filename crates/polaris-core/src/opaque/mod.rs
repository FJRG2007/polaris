//! OPAQUE (RFC 9807), the augmented PAKE behind Polaris' password sign-in and
//! the account key's password lock (docs/chat-e2ee-phase1.md).
//!
//! Built on `opaque-ke` 4.0.1 (Meta; NCC Group audit 2021), with exactly the
//! suite and wire encoding of `@serenity-kit/opaque` 1.x, which wraps the same
//! crate: OPRF and AKE over ristretto255, 3DH with SHA-512, Argon2id as the
//! key-stretching function with an all-zero salt, every message and state as
//! unpadded base64url. A record, server setup or login state written by one is
//! read by the other, so the switch between the TypeScript path and this one
//! never strands an account.
//!
//! Pure: randomness comes in as an argument (`rng`), nothing here touches a
//! clock, a file or the network. The server never receives anything that lets
//! it test a password guess without running a full Argon2id per guess against
//! a stolen record, and an unknown account gets a login response shaped like a
//! real one (RFC 9807, 10.9), so the first step is no account-existence oracle.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use generic_array::{ArrayLength, GenericArray};
use opaque_ke::ciphersuite::CipherSuite;
use opaque_ke::errors::InternalError;
use opaque_ke::ksf::Ksf;
use opaque_ke::{
    ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialFinalization, CredentialRequest,
    CredentialResponse, Identifiers, RegistrationRequest, RegistrationResponse, ServerLogin,
    ServerLoginParameters, ServerRegistration, ServerSetup,
};
use rand_core::{CryptoRng, RngCore};
use std::fmt;
use std::marker::PhantomData;

/// The suite: ristretto255 OPRF and 3DH over SHA-512, generic only in its
/// key-stretching function so the RFC vectors (identity KSF) run the same code.
pub struct Suite<K>(PhantomData<K>);

impl<K: Ksf> CipherSuite for Suite<K> {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2::Sha512>;
    type Ksf = K;
}

/// The suite every Polaris record uses. Its Argon2id cost is set per call (see [`KsfParams`]).
pub type PolarisSuite = Suite<Argon2Ksf>;

/// Argon2id with an all-zero salt, as `@serenity-kit/opaque` runs it: OPAQUE
/// already salts the input through the OPRF, the KSF only adds cost.
#[derive(Default)]
pub struct Argon2Ksf {
    argon: Argon2<'static>,
}

impl Ksf for Argon2Ksf {
    fn hash<L: ArrayLength<u8>>(
        &self,
        input: GenericArray<u8, L>,
    ) -> Result<GenericArray<u8, L>, InternalError> {
        let mut output = GenericArray::default();
        self.argon
            .hash_password_into(&input, &[0; argon2::RECOMMENDED_SALT_LEN], &mut output)
            .map_err(|_| InternalError::KsfError)?;
        Ok(output)
    }
}

/// Argon2id cost. `memory` is in KiB, as in RFC 9106 and `@serenity-kit/opaque`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KsfParams {
    pub memory: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl KsfParams {
    /// Profile v1 of the password lock: 128 MiB, 3 passes, 1 lane. Fixed in
    /// code on the client, never read from a server, so it cannot be talked down.
    pub const PROFILE_V1: KsfParams = KsfParams {
        memory: 131_072,
        iterations: 3,
        parallelism: 1,
    };

    /// `@serenity-kit/opaque`'s default when no KSF is named (RFC 9106, 4,
    /// second recommendation): 64 MiB, 3 passes, 4 lanes.
    pub const MEMORY_CONSTRAINED: KsfParams = KsfParams {
        memory: 65_536,
        iterations: 3,
        parallelism: 4,
    };

    fn ksf(self) -> Result<Argon2Ksf, Error> {
        let params = Params::new(self.memory, self.iterations, self.parallelism, None)
            .map_err(|_| Error::Ksf)?;
        Ok(Argon2Ksf {
            argon: Argon2::new(Algorithm::Argon2id, Version::V0x13, params),
        })
    }
}

/// Every way a step can fail. The messages name the field, never its value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// A field was not unpadded base64url.
    Encoding(&'static str),
    /// A field decoded but is not a valid message or state, or the exchange
    /// itself failed (a wrong password at the server's finish lands here).
    Protocol(&'static str),
    /// The Argon2id parameters are outside what Argon2 accepts.
    Ksf,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Encoding(field) => write!(f, "base64 decoding failed at \"{field}\""),
            Error::Protocol(step) => write!(f, "opaque protocol error at \"{step}\""),
            Error::Ksf => f.write_str("Invalid keyStretching (argon2id) combination"),
        }
    }
}

impl std::error::Error for Error {}

fn decode(field: &'static str, value: &str) -> Result<Vec<u8>, Error> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| Error::Encoding(field))
}

fn encode(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn identifiers<'a>(client: Option<&'a str>, server: Option<&'a str>) -> Identifiers<'a> {
    Identifiers {
        client: client.map(str::as_bytes),
        server: server.map(str::as_bytes),
    }
}

fn setup<K: Ksf>(server_setup: &str) -> Result<ServerSetup<Suite<K>>, Error> {
    ServerSetup::<Suite<K>>::deserialize(&decode("serverSetup", server_setup)?)
        .map_err(|_| Error::Protocol("deserialize serverSetup"))
}

/// The optional identities bound into the AKE transcript (RFC 9807, 4.1.2).
/// Polaris binds the account id as the client identity, so a record made for
/// one account cannot complete a login as another.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Idents<'a> {
    pub client: Option<&'a str>,
    pub server: Option<&'a str>,
}

impl<'a> Idents<'a> {
    fn get(self) -> Identifiers<'a> {
        identifiers(self.client, self.server)
    }
}

pub struct ServerLoginStart {
    pub server_login_state: String,
    pub login_response: String,
}

pub struct ClientStart {
    pub state: String,
    pub request: String,
}

pub struct ClientRegistrationFinish {
    pub registration_record: String,
    pub export_key: String,
    pub server_static_public_key: String,
}

pub struct ClientLoginFinish {
    pub finish_login_request: String,
    pub session_key: String,
    pub export_key: String,
    pub server_static_public_key: String,
}

/// A fresh server setup: the OPRF seed and the server's long-term AKE key pair.
pub fn create_server_setup<R: RngCore + CryptoRng>(rng: &mut R) -> String {
    encode(ServerSetup::<PolarisSuite>::new(rng).serialize())
}

/// The server's long-term public key, which a client sees at every login.
pub fn server_public_key(server_setup: &str) -> Result<String, Error> {
    Ok(encode(
        setup::<Argon2Ksf>(server_setup)?
            .keypair()
            .public()
            .serialize(),
    ))
}

/// Registration step two (server): evaluate the blinded password under the
/// OPRF key derived for `user_identifier`.
pub fn create_registration_response(
    server_setup: &str,
    user_identifier: &str,
    registration_request: &str,
) -> Result<String, Error> {
    generic::registration_response::<Argon2Ksf>(
        &setup(server_setup)?,
        user_identifier,
        registration_request,
    )
}

/// Login step two (server). `registration_record` `None` answers with a
/// response indistinguishable from a real one, built from the setup's dummy
/// key and the same OPRF key derivation, so an unknown or unmigrated account
/// looks exactly like a known one until the client's finish fails.
pub fn start_server_login<R: RngCore + CryptoRng>(
    rng: &mut R,
    server_setup: &str,
    registration_record: Option<&str>,
    start_login_request: &str,
    user_identifier: &str,
    idents: Idents<'_>,
) -> Result<ServerLoginStart, Error> {
    generic::start_server_login::<Argon2Ksf, R>(
        rng,
        &setup(server_setup)?,
        registration_record,
        start_login_request,
        user_identifier,
        idents,
        None,
    )
}

/// Login step four (server): the session key when the client proved it knows
/// the password, an error otherwise. The MAC is checked in constant time by
/// `opaque-ke` (`subtle`).
pub fn finish_server_login(
    server_login_state: &str,
    finish_login_request: &str,
    idents: Idents<'_>,
) -> Result<String, Error> {
    generic::finish_server_login::<Argon2Ksf>(
        server_login_state,
        finish_login_request,
        idents,
        None,
    )
}

/// Registration step one (client): blind the password.
pub fn start_client_registration<R: RngCore + CryptoRng>(
    rng: &mut R,
    password: &str,
) -> Result<ClientStart, Error> {
    generic::start_client_registration::<Argon2Ksf, R>(rng, password)
}

/// Registration step three (client): the record to upload and the export key,
/// which never leaves the client.
pub fn finish_client_registration<R: RngCore + CryptoRng>(
    rng: &mut R,
    client_registration_state: &str,
    registration_response: &str,
    password: &str,
    idents: Idents<'_>,
    ksf: KsfParams,
) -> Result<ClientRegistrationFinish, Error> {
    generic::finish_client_registration::<Argon2Ksf, R>(
        rng,
        client_registration_state,
        registration_response,
        password,
        idents,
        Some(&ksf.ksf()?),
    )
}

/// Login step one (client).
pub fn start_client_login<R: RngCore + CryptoRng>(
    rng: &mut R,
    password: &str,
) -> Result<ClientStart, Error> {
    generic::start_client_login::<Argon2Ksf, R>(rng, password)
}

/// Login step three (client). `Ok(None)` is a refused login - a wrong
/// password, a record under another account, another server - told apart from
/// a malformed input, which is an error. Nothing is sent on `None`.
pub fn finish_client_login<R: RngCore + CryptoRng>(
    rng: &mut R,
    client_login_state: &str,
    login_response: &str,
    password: &str,
    idents: Idents<'_>,
    ksf: KsfParams,
) -> Result<Option<ClientLoginFinish>, Error> {
    generic::finish_client_login::<Argon2Ksf, R>(
        rng,
        client_login_state,
        login_response,
        password,
        idents,
        Some(&ksf.ksf()?),
        None,
    )
}

/// The same steps over any suite. Public so the RFC 9807 vectors (identity
/// KSF) replay through the exact code the production suite runs.
pub mod generic {
    use super::*;

    pub fn registration_response<K: Ksf>(
        setup: &ServerSetup<Suite<K>>,
        user_identifier: &str,
        registration_request: &str,
    ) -> Result<String, Error> {
        let request = RegistrationRequest::<Suite<K>>::deserialize(&decode(
            "registrationRequest",
            registration_request,
        )?)
        .map_err(|_| Error::Protocol("deserialize registrationRequest"))?;
        let started =
            ServerRegistration::<Suite<K>>::start(setup, request, user_identifier.as_bytes())
                .map_err(|_| Error::Protocol("start server registration"))?;
        Ok(encode(started.message.serialize()))
    }

    /// The record the server stores, checked to be a well-formed upload.
    pub fn parse_record<K: Ksf>(
        registration_record: &str,
    ) -> Result<ServerRegistration<Suite<K>>, Error> {
        ServerRegistration::<Suite<K>>::deserialize(&decode(
            "registrationRecord",
            registration_record,
        )?)
        .map_err(|_| Error::Protocol("deserialize registrationRecord"))
    }

    pub fn start_server_login<K: Ksf, R: RngCore + CryptoRng>(
        rng: &mut R,
        setup: &ServerSetup<Suite<K>>,
        registration_record: Option<&str>,
        start_login_request: &str,
        user_identifier: &str,
        idents: Idents<'_>,
        context: Option<&[u8]>,
    ) -> Result<ServerLoginStart, Error> {
        let record = registration_record.map(parse_record::<K>).transpose()?;
        let request = CredentialRequest::<Suite<K>>::deserialize(&decode(
            "startLoginRequest",
            start_login_request,
        )?)
        .map_err(|_| Error::Protocol("deserialize startLoginRequest"))?;
        let params = ServerLoginParameters {
            identifiers: idents.get(),
            context,
        };
        let started = ServerLogin::start(
            rng,
            setup,
            record,
            request,
            user_identifier.as_bytes(),
            params,
        )
        .map_err(|_| Error::Protocol("start server login"))?;
        Ok(ServerLoginStart {
            server_login_state: encode(started.state.serialize()),
            login_response: encode(started.message.serialize()),
        })
    }

    pub fn finish_server_login<K: Ksf>(
        server_login_state: &str,
        finish_login_request: &str,
        idents: Idents<'_>,
        context: Option<&[u8]>,
    ) -> Result<String, Error> {
        let finalization = CredentialFinalization::<Suite<K>>::deserialize(&decode(
            "finishLoginRequest",
            finish_login_request,
        )?)
        .map_err(|_| Error::Protocol("deserialize finishLoginRequest"))?;
        let state =
            ServerLogin::<Suite<K>>::deserialize(&decode("serverLoginState", server_login_state)?)
                .map_err(|_| Error::Protocol("deserialize serverLoginState"))?;
        let params = ServerLoginParameters {
            identifiers: idents.get(),
            context,
        };
        let finished = state
            .finish(finalization, params)
            .map_err(|_| Error::Protocol("finish server login"))?;
        Ok(encode(finished.session_key))
    }

    pub fn start_client_registration<K: Ksf, R: RngCore + CryptoRng>(
        rng: &mut R,
        password: &str,
    ) -> Result<ClientStart, Error> {
        let started = ClientRegistration::<Suite<K>>::start(rng, password.as_bytes())
            .map_err(|_| Error::Protocol("start client registration"))?;
        Ok(ClientStart {
            state: encode(started.state.serialize()),
            request: encode(started.message.serialize()),
        })
    }

    pub fn finish_client_registration<K: Ksf, R: RngCore + CryptoRng>(
        rng: &mut R,
        client_registration_state: &str,
        registration_response: &str,
        password: &str,
        idents: Idents<'_>,
        ksf: Option<&K>,
    ) -> Result<ClientRegistrationFinish, Error> {
        let response = RegistrationResponse::<Suite<K>>::deserialize(&decode(
            "registrationResponse",
            registration_response,
        )?)
        .map_err(|_| Error::Protocol("deserialize registrationResponse"))?;
        let state = ClientRegistration::<Suite<K>>::deserialize(&decode(
            "clientRegistrationState",
            client_registration_state,
        )?)
        .map_err(|_| Error::Protocol("deserialize clientRegistrationState"))?;
        let params = ClientRegistrationFinishParameters::new(idents.get(), ksf);
        let finished = state
            .finish(rng, password.as_bytes(), response, params)
            .map_err(|_| Error::Protocol("finish client registration"))?;
        Ok(ClientRegistrationFinish {
            registration_record: encode(finished.message.serialize()),
            export_key: encode(finished.export_key),
            server_static_public_key: encode(finished.server_s_pk.serialize()),
        })
    }

    pub fn start_client_login<K: Ksf, R: RngCore + CryptoRng>(
        rng: &mut R,
        password: &str,
    ) -> Result<ClientStart, Error> {
        let started = ClientLogin::<Suite<K>>::start(rng, password.as_bytes())
            .map_err(|_| Error::Protocol("start client login"))?;
        Ok(ClientStart {
            state: encode(started.state.serialize()),
            request: encode(started.message.serialize()),
        })
    }

    pub fn finish_client_login<K: Ksf, R: RngCore + CryptoRng>(
        rng: &mut R,
        client_login_state: &str,
        login_response: &str,
        password: &str,
        idents: Idents<'_>,
        ksf: Option<&K>,
        context: Option<&[u8]>,
    ) -> Result<Option<ClientLoginFinish>, Error> {
        let response =
            CredentialResponse::<Suite<K>>::deserialize(&decode("loginResponse", login_response)?)
                .map_err(|_| Error::Protocol("deserialize loginResponse"))?;
        let state =
            ClientLogin::<Suite<K>>::deserialize(&decode("clientLoginState", client_login_state)?)
                .map_err(|_| Error::Protocol("deserialize clientLoginState"))?;
        let params = ClientLoginFinishParameters::new(context, idents.get(), ksf);
        // Any failure past decoding is the server failing to prove it holds
        // this password's record: one answer, no detail.
        let Ok(finished) = state.finish(rng, password.as_bytes(), response, params) else {
            return Ok(None);
        };
        Ok(Some(ClientLoginFinish {
            finish_login_request: encode(finished.message.serialize()),
            session_key: encode(finished.session_key),
            export_key: encode(finished.export_key),
            server_static_public_key: encode(finished.server_s_pk.serialize()),
        }))
    }
}

/// The steps as the bindings call them: randomness arrives as a 32-byte seed
/// drawn by the caller from the platform's CSPRNG, expanded with ChaCha20. A
/// seed must never be reused; the facade draws a fresh one per call.
pub mod seeded {
    use super::*;
    use rand_chacha::rand_core::SeedableRng;
    use rand_chacha::ChaCha20Rng;

    fn rng(seed: &[u8]) -> Result<ChaCha20Rng, Error> {
        let seed: [u8; 32] = seed.try_into().map_err(|_| Error::Protocol("seed"))?;
        Ok(ChaCha20Rng::from_seed(seed))
    }

    fn ksf(memory: u32, iterations: u32, parallelism: u32) -> KsfParams {
        KsfParams {
            memory,
            iterations,
            parallelism,
        }
    }

    pub fn create_server_setup(seed: &[u8]) -> Result<String, Error> {
        Ok(super::create_server_setup(&mut rng(seed)?))
    }

    pub fn start_server_login(
        seed: &[u8],
        server_setup: &str,
        registration_record: Option<&str>,
        start_login_request: &str,
        user_identifier: &str,
        idents: Idents<'_>,
    ) -> Result<ServerLoginStart, Error> {
        super::start_server_login(
            &mut rng(seed)?,
            server_setup,
            registration_record,
            start_login_request,
            user_identifier,
            idents,
        )
    }

    pub fn start_client_registration(seed: &[u8], password: &str) -> Result<ClientStart, Error> {
        super::start_client_registration(&mut rng(seed)?, password)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_client_registration(
        seed: &[u8],
        client_registration_state: &str,
        registration_response: &str,
        password: &str,
        idents: Idents<'_>,
        memory: u32,
        iterations: u32,
        parallelism: u32,
    ) -> Result<ClientRegistrationFinish, Error> {
        super::finish_client_registration(
            &mut rng(seed)?,
            client_registration_state,
            registration_response,
            password,
            idents,
            ksf(memory, iterations, parallelism),
        )
    }

    pub fn start_client_login(seed: &[u8], password: &str) -> Result<ClientStart, Error> {
        super::start_client_login(&mut rng(seed)?, password)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_client_login(
        seed: &[u8],
        client_login_state: &str,
        login_response: &str,
        password: &str,
        idents: Idents<'_>,
        memory: u32,
        iterations: u32,
        parallelism: u32,
    ) -> Result<Option<ClientLoginFinish>, Error> {
        super::finish_client_login(
            &mut rng(seed)?,
            client_login_state,
            login_response,
            password,
            idents,
            ksf(memory, iterations, parallelism),
        )
    }
}

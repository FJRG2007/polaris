//! One device's MLS identity and every group operation it performs.

use super::journal::Journal;
use super::provider::Provider;
use super::{ErrorKind, MlsError, Result, MAX_PAST_EPOCHS, SUPPORTED_CIPHERSUITES};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_memory_storage::MemoryStorage;
use openmls_traits::storage::{StorageProvider, CURRENT_VERSION};
use openmls_traits::types::SignatureScheme;
use openmls_traits::OpenMlsProvider;

fn rejected(error: impl std::fmt::Display) -> MlsError {
    MlsError::new(ErrorKind::Rejected, error)
}

fn malformed(error: impl std::fmt::Display) -> MlsError {
    MlsError::new(ErrorKind::Malformed, error)
}

fn internal(error: impl std::fmt::Display) -> MlsError {
    MlsError::new(ErrorKind::Internal, error)
}

fn storage_error(error: impl std::fmt::Display) -> MlsError {
    MlsError::new(ErrorKind::Storage, error)
}

fn encode(message: &MlsMessageOut) -> Result<Vec<u8>> {
    message.tls_serialize_detached().map_err(internal)
}

/// An `MLSMessage` from untrusted bytes: exactly one, nothing trailing.
fn decode(bytes: &[u8]) -> Result<MlsMessageBodyIn> {
    MlsMessageIn::tls_deserialize_exact(bytes)
        .map(MlsMessageIn::extract)
        .map_err(malformed)
}

fn wrong_type(expected: &str) -> MlsError {
    MlsError::new(
        ErrorKind::WrongMessageType,
        format!("expected an MLSMessage carrying a {expected}"),
    )
}

/// What a commit produced: the commit for the group, a Welcome for anyone it
/// added, and the new epoch's GroupInfo (with the ratchet tree) for external
/// joins. The commit is pending until [`Member::merge_pending_commit`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOutput {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
    pub group_info: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessedKind {
    Application,
    Proposal,
    Commit,
}

impl ProcessedKind {
    /// The name the bindings hand to JavaScript.
    pub fn as_str(self) -> &'static str {
        match self {
            ProcessedKind::Application => "application",
            ProcessedKind::Proposal => "proposal",
            ProcessedKind::Commit => "commit",
        }
    }
}

/// The outcome of [`Member::process`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Processed {
    pub kind: ProcessedKind,
    /// The sender's leaf, for a member sender; `None` for an external joiner.
    pub sender_leaf: Option<u32>,
    /// The identity in the sender's credential. OpenMLS has verified the
    /// signature against the credential's key; whether that key belongs to
    /// that identity is the authentication service's call (RFC 9420, 5.3.1).
    pub sender_identity: Vec<u8>,
    /// The application message; empty for proposals and commits.
    pub plaintext: Vec<u8>,
    /// The group's epoch after processing.
    pub epoch: u64,
    /// False once a commit removed this member.
    pub active: bool,
}

/// One leaf of a group's tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMember {
    pub leaf: u32,
    pub identity: Vec<u8>,
    pub signature_key: Vec<u8>,
}

/// One device: its signature key, its basic credential, and the groups in its
/// storage.
pub struct Member<S: StorageProvider<CURRENT_VERSION> = MemoryStorage> {
    provider: Provider<S>,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    ciphersuite: Ciphersuite,
}

fn ciphersuite(value: u16) -> Result<Ciphersuite> {
    let unsupported = || {
        MlsError::new(
            ErrorKind::UnsupportedCiphersuite,
            format!("cipher suite 0x{value:04x} is not one Polaris accepts"),
        )
    };
    if !SUPPORTED_CIPHERSUITES.contains(&value) {
        return Err(unsupported());
    }
    Ciphersuite::try_from(value).map_err(|_| unsupported())
}

impl Member<MemoryStorage> {
    /// A new device with in-memory storage.
    pub fn new(identity: &[u8], ciphersuite: u16, seed: [u8; 32]) -> Result<Self> {
        Self::with_storage(identity, ciphersuite, seed, MemoryStorage::default())
    }

    /// [`Member::new`] from the loosely typed values a binding receives: a
    /// suite outside `u16` or a seed that is not 32 bytes is refused here.
    pub fn from_binding(identity: &[u8], ciphersuite: u32, seed: &[u8]) -> Result<Self> {
        let (suite, seed) = binding_args(ciphersuite, seed)?;
        Self::new(identity, suite, seed)
    }

    /// [`Member::open`] over what a host's store holds for this device
    /// (`keys[i]` holds `values[i]`), with the [`Journal`] that knows the store
    /// holds exactly that. `seed` must be fresh on every boot: a seed used
    /// before would replay the randomness drawn after it.
    pub fn restore_from_binding(
        identity: &[u8],
        ciphersuite: u32,
        seed: &[u8],
        keys: Vec<Vec<u8>>,
        values: Vec<Vec<u8>>,
        signature_public_key: &[u8],
    ) -> Result<(Self, Journal)> {
        let (suite, seed) = binding_args(ciphersuite, seed)?;
        if keys.len() != values.len() {
            return Err(MlsError::new(
                ErrorKind::Malformed,
                format!(
                    "the store gave {} keys and {} values",
                    keys.len(),
                    values.len()
                ),
            ));
        }
        let (storage, journal) = Journal::restore(keys.into_iter().zip(values));
        Self::open(identity, suite, seed, storage, signature_public_key)
            .map(|member| (member, journal))
    }
}

fn binding_args(ciphersuite: u32, seed: &[u8]) -> Result<(u16, [u8; 32])> {
    let suite = u16::try_from(ciphersuite).map_err(|_| {
        MlsError::new(
            ErrorKind::UnsupportedCiphersuite,
            format!("cipher suite {ciphersuite} is not one Polaris accepts"),
        )
    })?;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| MlsError::new(ErrorKind::Malformed, "the seed must be exactly 32 bytes"))?;
    Ok((suite, seed))
}

impl<S: StorageProvider<CURRENT_VERSION>> Member<S> {
    /// A new device: an Ed25519 key from the seeded generator, stored in
    /// `storage` so [`Member::open`] can bring the device back.
    pub fn with_storage(
        identity: &[u8],
        ciphersuite: u16,
        seed: [u8; 32],
        storage: S,
    ) -> Result<Self> {
        let suite = self::ciphersuite(ciphersuite)?;
        let provider = Provider::new(seed, storage);
        let mut secret = [0u8; 32];
        provider.rand().fill(&mut secret).map_err(internal)?;
        let signing = ed25519_dalek::SigningKey::from_bytes(&secret);
        secret.fill(0);
        let signer = SignatureKeyPair::from_raw(
            SignatureScheme::ED25519,
            signing.to_bytes().to_vec(),
            signing.verifying_key().to_bytes().to_vec(),
        );
        signer.store(provider.storage()).map_err(storage_error)?;
        Ok(Self::assemble(identity, suite, provider, signer))
    }

    /// A device whose signature key and groups are already in `storage`.
    pub fn open(
        identity: &[u8],
        ciphersuite: u16,
        seed: [u8; 32],
        storage: S,
        signature_public_key: &[u8],
    ) -> Result<Self> {
        let suite = self::ciphersuite(ciphersuite)?;
        let provider = Provider::new(seed, storage);
        let signer = SignatureKeyPair::read(
            provider.storage(),
            signature_public_key,
            SignatureScheme::ED25519,
        )
        .ok_or_else(|| {
            MlsError::new(
                ErrorKind::Storage,
                "no signature key with that public key in storage",
            )
        })?;
        Ok(Self::assemble(identity, suite, provider, signer))
    }

    fn assemble(
        identity: &[u8],
        ciphersuite: Ciphersuite,
        provider: Provider<S>,
        signer: SignatureKeyPair,
    ) -> Self {
        let credential = CredentialWithKey {
            credential: BasicCredential::new(identity.to_vec()).into(),
            signature_key: signer.public().into(),
        };
        Self {
            provider,
            signer,
            credential,
            ciphersuite,
        }
    }

    pub fn storage(&self) -> &S {
        self.provider.storage()
    }

    pub fn signature_public_key(&self) -> &[u8] {
        self.signer.public()
    }

    pub fn ciphersuite(&self) -> u16 {
        self.ciphersuite.into()
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities::new(
            None,
            Some(&[self.ciphersuite]),
            None,
            None,
            Some(&[CredentialType::Basic]),
        )
    }

    fn wire_format_policy() -> WireFormatPolicy {
        // Everything this member sends is a PrivateMessage, so the delivery
        // service sees no handshake content. Incoming must also take
        // PublicMessage: an external commit is always one (RFC 9420, 12.4.3.2).
        MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY
    }

    fn join_config() -> MlsGroupJoinConfig {
        MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .wire_format_policy(Self::wire_format_policy())
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build()
    }

    fn load(&self, group_id: &[u8]) -> Result<MlsGroup> {
        MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(storage_error)?
            .ok_or_else(|| MlsError::new(ErrorKind::UnknownGroup, "no group with that id"))
    }

    fn refuse_existing(&self, group_id: &GroupId) -> Result<()> {
        let existing = MlsGroup::load(self.provider.storage(), group_id).map_err(storage_error)?;
        match existing {
            Some(_) => Err(rejected(
                "a group with that id already exists in this storage",
            )),
            None => Ok(()),
        }
    }

    /// A fresh, single-use KeyPackage as an `MLSMessage`. Its private keys
    /// stay in storage until a Welcome consumes them, once.
    pub fn key_package(&self) -> Result<Vec<u8>> {
        let bundle = KeyPackage::builder()
            .leaf_node_capabilities(self.capabilities())
            .build(
                self.ciphersuite,
                &self.provider,
                &self.signer,
                self.credential.clone(),
            )
            .map_err(internal)?;
        encode(&MlsMessageOut::from(bundle.key_package().clone()))
    }

    /// A new group with this member alone in it, at epoch 0.
    pub fn create_group(&self, group_id: &[u8]) -> Result<()> {
        let id = GroupId::from_slice(group_id);
        self.refuse_existing(&id)?;
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(self.ciphersuite)
            .use_ratchet_tree_extension(true)
            .wire_format_policy(Self::wire_format_policy())
            .max_past_epochs(MAX_PAST_EPOCHS)
            .capabilities(self.capabilities())
            .build();
        MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            id,
            self.credential.clone(),
        )
        .map_err(rejected)?;
        Ok(())
    }

    fn parse_key_package(&self, bytes: &[u8]) -> Result<KeyPackage> {
        let MlsMessageBodyIn::KeyPackage(key_package) = decode(bytes)? else {
            return Err(wrong_type("KeyPackage"));
        };
        let key_package = key_package
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(rejected)?;
        if key_package.ciphersuite() != self.ciphersuite {
            return Err(rejected("the key package is for another cipher suite"));
        }
        Ok(key_package)
    }

    /// Commit adding the members whose KeyPackages are given.
    pub fn add_members(&self, group_id: &[u8], key_packages: &[Vec<u8>]) -> Result<CommitOutput> {
        let parsed = key_packages
            .iter()
            .map(|bytes| self.parse_key_package(bytes))
            .collect::<Result<Vec<_>>>()?;
        let mut group = self.load(group_id)?;
        let (commit, welcome, group_info) = group
            .add_members(&self.provider, &self.signer, &parsed)
            .map_err(rejected)?;
        Ok(CommitOutput {
            commit: encode(&commit)?,
            welcome: Some(encode(&welcome)?),
            group_info: group_info
                .map(|info| encode(&MlsMessageOut::from(info)))
                .transpose()?,
        })
    }

    /// Commit removing the members at these leaves.
    pub fn remove_members(&self, group_id: &[u8], leaves: &[u32]) -> Result<CommitOutput> {
        let mut group = self.load(group_id)?;
        let leaves: Vec<LeafNodeIndex> = leaves
            .iter()
            .map(|&leaf| LeafNodeIndex::new(leaf))
            .collect();
        let (commit, welcome, group_info) = group
            .remove_members(&self.provider, &self.signer, &leaves)
            .map_err(rejected)?;
        Ok(CommitOutput {
            commit: encode(&commit)?,
            welcome: welcome.as_ref().map(encode).transpose()?,
            group_info: group_info
                .map(|info| encode(&MlsMessageOut::from(info)))
                .transpose()?,
        })
    }

    /// Commit a fresh leaf key and path: post-compromise security for this
    /// member (RFC 9420, 16.6).
    pub fn self_update(&self, group_id: &[u8]) -> Result<CommitOutput> {
        let mut group = self.load(group_id)?;
        let bundle = group
            .self_update(&self.provider, &self.signer, LeafNodeParameters::default())
            .map_err(rejected)?;
        let (commit, welcome, group_info) = bundle.into_contents();
        Ok(CommitOutput {
            commit: encode(&commit)?,
            welcome: welcome
                .map(|welcome| {
                    encode(&MlsMessageOut::from_welcome(
                        welcome,
                        ProtocolVersion::Mls10,
                    ))
                })
                .transpose()?,
            group_info: group_info
                .map(|info| encode(&MlsMessageOut::from(info)))
                .transpose()?,
        })
    }

    /// Apply this member's pending commit, once the delivery service accepted it.
    pub fn merge_pending_commit(&self, group_id: &[u8]) -> Result<()> {
        let mut group = self.load(group_id)?;
        if group.pending_commit().is_none() {
            return Err(rejected("there is no pending commit"));
        }
        group.merge_pending_commit(&self.provider).map_err(rejected)
    }

    /// Drop this member's pending commit, when the delivery service refused it.
    pub fn clear_pending_commit(&self, group_id: &[u8]) -> Result<()> {
        let mut group = self.load(group_id)?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(storage_error)
    }

    /// Join the group a Welcome invites this member to; returns the group id.
    pub fn join_by_welcome(&self, welcome: &[u8]) -> Result<Vec<u8>> {
        let MlsMessageBodyIn::Welcome(welcome) = decode(welcome)? else {
            return Err(wrong_type("Welcome"));
        };
        let staged =
            StagedWelcome::build_from_welcome(&self.provider, &Self::join_config(), welcome)
                .map_err(rejected)?
                .build()
                .map_err(rejected)?;
        let id = staged.group_context().group_id().clone();
        self.refuse_existing(&id)?;
        if staged.group_context().ciphersuite() != self.ciphersuite {
            return Err(rejected("the group uses another cipher suite"));
        }
        staged.into_group(&self.provider).map_err(rejected)?;
        Ok(id.to_vec())
    }

    /// This epoch's signed GroupInfo with the ratchet tree, for external joins.
    pub fn group_info(&self, group_id: &[u8]) -> Result<Vec<u8>> {
        let group = self.load(group_id)?;
        let info = group
            .export_group_info(self.provider.crypto(), &self.signer, true)
            .map_err(rejected)?;
        encode(&info)
    }

    /// Join through an external commit from a GroupInfo (RFC 9420, 12.4.3.2).
    /// Returns the group id and the commit. OpenMLS 0.9.2 applies an external
    /// commit as soon as it is built (`finalize`), so the joiner is in the new
    /// epoch at once; if the delivery service refuses the commit, the joiner
    /// discards the group and joins again from a fresh GroupInfo.
    pub fn join_by_external_commit(&self, group_info: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        let MlsMessageBodyIn::GroupInfo(info) = decode(group_info)? else {
            return Err(wrong_type("GroupInfo"));
        };
        if info.ciphersuite() != self.ciphersuite {
            return Err(rejected("the group uses another cipher suite"));
        }
        self.refuse_existing(&info.group_id().clone())?;
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(Self::join_config())
            .build_group(&self.provider, info, self.credential.clone())
            .map_err(rejected)?
            .leaf_node_parameters(
                LeafNodeParameters::builder()
                    .with_capabilities(self.capabilities())
                    .build(),
            )
            .load_psks(self.provider.storage())
            .map_err(rejected)?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .map_err(rejected)?
            .finalize(&self.provider)
            .map_err(rejected)?;
        let (commit, _, _) = bundle.into_contents();
        Ok((group.group_id().to_vec(), encode(&commit)?))
    }

    /// An application message for the group, as a PrivateMessage.
    pub fn encrypt(&self, group_id: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
        let mut group = self.load(group_id)?;
        let message = group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(rejected)?;
        encode(&message)
    }

    /// Process a message from the delivery service: decrypt an application
    /// message, queue a proposal, or verify and apply a commit.
    pub fn process(&self, group_id: &[u8], message: &[u8]) -> Result<Processed> {
        let (MlsMessageBodyIn::PrivateMessage(_) | MlsMessageBodyIn::PublicMessage(_)) =
            decode(message)?
        else {
            return Err(wrong_type("PublicMessage or PrivateMessage"));
        };
        let protocol = MlsMessageIn::tls_deserialize_exact(message)
            .map_err(malformed)?
            .try_into_protocol_message()
            .map_err(rejected)?;
        if protocol.group_id().as_slice() != group_id {
            return Err(rejected("the message belongs to another group"));
        }
        let mut group = self.load(group_id)?;
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(rejected)?;
        let sender_leaf = match processed.sender() {
            Sender::Member(leaf) => Some(leaf.u32()),
            _ => None,
        };
        let sender_identity = BasicCredential::try_from(processed.credential().clone())
            .map(|credential| credential.identity().to_vec())
            .map_err(rejected)?;
        let (kind, plaintext) = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => {
                (ProcessedKind::Application, message.into_bytes())
            }
            ProcessedMessageContent::ProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.storage(), *proposal)
                    .map_err(storage_error)?;
                (ProcessedKind::Proposal, Vec::new())
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                group
                    .store_pending_proposal(self.provider.storage(), *proposal)
                    .map_err(storage_error)?;
                (ProcessedKind::Proposal, Vec::new())
            }
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                group
                    .merge_staged_commit(&self.provider, *commit)
                    .map_err(rejected)?;
                (ProcessedKind::Commit, Vec::new())
            }
            // The delivery service echoed this member's own pending commit:
            // accepting it is the same as merge_pending_commit.
            ProcessedMessageContent::OwnPendingCommit => {
                group
                    .merge_pending_commit(&self.provider)
                    .map_err(rejected)?;
                (ProcessedKind::Commit, Vec::new())
            }
            // An author cannot open its own PrivateMessage (RFC 9420, 6.3.2:
            // its key was deleted when it was sent); the sender keeps its
            // plaintext, so the echo is refused rather than reported empty.
            ProcessedMessageContent::OwnPrivateMessage => {
                return Err(rejected("this member sent that message; its key is gone"));
            }
        };
        Ok(Processed {
            kind,
            sender_leaf,
            sender_identity,
            plaintext,
            epoch: group.epoch().as_u64(),
            active: group.is_active(),
        })
    }

    pub fn epoch(&self, group_id: &[u8]) -> Result<u64> {
        Ok(self.load(group_id)?.epoch().as_u64())
    }

    /// The epoch authenticator (RFC 9420, 8.7): equal on every member in the
    /// same epoch, which is how two members confirm they agree on the group.
    pub fn epoch_authenticator(&self, group_id: &[u8]) -> Result<Vec<u8>> {
        Ok(self
            .load(group_id)?
            .epoch_authenticator()
            .as_slice()
            .to_vec())
    }

    /// An exporter secret (RFC 9420, 8.5) for this epoch.
    pub fn export_secret(
        &self,
        group_id: &[u8],
        label: &str,
        context: &[u8],
        length: usize,
    ) -> Result<Vec<u8>> {
        self.load(group_id)?
            .export_secret(self.provider.crypto(), label, context, length)
            .map_err(rejected)
    }

    pub fn own_leaf(&self, group_id: &[u8]) -> Result<u32> {
        Ok(self.load(group_id)?.own_leaf_index().u32())
    }

    /// Every member of the group, by leaf.
    pub fn members(&self, group_id: &[u8]) -> Result<Vec<GroupMember>> {
        self.load(group_id)?
            .members()
            .map(|member| {
                let identity = BasicCredential::try_from(member.credential)
                    .map(|credential| credential.identity().to_vec())
                    .map_err(rejected)?;
                Ok(GroupMember {
                    leaf: member.index.u32(),
                    identity,
                    signature_key: member.signature_key,
                })
            })
            .collect()
    }
}

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

/// What `Member::sign_content` signs in front of the payload.
pub const CONTENT_SIGNATURE_LABEL: &[u8] = b"polaris/chat-e2ee/content-signature/v1\0";

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

/// The largest ratchet tree (TLS-encoded, before the commit) a Welcome and a
/// GroupInfo still carry in their `ratchet_tree` extension. Past it both leave
/// the tree out (RFC 9420, 12.4.3.3) and the commit hands it back on its own
/// ([`CommitOutput::ratchet_tree`]) for the delivery service to keep, so a
/// Welcome into a large group does not repeat the whole tree for every
/// device it invites. Small groups keep the tree inline, which is what every
/// device that predates this expects.
pub const INLINE_TREE_BYTES: usize = 64 * 1024;

/// The largest commit the delivery service takes, as decoded bytes
/// (`mlsBytes` in `apps/web/src/lib/chat/e2ee/schemas.ts`). A commit past it
/// is refused here, before anything is staged ([`ErrorKind::CommitTooLarge`]),
/// rather than built, sent and refused by the route.
pub const MAX_COMMIT_BYTES: usize = 1024 * 1024;

/// RFC 9420 appendix C tree math over node indices (leaves even, parents odd).
mod treemath {
    pub fn level(x: u64) -> u32 {
        (!x).trailing_zeros()
    }

    fn parent_step(x: u64) -> u64 {
        let k = level(x);
        let b = (x >> (k + 1)) & 1;
        (x | (1 << k)) ^ (b << (k + 1))
    }

    /// The parent of `x` in a tree of `nodes` nodes.
    pub fn parent(x: u64, nodes: u64) -> u64 {
        let mut p = parent_step(x);
        while p >= nodes {
            p = parent_step(p);
        }
        p
    }

    /// The child of `parent` that is not `child`.
    pub fn sibling(child: u64, parent: u64, nodes: u64) -> u64 {
        let k = level(parent);
        let left = |x: u64, k: u32| x ^ (1 << (k - 1));
        if child < parent {
            let mut right = parent ^ (3 << (k - 1));
            let mut depth = k - 1;
            while right >= nodes && depth > 0 {
                right = left(right, depth);
                depth -= 1;
            }
            right
        } else {
            left(parent, k)
        }
    }

    /// The root of a tree of `nodes` nodes.
    pub fn root(nodes: u64) -> u64 {
        (1u64 << (63 - nodes.leading_zeros())) - 1
    }

    /// The first and last leaf index under node `x`.
    pub fn leaf_span(x: u64) -> (u64, u64) {
        let k = level(x);
        ((x + 1 - (1 << k)) / 2, (x + (1 << k) - 1) / 2)
    }
}

fn parse_tree(bytes: &[u8]) -> Result<RatchetTreeIn> {
    RatchetTreeIn::tls_deserialize_exact(bytes).map_err(malformed)
}

/// What a commit produced: the commit for the group, a Welcome for anyone it
/// added, and the new epoch's GroupInfo for external joins. The commit is
/// pending until [`Member::merge_pending_commit`].
///
/// While the tree is small the Welcome and GroupInfo carry it and
/// `ratchet_tree` is `None`. Past [`INLINE_TREE_BYTES`] they leave it out and
/// `ratchet_tree` is the new epoch's tree, which a joiner needs beside either
/// of them; OpenMLS checks it against the tree hash the signed GroupInfo
/// commits to, so whoever stores it cannot swap it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOutput {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
    pub group_info: Option<Vec<u8>>,
    pub ratchet_tree: Option<Vec<u8>>,
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
    /// False once a commit removed this member (its own leave included). The
    /// group's state is then deleted from storage: later calls for that group
    /// answer `UnknownGroup`.
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
    /// [`MAX_COMMIT_BYTES`] unless a test sets a smaller one.
    commit_limit: std::sync::atomic::AtomicUsize,
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
            commit_limit: std::sync::atomic::AtomicUsize::new(MAX_COMMIT_BYTES),
        }
    }

    /// The largest commit this member builds ([`MAX_COMMIT_BYTES`] by default).
    pub fn commit_limit(&self) -> usize {
        self.commit_limit.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Build commits against another limit: tests use a small one to reach
    /// the refusal without a group of a thousand members.
    pub fn set_commit_limit(&self, bytes: usize) {
        self.commit_limit
            .store(bytes, std::sync::atomic::Ordering::Relaxed);
    }

    /// Refuse a staged commit past [`Member::commit_limit`], unstaging it.
    fn within_limit(&self, group: &mut MlsGroup, out: CommitOutput) -> Result<CommitOutput> {
        let limit = self.commit_limit();
        if out.commit.len() <= limit {
            return Ok(out);
        }
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(storage_error)?;
        Err(MlsError::new(
            ErrorKind::CommitTooLarge,
            format!(
                "the commit is {} bytes, past the {limit} the delivery service takes",
                out.commit.len()
            ),
        ))
    }

    /// How many nodes of this member's filtered direct path (RFC 9420, 4.1.2:
    /// the ancestors whose other side holds somebody) are blank. A member
    /// added by somebody else's commit has the ancestors it does not share
    /// with the adder blank, and every commit in the group then encrypts
    /// through each leaf under a blank node (RFC 9420, 4.2); one commit of
    /// its own with a path (`self_update`) fills them. Zero once filled, and
    /// for the member whose commits built the group. Ancestors that hold this
    /// member as an unmerged leaf (RFC 9420, 12.1.1) are not counted: OpenMLS
    /// does not expose them, and each costs a commit one ciphertext, where a
    /// blank costs one per leaf under it.
    pub fn blank_path(&self, group_id: &[u8]) -> Result<u32> {
        let group = self.load(group_id)?;
        let tree = group.treesync();
        let slots = tree.leaves();
        let width = slots.len() as u64;
        if width < 2 {
            return Ok(0);
        }
        // full[i]: occupied leaves before leaf i, so a span's count is a subtraction.
        let mut full = Vec::with_capacity(slots.len() + 1);
        full.push(0u32);
        for slot in &slots {
            full.push(full[full.len() - 1] + u32::from(slot.is_some()));
        }
        let occupied = |node: u64| {
            let (first, last) = treemath::leaf_span(node);
            let last = last.min(width - 1);
            first <= last && full[last as usize + 1] > full[first as usize]
        };
        let blank: std::collections::HashSet<u32> =
            tree.blank_parents().map(|index| index.u32()).collect();
        let nodes = 2 * width - 1;
        let root = treemath::root(nodes);
        let mut child = 2 * u64::from(group.own_leaf_index().u32());
        let mut count = 0;
        while child != root {
            let parent = treemath::parent(child, nodes);
            let other = treemath::sibling(child, parent, nodes);
            if occupied(other) && blank.contains(&(((parent - 1) / 2) as u32)) {
                count += 1;
            }
            child = parent;
        }
        Ok(count)
    }

    pub fn storage(&self) -> &S {
        self.provider.storage()
    }

    pub fn signature_public_key(&self) -> &[u8] {
        self.signer.public()
    }

    /// An Ed25519 signature with this device's MLS signature key over
    /// `CONTENT_SIGNATURE_LABEL || payload`, for content stored outside MLS
    /// (a chat message sealed under a history key). The label keeps it apart
    /// from every MLS signature, which signs a length-prefixed "MLS 1.0 "
    /// label first, so no payload makes this an MLS signature oracle.
    pub fn sign_content(&self, payload: &[u8]) -> Result<Vec<u8>> {
        use openmls_traits::signatures::Signer as _;
        let mut data = Vec::with_capacity(CONTENT_SIGNATURE_LABEL.len() + payload.len());
        data.extend_from_slice(CONTENT_SIGNATURE_LABEL);
        data.extend_from_slice(payload);
        self.signer
            .sign(&data)
            .map_err(|error| internal(format!("{error:?}")))
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

    /// Whether this group's tree still travels inside Welcomes and GroupInfos.
    fn tree_inline(group: &MlsGroup) -> bool {
        use openmls::prelude::tls_codec::Size as _;
        group.export_ratchet_tree().tls_serialized_len() <= INLINE_TREE_BYTES
    }

    /// The wire form of a staged commit; with the new epoch's tree beside it
    /// when the tree was left out of the Welcome and GroupInfo.
    fn commit_output(
        &self,
        group: &MlsGroup,
        bundle: openmls::group::CommitMessageBundle,
        inline: bool,
    ) -> Result<CommitOutput> {
        let (commit, welcome, group_info) = bundle.into_contents();
        let ratchet_tree = if inline {
            None
        } else {
            let staged = group
                .pending_commit()
                .ok_or_else(|| internal("the commit was not staged"))?;
            let tree = staged
                .export_ratchet_tree(self.provider.crypto(), group.export_ratchet_tree())
                .map_err(internal)?
                .ok_or_else(|| internal("the staged commit carries no tree"))?;
            Some(tree.tls_serialize_detached().map_err(internal)?)
        };
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
            ratchet_tree,
        })
    }

    /// Commit adding the members whose KeyPackages are given. As
    /// `MlsGroup::add_members` does, the commit carries a path - unless that
    /// path is what takes it past [`Member::commit_limit`] (a sparse tree
    /// costs one ciphertext per leaf under a blank node): an Add does not
    /// require a path (RFC 9420, 12.4), so it is built again without one, and
    /// refused with `CommitTooLarge` only if it is still too large.
    pub fn add_members(&self, group_id: &[u8], key_packages: &[Vec<u8>]) -> Result<CommitOutput> {
        if key_packages.is_empty() {
            return Err(rejected("no key packages to add"));
        }
        let parsed = key_packages
            .iter()
            .map(|bytes| self.parse_key_package(bytes))
            .collect::<Result<Vec<_>>>()?;
        let mut group = self.load(group_id)?;
        let inline = Self::tree_inline(&group);
        let out = self.stage_adds(&mut group, parsed.clone(), inline, true)?;
        let out = if out.commit.len() <= self.commit_limit() {
            out
        } else {
            group
                .clear_pending_commit(self.provider.storage())
                .map_err(storage_error)?;
            let out = self.stage_adds(&mut group, parsed, inline, false)?;
            self.within_limit(&mut group, out)?
        };
        if out.welcome.is_none() {
            return Err(internal("an add commit came back without its Welcome"));
        }
        Ok(out)
    }

    /// Stage a commit of these adds, with this member's path or without.
    fn stage_adds(
        &self,
        group: &mut MlsGroup,
        parsed: Vec<KeyPackage>,
        inline: bool,
        path: bool,
    ) -> Result<CommitOutput> {
        let bundle = group
            .commit_builder()
            .propose_adds(parsed)
            .force_self_update(path)
            .load_psks(self.provider.storage())
            .map_err(rejected)?
            .use_ratchet_tree_extension(inline)
            .create_group_info(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .map_err(rejected)?
            .stage_commit(&self.provider)
            .map_err(rejected)?;
        self.commit_output(group, bundle, inline)
    }

    /// Commit removing the members at these leaves. Refused with
    /// `CommitTooLarge` past [`Member::commit_limit`]: a removal requires a
    /// path, so the caller removes fewer at once.
    pub fn remove_members(&self, group_id: &[u8], leaves: &[u32]) -> Result<CommitOutput> {
        if leaves.is_empty() {
            return Err(rejected("no members to remove"));
        }
        let mut group = self.load(group_id)?;
        let leaves: Vec<LeafNodeIndex> = leaves
            .iter()
            .map(|&leaf| LeafNodeIndex::new(leaf))
            .collect();
        let inline = Self::tree_inline(&group);
        let bundle = group
            .commit_builder()
            .propose_removals(leaves)
            .load_psks(self.provider.storage())
            .map_err(rejected)?
            .use_ratchet_tree_extension(inline)
            .create_group_info(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .map_err(rejected)?
            .stage_commit(&self.provider)
            .map_err(rejected)?;
        let out = self.commit_output(&group, bundle, inline)?;
        self.within_limit(&mut group, out)
    }

    /// Commit a fresh leaf key and path: post-compromise security for this
    /// member (RFC 9420, 16.6), and the commit that fills a joiner's blank
    /// ancestors ([`Member::blank_path`]). Refused with `CommitTooLarge` past
    /// [`Member::commit_limit`], which in a sparse tree shrinks as other
    /// members fill theirs.
    pub fn self_update(&self, group_id: &[u8]) -> Result<CommitOutput> {
        let mut group = self.load(group_id)?;
        let inline = Self::tree_inline(&group);
        let bundle = group
            .commit_builder()
            .leaf_node_parameters(LeafNodeParameters::default())
            .consume_proposal_store(true)
            .load_psks(self.provider.storage())
            .map_err(rejected)?
            .use_ratchet_tree_extension(inline)
            .create_group_info(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .map_err(rejected)?
            .stage_commit(&self.provider)
            .map_err(rejected)?;
        let out = self.commit_output(&group, bundle, inline)?;
        self.within_limit(&mut group, out)
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

    /// Drop every trace of a group from this member's storage - its tree,
    /// epoch secrets, pending commit and this epoch's leaf keys - so the
    /// member can join it again (a Welcome or an external commit refuses a
    /// group it already holds). For a device whose copy of the group forked
    /// or fell too far behind, and for an external join the delivery service
    /// refused. Unknown groups are refused with `UnknownGroup`.
    pub fn forget_group(&self, group_id: &[u8]) -> Result<()> {
        let mut group = self.load(group_id)?;
        let (epoch, own_leaf) = (group.epoch(), group.own_leaf_index().u32());
        group
            .delete(self.provider.storage())
            .map_err(storage_error)?;
        self.provider
            .storage()
            .delete_encryption_epoch_key_pairs(group.group_id(), &epoch, own_leaf)
            .map_err(storage_error)
    }

    /// Join the group a Welcome invites this member to; returns the group id.
    pub fn join_by_welcome(&self, welcome: &[u8]) -> Result<Vec<u8>> {
        self.join_by_welcome_with_tree(welcome, None)
    }

    /// [`Member::join_by_welcome`] for a Welcome that may have left the
    /// ratchet tree out: `ratchet_tree` is that epoch's tree as the delivery
    /// service keeps it. OpenMLS builds the tree, checks its hash against the
    /// GroupInfo the Welcome encrypts and refuses a mismatch, so a tree from
    /// an untrusted store cannot put this member in a different group. A
    /// Welcome without the tree, joined with none, is refused with
    /// `MissingTree`: fetch the tree and call again.
    pub fn join_by_welcome_with_tree(
        &self,
        welcome: &[u8],
        ratchet_tree: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        let MlsMessageBodyIn::Welcome(welcome) = decode(welcome)? else {
            return Err(wrong_type("Welcome"));
        };
        let tree = ratchet_tree.map(parse_tree).transpose()?;
        let mut join =
            StagedWelcome::build_from_welcome(&self.provider, &Self::join_config(), welcome)
                .map_err(rejected)?;
        if let Some(tree) = tree {
            join = join.with_ratchet_tree(tree);
        }
        let staged = join.build().map_err(|error| match error {
            WelcomeError::MissingRatchetTree => MlsError::new(ErrorKind::MissingTree, error),
            error => rejected(error),
        })?;
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

    /// This epoch's signed GroupInfo without the ratchet tree, and the tree on
    /// its own, for a group whose tree is past [`INLINE_TREE_BYTES`]: what an
    /// external joiner then needs from the delivery service, in two pieces
    /// the store can hold and serve apart. `None` for the tree while it is
    /// small enough to ride inside the GroupInfo, as [`Member::group_info`].
    pub fn group_info_parts(&self, group_id: &[u8]) -> Result<(Vec<u8>, Option<Vec<u8>>)> {
        let group = self.load(group_id)?;
        let inline = Self::tree_inline(&group);
        let info = group
            .export_group_info(self.provider.crypto(), &self.signer, inline)
            .map_err(rejected)?;
        let tree = if inline {
            None
        } else {
            Some(
                group
                    .export_ratchet_tree()
                    .tls_serialize_detached()
                    .map_err(internal)?,
            )
        };
        Ok((encode(&info)?, tree))
    }

    /// Join through an external commit from a GroupInfo (RFC 9420, 12.4.3.2).
    /// Returns the group id and the commit. OpenMLS 0.9.2 applies an external
    /// commit as soon as it is built (`finalize`), so the joiner is in the new
    /// epoch at once; if the delivery service refuses the commit, the joiner
    /// discards the group and joins again from a fresh GroupInfo.
    pub fn join_by_external_commit(&self, group_info: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        self.join_by_external_commit_with_tree(group_info, None)
    }

    /// [`Member::join_by_external_commit`] from a GroupInfo that left the tree
    /// out, with that epoch's tree beside it. OpenMLS verifies the GroupInfo's
    /// signature against the signer's leaf in the tree and the tree against
    /// the hash in the signed group context, and refuses either mismatch.
    pub fn join_by_external_commit_with_tree(
        &self,
        group_info: &[u8],
        ratchet_tree: Option<&[u8]>,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        let MlsMessageBodyIn::GroupInfo(info) = decode(group_info)? else {
            return Err(wrong_type("GroupInfo"));
        };
        if info.ciphersuite() != self.ciphersuite {
            return Err(rejected("the group uses another cipher suite"));
        }
        let tree = ratchet_tree.map(parse_tree).transpose()?;
        self.refuse_existing(&info.group_id().clone())?;
        let mut builder = MlsGroup::external_commit_builder().with_config(Self::join_config());
        if let Some(tree) = tree {
            builder = builder.with_ratchet_tree(tree);
        }
        let (group, bundle) = builder
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
        // The epoch and leaf this device's leaf keys are filed under, should
        // the message remove it (see below).
        let (epoch_before, own_leaf) = (group.epoch(), group.own_leaf_index().u32());
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
        let epoch = group.epoch().as_u64();
        let active = group.is_active();
        if !active {
            // OpenMLS only marks a removed member's group inactive and keeps
            // its tree and epoch secrets in storage. A device that is out of
            // the group has no use for them and must not keep them on disk,
            // so the whole group goes (and the journal reports the deletions).
            // `delete` drops the leaf keys of the epoch the removal moved
            // to; the ones this device used until then stay unless named.
            group
                .delete(self.provider.storage())
                .map_err(storage_error)?;
            self.provider
                .storage()
                .delete_encryption_epoch_key_pairs(group.group_id(), &epoch_before, own_leaf)
                .map_err(storage_error)?;
        }
        Ok(Processed {
            kind,
            sender_leaf,
            sender_identity,
            plaintext,
            epoch,
            active,
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

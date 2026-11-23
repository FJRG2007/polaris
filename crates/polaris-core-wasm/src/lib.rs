//! WebAssembly binding of `polaris-core`. Conversion and error mapping only:
//! no domain logic lives here (docs/rust-core-plan.md, 3.1).
//!
//! The export names match the Node binding's, so the facade drives both
//! through one interface. A domain error crosses as a JavaScript `Error` whose
//! `code` is the TypeScript error class name and whose message is the
//! TypeScript message. A panic traps (wasm32 aborts on panic), which reaches
//! JavaScript as a `WebAssembly.RuntimeError`; the facade then drops the
//! instance and falls back.

use wasm_bindgen::prelude::*;

fn coded_error(class: &str, message: String) -> JsValue {
    let error = js_sys::Error::new(&message);
    // Setting a plain data property on a fresh Error object cannot fail.
    let _ = js_sys::Reflect::set(
        &error,
        &JsValue::from_str("code"),
        &JsValue::from_str(class),
    );
    error.into()
}

#[wasm_bindgen(js_name = probeFnv1a32)]
pub fn probe_fnv1a32(text: &str) -> u32 {
    polaris_core::probe::fnv1a32(text)
}

#[wasm_bindgen(js_name = probeDecodeHex)]
pub fn probe_decode_hex(hex: &str) -> Result<Vec<u8>, JsValue> {
    polaris_core::probe::decode_hex(hex).map_err(|e| coded_error("RangeError", e.to_string()))
}

/// Panics on purpose, so the facade's tests can prove a real trap is caught
/// and answered by the TypeScript implementation.
#[wasm_bindgen(js_name = probePanic)]
pub fn probe_panic() {
    panic!("polaris-core-wasm: deliberate panic for the facade's fallback test");
}
// ---- mls (docs/rust-core-plan.md Phase 2, E1) ----------------------------
// The same class and member names as the Node binding's `MlsMember`. Every
// argument and result is the RFC 9420 wire encoding; an error carries the
// domain's code (`MlsRejected`, ...) and OpenMLS's explanation.

#[cfg(feature = "mls")]
fn mls_error(error: polaris_core::mls::MlsError) -> JsValue {
    coded_error(error.code(), error.message)
}

/// What a commit produced (`polaris_core::mls::CommitOutput`).
#[cfg(feature = "mls")]
#[wasm_bindgen(getter_with_clone)]
pub struct MlsCommit {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
    #[wasm_bindgen(js_name = groupInfo)]
    pub group_info: Option<Vec<u8>>,
}

#[cfg(feature = "mls")]
fn mls_commit(output: polaris_core::mls::CommitOutput) -> MlsCommit {
    MlsCommit {
        commit: output.commit,
        welcome: output.welcome,
        group_info: output.group_info,
    }
}

/// An external join: the group id and the commit to send.
#[cfg(feature = "mls")]
#[wasm_bindgen(getter_with_clone)]
pub struct MlsExternalJoin {
    #[wasm_bindgen(js_name = groupId)]
    pub group_id: Vec<u8>,
    pub commit: Vec<u8>,
}

/// The outcome of processing a message (`polaris_core::mls::Processed`).
#[cfg(feature = "mls")]
#[wasm_bindgen(getter_with_clone)]
pub struct MlsProcessed {
    pub kind: String,
    #[wasm_bindgen(js_name = senderLeaf)]
    pub sender_leaf: Option<u32>,
    #[wasm_bindgen(js_name = senderIdentity)]
    pub sender_identity: Vec<u8>,
    pub plaintext: Vec<u8>,
    pub epoch: u64,
    pub active: bool,
}

/// One leaf of a group (`polaris_core::mls::GroupMember`).
#[cfg(feature = "mls")]
#[wasm_bindgen(getter_with_clone)]
pub struct MlsGroupMember {
    pub leaf: u32,
    pub identity: Vec<u8>,
    #[wasm_bindgen(js_name = signatureKey)]
    pub signature_key: Vec<u8>,
}

/// One device's MLS state.
#[cfg(feature = "mls")]
#[wasm_bindgen]
pub struct MlsMember {
    inner: polaris_core::mls::Member,
    journal: polaris_core::mls::Journal,
}

/// One key the host's store writes (`value`) or deletes (no `value`),
/// `polaris_core::mls::StoreChange`.
#[cfg(feature = "mls")]
#[wasm_bindgen(getter_with_clone)]
pub struct MlsStoreChange {
    pub key: Vec<u8>,
    pub value: Option<Vec<u8>>,
}

#[cfg(feature = "mls")]
#[wasm_bindgen]
impl MlsMember {
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &[u8], ciphersuite: u32, seed: &[u8]) -> Result<MlsMember, JsValue> {
        polaris_core::mls::Member::from_binding(identity, ciphersuite, seed)
            .map(|inner| MlsMember {
                inner,
                journal: polaris_core::mls::Journal::default(),
            })
            .map_err(mls_error)
    }

    /// The device as the host's store holds it (`keys[i]` holds `values[i]`);
    /// `seed` is fresh for this boot.
    pub fn restore(
        identity: &[u8],
        ciphersuite: u32,
        seed: &[u8],
        keys: Vec<js_sys::Uint8Array>,
        values: Vec<js_sys::Uint8Array>,
        #[wasm_bindgen(js_name = signaturePublicKey)] signature_public_key: &[u8],
    ) -> Result<MlsMember, JsValue> {
        polaris_core::mls::Member::restore_from_binding(
            identity,
            ciphersuite,
            seed,
            keys.iter().map(js_sys::Uint8Array::to_vec).collect(),
            values.iter().map(js_sys::Uint8Array::to_vec).collect(),
            signature_public_key,
        )
        .map(|(inner, journal)| MlsMember { inner, journal })
        .map_err(mls_error)
    }

    /// Everything changed since the last call, for the host to write in one
    /// transaction (`polaris_core::mls::Journal`).
    #[wasm_bindgen(js_name = storeChanges)]
    pub fn store_changes(&self) -> Vec<MlsStoreChange> {
        polaris_core::mls::Journal::changes(&self.journal, self.inner.storage())
            .into_iter()
            .map(|change| MlsStoreChange {
                key: change.key,
                value: change.value,
            })
            .collect()
    }

    #[wasm_bindgen(js_name = signaturePublicKey)]
    pub fn signature_public_key(&self) -> Vec<u8> {
        polaris_core::mls::Member::signature_public_key(&self.inner).to_vec()
    }

    #[wasm_bindgen(js_name = keyPackage)]
    pub fn key_package(&self) -> Result<Vec<u8>, JsValue> {
        polaris_core::mls::Member::key_package(&self.inner).map_err(mls_error)
    }

    #[wasm_bindgen(js_name = createGroup)]
    pub fn create_group(&self, group_id: &[u8]) -> Result<(), JsValue> {
        polaris_core::mls::Member::create_group(&self.inner, group_id).map_err(mls_error)
    }

    #[wasm_bindgen(js_name = addMembers)]
    pub fn add_members(
        &self,
        group_id: &[u8],
        key_packages: Vec<js_sys::Uint8Array>,
    ) -> Result<MlsCommit, JsValue> {
        let key_packages: Vec<Vec<u8>> = key_packages
            .iter()
            .map(js_sys::Uint8Array::to_vec)
            .collect();
        polaris_core::mls::Member::add_members(&self.inner, group_id, &key_packages)
            .map(mls_commit)
            .map_err(mls_error)
    }

    #[wasm_bindgen(js_name = removeMembers)]
    pub fn remove_members(&self, group_id: &[u8], leaves: Vec<u32>) -> Result<MlsCommit, JsValue> {
        polaris_core::mls::Member::remove_members(&self.inner, group_id, &leaves)
            .map(mls_commit)
            .map_err(mls_error)
    }

    #[wasm_bindgen(js_name = selfUpdate)]
    pub fn self_update(&self, group_id: &[u8]) -> Result<MlsCommit, JsValue> {
        polaris_core::mls::Member::self_update(&self.inner, group_id)
            .map(mls_commit)
            .map_err(mls_error)
    }

    #[wasm_bindgen(js_name = mergePendingCommit)]
    pub fn merge_pending_commit(&self, group_id: &[u8]) -> Result<(), JsValue> {
        polaris_core::mls::Member::merge_pending_commit(&self.inner, group_id).map_err(mls_error)
    }

    #[wasm_bindgen(js_name = clearPendingCommit)]
    pub fn clear_pending_commit(&self, group_id: &[u8]) -> Result<(), JsValue> {
        polaris_core::mls::Member::clear_pending_commit(&self.inner, group_id).map_err(mls_error)
    }

    #[wasm_bindgen(js_name = joinByWelcome)]
    pub fn join_by_welcome(&self, welcome: &[u8]) -> Result<Vec<u8>, JsValue> {
        polaris_core::mls::Member::join_by_welcome(&self.inner, welcome).map_err(mls_error)
    }

    #[wasm_bindgen(js_name = groupInfo)]
    pub fn group_info(&self, group_id: &[u8]) -> Result<Vec<u8>, JsValue> {
        polaris_core::mls::Member::group_info(&self.inner, group_id).map_err(mls_error)
    }

    #[wasm_bindgen(js_name = joinByExternalCommit)]
    pub fn join_by_external_commit(&self, group_info: &[u8]) -> Result<MlsExternalJoin, JsValue> {
        polaris_core::mls::Member::join_by_external_commit(&self.inner, group_info)
            .map(|(group_id, commit)| MlsExternalJoin { group_id, commit })
            .map_err(mls_error)
    }

    pub fn encrypt(&self, group_id: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
        polaris_core::mls::Member::encrypt(&self.inner, group_id, plaintext).map_err(mls_error)
    }

    pub fn process(&self, group_id: &[u8], message: &[u8]) -> Result<MlsProcessed, JsValue> {
        polaris_core::mls::Member::process(&self.inner, group_id, message)
            .map(|processed| MlsProcessed {
                kind: processed.kind.as_str().to_string(),
                sender_leaf: processed.sender_leaf,
                sender_identity: processed.sender_identity,
                plaintext: processed.plaintext,
                epoch: processed.epoch,
                active: processed.active,
            })
            .map_err(mls_error)
    }

    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, JsValue> {
        polaris_core::mls::Member::epoch(&self.inner, group_id).map_err(mls_error)
    }

    #[wasm_bindgen(js_name = epochAuthenticator)]
    pub fn epoch_authenticator(&self, group_id: &[u8]) -> Result<Vec<u8>, JsValue> {
        polaris_core::mls::Member::epoch_authenticator(&self.inner, group_id).map_err(mls_error)
    }

    #[wasm_bindgen(js_name = exportSecret)]
    pub fn export_secret(
        &self,
        group_id: &[u8],
        label: &str,
        context: &[u8],
        length: u32,
    ) -> Result<Vec<u8>, JsValue> {
        polaris_core::mls::Member::export_secret(
            &self.inner,
            group_id,
            label,
            context,
            length as usize,
        )
        .map_err(mls_error)
    }

    #[wasm_bindgen(js_name = ownLeaf)]
    pub fn own_leaf(&self, group_id: &[u8]) -> Result<u32, JsValue> {
        polaris_core::mls::Member::own_leaf(&self.inner, group_id).map_err(mls_error)
    }

    pub fn members(&self, group_id: &[u8]) -> Result<Vec<MlsGroupMember>, JsValue> {
        polaris_core::mls::Member::members(&self.inner, group_id)
            .map(|members| {
                members
                    .into_iter()
                    .map(|member| MlsGroupMember {
                        leaf: member.leaf,
                        identity: member.identity,
                        signature_key: member.signature_key,
                    })
                    .collect()
            })
            .map_err(mls_error)
    }
}

/**
 * Phase 0 MLS spike scenario on ts-mls. Runs unchanged in Node and in a browser page.
 * Per group size N: create the group with N members in one commit, join a second member
 * from the Welcome, add and remove one member, encrypt/decrypt application messages,
 * derive the content key with the MLS exporter, serialize/restore the receiver's state,
 * and join one member through an external commit.
 */
import {
    acceptAll,
    createApplicationMessage,
    createCommit,
    createGroup,
    createGroupInfoWithExternalPubAndRatchetTree,
    decodeGroupState,
    decodeMlsMessage,
    defaultCapabilities,
    defaultLifetime,
    emptyPskIndex,
    encodeGroupState,
    encodeMlsMessage,
    generateKeyPackage,
    getCiphersuiteFromName,
    getCiphersuiteImpl,
    joinGroup,
    joinGroupExternal,
    mlsExporter,
    processMessage,
    type CiphersuiteImpl,
    type ClientState,
    type MLSMessage,
    type Proposal
} from "ts-mls";

type Row = Record<string, number | string | boolean>;
type KeyPackageResult = Awaited<ReturnType<typeof generateKeyPackage>>;

const encoder = new TextEncoder();
const now = (): number => performance.now();

/** Ciphersuite 0x0001, the one the proposal (3.2 point 4) picks. */
export async function init(): Promise<CiphersuiteImpl> {
    return getCiphersuiteImpl(getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"));
}

function keyPackage(name: string, impl: CiphersuiteImpl): Promise<KeyPackageResult> {
    return generateKeyPackage({ credentialType: "basic", identity: encoder.encode(name) }, defaultCapabilities(), defaultLifetime, [], impl);
}

/** Encodes then decodes, so every measured message really crosses the wire format. */
function wire(message: MLSMessage): { bytes: number; decoded: MLSMessage } {
    const bytes = encodeMlsMessage(message);
    const decoded = decodeMlsMessage(bytes, 0)?.[0];
    if (!decoded) throw new Error("decode failed");
    return { bytes: bytes.length, decoded };
}

async function receive(state: ClientState, message: MLSMessage, impl: CiphersuiteImpl): Promise<{ state: ClientState; text?: string }> {
    if (message.wireformat !== "mls_private_message" && message.wireformat !== "mls_public_message") throw new Error(`unexpected ${message.wireformat}`);
    const result = await processMessage(message, state, emptyPskIndex, acceptAll, impl);
    if (result.kind === "applicationMessage") return { state: result.newState, text: new TextDecoder().decode(result.message) };
    return { state: result.newState };
}

async function contentKey(state: ClientState, impl: CiphersuiteImpl): Promise<Uint8Array> {
    const epoch = new Uint8Array(8);
    new DataView(epoch.buffer).setBigUint64(0, state.groupContext.epoch);
    return mlsExporter(state.keySchedule.exporterSecret, "polaris/content", epoch, 32, impl);
}

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export async function runSize(n: number, impl: CiphersuiteImpl, messages = 50): Promise<Row> {
    const row: Row = { members: n };

    let t = now();
    const packages: KeyPackageResult[] = [];
    for (let i = 0; i < n + 2; i++) packages.push(await keyPackage(`device-${i}`, impl));
    row.keyPackageMs = (now() - t) / (n + 2);
    const [alicePkg, bobPkg] = packages as [KeyPackageResult, KeyPackageResult];
    const extra = packages[n] as KeyPackageResult;
    const outsider = packages[n + 1] as KeyPackageResult;

    t = now();
    let alice = await createGroup(encoder.encode(`group-${n}`), alicePkg.publicPackage, alicePkg.privatePackage, [], impl);
    const adds: Proposal[] = packages.slice(1, n).map((p) => ({ proposalType: "add", add: { keyPackage: p.publicPackage } }));
    const created = await createCommit({ state: alice, cipherSuite: impl }, { extraProposals: adds });
    alice = created.newState;
    row.createMs = now() - t;
    if (!created.welcome) throw new Error("no welcome");
    const welcome = wire({ welcome: created.welcome, wireformat: "mls_welcome", version: "mls10" });
    row.createCommitBytes = wire(created.commit).bytes;
    row.welcomeBytes = welcome.bytes;

    t = now();
    if (welcome.decoded.wireformat !== "mls_welcome") throw new Error("welcome");
    let bob = await joinGroup(welcome.decoded.welcome, bobPkg.publicPackage, bobPkg.privatePackage, emptyPskIndex, impl, alice.ratchetTree);
    row.joinFromWelcomeMs = now() - t;

    t = now();
    const added = await createCommit({ state: alice, cipherSuite: impl }, { extraProposals: [{ proposalType: "add", add: { keyPackage: extra.publicPackage } }] });
    row.addCommitMs = now() - t;
    alice = added.newState;
    const addWire = wire(added.commit);
    row.addCommitBytes = addWire.bytes;
    row.addWelcomeBytes = added.welcome ? wire({ welcome: added.welcome, wireformat: "mls_welcome", version: "mls10" }).bytes : 0;
    t = now();
    bob = (await receive(bob, addWire.decoded, impl)).state;
    row.addProcessMs = now() - t;

    t = now();
    const removed = await createCommit({ state: alice, cipherSuite: impl }, { extraProposals: [{ proposalType: "remove", remove: { removed: n } }] });
    row.removeCommitMs = now() - t;
    alice = removed.newState;
    const removeWire = wire(removed.commit);
    row.removeCommitBytes = removeWire.bytes;
    t = now();
    bob = (await receive(bob, removeWire.decoded, impl)).state;
    row.removeProcessMs = now() - t;

    const text = "x".repeat(200);
    let encryptMs = 0;
    let decryptMs = 0;
    let ciphertextBytes = 0;
    for (let i = 0; i < messages; i++) {
        t = now();
        const sent = await createApplicationMessage(alice, encoder.encode(text), impl);
        encryptMs += now() - t;
        alice = sent.newState;
        const msg = wire({ privateMessage: sent.privateMessage, wireformat: "mls_private_message", version: "mls10" });
        ciphertextBytes = msg.bytes;
        t = now();
        const got = await receive(bob, msg.decoded, impl);
        decryptMs += now() - t;
        bob = got.state;
        if (got.text !== text) throw new Error("plaintext mismatch");
    }
    row.encryptMs = encryptMs / messages;
    row.decryptMs = decryptMs / messages;
    row.msg200BCiphertextBytes = ciphertextBytes;

    t = now();
    const keyA = await contentKey(alice, impl);
    row.exporterMs = now() - t;
    row.exporterAgrees = equal(keyA, await contentKey(bob, impl));

    t = now();
    const stateBytes = encodeGroupState(bob);
    row.serializeMs = now() - t;
    row.stateBytes = stateBytes.length;
    t = now();
    const decodedState = decodeGroupState(stateBytes, 0)?.[0];
    if (!decodedState) throw new Error("state decode");
    let restored: ClientState = { ...decodedState, clientConfig: bob.clientConfig };
    row.restoreMs = now() - t;
    const after = await createApplicationMessage(alice, encoder.encode("after restore"), impl);
    alice = after.newState;
    const afterGot = await receive(restored, wire({ privateMessage: after.privateMessage, wireformat: "mls_private_message", version: "mls10" }).decoded, impl);
    restored = afterGot.state;
    row.restoredDecrypts = afterGot.text === "after restore";

    t = now();
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(alice, [], impl);
    row.groupInfoBytes = wire({ groupInfo, wireformat: "mls_group_info", version: "mls10" }).bytes;
    const external = await joinGroupExternal(groupInfo, outsider.publicPackage, outsider.privatePackage, false, impl);
    row.externalJoinMs = now() - t;
    const externalWire = wire({ publicMessage: external.publicMessage, wireformat: "mls_public_message", version: "mls10" });
    row.externalCommitBytes = externalWire.bytes;
    t = now();
    alice = (await receive(alice, externalWire.decoded, impl)).state;
    row.externalProcessMs = now() - t;
    row.externalAgrees = equal(await contentKey(alice, impl), await contentKey(external.newState, impl));

    return row;
}

export async function runAll(sizes: number[], log: (row: Row) => void): Promise<Row[]> {
    const t = now();
    const impl = await init();
    const initMs = now() - t;
    log({ step: "init", ms: initMs });
    const rows: Row[] = [];
    for (const n of sizes) {
        const row = await runSize(n, impl, n >= 1000 ? 20 : 50);
        rows.push(row);
        log(row);
    }
    return rows;
}

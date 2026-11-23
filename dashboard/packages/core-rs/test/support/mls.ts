/**
 * One MLS group's life through a real binding (napi or WebAssembly): Welcome,
 * messages, a self-update, an external join and a removal, with the refusals a
 * binding has to carry across intact (replay, a removed member, a bad suite).
 * The Rust suites (crates/polaris-core/tests) cover the protocol; this proves
 * the boundary converts every argument, result and error code.
 */

import { expect } from "vitest";

/** The hybrid ML-KEM-768 + X25519 suite and the RFC 9420 classic one (polaris_core::mls). */
export const SUITES = [0x004f, 0x0001] as const;

interface Commit {
    commit: Uint8Array;
    welcome?: Uint8Array | null;
    groupInfo?: Uint8Array | null;
}

interface Processed {
    kind: string;
    senderLeaf?: number | null;
    senderIdentity: Uint8Array;
    plaintext: Uint8Array;
    epoch: bigint;
    active: boolean;
}

export interface MlsMemberLike {
    signaturePublicKey(): Uint8Array;
    keyPackage(): Uint8Array;
    createGroup(groupId: Uint8Array): void;
    addMembers(groupId: Uint8Array, keyPackages: Uint8Array[]): Commit;
    removeMembers(groupId: Uint8Array, leaves: number[]): Commit;
    selfUpdate(groupId: Uint8Array): Commit;
    mergePendingCommit(groupId: Uint8Array): void;
    joinByWelcome(welcome: Uint8Array): Uint8Array;
    groupInfo(groupId: Uint8Array): Uint8Array;
    joinByExternalCommit(groupInfo: Uint8Array): { groupId: Uint8Array; commit: Uint8Array };
    encrypt(groupId: Uint8Array, plaintext: Uint8Array): Uint8Array;
    process(groupId: Uint8Array, message: Uint8Array): Processed;
    epoch(groupId: Uint8Array): bigint;
    epochAuthenticator(groupId: Uint8Array): Uint8Array;
    exportSecret(groupId: Uint8Array, label: string, context: Uint8Array, length: number): Uint8Array;
    ownLeaf(groupId: Uint8Array): number;
    members(groupId: Uint8Array): { leaf: number; identity: Uint8Array; signatureKey: Uint8Array }[];
}

export type MlsMemberClass = new (identity: Uint8Array, ciphersuite: number, seed: Uint8Array) => MlsMemberLike;

const text = new TextEncoder();
const bytes = (value: Uint8Array | null | undefined) => Array.from(value ?? []);
const seed = () => crypto.getRandomValues(new Uint8Array(32));

/** The error a call threw, so its `code` can be asserted. */
function refusal(call: () => unknown): { code?: string; message: string } {
    try {
        call();
    } catch (error) {
        return error as { code?: string; message: string };
    }
    throw new Error("the call was expected to be refused");
}

export function runGroupLife(Member: MlsMemberClass, suite: number) {
    const groupId = text.encode(`group-${suite}`);
    const alice = new Member(text.encode("alice"), suite, seed());
    const bob = new Member(text.encode("bob"), suite, seed());
    const carol = new Member(text.encode("carol"), suite, seed());
    expect(alice.signaturePublicKey()).toHaveLength(32);

    alice.createGroup(groupId);
    const added = alice.addMembers(groupId, [bob.keyPackage()]);
    expect(added.welcome).toBeTruthy();
    expect(added.groupInfo).toBeTruthy();
    alice.mergePendingCommit(groupId);
    expect(bytes(bob.joinByWelcome(added.welcome as Uint8Array))).toEqual(bytes(groupId));
    expect(alice.epoch(groupId)).toBe(1n);
    expect(bob.epoch(groupId)).toBe(1n);
    expect(bytes(bob.epochAuthenticator(groupId))).toEqual(bytes(alice.epochAuthenticator(groupId)));

    const sealed = alice.encrypt(groupId, text.encode("hello bob"));
    const opened = bob.process(groupId, sealed);
    expect(opened.kind).toBe("application");
    expect(opened.senderLeaf).toBe(0);
    expect(bytes(opened.senderIdentity)).toEqual(bytes(text.encode("alice")));
    expect(bytes(opened.plaintext)).toEqual(bytes(text.encode("hello bob")));
    expect(opened.epoch).toBe(1n);
    expect(opened.active).toBe(true);
    expect(refusal(() => bob.process(groupId, sealed)).code).toMatch(/^Mls/);

    const context = text.encode("ctx");
    expect(bytes(bob.exportSecret(groupId, "polaris test", context, 32))).toEqual(
        bytes(alice.exportSecret(groupId, "polaris test", context, 32))
    );

    const updated = bob.selfUpdate(groupId);
    bob.mergePendingCommit(groupId);
    expect(alice.process(groupId, updated.commit).kind).toBe("commit");
    expect(alice.epoch(groupId)).toBe(2n);

    const joined = carol.joinByExternalCommit(alice.groupInfo(groupId));
    expect(bytes(joined.groupId)).toEqual(bytes(groupId));
    const external = alice.process(groupId, joined.commit);
    expect(external.kind).toBe("commit");
    expect(external.senderLeaf ?? null).toBeNull();
    bob.process(groupId, joined.commit);
    expect(alice.members(groupId).map((m) => new TextDecoder().decode(m.identity)).sort()).toEqual([
        "alice",
        "bob",
        "carol"
    ]);

    const removed = alice.removeMembers(groupId, [bob.ownLeaf(groupId)]);
    alice.mergePendingCommit(groupId);
    expect(bob.process(groupId, removed.commit).active).toBe(false);
    carol.process(groupId, removed.commit);
    const after = alice.encrypt(groupId, text.encode("bob is gone"));
    expect(bytes(carol.process(groupId, after).plaintext)).toEqual(bytes(text.encode("bob is gone")));
    expect(refusal(() => bob.process(groupId, after)).code).toMatch(/^Mls/);
    expect(alice.members(groupId)).toHaveLength(2);
}

export function runRefusals(Member: MlsMemberClass) {
    expect(refusal(() => new Member(text.encode("x"), 0x9999, seed())).code).toBe("MlsUnsupportedCiphersuite");
    expect(refusal(() => new Member(text.encode("x"), 0x004f, new Uint8Array(31))).code).toBe("MlsMalformed");
    const member = new Member(text.encode("x"), 0x004f, seed());
    expect(refusal(() => member.epoch(text.encode("nope"))).code).toBe("MlsUnknownGroup");
    expect(refusal(() => member.joinByWelcome(new Uint8Array([1, 2, 3]))).code).toMatch(/^Mls/);
}

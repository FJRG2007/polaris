/**
 * Request bodies of the end-to-end encryption routes, shared by the browser and
 * the server. Every op is one variant of a discriminated union and every field
 * is bounded: OPAQUE messages and envelopes are base64url of a known size.
 */

import { z } from "zod";
import * as core from "@polaris/core";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** base64url text between the given byte lengths once decoded. */
function base64Url(minBytes: number, maxBytes: number) {
    return z
        .string()
        .min(Math.floor((minBytes * 4) / 3))
        .max(Math.ceil((maxBytes * 4) / 3))
        .regex(BASE64URL);
}

/** OPAQUE messages: the largest (a registration record) is under 200 bytes. */
const opaqueMessage = base64Url(16, 1024);
/** A lock envelope is exactly 82 bytes (2 + 32 + 32 + 16), 110 characters. */
const lockEnvelope = z.string().length(110).regex(BASE64URL);
const akVersion = z.number().int().min(1).max(0x7fffffff);
const email = z.string().trim().toLowerCase().email().max(320);
const loginId = z.string().uuid();
/** A WebAuthn credential id, base64url, as better-auth stores it. */
const credentialId = z.string().min(16).max(1366).regex(BASE64URL);

const passwordLock = z.object({ akVersion, envelope: lockEnvelope });

export const signInBody = z.discriminatedUnion("op", [
    z.object({ op: z.literal("sign-in-start"), email, startLoginRequest: opaqueMessage }),
    z.object({
        op: z.literal("sign-in-finish"),
        loginId,
        finishLoginRequest: opaqueMessage
    }),
    z.object({ op: z.literal("adopt-start"), email, registrationRequest: opaqueMessage }),
    z.object({
        op: z.literal("adopt-finish"),
        email,
        // Checked against the account's current password hash, exactly as the
        // password sign-in this follows checked it moments earlier.
        password: z.string().min(1).max(1024),
        registrationRecord: opaqueMessage,
        // The profile the record was made with; a client from before v2 sends none.
        ksfVersion: z.union([z.literal(1), z.literal(2)]).default(1)
    }),
    z.object({ op: z.literal("verify-start"), email, startLoginRequest: opaqueMessage }),
    z.object({
        op: z.literal("verify-finish"),
        loginId,
        finishLoginRequest: opaqueMessage
    })
]);
export type SignInBody = z.infer<typeof signInBody>;

/** A share sealed to an account or to a request key: a hybrid envelope of 33 bytes, about 1.6k as text. */
const recoveryEnvelope = z.string().min(1500).max(2048).regex(BASE64URL);

export const keysBody = z.discriminatedUnion("op", [
    z.object({ op: z.literal("state") }),
    z.object({
        op: z.literal("create-account-key"),
        akVersion,
        signPublicKey: z.string().length(43).regex(BASE64URL),
        hpkePublicKey: z.string().length(1622).regex(BASE64URL)
    }),
    z.object({ op: z.literal("put-passkey-lock"), lockId: credentialId, akVersion, envelope: lockEnvelope }),
    z.object({ op: z.literal("delete-passkey-lock"), lockId: credentialId }),
    z.object({ op: z.literal("unlock-start"), startLoginRequest: opaqueMessage }),
    z.object({
        op: z.literal("unlock-finish"),
        loginId,
        finishLoginRequest: opaqueMessage,
        passwordLock: passwordLock.optional()
    }),
    // Proving the current password to a server action, without the password.
    z.object({ op: z.literal("proof-start"), startLoginRequest: opaqueMessage }),
    // A new password: registration, then a login against the record it made.
    z.object({ op: z.literal("set-start"), registrationRequest: opaqueMessage }),
    z.object({
        op: z.literal("set-verify"),
        registrationRecord: opaqueMessage,
        ksfVersion: z.union([z.literal(1), z.literal(2)]),
        startLoginRequest: opaqueMessage
    }),
    // Quorum recovery (recovery-service.ts): keep the shares current, raise a
    // request, approve one as a custodian, close one.
    z.object({ op: z.literal("recovery-state") }),
    z.object({
        op: z.literal("put-recovery-shares"),
        akVersion,
        splitId: z.string().uuid(),
        threshold: z.number().int().min(1).max(3),
        scope: z.string().regex(/^(instance|org:[0-9a-f-]{36})$/),
        shares: z
            .array(z.object({ custodianId: z.string().uuid(), custodianAkVersion: akVersion, envelope: recoveryEnvelope }))
            .min(1)
            .max(3)
    }),
    z.object({ op: z.literal("recovery-own") }),
    z.object({ op: z.literal("recovery-open"), requesterKey: z.string().length(1622).regex(BASE64URL) }),
    z.object({ op: z.literal("recovery-inbox") }),
    z.object({ op: z.literal("recovery-approve"), requestId: z.string().uuid(), envelope: recoveryEnvelope }),
    z.object({ op: z.literal("recovery-decline"), requestId: z.string().uuid() }),
    z.object({ op: z.literal("recovery-complete"), requestId: z.string().uuid() }),
    // The organisation recovery key of each scope this account is a custodian
    // of, and storing a scope's first one (its seed split like an account key).
    z.object({ op: z.literal("recovery-key-state") }),
    z.object({
        op: z.literal("put-recovery-key"),
        id: z.string().uuid(),
        scope: z.string().regex(/^(instance|org:[0-9a-f-]{36})$/),
        hpkePublicKey: z.string().length(1622).regex(BASE64URL),
        threshold: z.number().int().min(1).max(3),
        shares: z
            .array(z.object({ custodianId: z.string().uuid(), custodianAkVersion: akVersion, envelope: recoveryEnvelope }))
            .min(1)
            .max(3)
    }),
    // Opening a scope's recovery key with a quorum (recovery-opening.ts): raise
    // one, release or decline a seed share, then the opener's browser reads the
    // history sealed to it, seals it to the members missing it, splits the seed
    // again when the custodians changed, and closes the opening.
    z.object({ op: z.literal("recovery-key-open"), keyId: z.string().uuid(), requesterKey: z.string().length(1622).regex(BASE64URL) }),
    z.object({ op: z.literal("recovery-key-release"), openingId: z.string().uuid(), envelope: recoveryEnvelope }),
    z.object({ op: z.literal("recovery-key-decline"), openingId: z.string().uuid() }),
    z.object({ op: z.literal("recovery-key-work"), openingId: z.string().uuid(), after: z.string().uuid().nullable() }),
    z.object({
        op: z.literal("recovery-key-seal"),
        openingId: z.string().uuid(),
        envelopes: z
            .array(
                z.object({
                    channelId: z.string().uuid(),
                    epoch: z.string().regex(/^[0-9]{1,20}$/),
                    recipient: z.string().uuid(),
                    envelope: base64Url(64, 4096)
                })
            )
            .min(1)
            .max(200)
    }),
    z.object({
        op: z.literal("recovery-key-resplit"),
        openingId: z.string().uuid(),
        splitId: z.string().uuid(),
        threshold: z.number().int().min(1).max(3),
        shares: z.array(z.object({ custodianId: z.string().uuid(), custodianAkVersion: akVersion, envelope: recoveryEnvelope })).min(1).max(3)
    }),
    z.object({ op: z.literal("recovery-key-complete"), openingId: z.string().uuid() })
]);
export type KeysBody = z.infer<typeof keysBody>;

/** MLS wire objects: a key package or Welcome at 1,000 members stays far under 1 MiB. */
const mlsBytes = base64Url(1, 1024 * 1024);
/**
 * A large group's ratchet tree travels apart from its GroupInfo and Welcomes,
 * in parts of this many bytes; at the hybrid suite a filled tree weighs about
 * 2.6 KB a member, so 64 parts hold a tree of some 12,000 members.
 */
export const TREE_PART_BYTES = 512 * 1024;
export const MAX_TREE_PARTS = 64;
const treeParts = z.number().int().min(1).max(MAX_TREE_PARTS);
/** The two suites polaris_core::mls speaks: hybrid 0x004F and RFC 9420's 0x0001. */
const ciphersuite = z.union([z.literal(0x004f), z.literal(0x0001)]);
/** A device id: what the device made for itself, never an address or a path. */
export const deviceId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
const epoch = z.string().regex(/^\d{1,19}$/);
const channelId = z.string().uuid();
/** `${userId}/${device}`, as the delivery service addresses a device. */
const deviceAddressText = z.string().max(110).regex(/^[0-9a-f-]{36}\/[A-Za-z0-9_-]{8,64}$/);

export const mlsBody = z.discriminatedUnion("op", [
    z.object({
        op: z.literal("register-device"),
        device: deviceId,
        signatureKey: base64Url(32, 2048),
        e2eeVersion: z.number().int().min(1).max(1000),
        // The suite whose unclaimed key packages the answer counts; older callers sent none.
        ciphersuite: ciphersuite.default(0x004f)
    }),
    z.object({
        op: z.literal("publish-key-packages"),
        device: deviceId,
        ciphersuite,
        keyPackages: z.array(mlsBytes).min(1).max(100),
        lastResort: z.boolean().default(false)
    }),
    z.object({ op: z.literal("claim-key-packages"), channelId, userIds: z.array(z.string().uuid()).min(1).max(100), ciphersuite }),
    // The public account keys of conversation members, to seal history keys to.
    z.object({ op: z.literal("account-keys"), channelId, userIds: z.array(z.string().uuid()).min(1).max(100) }),
    // Every member's public account key, a page at a time: the committer seals each epoch's history key to all of them.
    z.object({ op: z.literal("member-account-keys"), channelId, after: z.string().uuid().optional() }),
    // Members whose account key has no envelope of a key the server sealed and forgot (the migrated history's, a
    // sweep's) yet, asked by one who holds it. `upTo`: the `next` of the previous page (older callers sent none).
    z.object({ op: z.literal("legacy-key-gaps"), channelId, upTo: epoch.optional() }),
    // The accounts holding a leaf in the caller's copy of the group: which have left, and who is in but has no leaf.
    // `devices`: the leaves of those accounts other than the caller's own (older callers sent none): which are retired.
    z.object({
        op: z.literal("roster"),
        channelId,
        accounts: z.array(z.string().uuid()).min(1).max(1000),
        devices: z.array(deviceAddressText).max(1000).default([]),
        ciphersuite
    }),
    // The session's own device leaves: its account signed out of this browser.
    z.object({ op: z.literal("retire-device"), device: deviceId }),
    z.object({ op: z.literal("group"), channelId }),
    z.object({ op: z.literal("create-group"), channelId, groupId: base64Url(16, 256), ciphersuite, groupInfo: mlsBytes }),
    z.object({
        op: z.literal("commit"),
        channelId,
        device: deviceId,
        epoch,
        commit: mlsBytes,
        groupInfo: mlsBytes,
        welcomes: z.array(z.object({ recipient: deviceAddressText, welcome: mlsBytes })).max(100).default([]),
        // The new epoch's tree, left out of the GroupInfo and Welcomes, staged by this device in this many parts
        // (`put-tree-part`) before the commit. Older callers and small groups send none.
        treeParts: treeParts.optional()
    }),
    // One part of the ratchet tree of `epoch` (the epoch the caller's next commit moves the group into); `part`
    // below `parts` is checked by the handler.
    z.object({
        op: z.literal("put-tree-part"),
        channelId,
        device: deviceId,
        epoch,
        part: z.number().int().min(0).max(MAX_TREE_PARTS - 1),
        parts: treeParts,
        bytes: base64Url(1, TREE_PART_BYTES)
    }),
    // One part of the tree kept for `epoch`: a Welcome's (its event's epoch) or the latest, for an external join.
    z.object({ op: z.literal("ratchet-tree"), channelId, epoch, part: z.number().int().min(0).max(MAX_TREE_PARTS - 1).default(0) }),
    z.object({ op: z.literal("application"), channelId, device: deviceId, epoch, payload: mlsBytes }),
    z.object({ op: z.literal("events"), channelId, device: deviceId, after: epoch.default("0") }),
    z.object({
        op: z.literal("put-history-keys"),
        channelId,
        epoch,
        envelopes: z.array(z.object({ recipient: z.string().min(1).max(64), envelope: base64Url(64, 4096) })).min(1).max(1000)
    }),
    z.object({ op: z.literal("history-keys"), channelId, from: epoch.default("0") }),
    // A chat message sealed under the epoch's history key, signed by the device.
    z.object({
        op: z.literal("send-sealed"),
        channelId,
        device: deviceId,
        clientKey: z.string().uuid(),
        parentId: z.string().uuid().nullable().optional(),
        replyToId: z.string().uuid().nullable().optional(),
        // Files sealed in this browser and staged with `?sealed=1`, named (with their keys) inside the seal.
        uploads: z.array(z.string().uuid()).min(1).max(25).optional(),
        // A poll whose question and answers are in the seal: only how many answers, and its rules.
        poll: z
            .object({
                options: z.number().int().min(core.MIN_POLL_OPTIONS).max(core.MAX_POLL_OPTIONS),
                multiple: z.boolean(),
                hideResults: z.boolean(),
                // Absent from a tab still on the build before the choice: anonymous, which publishes nothing.
                anonymous: z.boolean().default(true),
                hours: core.chatPollCreateSchema.shape.hours
            })
            .strict()
            .optional(),
        // A new forum post whose title is in the seal: only its tags, which the forum's list filters on.
        forum: z.object({ tagIds: core.chatForumPostFieldsSchema.shape.tagIds }).strict().optional(),
        epoch,
        senderLeaf: z.number().int().min(0).max(0xffffffff),
        ciphertext: base64Url(17, 256 * 1024),
        signature: base64Url(64, 64)
    }),
    // A new version of one of the caller's sealed messages, sealed and signed the same way.
    z.object({
        op: z.literal("edit-sealed"),
        channelId,
        device: deviceId,
        messageId: z.string().uuid(),
        epoch,
        senderLeaf: z.number().int().min(0).max(0xffffffff),
        // The version this one is: the stored one's revision plus one.
        revision: z.number().int().min(1).max(0x7fffffff),
        ciphertext: base64Url(17, 256 * 1024),
        signature: base64Url(64, 64)
    }),
    // A sealed message written now and sent later: what `send-sealed` takes (no poll, no forum post) and when it goes.
    z.object({
        op: z.literal("schedule-sealed"),
        channelId,
        device: deviceId,
        clientKey: z.string().uuid(),
        parentId: z.string().uuid().nullable().optional(),
        replyToId: z.string().uuid().nullable().optional(),
        uploads: z.array(z.string().uuid()).min(1).max(25).optional(),
        sendAt: core.chatScheduleSchema.shape.sendAt,
        epoch,
        senderLeaf: z.number().int().min(0).max(0xffffffff),
        ciphertext: base64Url(17, 256 * 1024),
        signature: base64Url(64, 64)
    }),
    // One of the caller's sealed scheduled messages sealed again at the conversation's current epoch.
    z.object({
        op: z.literal("reseal-scheduled"),
        channelId,
        device: deviceId,
        scheduledId: z.string().uuid(),
        epoch,
        senderLeaf: z.number().int().min(0).max(0xffffffff),
        ciphertext: base64Url(17, 256 * 1024),
        signature: base64Url(64, 64)
    }),
    z.object({ op: z.literal("read-sealed"), channelId, messageIds: z.array(z.string().uuid()).min(1).max(100) })
]);
export type MlsBody = z.infer<typeof mlsBody>;

/**
 * The second half of an OPAQUE login a server action finishes itself: a proof of
 * the current password (`proof-start`) or the verification of a new one
 * (`set-verify`). `finishLoginRequest` is absent when the client's own finish
 * failed - a wrong password - so the server still spends and counts the attempt.
 */
export const opaqueFinish = z.object({ loginId, finishLoginRequest: opaqueMessage.optional() });
export type OpaqueFinish = z.infer<typeof opaqueFinish>;

/** Where an action used to take the account password: the password itself (an
 *  older client, an account not on OPAQUE yet) or a proof of it. */
export const passwordOrProof = z.union([z.string().min(1, "Password is required"), opaqueFinish]);

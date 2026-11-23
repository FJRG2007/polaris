/**
 * Request bodies of the end-to-end encryption routes, shared by the browser and
 * the server. Every op is one variant of a discriminated union and every field
 * is bounded: OPAQUE messages and envelopes are base64url of a known size.
 */

import { z } from "zod";

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
    })
]);
export type KeysBody = z.infer<typeof keysBody>;

/** MLS wire objects: a key package or Welcome at 1,000 members stays far under 1 MiB. */
const mlsBytes = base64Url(1, 1024 * 1024);
/** The two suites polaris_core::mls speaks: hybrid 0x004F and RFC 9420's 0x0001. */
const ciphersuite = z.union([z.literal(0x004f), z.literal(0x0001)]);
/** A device id: what the device made for itself, never an address or a path. */
const deviceId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
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
    z.object({ op: z.literal("group"), channelId }),
    z.object({ op: z.literal("create-group"), channelId, groupId: base64Url(16, 256), ciphersuite, groupInfo: mlsBytes }),
    z.object({
        op: z.literal("commit"),
        channelId,
        device: deviceId,
        epoch,
        commit: mlsBytes,
        groupInfo: mlsBytes,
        welcomes: z.array(z.object({ recipient: deviceAddressText, welcome: mlsBytes })).max(100).default([])
    }),
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

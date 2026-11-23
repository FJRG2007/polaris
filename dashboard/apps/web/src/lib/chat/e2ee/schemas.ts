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
    })
]);
export type KeysBody = z.infer<typeof keysBody>;

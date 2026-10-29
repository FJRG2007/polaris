"use client";

/**
 * Signing in with a passkey for the account typed on the sign-in screen.
 *
 * better-auth's `signIn.passkey()` asks for options with no account in them, so
 * the browser opens a discoverable-credential prompt and the person picks the
 * account again. A browser with its own account chooser (Chrome) makes that
 * look like one step; Windows Hello inside the desktop app does not, and asks
 * which passkey to use. With the typed account's credentials in
 * `allowCredentials`, every platform goes straight to that account.
 *
 * Only the prompt is narrowed: the challenge and its cookie still come from
 * better-auth's own `generate-authenticate-options`, and the answer is checked
 * by its own `verify-authentication`, exactly as `signIn.passkey()` does.
 */

import { authClient } from "@/lib/auth-client";
import { fromBase64Url, toBase64Url } from "@/lib/vault/passkey-client";

/** A credential the typed account holds, as the server stores it. */
export interface PasskeyDescriptor {
    /** base64url, as WebAuthn reported it at registration. */
    readonly id: string;
    readonly transports: readonly string[];
}

/** The options better-auth hands out, in WebAuthn's JSON form. */
export interface RequestOptionsJson {
    readonly challenge: string;
    readonly rpId?: string;
    readonly timeout?: number;
    readonly userVerification?: UserVerificationRequirement;
    readonly allowCredentials?: readonly { id: string; transports?: string[] }[];
    readonly extensions?: AuthenticationExtensionsClientInputs;
}

export type PasskeySignInResult = { error: null } | { error: { code?: string } };

/** The browser's options for these JSON options, limited to `allow` when given. */
export function requestOptions(
    json: RequestOptionsJson,
    allow: readonly PasskeyDescriptor[]
): PublicKeyCredentialRequestOptions {
    const credentials = allow.length > 0 ? allow : (json.allowCredentials ?? []);
    return {
        challenge: fromBase64Url(json.challenge) as BufferSource,
        ...(json.rpId ? { rpId: json.rpId } : {}),
        ...(json.timeout ? { timeout: json.timeout } : {}),
        ...(json.userVerification ? { userVerification: json.userVerification } : {}),
        ...(json.extensions ? { extensions: json.extensions } : {}),
        allowCredentials: credentials.map((credential) => ({
            type: "public-key" as const,
            id: fromBase64Url(credential.id) as BufferSource,
            ...(credential.transports?.length
                ? { transports: [...credential.transports] as AuthenticatorTransport[] }
                : {})
        }))
    };
}

/** An assertion in the JSON shape `verify-authentication` reads. */
export function assertionJson(credential: PublicKeyCredential): Record<string, unknown> {
    const response = credential.response as AuthenticatorAssertionResponse;
    const bytes = (buffer: ArrayBuffer) => toBase64Url(new Uint8Array(buffer));
    return {
        id: credential.id,
        rawId: bytes(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
        response: {
            clientDataJSON: bytes(response.clientDataJSON),
            authenticatorData: bytes(response.authenticatorData),
            signature: bytes(response.signature),
            ...(response.userHandle ? { userHandle: bytes(response.userHandle) } : {})
        }
    };
}

/**
 * Run the ceremony for these credentials. A cancelled prompt answers with an
 * error like any other failure, so the form is left as it was.
 */
export async function signInWithPasskeys(
    allow: readonly PasskeyDescriptor[]
): Promise<PasskeySignInResult> {
    const options = await authClient.$fetch<RequestOptionsJson>(
        "/passkey/generate-authenticate-options",
        { method: "GET", throw: false }
    );
    if (!options.data) return { error: { code: "OPTIONS_FAILED" } };
    let credential: Credential | null;
    try {
        credential = await navigator.credentials.get({
            publicKey: requestOptions(options.data, allow)
        });
    } catch {
        return { error: { code: "AUTH_CANCELLED" } };
    }
    if (!credential || !("rawId" in credential)) return { error: { code: "AUTH_CANCELLED" } };
    const verified = (await authClient.$fetch("/passkey/verify-authentication", {
        method: "POST",
        body: { response: assertionJson(credential as PublicKeyCredential) },
        throw: false
    })) as { error?: { code?: string } | null };
    if (verified.error) return { error: { code: verified.error.code } };
    authClient.$store.notify("$sessionSignal");
    return { error: null };
}

/**
 * The passkey ceremony asking for PRF (chat end-to-end encryption, internal
 * flag). The PRF output is the passkey lock's secret, so the one property that
 * matters most is that it never reaches the server: the assertion posted to
 * `verify-authentication` carries no extension results. And without extensions
 * asked for, the ceremony is exactly the old one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const posted: unknown[] = [];

vi.mock("@/lib/auth-client", () => ({
    authClient: {
        $fetch: async (path: string, init: { body?: unknown }) => {
            if (path === "/passkey/generate-authenticate-options") return { data: { challenge: "AAAA", rpId: "polaris.example.com" } };
            posted.push(init.body);
            return { data: {}, error: null };
        },
        $store: { notify: () => undefined }
    }
}));
vi.mock("@/lib/local-passkeys", () => ({
    rememberLocalPasskey: () => undefined,
    resumeAutomaticPasskey: () => undefined,
    forgetLocalPasskeys: () => undefined
}));

const PRF = new Uint8Array(32).fill(0x5a);
let asked: PublicKeyCredentialRequestOptions | null = null;

const { signInWithPasskeys } = await import("@/lib/passkey-sign-in");
const { prfExtension, prfOutputOf } = await import("@polaris/chat-crypto/passkey-lock");

beforeEach(() => {
    posted.length = 0;
    asked = null;
    const buffer = (n: number) => new Uint8Array(n).fill(1).buffer;
    vi.stubGlobal("navigator", {
        credentials: {
            get: async ({ publicKey }: { publicKey: PublicKeyCredentialRequestOptions }) => {
                asked = publicKey;
                return {
                    id: "Y3JlZGVudGlhbC1pZC1vbmUtMTIzNDU2",
                    rawId: buffer(24),
                    type: "public-key",
                    authenticatorAttachment: "platform",
                    response: { clientDataJSON: buffer(8), authenticatorData: buffer(8), signature: buffer(8), userHandle: null },
                    getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: PRF.buffer.slice(0) } } })
                };
            }
        }
    });
});

describe("the passkey ceremony with the chat key's PRF", () => {
    it("asks for PRF, hands the output back in this tab, and posts none of it", async () => {
        const result = await signInWithPasskeys([], await prfExtension());
        expect((asked?.extensions as { prf?: unknown })?.prf).toBeDefined();
        expect(result.error).toBeNull();
        const output = prfOutputOf((result as { extensionResults?: unknown }).extensionResults);
        expect(Array.from(output!)).toEqual(Array.from(PRF));
        const sent = JSON.stringify(posted);
        expect(sent).not.toMatch(/prf|clientExtensionResults|extension/i);
        expect(sent).not.toContain(Buffer.from(PRF).toString("base64url"));
    });

    it("is the old ceremony without extensions: no PRF asked, no results returned", async () => {
        const result = await signInWithPasskeys([]);
        expect(asked?.extensions).toBeUndefined();
        expect(result).toEqual({ error: null });
    });
});

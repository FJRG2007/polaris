/**
 * A passkey sign-in with an account typed goes straight to that account.
 *
 * Asserted on the two conversions the ceremony depends on: the options the
 * browser is handed name the typed account's credentials (so Windows Hello
 * does not ask which passkey to use), and the answer goes back to better-auth
 * in the base64url JSON its `verify-authentication` reads.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

const { assertionJson, requestOptions } = await import("@/lib/passkey-sign-in");
const { fromBase64Url, toBase64Url } = await import("@/lib/vault/passkey-client");

const bytes = (...values: number[]) => new Uint8Array(values);
const base = { challenge: toBase64Url(bytes(1, 2, 3, 250)), rpId: "polaris.example", userVerification: "preferred" as const };

describe("passkey options for a typed account", () => {
    it("lists only the typed account's credentials, with their transports", () => {
        const options = requestOptions(base, [{ id: toBase64Url(bytes(9, 8, 7)), transports: ["internal", "hybrid"] }]);
        expect(new Uint8Array(options.challenge as Uint8Array)).toEqual(bytes(1, 2, 3, 250));
        expect(options.rpId).toBe("polaris.example");
        expect(options.allowCredentials).toHaveLength(1);
        expect(new Uint8Array(options.allowCredentials![0]!.id as Uint8Array)).toEqual(bytes(9, 8, 7));
        expect(options.allowCredentials![0]!.transports).toEqual(["internal", "hybrid"]);
    });

    it("keeps the server's own list when no account is typed", () => {
        const options = requestOptions({ ...base, allowCredentials: [{ id: toBase64Url(bytes(5)) }] }, []);
        expect(options.allowCredentials).toHaveLength(1);
        expect(options.allowCredentials![0]!.transports).toBeUndefined();
        expect(requestOptions(base, []).allowCredentials).toEqual([]);
    });
});

describe("the answer sent back", () => {
    it("is base64url JSON with the assertion's parts", () => {
        const buffer = (...values: number[]) => bytes(...values).buffer;
        const credential = {
            id: toBase64Url(bytes(9, 8, 7)),
            rawId: buffer(9, 8, 7),
            type: "public-key",
            authenticatorAttachment: "platform",
            response: {
                clientDataJSON: buffer(1),
                authenticatorData: buffer(2, 255),
                signature: buffer(3),
                userHandle: null
            }
        } as unknown as PublicKeyCredential;
        const json = assertionJson(credential) as { rawId: string; response: Record<string, string> };
        expect(json.rawId).toBe(credential.id);
        expect(fromBase64Url(json.response.authenticatorData!)).toEqual(bytes(2, 255));
        expect(json.response.authenticatorData).not.toMatch(/[+/=]/);
        expect("userHandle" in json.response).toBe(false);
    });
});

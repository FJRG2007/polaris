/**
 * An authorized mailbox whose token could not be minted.
 *
 * Only a grant the provider refused is the owner's to fix, and only that one may
 * pause the mailbox and send the "needs connecting again" notice. A token
 * endpoint that did not answer is a retry: the authorization still works, and
 * telling somebody to reconnect it would be telling them something false.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class GoogleAuthExpiredError extends Error {}
class MicrosoftAuthExpiredError extends Error {}

const mint = {
    google: async (): Promise<string> => "google-token",
    microsoft: async (): Promise<string> => "ms-token"
};

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: () => ({}),
    decryptSecret: () => "",
    CredentialDecryptError: class extends Error {}
}));
vi.mock("@/lib/connections/store", () => ({
    readCredential: async () => ({ refreshToken: "refresh" })
}));
vi.mock("@/lib/google-calendar/service", () => ({
    getGoogleOAuthClient: async () => ({ clientId: "client", clientSecret: "secret" }),
    googleAccessToken: () => mint.google(),
    GoogleAuthExpiredError,
    GOOGLE_MAIL_SCOPES: []
}));
vi.mock("@/lib/connections/microsoft", () => ({
    getMicrosoftOAuthClient: async () => ({ clientId: "client", clientSecret: "secret" }),
    microsoftAccessToken: () => mint.microsoft(),
    MicrosoftAuthExpiredError,
    MICROSOFT_MAIL_SCOPES: []
}));

const { mailCredential, MailAuthError } = await import("@/lib/mailbox/credentials");

function authorized(service: string) {
    return {
        address: "ana@example.com",
        username: "",
        auth: "oauth",
        service,
        connectionId: "0190c1d2-0000-7000-8000-0000000000c1",
        encryptedSecret: null,
        secretNonce: null,
        secretKeyId: null
    };
}

beforeEach(() => {
    mint.google = async () => "google-token";
    mint.microsoft = async () => "ms-token";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("minting a mailbox's token", () => {
    it("asks for the authorization again when Google refuses the grant", async () => {
        mint.google = async () => {
            throw new GoogleAuthExpiredError("invalid_grant");
        };
        await expect(mailCredential(authorized("gmail"))).rejects.toBeInstanceOf(MailAuthError);
    });

    it("asks for the authorization again when Microsoft refuses the grant", async () => {
        mint.microsoft = async () => {
            throw new MicrosoftAuthExpiredError("invalid_grant");
        };
        await expect(mailCredential(authorized("outlook"))).rejects.toBeInstanceOf(MailAuthError);
    });

    it("retries, rather than pausing the mailbox, when Google does not answer", async () => {
        mint.google = async () => {
            throw new TypeError("fetch failed");
        };
        const attempt = mailCredential(authorized("gmail"));
        await expect(attempt).rejects.not.toBeInstanceOf(MailAuthError);
        await expect(attempt).rejects.toThrow(
            "Polaris could not reach Google to authorize this mailbox."
        );
    });

    it("retries, rather than pausing the mailbox, when Microsoft has a bad minute", async () => {
        mint.microsoft = async () => {
            throw new Error("Microsoft refused the token request (503)");
        };
        const attempt = mailCredential(authorized("outlook"));
        await expect(attempt).rejects.not.toBeInstanceOf(MailAuthError);
        await expect(attempt).rejects.toThrow(
            "Polaris could not reach Microsoft to authorize this mailbox."
        );
    });

    it("hands back the token when it is minted", async () => {
        await expect(mailCredential(authorized("gmail"))).resolves.toMatchObject({
            kind: "oauth",
            accessToken: "google-token"
        });
    });
});

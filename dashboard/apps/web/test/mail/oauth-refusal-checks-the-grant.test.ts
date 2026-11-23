/**
 * An authorized mailbox the mail server turned away, while the authorization
 * behind it was fine.
 *
 * BUG-0021: Gmail answered a login with an access token Polaris had cached
 * "AUTHENTICATIONFAILED", and that alone paused the mailbox and sent "needs
 * connecting again" - when asking Google for a new token, which is all the
 * Reconnect button ended up doing, would have fixed it with nobody involved.
 *
 * So a refused token is followed by a fresh one and one more login before
 * anything is written down, and only the provider refusing the grant itself is
 * the owner's to fix.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class GoogleAuthExpiredError extends Error {}
class MicrosoftAuthExpiredError extends Error {}

const google = {
    minted: 0,
    forgotten: 0,
    mint: async (): Promise<string> => `token-${google.minted}`
};

/** What the server does with each login, in order; `ok` past the end. */
const logins = {
    answers: [] as ("ok" | "refused" | "dropped")[],
    tokens: [] as string[]
};

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: () => ({}),
    decryptSecret: () => "secret",
    CredentialDecryptError: class extends Error {}
}));
vi.mock("@/lib/connections/store", () => ({
    readCredential: async () => ({ refreshToken: "refresh" })
}));
vi.mock("@/lib/google-calendar/service", () => ({
    getGoogleOAuthClient: async () => ({ clientId: "client", clientSecret: "secret" }),
    googleAccessToken: async () => {
        google.minted += 1;
        return google.mint();
    },
    forgetGoogleAccessToken: () => {
        google.forgotten += 1;
    },
    GoogleAuthExpiredError,
    GOOGLE_MAIL_SCOPES: []
}));
vi.mock("@/lib/connections/microsoft", () => ({
    getMicrosoftOAuthClient: async () => ({ clientId: "client", clientSecret: "secret" }),
    microsoftAccessToken: async () => "ms-token",
    forgetMicrosoftAccessToken: () => undefined,
    MicrosoftAuthExpiredError,
    MICROSOFT_MAIL_SCOPES: []
}));
vi.mock("imapflow", () => ({
    ImapFlow: class {
        private readonly auth: { accessToken?: string; pass?: string };
        public constructor(options: { auth: { accessToken?: string; pass?: string } }) {
            this.auth = options.auth;
        }
        public on(): void {}
        public close(): void {}
        public async logout(): Promise<void> {}
        public async connect(): Promise<void> {
            logins.tokens.push(this.auth.accessToken ?? this.auth.pass ?? "");
            const answer = logins.answers.shift() ?? "ok";
            if (answer === "refused") {
                throw Object.assign(new Error("Command failed"), {
                    authenticationFailed: true,
                    responseStatus: "NO",
                    serverResponseCode: "AUTHENTICATIONFAILED",
                    responseText: "Invalid credentials (Failure)"
                });
            }
            if (answer === "dropped") throw new Error("Socket closed unexpectedly");
        }
    }
}));

const { openImap } = await import("@/lib/mailbox/imap");
const { MailAuthError, resetTokenEndpoints } = await import("@/lib/mailbox/credentials");

function mailbox(auth: "oauth" | "password" = "oauth") {
    return {
        address: "ana@example.com",
        username: "",
        auth,
        service: auth === "oauth" ? "gmail" : "other",
        connectionId: auth === "oauth" ? "0190c1d2-0000-7000-8000-0000000000c1" : null,
        encryptedSecret: auth === "oauth" ? null : new Uint8Array([1]),
        secretNonce: auth === "oauth" ? null : new Uint8Array([1]),
        secretKeyId: null,
        imapHost: "imap.gmail.com",
        imapPort: 993,
        imapSecurity: "tls"
    };
}

beforeEach(() => {
    resetTokenEndpoints();
    google.minted = 0;
    google.forgotten = 0;
    google.mint = async () => `token-${google.minted}`;
    logins.answers = [];
    logins.tokens = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("an authorized mailbox whose token the mail server refuses", () => {
    it("mints a fresh token and logs in again instead of pausing the mailbox", async () => {
        logins.answers = ["refused", "ok"];
        await expect(openImap(mailbox())).resolves.toBeDefined();
        // The cached token, then one minted after the cache was dropped.
        expect(logins.tokens).toEqual(["token-1", "token-2"]);
        expect(google.forgotten).toBe(1);
    });

    it("is a refusal nobody is asked to fix when a fresh token is refused too", async () => {
        logins.answers = ["refused", "refused"];
        const attempt = openImap(mailbox());
        await expect(attempt).rejects.toBeInstanceOf(MailAuthError);
        await expect(attempt).rejects.toMatchObject({ grantRefused: false });
        // One retry, never a loop.
        expect(logins.tokens).toHaveLength(2);
    });

    it("is the owner's to fix when Google refuses the grant on the refresh", async () => {
        logins.answers = ["refused"];
        google.mint = async () => {
            if (google.minted > 1) {
                throw new GoogleAuthExpiredError(
                    "Google no longer accepts this authorization: invalid_grant"
                );
            }
            return "stale";
        };
        const attempt = openImap(mailbox());
        await expect(attempt).rejects.toBeInstanceOf(MailAuthError);
        await expect(attempt).rejects.toMatchObject({ grantRefused: true });
        expect(logins.tokens).toEqual(["stale"]);
    });

    it("is a retry, never a refusal, when the refresh cannot reach Google", async () => {
        logins.answers = ["refused"];
        google.mint = async () => {
            if (google.minted > 1) throw new TypeError("fetch failed");
            return "stale";
        };
        await expect(openImap(mailbox())).rejects.not.toBeInstanceOf(MailAuthError);
    });

    it("does not spend a fresh token on a connection that merely dropped", async () => {
        logins.answers = ["dropped"];
        await expect(openImap(mailbox())).rejects.not.toBeInstanceOf(MailAuthError);
        expect(logins.tokens).toHaveLength(1);
        expect(google.forgotten).toBe(0);
    });
});

describe("a password mailbox the server refuses", () => {
    it("is refused on the first answer, as before", async () => {
        logins.answers = ["refused", "ok"];
        await expect(openImap(mailbox("password"))).rejects.toBeInstanceOf(MailAuthError);
        expect(logins.tokens).toEqual(["secret"]);
    });
});

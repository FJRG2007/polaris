/**
 * What an account authenticates with, and where it comes from.
 *
 * Two shapes, and the difference matters at every call site. A password account
 * holds its own secret here, envelope-encrypted under the master key the same
 * way storage credentials and integration keys are, and it is decrypted for the
 * one connection being opened and never held anywhere else. An OAuth account
 * holds nothing at all: it points at the `UserConnection` its owner already
 * authorized, and a short-lived access token is minted from that per connection.
 *
 * The second is why linking Gmail is one button. It is also why an account can
 * go from working to refused without anybody touching it - somebody can revoke
 * the authorization from Google's own screen - so every path through here has to
 * be able to say "this needs authorizing again" rather than throwing whatever
 * the provider said.
 */

import { loadEnv } from "@polaris/config";
import { MAIL_OAUTH_SCOPES } from "@polaris/core";
import { readCredential } from "@/lib/connections/store";
import { encryptSecret, decryptSecret, CredentialDecryptError } from "@polaris/storage";
import {
    getGoogleOAuthClient,
    googleAccessToken,
    GoogleAuthExpiredError,
    GOOGLE_MAIL_SCOPES
} from "@/lib/google-calendar/service";
import {
    getMicrosoftOAuthClient,
    MicrosoftAuthExpiredError,
    MICROSOFT_MAIL_SCOPES,
    microsoftAccessToken
} from "@/lib/connections/microsoft";

/** What a socket is opened with. `pass` for a password account, `accessToken`
 *  for an OAuth one - exactly what imapflow and nodemailer each want. */
export type MailCredential =
    | { readonly kind: "password"; readonly user: string; readonly pass: string }
    | { readonly kind: "oauth"; readonly user: string; readonly accessToken: string };

/**
 * Raised when the mailbox cannot be reached because of who it belongs to rather
 * than because of the network: a password the server refuses, an authorization
 * that was revoked, a link that was removed.
 *
 * Separate from every other failure because it is the only one the person can do
 * something about, and because it is what puts an account into the `auth` state
 * rather than the `unreachable` one.
 */
export class MailAuthError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "MailAuthError";
    }
}

/** The columns this module needs off an account row. */
export interface MailCredentialSource {
    readonly address: string;
    readonly username: string;
    readonly auth: string;
    readonly service: string;
    readonly connectionId: string | null;
    readonly encryptedSecret: Uint8Array | null;
    readonly secretNonce: Uint8Array | null;
    readonly secretKeyId: string | null;
}

/** The login the servers are given: whatever was typed, or the address. */
export function mailLogin(account: Pick<MailCredentialSource, "address" | "username">): string {
    return account.username.trim() || account.address;
}

/** Seal a mailbox password for storage. */
export function sealMailSecret(secret: string): {
    encryptedSecret: Buffer;
    secretNonce: Buffer;
    secretKeyId: string;
} {
    const blob = encryptSecret(secret, loadEnv().POLARIS_MASTER_KEY);
    return { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
}

/**
 * The stored password, or null when there is none or the master key has moved
 * on from the one it was sealed under.
 *
 * An undecryptable secret reads as no secret rather than as an error about key
 * ids, the way every other credential in Polaris does: what the person can act
 * on is "connect this mailbox again", and that is what they are told.
 */
function openMailSecret(account: MailCredentialSource): string | null {
    if (!account.encryptedSecret || !account.secretNonce) return null;
    try {
        return decryptSecret(
            {
                ciphertext: Buffer.from(account.encryptedSecret),
                nonce: Buffer.from(account.secretNonce),
                keyId: account.secretKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch (caught) {
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
}

/**
 * The scopes a mail token is minted under, by provider.
 *
 * Read from the shared catalogue rather than restated, because the account form
 * compares what a link was granted against exactly this list before offering it,
 * and two copies of it would be a mailbox offered as ready that then cannot be
 * opened.
 */
function mailScopes(provider: string): readonly string[] {
    return MAIL_OAUTH_SCOPES[provider] ?? [];
}

/** Whether a link has been granted everything a mailbox needs. What the account
 *  form checks before offering an already-linked account for mail. */
export function grantsMailAccess(provider: string, scope: string): boolean {
    const granted = new Set(scope.split(/[\s,]+/).filter(Boolean));
    return mailScopes(provider).every((needed) => granted.has(needed));
}

/**
 * What to open a connection with, for one account.
 *
 * A missing or refused credential is a `MailAuthError`: an account with no
 * usable credential is not a network problem and must never be reported as one,
 * because the two lead somewhere different - one to a retry, the other to a
 * person. The reverse holds too: a token endpoint that could not be reached is
 * a plain error, retried, never a refusal.
 */
export async function mailCredential(account: MailCredentialSource): Promise<MailCredential> {
    const user = mailLogin(account);
    if (account.auth !== "oauth") {
        const pass = openMailSecret(account);
        if (!pass) throw new MailAuthError("This mailbox needs its password again.");
        return { kind: "password", user, pass };
    }

    if (!account.connectionId) {
        throw new MailAuthError("The account that authorized this mailbox is no longer linked.");
    }
    const credential = await readCredential(account.connectionId);
    const refreshToken = credential?.refreshToken;
    if (!refreshToken) {
        throw new MailAuthError(
            "The account that authorized this mailbox needs authorizing again."
        );
    }

    const provider = oauthProviderFor(account.service);
    try {
        if (provider === "google") {
            const client = await getGoogleOAuthClient();
            if (!client)
                throw new MailAuthError("Google is not connected on this Polaris any more.");
            // Google mints one token per refresh token regardless of what was
            // asked for; the scopes it carries are the ones the link was granted,
            // which is what `grantsMailAccess` checked before this account existed.
            void GOOGLE_MAIL_SCOPES;
            return {
                kind: "oauth",
                user,
                accessToken: await googleAccessToken(client, refreshToken)
            };
        }
        const client = await getMicrosoftOAuthClient();
        if (!client)
            throw new MailAuthError("Microsoft is not connected on this Polaris any more.");
        return {
            kind: "oauth",
            user,
            accessToken: await microsoftAccessToken(client, refreshToken, MICROSOFT_MAIL_SCOPES)
        };
    } catch (caught) {
        if (caught instanceof MailAuthError) throw caught;
        // A grant the provider refused is the same answer to the person holding
        // the mailbox: authorize it again. The provider's own words are kept off
        // the screen deliberately - they name endpoints and scopes.
        if (
            caught instanceof GoogleAuthExpiredError ||
            caught instanceof MicrosoftAuthExpiredError
        ) {
            throw new MailAuthError("This mailbox needs authorizing again.");
        }
        console.warn(`polaris: ${provider} did not answer a mail token request:`, caught);
        throw new Error(
            `Polaris could not reach ${provider === "google" ? "Google" : "Microsoft"} to authorize this mailbox.`
        );
    }
}

/** Which service authorizes a given mail service. Only two do. */
export function oauthProviderFor(service: string): "google" | "microsoft" {
    return service === "outlook" || service === "office365" ? "microsoft" : "google";
}

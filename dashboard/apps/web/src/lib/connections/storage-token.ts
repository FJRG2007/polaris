/**
 * Access tokens for the storage connections that are reached through somebody's
 * linked account.
 *
 * The bridge between two things that deliberately do not know about each other:
 * @polaris/storage holds no database and no OAuth client, and the connections
 * store knows nothing about drivers. This resolves one to the other - a storage
 * connection names an account, the account holds a refresh token, and the
 * provider turns that into an access token that is good for the next hour.
 *
 * A function is returned rather than a token because a large upload outlives an
 * access token. Each provider's own module caches until expiry, so asking per
 * request costs a map lookup and means the last chunk of a two-hour transfer is
 * not signed with a credential that died during the first.
 */

import { prisma } from "@polaris/db";
import { readCredential } from "./store";
import type { ConnectionRecord, TokenSource } from "@polaris/storage";
import { dropboxAccessToken, getDropboxOAuthClient } from "./dropbox";
import { getMicrosoftOAuthClient, microsoftAccessToken } from "./microsoft";
import { getGoogleOAuthClient, googleAccessToken } from "@/lib/google-calendar/service";
import { usesLinkedAccount, type StorageConfig, type StorageProviderKind } from "@polaris/core";

/** Which linked service each storage kind authorizes through. */
const PROVIDER_OF: Partial<Record<StorageProviderKind, "google" | "microsoft" | "dropbox">> = {
    gdrive: "google",
    onedrive: "microsoft",
    dropbox: "dropbox"
};

/** Raised when the account a connection names can no longer be used, with the
 *  reason somebody can act on rather than an unauthorized response. */
export class LinkedAccountUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "LinkedAccountUnavailableError";
    }
}

/**
 * A token supplier for a connection, for the driver registry to inject.
 *
 * Every failure here is somebody's to fix - the account was unlinked, the
 * operator removed the application, the grant was revoked - so each one says
 * which, instead of surfacing later as a 401 from a provider nobody can name.
 */
export function linkedAccountToken(record: ConnectionRecord): TokenSource {
    return async () => {
        const provider = PROVIDER_OF[record.kind];
        if (!provider) {
            throw new LinkedAccountUnavailableError(`${record.kind} does not use a linked account`);
        }
        const config = record.config as Extract<StorageConfig, { kind: "gdrive" | "onedrive" | "dropbox" }>;
        const link = await prisma.userConnection.findUnique({
            where: { provider_accountId: { provider, accountId: config.accountId } },
            select: { id: true, label: true }
        });
        if (!link) {
            throw new LinkedAccountUnavailableError(
                `The ${provider} account this connection uses is no longer linked. Link it again to keep writing here.`
            );
        }
        const credential = await readCredential(link.id);
        const refreshToken = credential?.refreshToken;
        if (!refreshToken) {
            throw new LinkedAccountUnavailableError(
                `${link.label} has no lasting authorization. Unlink it and link it again.`
            );
        }
        return exchange(provider, refreshToken);
    };
}

async function exchange(
    provider: "google" | "microsoft" | "dropbox",
    refreshToken: string
): Promise<string> {
    if (provider === "google") {
        const client = await getGoogleOAuthClient();
        if (!client) throw new LinkedAccountUnavailableError(missingApp("Google"));
        return googleAccessToken(client, refreshToken);
    }
    if (provider === "microsoft") {
        const client = await getMicrosoftOAuthClient();
        if (!client) throw new LinkedAccountUnavailableError(missingApp("Microsoft"));
        return microsoftAccessToken(client, refreshToken);
    }
    const client = await getDropboxOAuthClient();
    if (!client) throw new LinkedAccountUnavailableError(missingApp("Dropbox"));
    return dropboxAccessToken(client, refreshToken);
}

function missingApp(name: string): string {
    return `The ${name} application is not connected on this Polaris, so its accounts cannot be used. An administrator connects it in Integrations.`;
}

/** Whether a connection of this kind needs the supplier above. */
export function needsLinkedAccount(kind: StorageProviderKind): boolean {
    return usesLinkedAccount(kind);
}

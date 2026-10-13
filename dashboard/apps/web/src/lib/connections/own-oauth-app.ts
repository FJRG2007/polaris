/**
 * A provider application somebody registered themselves, used for their own
 * links instead of the deployment's.
 *
 * Spotify keeps an app in development mode to five allowlisted accounts and only
 * lifts that for registered businesses
 * (https://developer.spotify.com/documentation/web-api/concepts/quota-modes), so
 * one deployment app cannot serve everybody here. Anybody can create their own
 * in a couple of minutes, and as its owner they need no allowlist entry. The
 * secret is envelope-encrypted with the master key, like a link's credential.
 *
 * A link is always refreshed with the app that issued it: a refresh token is
 * bound to its client, so a person who adds or removes their own app later must
 * not have an existing link spoken for by the other one (`pickOAuthClient`).
 *
 * Setting up a provider app is the administrator's job, so a new link always
 * goes through the deployment's. An app somebody stored before that only keeps
 * the links it already issued alive.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import type { OAuthAppClient } from "./oauth-app";
import { CredentialDecryptError, decryptSecret, encryptSecret } from "@polaris/storage";

export { ownOAuthAppSchema, type OwnOAuthAppInput } from "./own-oauth-app-schema";
import type { OwnOAuthAppInput } from "./own-oauth-app-schema";

/**
 * Which application a link speaks through.
 *
 * - `issuedTo` set: exactly that app, or nothing when it is gone - a token
 *   refreshed through another client is refused anyway.
 * - Otherwise the deployment's: a link with no record of its app predates
 *   personal apps, and a new link goes through what the administrator set up.
 */
export function pickOAuthClient(options: {
    own: OAuthAppClient | null;
    deployment: OAuthAppClient | null;
    issuedTo?: string;
}): OAuthAppClient | null {
    const { own, deployment, issuedTo } = options;
    if (issuedTo) {
        if (own?.clientId === issuedTo) return own;
        if (deployment?.clientId === issuedTo) return deployment;
        return null;
    }
    return deployment;
}

function decrypt(row: {
    encryptedSecret: Uint8Array;
    secretNonce: Uint8Array;
    secretKeyId: string;
}): string | null {
    try {
        return decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedSecret),
                nonce: Buffer.from(row.secretNonce),
                keyId: row.secretKeyId
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch (caught) {
        // A rotated master key: read as no app, so the person adds it again.
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
}

const COLUMNS = {
    userId: true,
    clientId: true,
    encryptedSecret: true,
    secretNonce: true,
    secretKeyId: true
} as const;

/** This person's own app for a provider, or null. */
export async function ownOAuthApp(
    userId: string,
    provider: string
): Promise<OAuthAppClient | null> {
    const row = await prisma.userOAuthApp.findUnique({
        where: { userId_provider: { userId, provider } },
        select: COLUMNS
    });
    if (!row) return null;
    const clientSecret = decrypt(row);
    return clientSecret ? { clientId: row.clientId, clientSecret } : null;
}

/** Several people's own apps at once, for a poll. One query. */
export async function ownOAuthAppsFor(
    userIds: readonly string[],
    provider: string
): Promise<Map<string, OAuthAppClient>> {
    const found = new Map<string, OAuthAppClient>();
    if (userIds.length === 0) return found;
    const rows = await prisma.userOAuthApp.findMany({
        where: { provider, userId: { in: [...new Set(userIds)] } },
        select: COLUMNS
    });
    for (const row of rows) {
        const clientSecret = decrypt(row);
        if (clientSecret) found.set(row.userId, { clientId: row.clientId, clientSecret });
    }
    return found;
}

/** How many people brought their own app for a provider. One indexed count. */
export async function countOwnOAuthApps(provider: string): Promise<number> {
    return prisma.userOAuthApp.count({ where: { provider } });
}

/** The client id alone, for the screen: never the secret. */
export async function ownOAuthAppClientId(
    userId: string,
    provider: string
): Promise<string | null> {
    const row = await prisma.userOAuthApp.findUnique({
        where: { userId_provider: { userId, provider } },
        select: { clientId: true }
    });
    return row?.clientId ?? null;
}

/** Store or replace this person's app. Already validated and verified. */
export async function saveOwnOAuthApp(
    userId: string,
    provider: string,
    app: OwnOAuthAppInput
): Promise<void> {
    const blob = encryptSecret(app.clientSecret, loadEnv().POLARIS_MASTER_KEY);
    const data = {
        clientId: app.clientId,
        encryptedSecret: blob.ciphertext,
        secretNonce: blob.nonce,
        secretKeyId: blob.keyId
    };
    await prisma.userOAuthApp.upsert({
        where: { userId_provider: { userId, provider } },
        create: { userId, provider, ...data },
        update: data
    });
}

/** Forget this person's app. Links it issued stop refreshing, which the
 *  connection health sweep reports to them as any other dead link. */
export async function removeOwnOAuthApp(userId: string, provider: string): Promise<void> {
    await prisma.userOAuthApp.deleteMany({ where: { userId, provider } });
}

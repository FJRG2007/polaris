/**
 * Email channels: the control plane for how Polaris sends mail.
 *
 * They live in the same Channel table as the messaging channels and appear
 * beside them under Inbox > Channels, but nothing about them goes through the
 * bridge. Mail is sent from this process, over HTTPS or SMTP, so verification
 * links and sign-in codes keep working on a deployment that never installed the
 * messaging bridge at all - an account locked out because an optional app is not
 * running would be a poor trade.
 *
 * Credentials use the same envelope encryption as the messaging channels and
 * storage connections: one AES-256-GCM master key, ciphertext in the row, and no
 * path that reads a secret back out to a client.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import {
    EMAIL_PLATFORM,
    isMailProvider,
    parseMailConfig,
    type MailConfig,
    type MailProvider
} from "@polaris/core";
import { sendEmail } from "./mail/send";
import { verifyMailAccount } from "./mail/verify";
import type { EmailMessage, MailAccount } from "./mail/types";

/** An email channel as the UI sees it. Never carries the secret. */
export interface EmailChannelView {
    id: string;
    provider: MailProvider;
    name: string;
    /** The address it sends as, shown on the card. */
    from: string;
    status: string;
    /** Why the last check or send failed, when it did. */
    error: string | null;
    settings: Record<string, string>;
}

interface StoredConfig {
    settings?: Record<string, unknown>;
    error?: string | null;
}

function parseStored(config: string): StoredConfig {
    try {
        return JSON.parse(config) as StoredConfig;
    } catch {
        return {};
    }
}

/** Settings as strings, for a form that only ever renders text inputs. */
function displaySettings(settings: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [key, value === undefined || value === null ? "" : String(value)])
    );
}

function toView(row: {
    id: string;
    provider: string | null;
    name: string;
    externalId: string | null;
    status: string;
    config: string;
}): EmailChannelView | null {
    if (!row.provider || !isMailProvider(row.provider)) return null;
    const stored = parseStored(row.config);
    return {
        id: row.id,
        provider: row.provider,
        name: row.name,
        from: row.externalId ?? "",
        status: row.status,
        error: stored.error ?? null,
        settings: displaySettings(stored.settings ?? {})
    };
}

/**
 * Email channels, oldest first. Scoped to one owner for the Channels page, and
 * unscoped for the administrator choosing which one carries the sign-in mail -
 * that choice is instance-wide, so it has to see every channel there is.
 */
export async function listEmailChannels(ownerId?: string): Promise<EmailChannelView[]> {
    const rows = await prisma.channel.findMany({
        where: { platform: EMAIL_PLATFORM, ...(ownerId ? { ownerId } : {}) },
        orderBy: { createdAt: "asc" }
    });
    return rows.map(toView).filter((view): view is EmailChannelView => view !== null);
}

/** Read a channel's decrypted credential and validated configuration. */
async function loadAccount(channelId: string): Promise<MailAccount | null> {
    const row = await prisma.channel.findFirst({
        where: { id: channelId, platform: EMAIL_PLATFORM }
    });
    if (!row?.provider || !row.encryptedSecret || !row.secretNonce || !row.secretKeyId) return null;
    const parsed = parseMailConfig(row.provider, parseStored(row.config).settings ?? {});
    if (!parsed.ok) return null;
    const secret = decryptSecret(
        {
            ciphertext: Buffer.from(row.encryptedSecret),
            nonce: Buffer.from(row.secretNonce),
            keyId: row.secretKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return { config: parsed.value, secret };
}

/** Record how a channel last behaved, so the card can say so. */
async function recordOutcome(channelId: string, error: string | null): Promise<void> {
    const row = await prisma.channel.findUnique({ where: { id: channelId }, select: { config: true } });
    if (!row) return;
    const stored = parseStored(row.config);
    await prisma.channel.update({
        where: { id: channelId },
        data: {
            status: error ? "error" : "connected",
            config: JSON.stringify({ ...stored, error })
        }
    });
}

export interface EmailChannelInput {
    provider: string;
    name: string;
    /** API key or password. Required when creating, optional when updating. */
    secret?: string;
    settings: Record<string, unknown>;
}

/**
 * Add an email channel, checking the credentials before the row is trusted. A
 * provider that refuses them is still stored - with the reason on the card - so
 * the operator can correct one field instead of retyping the whole form.
 */
export async function createEmailChannel(
    ownerId: string,
    input: EmailChannelInput
): Promise<{ channel?: EmailChannelView; error?: string }> {
    const parsed = parseMailConfig(input.provider, input.settings);
    if (!parsed.ok) return { error: parsed.error };
    const secret = input.secret?.trim();
    if (!secret) return { error: "Enter the key or password for this provider." };
    const name = input.name.trim();
    if (!name) return { error: "Give the channel a name." };

    const blob = encryptSecret(secret, loadEnv().POLARIS_MASTER_KEY);
    const failure = await checkAccount({ config: parsed.value, secret });
    const row = await prisma.channel.create({
        data: {
            ownerId,
            platform: EMAIL_PLATFORM,
            provider: parsed.value.provider,
            name,
            externalId: parsed.value.settings.from,
            status: failure ? "error" : "connected",
            config: JSON.stringify({ settings: parsed.value.settings, error: failure }),
            encryptedSecret: blob.ciphertext,
            secretNonce: blob.nonce,
            secretKeyId: blob.keyId
        }
    });
    const view = toView(row);
    return view ? { channel: view } : { error: "Could not store the channel." };
}

/** Verify credentials, returning the reason they failed or null when they work. */
async function checkAccount(account: MailAccount): Promise<string | null> {
    try {
        await verifyMailAccount(account);
        return null;
    } catch (caught) {
        return caught instanceof Error ? caught.message : "The provider refused those credentials.";
    }
}

/**
 * Change a channel's name, settings, or credential. An omitted secret keeps the
 * stored one, so an operator can fix a typo in the From address without having
 * to find their API key again.
 */
export async function updateEmailChannel(
    channelId: string,
    input: EmailChannelInput
): Promise<{ channel?: EmailChannelView; error?: string }> {
    const existing = await prisma.channel.findFirst({
        where: { id: channelId, platform: EMAIL_PLATFORM }
    });
    if (!existing) return { error: "That channel no longer exists." };
    const parsed = parseMailConfig(input.provider, input.settings);
    if (!parsed.ok) return { error: parsed.error };
    const name = input.name.trim();
    if (!name) return { error: "Give the channel a name." };

    const replacement = input.secret?.trim();
    const blob = replacement ? encryptSecret(replacement, loadEnv().POLARIS_MASTER_KEY) : null;
    const secret = replacement ?? (await loadAccount(channelId))?.secret;
    if (!secret) return { error: "This channel has no stored key. Enter one to save it." };

    const failure = await checkAccount({ config: parsed.value, secret });
    const row = await prisma.channel.update({
        where: { id: channelId },
        data: {
            provider: parsed.value.provider,
            name,
            externalId: parsed.value.settings.from,
            status: failure ? "error" : "connected",
            config: JSON.stringify({ settings: parsed.value.settings, error: failure }),
            ...(blob
                ? { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId }
                : {})
        }
    });
    const view = toView(row);
    return view ? { channel: view } : { error: "Could not store the channel." };
}

/** Remove an email channel. */
export async function deleteEmailChannel(channelId: string): Promise<void> {
    await prisma.channel.deleteMany({ where: { id: channelId, platform: EMAIL_PLATFORM } });
}

/**
 * Send through a named channel, recording the outcome on it. Returns the failure
 * text rather than throwing: every caller here is either a user action that wants
 * to show the reason, or an auth flow that must not break because mail is
 * misconfigured.
 */
export async function sendThroughChannel(
    channelId: string,
    message: EmailMessage
): Promise<{ error?: string }> {
    const account = await loadAccount(channelId);
    if (!account) {
        await recordOutcome(channelId, "The channel is not configured.");
        return { error: "That email channel is not configured." };
    }
    try {
        await sendEmail(account, message);
        await recordOutcome(channelId, null);
        return {};
    } catch (caught) {
        const error = caught instanceof Error ? caught.message : "The provider refused the message.";
        await recordOutcome(channelId, error);
        return { error };
    }
}

/** Re-check a channel's credentials and update its status. */
export async function recheckEmailChannel(channelId: string): Promise<{ error?: string }> {
    const account = await loadAccount(channelId);
    if (!account) return { error: "That email channel is not configured." };
    const failure = await checkAccount(account);
    await recordOutcome(channelId, failure);
    return failure ? { error: failure } : {};
}

/** The configuration a channel sends with, for callers that need the From address. */
export async function emailChannelConfig(channelId: string): Promise<MailConfig | null> {
    return (await loadAccount(channelId))?.config ?? null;
}

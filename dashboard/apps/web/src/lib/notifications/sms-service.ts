/**
 * The text-message sender: the account's SMS provider and how one alert reaches
 * a phone.
 *
 * A sender lives in the Channel table beside the email and messaging channels,
 * for the same reason they do - one place that holds a credential, one envelope
 * encryption, one status field saying whether it last worked. The bridge never
 * runs it; this process posts to the provider itself, so an alert about a
 * service being down does not depend on another service being up.
 *
 * The auth token is never read back to a client. Saving without one keeps the
 * stored token, so the sending number can be corrected without finding the
 * credential again.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import {
    parseSmsConfig,
    SMS_PLATFORM,
    type SmsChannelInput,
    type SmsConfig,
    type SmsProvider
} from "@polaris/core";

/** An SMS sender as the UI sees it. Never carries the token. */
export interface SmsSenderView {
    id: string;
    provider: SmsProvider;
    name: string;
    /** The number it sends from, shown on the card. */
    from: string;
    status: string;
    error: string | null;
    settings: Record<string, string>;
}

/** How long to wait on the provider. Short: an alert is best effort. */
const TIMEOUT_MS = 10_000;

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

function toView(row: {
    id: string;
    provider: string | null;
    name: string;
    externalId: string | null;
    status: string;
    config: string;
}): SmsSenderView | null {
    if (row.provider !== "twilio") return null;
    const stored = parseStored(row.config);
    return {
        id: row.id,
        provider: row.provider,
        name: row.name,
        from: row.externalId ?? "",
        status: row.status,
        error: stored.error ?? null,
        settings: Object.fromEntries(
            Object.entries(stored.settings ?? {}).map(([key, value]) => [key, value == null ? "" : String(value)])
        )
    };
}

/** Every sender this account configured. */
export async function listSmsSenders(ownerId: string): Promise<SmsSenderView[]> {
    const rows = await prisma.channel.findMany({
        where: { ownerId, platform: SMS_PLATFORM },
        orderBy: { createdAt: "asc" },
        select: { id: true, provider: true, name: true, externalId: true, status: true, config: true }
    });
    return rows.map(toView).filter((view): view is SmsSenderView => view !== null);
}

/** The sender an alert goes out through: the account's first working one. */
async function activeSender(
    ownerId: string
): Promise<{ config: SmsConfig; secret: string } | { error: string }> {
    const row = await prisma.channel.findFirst({
        where: { ownerId, platform: SMS_PLATFORM, status: "connected" },
        orderBy: { createdAt: "asc" }
    });
    if (!row) return { error: "No working SMS sender is configured." };
    const parsed = parseSmsConfig(row.provider ?? "", parseStored(row.config).settings);
    if (!parsed.ok) return { error: "The SMS sender's settings are no longer valid." };
    if (!row.encryptedSecret || !row.secretNonce) return { error: "The SMS sender has no credential stored." };
    try {
        const secret = decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedSecret),
                nonce: Buffer.from(row.secretNonce),
                keyId: row.secretKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
        return { config: parsed.value, secret };
    } catch {
        return { error: "The SMS sender's credential cannot be read. Re-enter it." };
    }
}

/** Whether this account can send a text right now. */
export async function smsAvailable(ownerId: string): Promise<boolean> {
    const count = await prisma.channel.count({
        where: { ownerId, platform: SMS_PLATFORM, status: "connected" }
    });
    return count > 0;
}

/** Twilio's REST call. One form POST, so no SDK is worth the dependency. */
async function sendWithTwilio(
    config: SmsConfig,
    secret: string,
    to: string,
    text: string
): Promise<{ error?: string }> {
    const auth = Buffer.from(`${config.settings.accountSid}:${secret}`).toString("base64");
    let res: Response;
    try {
        res = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.settings.accountSid)}/Messages.json`,
            {
                method: "POST",
                cache: "no-store",
                headers: {
                    Authorization: `Basic ${auth}`,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({ To: to, From: config.settings.from, Body: text }),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            }
        );
    } catch (caught) {
        const timedOut = caught instanceof Error && caught.name === "TimeoutError";
        return { error: timedOut ? "Twilio did not answer in time." : "Twilio could not be reached." };
    }
    if (res.ok) return {};
    // Twilio explains itself well - an unverified number or an unreachable
    // country is exactly the kind of thing the operator has to be told.
    const payload = (await res.json().catch(() => null)) as { message?: string } | null;
    return { error: payload?.message ?? `Twilio refused the message (HTTP ${res.status}).` };
}

/** Confirm a credential works before storing the sender as connected. */
async function verifySender(config: SmsConfig, secret: string): Promise<string | null> {
    const auth = Buffer.from(`${config.settings.accountSid}:${secret}`).toString("base64");
    let res: Response;
    try {
        res = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.settings.accountSid)}.json`,
            {
                cache: "no-store",
                headers: { Authorization: `Basic ${auth}` },
                signal: AbortSignal.timeout(TIMEOUT_MS)
            }
        );
    } catch {
        return "Twilio could not be reached to check the credential.";
    }
    if (res.ok) return null;
    if (res.status === 401) return "Twilio rejected that account SID and auth token.";
    const payload = (await res.json().catch(() => null)) as { message?: string } | null;
    return payload?.message ?? `Twilio answered HTTP ${res.status}.`;
}

/** Send one text through this account's sender. */
export async function sendSms(ownerId: string, to: string, text: string): Promise<{ error?: string }> {
    const sender = await activeSender(ownerId);
    if ("error" in sender) return { error: sender.error };
    return sendWithTwilio(sender.config, sender.secret, to, text);
}

/**
 * Add or replace this account's sender. A credential the provider refuses is
 * still stored, with the reason on the card, so one field can be corrected
 * rather than the whole form retyped.
 */
export async function saveSmsSender(
    ownerId: string,
    input: SmsChannelInput & { id?: string }
): Promise<{ sender?: SmsSenderView; error?: string }> {
    const parsed = parseSmsConfig(input.provider, input.settings);
    if (!parsed.ok) return { error: parsed.error };
    const name = input.name.trim();
    if (!name) return { error: "Give the sender a name." };

    const existing = input.id
        ? await prisma.channel.findFirst({ where: { id: input.id, ownerId, platform: SMS_PLATFORM } })
        : null;
    if (input.id && !existing) return { error: "That sender no longer exists." };

    let secret = input.secret?.trim();
    if (!secret && existing?.encryptedSecret && existing.secretNonce) {
        try {
            secret = decryptSecret(
                {
                    ciphertext: Buffer.from(existing.encryptedSecret),
                    nonce: Buffer.from(existing.secretNonce),
                    keyId: existing.secretKeyId ?? ""
                },
                loadEnv().POLARIS_MASTER_KEY
            );
        } catch {
            return { error: "The stored auth token cannot be read. Enter it again." };
        }
    }
    if (!secret) return { error: "Enter the auth token for this provider." };

    const failure = await verifySender(parsed.value, secret);
    const blob = encryptSecret(secret, loadEnv().POLARIS_MASTER_KEY);
    const data = {
        ownerId,
        platform: SMS_PLATFORM,
        provider: parsed.value.provider,
        name,
        externalId: parsed.value.settings.from,
        status: failure ? "error" : "connected",
        config: JSON.stringify({ settings: parsed.value.settings, error: failure }),
        encryptedSecret: blob.ciphertext,
        secretNonce: blob.nonce,
        secretKeyId: blob.keyId
    };
    const row = existing
        ? await prisma.channel.update({ where: { id: existing.id }, data })
        : await prisma.channel.create({ data });
    const view = toView(row);
    return view ? { sender: view } : { error: "Could not store the sender." };
}

export async function deleteSmsSender(ownerId: string, id: string): Promise<void> {
    await prisma.channel.deleteMany({ where: { id, ownerId, platform: SMS_PLATFORM } });
}

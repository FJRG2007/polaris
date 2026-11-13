/**
 * Messaging channels. The web is the source of truth: it stores channels (with
 * envelope-encrypted credentials) and drives the bridge to connect them; alerts,
 * automation notices and two-factor codes are sent through them. Channel secrets
 * use the same AES-256-GCM master key as integrations and storage credentials.
 */

import { EMAIL_PLATFORM } from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { capabilitiesFor } from "@polaris/messaging";
import type { ChannelCapabilities, ChannelSetup, Platform } from "@polaris/messaging";
import {
    bridgeChannelState,
    bridgeConfigured,
    bridgeConnectChannel,
    bridgeDisconnectChannel
} from "./messaging/bridge-client";

export interface ChannelView {
    id: string;
    platform: string;
    provider: string | null;
    name: string;
    externalId: string | null;
    status: string;
    capabilities: ChannelCapabilities | null;
}

function parseCapabilities(config: string): ChannelCapabilities | null {
    try {
        const parsed = JSON.parse(config) as { capabilities?: ChannelCapabilities };
        return parsed.capabilities ?? null;
    } catch {
        return null;
    }
}

/** The owner's channels. Email channels share the table but are not the bridge's
 *  to run, so they are left to the mail service (see EMAIL_PLATFORM). */
export async function listChannels(ownerId: string): Promise<ChannelView[]> {
    const rows = await prisma.channel.findMany({
        where: { ownerId, platform: { not: EMAIL_PLATFORM } },
        orderBy: { createdAt: "asc" }
    });
    return rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        provider: row.provider,
        name: row.name,
        externalId: row.externalId,
        status: row.status,
        capabilities: parseCapabilities(row.config)
    }));
}

/** Connect a new channel: persist it (encrypting the credential), then bring it
 *  online in the bridge. On failure the row is kept with an "error" status so the
 *  operator can retry. */
export async function connectChannel(
    ownerId: string,
    input: {
        platform: Platform;
        provider?: string;
        name: string;
        token?: string;
        config?: Record<string, string>;
    }
): Promise<ChannelView> {
    const env = loadEnv();
    // Clean up a prior failed/in-progress attempt with the same name on this
    // platform, so retrying (e.g. after a QR that errored) does not leave a
    // duplicate channel - one "error" next to the new "connected". Connected
    // channels are never touched.
    await prisma.channel.deleteMany({
        where: {
            ownerId,
            platform: input.platform,
            name: input.name,
            status: { in: ["error", "connecting", "disconnected"] }
        }
    });
    // whatsapp-web logs in by QR and has no upfront token; others do.
    const trimmedToken = input.token?.trim();
    const blob = trimmedToken ? encryptSecret(trimmedToken, env.POLARIS_MASTER_KEY) : null;
    const providerConfig = input.config ?? {};
    const channel = await prisma.channel.create({
        data: {
            ownerId,
            platform: input.platform,
            provider: input.provider ?? null,
            name: input.name,
            status: "connecting",
            config: JSON.stringify({
                capabilities: capabilitiesFor(input.platform, input.provider),
                providerConfig
            }),
            encryptedSecret: blob?.ciphertext ?? null,
            secretNonce: blob?.nonce ?? null,
            secretKeyId: blob?.keyId ?? null
        }
    });
    try {
        const result = await bridgeConnectChannel({
            channelId: channel.id,
            platform: input.platform,
            provider: input.provider,
            token: trimmedToken,
            config: input.config
        });
        // An adapter that returns its identity is live now (telegram, cloud). One
        // that logs in by QR (whatsapp-web) stays "connecting" until scanned - the
        // UI polls channelState for the QR and the eventual connected status.
        const updated = await prisma.channel.update({
            where: { id: channel.id },
            data: {
                status: result.externalId ? "connected" : "connecting",
                externalId: result.externalId ?? null,
                config: JSON.stringify({ capabilities: result.capabilities, providerConfig })
            }
        });
        return {
            id: updated.id,
            platform: updated.platform,
            provider: updated.provider,
            name: updated.name,
            externalId: updated.externalId,
            status: updated.status,
            capabilities: result.capabilities
        };
    } catch (caught) {
        await prisma.channel.update({ where: { id: channel.id }, data: { status: "error" } });
        throw caught instanceof Error ? caught : new Error("Could not connect the channel");
    }
}

/** Re-establish a channel's live adapter in the bridge, reusing its stored
 *  credentials (no need to re-enter a token). For token channels this fixes an
 *  errored connection in place; whatsapp-web restores from its session when valid. */
export async function reconnectChannel(
    ownerId: string,
    channelId: string
): Promise<{ status: string }> {
    const env = loadEnv();
    const channel = await prisma.channel.findFirst({ where: { id: channelId, ownerId } });
    if (!channel) throw new Error("Channel not found");
    const token =
        channel.encryptedSecret && channel.secretNonce && channel.secretKeyId
            ? decryptSecret(
                  {
                      ciphertext: Buffer.from(channel.encryptedSecret),
                      nonce: Buffer.from(channel.secretNonce),
                      keyId: channel.secretKeyId
                  },
                  env.POLARIS_MASTER_KEY
              )
            : undefined;
    let providerConfig: Record<string, string> | undefined;
    try {
        providerConfig = (JSON.parse(channel.config) as { providerConfig?: Record<string, string> })
            .providerConfig;
    } catch {
        providerConfig = undefined;
    }
    const result = await bridgeConnectChannel({
        channelId: channel.id,
        platform: channel.platform as Platform,
        provider: channel.provider ?? undefined,
        token,
        config: providerConfig
    });
    const status = result.externalId ? "connected" : "connecting";
    await prisma.channel.update({
        where: { id: channel.id },
        data: { status, ...(result.externalId ? { externalId: result.externalId } : {}) }
    });
    return { status };
}

/** Update a channel's editable settings: its display name, its credential
 *  (bot token), and/or its provider config. Changing the credential or config
 *  re-encrypts it and reconnects the adapter so the change takes effect at once;
 *  a name-only change does not disturb the live connection. */
export async function updateChannelCredentials(
    ownerId: string,
    channelId: string,
    patch: { name?: string; token?: string; config?: Record<string, string> }
): Promise<{ status: string }> {
    const env = loadEnv();
    const channel = await prisma.channel.findFirst({ where: { id: channelId, ownerId } });
    if (!channel) throw new Error("Channel not found");

    const trimmedName = patch.name?.trim();
    const trimmedToken = patch.token?.trim();
    const changingToken = Boolean(trimmedToken);
    const changingConfig = patch.config !== undefined;
    const blob = changingToken ? encryptSecret(trimmedToken!, env.POLARIS_MASTER_KEY) : null;

    // Merge the new provider config into the stored blob, preserving capabilities.
    let configJson: string | undefined;
    if (changingConfig) {
        let capabilities: ChannelCapabilities;
        let existingConfig: Record<string, string> = {};
        try {
            const parsed = JSON.parse(channel.config) as {
                capabilities?: ChannelCapabilities;
                providerConfig?: Record<string, string>;
            };
            capabilities =
                parsed.capabilities ??
                capabilitiesFor(channel.platform as Platform, channel.provider ?? undefined);
            existingConfig = parsed.providerConfig ?? {};
        } catch {
            capabilities = capabilitiesFor(
                channel.platform as Platform,
                channel.provider ?? undefined
            );
        }
        configJson = JSON.stringify({
            capabilities,
            providerConfig: { ...existingConfig, ...patch.config }
        });
    }

    await prisma.channel.update({
        where: { id: channel.id },
        data: {
            ...(trimmedName ? { name: trimmedName } : {}),
            ...(blob
                ? {
                      encryptedSecret: blob.ciphertext,
                      secretNonce: blob.nonce,
                      secretKeyId: blob.keyId
                  }
                : {}),
            ...(configJson ? { config: configJson } : {})
        }
    });

    // Credentials or config changed - reconnect so the live adapter uses them now.
    if (changingToken || changingConfig) return reconnectChannel(ownerId, channelId);
    return { status: channel.status };
}

/** Disconnect and forget a channel. */
export async function deleteChannel(ownerId: string, channelId: string): Promise<void> {
    const channel = await prisma.channel.findFirst({ where: { id: channelId, ownerId } });
    if (!channel) throw new Error("Channel not found");
    try {
        await bridgeDisconnectChannel(channelId);
    } catch {
        // The bridge may not know it (restarted); removing the record still proceeds.
    }
    await prisma.channel.delete({ where: { id: channel.id } });
}

/** Normalize a peer id to what the platform's adapter expects. WhatsApp wants a
 *  JID (<digits>@c.us) - a plain phone number is converted; other platforms take
 *  the id as entered. */
export function normalizePeerId(platform: string, raw: string): string {
    const value = raw.trim();
    if (platform === "whatsapp" && value && !value.includes("@")) {
        const digits = value.replace(/\D/g, "");
        return digits ? `${digits}@c.us` : value;
    }
    if (platform === "discord") {
        const decoded = value.startsWith("user:")
            ? value.slice("user:".length)
            : value.startsWith("channel:")
              ? value.slice("channel:".length)
              : value;
        if (!decoded.trim()) return "";
    }
    return value;
}

export interface ChannelLiveState {
    status: string;
    qr?: string;
    externalId?: string;
    /** What the channel still needs from its owner (Discord: invite, intents). */
    setup?: ChannelSetup;
}

/** Poll the bridge for a channel's live state (QR / connected), persisting a
 *  connected or errored result. Drives the whatsapp-web QR onboarding UI. */
export async function channelState(ownerId: string, channelId: string): Promise<ChannelLiveState> {
    const channel = await prisma.channel.findFirst({
        where: { id: channelId, ownerId },
        select: { id: true }
    });
    if (!channel) throw new Error("Channel not found");
    const state = await bridgeChannelState(channelId);
    if (state.status === "connected") {
        await prisma.channel.update({
            where: { id: channelId },
            data: {
                status: "connected",
                ...(state.externalId ? { externalId: state.externalId } : {})
            }
        });
    } else if (state.status === "error" || state.status === "disconnected") {
        await prisma.channel.update({ where: { id: channelId }, data: { status: state.status } });
    }
    return { status: state.status, qr: state.qr, externalId: state.externalId, setup: state.setup };
}

/**
 * The last reason each channel could not be re-established.
 *
 * This runs every minute forever, so a reason reported on every pass is a line
 * per channel per minute for as long as the condition lasts - which, for a
 * bridge that is down for an afternoon, is hundreds of copies of one fact. Kept
 * here so the same reason is said once and a *changed* one is said again, and
 * cleared the moment a channel comes back so the next failure is not swallowed
 * by the memory of the last one.
 */
const reconcileTrouble = new Map<string, string>();

/** Say it, unless it is the same thing this channel said last time. */
function reportTrouble(channelId: string, reason: string): void {
    if (reconcileTrouble.get(channelId) === reason) return;
    reconcileTrouble.set(channelId, reason);
    console.error(`reconcileChannels: could not re-establish ${channelId}:`, reason);
}

/** Re-establish live adapters in the bridge for channels the DB considers up. The
 *  bridge holds adapters in memory, so a bridge (or web) restart leaves a channel
 *  "connected" in the DB but dead at the bridge; this reconnects any whose bridge
 *  state is missing. whatsapp-web restores from its LocalAuth session without a new
 *  QR when the session is still valid. Best-effort and idempotent - channels the
 *  bridge already runs are left alone, so it never churns a healthy adapter. */
export async function reconcileChannels(): Promise<void> {
    // No bridge, nothing to reconcile - and nothing wrong. The bridge is an app
    // somebody installs, so an instance that never installed one is not a broken
    // instance, and every channel row left over from before it was removed is
    // not a fault either.
    //
    // Reported as an error this was one line per channel per minute, forever,
    // about a feature nobody had turned on. It is the first thing Polaris' own
    // telemetry caught once it started listening, and it would have buried
    // everything real underneath it.
    if (!(await bridgeConfigured())) {
        reconcileTrouble.clear();
        return;
    }

    const env = loadEnv();
    const channels = await prisma.channel.findMany({
        where: { status: { in: ["connected", "connecting"] }, platform: { not: EMAIL_PLATFORM } }
    });
    // A channel that is no longer in the list cannot report anything, and its
    // remembered reason would otherwise sit here for the life of the process.
    const present = new Set(channels.map((channel) => channel.id));
    for (const id of [...reconcileTrouble.keys()]) {
        if (!present.has(id)) reconcileTrouble.delete(id);
    }

    for (const channel of channels) {
        try {
            await bridgeChannelState(channel.id);
            // The bridge already runs an adapter for this channel (in any state), so
            // leave it. Never re-initialize a live whatsapp-web client just because it
            // reports an error - a fresh init re-links the device, which WhatsApp flags
            // as suspicious. Only (re)establish a channel whose adapter is truly gone.
            reconcileTrouble.delete(channel.id);
            continue;
        } catch {
            // Adapter absent (404) or bridge unreachable: (re)establish it below.
        }
        try {
            const token =
                channel.encryptedSecret && channel.secretNonce && channel.secretKeyId
                    ? decryptSecret(
                          {
                              ciphertext: Buffer.from(channel.encryptedSecret),
                              nonce: Buffer.from(channel.secretNonce),
                              keyId: channel.secretKeyId
                          },
                          env.POLARIS_MASTER_KEY
                      )
                    : undefined;
            let providerConfig: Record<string, string> | undefined;
            try {
                providerConfig = (
                    JSON.parse(channel.config) as { providerConfig?: Record<string, string> }
                ).providerConfig;
            } catch {
                providerConfig = undefined;
            }
            await bridgeConnectChannel({
                channelId: channel.id,
                platform: channel.platform as Platform,
                provider: channel.provider ?? undefined,
                token,
                config: providerConfig
            });
            reconcileTrouble.delete(channel.id);
        } catch (caught) {
            reportTrouble(channel.id, caught instanceof Error ? caught.message : String(caught));
        }
    }
}

/** Run channel reconcile at startup and on an interval, so channels self-heal
 *  after a bridge or web restart without any manual reconnection. */
export function startChannelReconcile(): void {
    // The pass itself handles a channel that will not come back; what reaches
    // here is the pass failing outright - the database away, mostly. Said once
    // for the same reason as the rest: on a minute timer, a condition that lasts
    // an hour is sixty copies of one sentence.
    let lastFailure: string | null = null;
    const tick = () =>
        void reconcileChannels()
            .then(() => {
                lastFailure = null;
            })
            .catch((error: unknown) => {
                const reason = error instanceof Error ? error.message : String(error);
                if (lastFailure === reason) return;
                lastFailure = reason;
                console.error("polaris: channel reconcile failed:", error);
            });
    tick();
    setInterval(tick, 60_000);
}

/**
 * Messaging channels already stored here keep running in this process
 * (channel-runtime); alerts, automation notices and two-factor codes are sent
 * through them. Channel secrets use the same AES-256-GCM master key as
 * integrations and storage credentials.
 */

import { EMAIL_PLATFORM } from "@polaris/core";
import { isWhatsAppWebProvider } from "@polaris/messaging";
import { prisma } from "@polaris/db";
import { hasWhatsAppSession } from "./messaging/whatsapp-session";
import { connectLive, connectRequestFor, liveState } from "./messaging/channel-runtime";

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

/**
 * The last reason each channel could not be re-established.
 *
 * This runs every minute forever, so a reason reported on every pass is a line
 * per channel per minute for as long as the condition lasts - which, for a
 * channel whose token stopped working for an afternoon, is hundreds of copies of one fact. Kept
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

/** Start adapters for channels the DB considers up. Adapters live in memory, so
 *  a web restart leaves a channel "connected" in the DB with nothing running;
 *  this starts any that are missing. whatsapp-web restores from its LocalAuth
 *  session without a new QR when the session is still valid; one with no session
 *  is marked disconnected instead of opening a browser nobody is watching.
 *  Best-effort and idempotent - a running adapter is never churned. */
export async function reconcileChannels(): Promise<void> {
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
        // Already running here (in any state): leave it. Never re-initialize a live
        // whatsapp-web client just because it reports an error - a fresh init
        // re-links the device, which WhatsApp flags as suspicious.
        if (liveState(channel.id)) {
            reconcileTrouble.delete(channel.id);
            continue;
        }
        try {
            if (channel.platform === "whatsapp" && isWhatsAppWebProvider(channel.provider)) {
                if (!hasWhatsAppSession(channel.id)) {
                    await prisma.channel.update({
                        where: { id: channel.id },
                        data: { status: "disconnected" }
                    });
                    continue;
                }
            }
            await connectLive(connectRequestFor(channel));
            reconcileTrouble.delete(channel.id);
        } catch (caught) {
            reportTrouble(channel.id, caught instanceof Error ? caught.message : String(caught));
        }
    }
}

/** Run channel reconcile at startup and on an interval, so channels self-heal
 *  after a restart without any manual reconnection. */
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

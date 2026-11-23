/**
 * Members the server runs: Polar, and the webhooks of a channel.
 *
 * Each kind is one fixed service account id, a UUID with version nibble 0, which
 * neither `uuid(7)` nor `gen_random_uuid()` can ever give a person - so an MLS
 * address stays `${userId}/${device}` and nothing that keys on an account needs a
 * new shape (docs/chat-e2ee-mls.md, "Server-run members").
 *
 * A service account reaches a conversation only through what puts it there, and
 * `channelAccess` answers it from here, so every check the MLS route makes about
 * an account - claiming its key packages, a Welcome to it, its history-key
 * envelope - holds for it the way it holds for a person:
 *
 * - Polar where somebody added it: a `ChatServiceMember` row (`service: "polar"`),
 *   not a `ChatChannelMember` one - that is an account's, with a read mark, a
 *   role and a timeout, and Polar has no account. The row goes with the channel.
 * - A webhook in its own channel: it belongs there already (`ChatWebhook`), so it
 *   needs no row.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";

export const POLAR_SERVICE_ID = "00000000-0000-0000-0000-000000000001";
export const WEBHOOK_SERVICE_ID = "00000000-0000-0000-0000-000000000002";

/** The `service` a `ChatServiceMember` row names. */
export const POLAR_SERVICE = "polar";

export type ServiceKind = "polar" | "webhook";

/** Which service an account id is, or null for a person. */
export function serviceKind(accountId: string): ServiceKind | null {
    if (accountId === POLAR_SERVICE_ID) return "polar";
    if (accountId === WEBHOOK_SERVICE_ID) return "webhook";
    return null;
}

/**
 * A service member's MLS device id. Polar runs one device per conversation, a
 * webhook one per webhook (a webhook belongs to one channel): a member is
 * restored from all of its store at once, so one device across every group would
 * load every group for every message.
 */
export function serviceDevice(owner: string): string {
    return owner.replaceAll("-", "");
}

/** Whether a service account reaches this conversation. */
export async function serviceReaches(kind: ServiceKind, channelId: string): Promise<boolean> {
    if (kind === "webhook") return (await prisma.chatWebhook.count({ where: { channelId }, take: 1 })) > 0;
    const row = await prisma.chatServiceMember.findUnique({
        where: { channelId_service: { channelId, service: POLAR_SERVICE } },
        select: { channelId: true }
    });
    return row !== null;
}

/** Whether Polar is a member of this conversation. */
export function polarAdded(channelId: string): Promise<boolean> {
    return serviceReaches("polar", channelId);
}

/**
 * Add Polar to a conversation, on behalf of somebody who may add people there
 * (the caller checks that). Adding it twice is the same as once.
 */
export async function addPolar(addedById: string, channelId: string): Promise<void> {
    await prisma.chatServiceMember.upsert({
        where: { channelId_service: { channelId, service: POLAR_SERVICE } },
        create: { channelId, service: POLAR_SERVICE, addedById },
        update: {}
    });
}

/** Take Polar out of a conversation; one it is not in is left as it is. */
export async function removePolar(channelId: string): Promise<void> {
    await prisma.chatServiceMember.deleteMany({ where: { channelId, service: POLAR_SERVICE } });
}

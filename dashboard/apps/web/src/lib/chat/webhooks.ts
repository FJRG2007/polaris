/**
 * Incoming webhooks: an address something outside Polaris posts into a channel
 * through - a CI run, a monitor, a form.
 *
 * Discord's model, and Discord's request body (`content`, `username`), so the
 * tools that already speak to a Discord webhook speak to this by changing the
 * address. Whoever runs the channel makes, renames, resets and deletes them from
 * the channel's settings.
 *
 * **The address is the whole credential.** It carries a secret, and only the
 * secret's hash is stored: the full address is shown once, when the webhook is
 * made or its secret reset, and never again - the same as an API key. Resetting
 * is how a leaked address is taken back without breaking the others.
 *
 * What a webhook may do is post into its one channel and nothing else: it has no
 * account, so it reaches no other room, reads nothing, and its `@` mentions are
 * text rather than notifications.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { unfurlLater } from "./messages";
import { publishChatChange } from "./live";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ChatAccessError, requireChannel, type ChatActor } from "./access";

/** One webhook, as the channel's settings list it. Never carries the secret. */
export interface ChatWebhookView {
    readonly id: string;
    readonly name: string;
    readonly createdBy: string | null;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
}

/** A webhook just made or reset: the one moment the secret is known. */
export interface ChatWebhookSecret {
    readonly webhook: ChatWebhookView;
    /** The secret half of its address: `/api/chat/webhooks/<id>/<token>`. */
    readonly token: string;
}

/** The webhooks on one channel, oldest first. Whoever runs the channel. */
export async function listWebhooks(
    actor: ChatActor,
    channelId: string
): Promise<readonly ChatWebhookView[]> {
    await requireManager(actor, channelId);
    const rows = await prisma.chatWebhook.findMany({
        where: { channelId },
        orderBy: { createdAt: "asc" },
        take: core.MAX_CHAT_WEBHOOKS,
        select: SELECT
    });
    return viewsOf(rows);
}

/** Make one. The answer carries the secret, once. */
export async function createWebhook(
    actor: ChatActor,
    input: core.ChatWebhookCreateInput
): Promise<ChatWebhookSecret> {
    await requireManager(actor, input.channelId);
    const count = await prisma.chatWebhook.count({ where: { channelId: input.channelId } });
    if (count >= core.MAX_CHAT_WEBHOOKS) {
        throw new ChatAccessError({
            key: "errors.tooManyWebhooks",
            params: { count: core.MAX_CHAT_WEBHOOKS }
        });
    }
    const token = newToken();
    const row = await prisma.chatWebhook.create({
        data: {
            channelId: input.channelId,
            name: input.name,
            tokenHash: hashOf(token),
            createdById: actor.id
        },
        select: SELECT
    });
    const [webhook] = await viewsOf([row]);
    return { webhook: webhook!, token };
}

/** Rename one. The name is what its messages carry unless a request asks for
 *  another. */
export async function renameWebhook(
    actor: ChatActor,
    input: core.ChatWebhookRenameInput
): Promise<void> {
    const found = await ownedWebhook(actor, input.webhookId);
    await prisma.chatWebhook.update({ where: { id: found.id }, data: { name: input.name } });
}

/** A new secret, which stops the old address working at once. */
export async function resetWebhook(
    actor: ChatActor,
    webhookId: string
): Promise<ChatWebhookSecret> {
    const found = await ownedWebhook(actor, webhookId);
    const token = newToken();
    const row = await prisma.chatWebhook.update({
        where: { id: found.id },
        data: { tokenHash: hashOf(token) },
        select: SELECT
    });
    const [webhook] = await viewsOf([row]);
    return { webhook: webhook!, token };
}

/** Delete one. What it already posted stays, under the name it posted with. */
export async function deleteWebhook(actor: ChatActor, webhookId: string): Promise<void> {
    const found = await ownedWebhook(actor, webhookId);
    await prisma.chatWebhook.delete({ where: { id: found.id } });
}

/** The webhook an address names, when its secret is right - or null, for every
 *  way it can be wrong, so a caller cannot tell an unknown id from a bad
 *  secret. */
export async function webhookFor(
    id: string,
    token: string
): Promise<{ id: string; channelId: string; name: string } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
    const row = await prisma.chatWebhook.findUnique({
        where: { id },
        select: { id: true, channelId: true, name: true, tokenHash: true }
    });
    if (!row) return null;
    const presented = Buffer.from(hashOf(token), "hex");
    const stored = Buffer.from(row.tokenHash, "hex");
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;
    return { id: row.id, channelId: row.channelId, name: row.name };
}

/**
 * Post a message through a webhook.
 *
 * The channel's own rules still hold where they are about the room rather than
 * about a person: an archived channel, or one in an archived space, takes
 * nothing. Slow mode and the per-person rate are about people talking over each
 * other and do not apply - the route's own limit is what holds a webhook back.
 *
 * @returns The id of the message, for a caller that asked to wait for it.
 */
export async function postThroughWebhook(
    webhook: { id: string; channelId: string; name: string },
    input: core.ChatWebhookExecuteInput
): Promise<string> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: webhook.channelId },
        select: { archived: true, space: { select: { archived: true } } }
    });
    if (!channel || channel.archived || channel.space?.archived) {
        throw new ChatAccessError({ key: "errors.conversationArchived" });
    }

    const label = input.username?.trim() || webhook.name;
    const id = await prisma.$transaction(async (tx) => {
        const message = await tx.chatMessage.create({
            data: {
                channelId: webhook.channelId,
                authorId: null,
                kind: "text",
                body: input.content,
                webhookId: webhook.id,
                authorLabel: label
            },
            select: { id: true, createdAt: true }
        });
        await tx.chatChannel.update({
            where: { id: webhook.channelId },
            data: { lastMessageAt: message.createdAt }
        });
        // `updateMany`, so a webhook deleted while its request was in flight
        // still lands the message it was already let through for.
        await tx.chatWebhook.updateMany({
            where: { id: webhook.id },
            data: { lastUsedAt: message.createdAt }
        });
        return message.id;
    });

    publishChatChange({ channelId: webhook.channelId, kind: "posted", actorId: "" });
    unfurlLater(input.content);
    return id;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SELECT = {
    id: true,
    name: true,
    createdById: true,
    createdAt: true,
    lastUsedAt: true
} as const;

/** Managing a channel's webhooks is running the channel: Discord's Manage
 *  Webhooks, which in Polaris is the same standing as the rest of its
 *  settings. */
async function requireManager(actor: ChatActor, channelId: string): Promise<void> {
    const access = await requireChannel(actor, channelId);
    if (!access.spaceId || !access.mayAdminister) {
        throw new ChatAccessError({ key: "errors.channelChangeNotAllowed" });
    }
}

async function ownedWebhook(actor: ChatActor, webhookId: string): Promise<{ id: string }> {
    const found = await prisma.chatWebhook.findUnique({
        where: { id: webhookId },
        select: { id: true, channelId: true }
    });
    if (!found) throw new ChatAccessError({ key: "errors.webhookGone" });
    await requireManager(actor, found.channelId);
    return found;
}

/** 48 URL-safe characters: 288 bits, the same order as an API key. */
function newToken(): string {
    return randomBytes(36).toString("base64url");
}

function hashOf(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

async function viewsOf(
    rows: readonly {
        id: string;
        name: string;
        createdById: string | null;
        createdAt: Date;
        lastUsedAt: Date | null;
    }[]
): Promise<ChatWebhookView[]> {
    const ids = [
        ...new Set(rows.map((row) => row.createdById).filter((id): id is string => id !== null))
    ];
    const people = ids.length
        ? await prisma.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, name: true }
          })
        : [];
    const names = new Map(people.map((person) => [person.id, person.name]));
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null
    }));
}

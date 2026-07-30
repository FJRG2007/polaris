"use server";

/**
 * Email-channel actions. Separate from the messaging actions next door because
 * nothing here touches the bridge: mail is sent by this process, so a channel is
 * stored, its credentials checked, and a test message put through, all in the
 * request that asked for it.
 *
 * A channel belongs to whoever added it. The settings arrive as plain strings
 * from the form and are only ever used after the provider's own schema has
 * accepted them (parseMailConfig, inside the service).
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { emailField } from "@polaris/core";
import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { requireUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit-service";
import {
    createEmailChannel,
    deleteEmailChannel,
    recheckEmailChannel,
    sendThroughChannel,
    updateEmailChannel,
    type EmailChannelView
} from "@/lib/mail-service";
import { EMAIL_PLATFORM } from "@polaris/core";

/** Test messages cost the provider's quota and can be aimed anywhere, so they
 *  are throttled per user rather than left open. */
const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 10 * 60 * 1000;

const channelInputSchema = z.object({
    provider: z.string().trim().min(1).max(32),
    name: z.string().trim().min(1).max(64),
    /** Omitted on an update to keep the stored credential. */
    secret: z.string().trim().min(1).max(4096).optional(),
    settings: z.record(z.string(), z.string().trim().max(512))
});

const channelIdSchema = z.string().uuid();

type ChannelResult = { channel?: EmailChannelView; error?: string };

/** Confirm the signed-in user owns this email channel before acting on it. */
async function requireOwnedChannel(userId: string, channelId: string): Promise<boolean> {
    const row = await prisma.channel.findFirst({
        where: { id: channelId, ownerId: userId, platform: EMAIL_PLATFORM },
        select: { id: true }
    });
    return row !== null;
}

export async function createEmailChannelAction(input: unknown): Promise<ChannelResult> {
    const user = await requireUser();
    const parsed = channelInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    const result = await createEmailChannel(user.id, parsed.data);
    if (result.channel) {
        await recordAudit({
            actorId: user.id,
            action: "email-channel.created",
            targetType: "channel",
            targetId: result.channel.id,
            metadata: { provider: result.channel.provider }
        });
        revalidatePath("/inbox/channels");
    }
    return result;
}

export async function updateEmailChannelAction(channelId: unknown, input: unknown): Promise<ChannelResult> {
    const user = await requireUser();
    const id = channelIdSchema.safeParse(channelId);
    const parsed = channelInputSchema.safeParse(input);
    if (!id.success || !parsed.success) return { error: "Check the form." };
    if (!(await requireOwnedChannel(user.id, id.data))) return { error: "That channel no longer exists." };
    const result = await updateEmailChannel(id.data, parsed.data);
    if (result.channel) {
        await recordAudit({
            actorId: user.id,
            action: "email-channel.updated",
            targetType: "channel",
            targetId: id.data
        });
        revalidatePath("/inbox/channels");
    }
    return result;
}

export async function deleteEmailChannelAction(channelId: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const id = channelIdSchema.safeParse(channelId);
    if (!id.success) return { error: "Unknown channel." };
    if (!(await requireOwnedChannel(user.id, id.data))) return { error: "That channel no longer exists." };
    await deleteEmailChannel(id.data);
    await recordAudit({
        actorId: user.id,
        action: "email-channel.deleted",
        targetType: "channel",
        targetId: id.data
    });
    revalidatePath("/inbox/channels");
    return {};
}

/** Re-run the credential check, for a channel whose key was rotated elsewhere. */
export async function recheckEmailChannelAction(channelId: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const id = channelIdSchema.safeParse(channelId);
    if (!id.success) return { error: "Unknown channel." };
    if (!(await requireOwnedChannel(user.id, id.data))) return { error: "That channel no longer exists." };
    const result = await recheckEmailChannel(id.data);
    revalidatePath("/inbox/channels");
    return result;
}

/**
 * Put a real message through the channel. The only check that proves the whole
 * path works, because it is the only one that exercises the sending address -
 * the reason mail does not arrive is almost always that the provider has not
 * been told the From address belongs to you.
 */
export async function sendTestEmailAction(channelId: unknown, to: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const id = channelIdSchema.safeParse(channelId);
    const address = emailField.safeParse(to);
    if (!id.success) return { error: "Unknown channel." };
    if (!address.success) return { error: "Enter the address to send the test to." };
    if (!(await requireOwnedChannel(user.id, id.data))) return { error: "That channel no longer exists." };

    const throttle = await rateLimit(`email-test:${user.id}`, TEST_LIMIT, TEST_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many test messages. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
    }

    const result = await sendThroughChannel(id.data, {
        to: address.data,
        subject: "Polaris test message",
        text: "This is a test from Polaris. If it reached you, this channel can send mail."
    });
    revalidatePath("/inbox/channels");
    return result;
}

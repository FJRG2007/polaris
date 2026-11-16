"use server";

/**
 * Disappearing messages, delete for me, and deleting a chat - see
 * `lib/chat/vanish`, which checks membership and the instance's mode on every
 * call. Each input is parsed here first.
 */

import { z } from "zod";
import * as vanish from "@/lib/chat/vanish";
import { guardChat } from "@/lib/chat/chat-guard";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { VANISH_DURATIONS } from "@/lib/chat/vanish-rules";

async function actor(): Promise<{ id: string; name: string }> {
    const user = await requirePermission("chat.use");
    return { id: user.id, name: user.name };
}

const idSchema = z.string().uuid();
const durationSchema = z.number().int().refine((value) => (VANISH_DURATIONS as readonly number[]).includes(value));
const proposalSchema = z.object({ vanishAfter: durationSchema, deleteForAll: z.boolean() }).strict();

async function refused(key: "errors.notInConversation" | "errors.messageGone" | "errors.vanishBadDuration" | "errors.proposalGone") {
    return { error: (await getTranslations("chat"))(key) };
}

/** The rules of one conversation as this reader may use them, or null where
 *  it has none. */
export async function directRulesAction(
    channelId: unknown
): Promise<{ rules?: vanish.DirectRulesView | null; error?: string }> {
    const me = await actor();
    const parsed = idSchema.safeParse(channelId);
    if (!parsed.success) return refused("errors.notInConversation");
    const result = await guardChat(() => vanish.directRulesFor(me, parsed.data));
    return result.error ? { error: result.error } : { rules: result.value ?? null };
}

export async function setVanishTimerAction(
    channelId: unknown,
    seconds: unknown
): Promise<{ error?: string }> {
    const me = await actor();
    const channel = idSchema.safeParse(channelId);
    if (!channel.success) return refused("errors.notInConversation");
    const duration = durationSchema.safeParse(seconds);
    if (!duration.success) return refused("errors.vanishBadDuration");
    return guardChat(() => vanish.setVanishTimer(me, channel.data, duration.data));
}

export async function proposeRulesAction(
    channelId: unknown,
    proposal: unknown
): Promise<{ error?: string }> {
    const me = await actor();
    const channel = idSchema.safeParse(channelId);
    if (!channel.success) return refused("errors.notInConversation");
    const parsed = proposalSchema.safeParse(proposal);
    if (!parsed.success) return refused("errors.vanishBadDuration");
    return guardChat(() => vanish.proposeRules(me, channel.data, parsed.data));
}

export async function answerProposalAction(
    proposalId: unknown,
    accept: unknown
): Promise<{ error?: string }> {
    const me = await actor();
    const id = idSchema.safeParse(proposalId);
    const answer = z.boolean().safeParse(accept);
    if (!id.success || !answer.success) return refused("errors.proposalGone");
    return guardChat(() => vanish.answerProposal(me, id.data, answer.data));
}

/** Delete a message for me only. */
export async function hideMessageAction(messageId: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = idSchema.safeParse(messageId);
    if (!parsed.success) return refused("errors.messageGone");
    return guardChat(() => vanish.hideMessage(me, parsed.data));
}

/** Delete the chat for me only. */
export async function clearChatAction(channelId: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = idSchema.safeParse(channelId);
    if (!parsed.success) return refused("errors.notInConversation");
    return guardChat(() => vanish.clearChatForMe(me, parsed.data));
}

/** Delete the chat for everybody in it. */
export async function deleteChatForAllAction(channelId: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = idSchema.safeParse(channelId);
    if (!parsed.success) return refused("errors.notInConversation");
    return guardChat(() => vanish.deleteChatForAll(me, parsed.data));
}

/**
 * Ask a poll from the chat screen. With sealed chat on, the question and its
 * answers are sealed in this browser and the server keeps only how many
 * answers there are, the rules and the votes; it is never sent in the clear
 * instead. Off, it is the plain server action.
 */

import * as core from "@polaris/core";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import * as actions from "./actions";

export async function sendPoll(input: core.ChatPollCreateInput, notSent: string): Promise<{ id?: string; error?: string }> {
    if (!(await sealedChat.sealsSendsIn(input.channelId))) return actions.createPollAction(input);
    const parsed = core.chatPollCreateSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? notSent };
    const { channelId, question, options, multiple, hideResults, anonymous, hours } = parsed.data;
    try {
        const id = await sealedChat.sendSealedMessage({
            channelId,
            body: question,
            clientKey: crypto.randomUUID(),
            parentId: parsed.data.parentId ?? null,
            replyToId: parsed.data.replyToId ?? null,
            poll: { options },
            pollRules: { multiple, hideResults, anonymous, hours }
        });
        return { id };
    } catch (caught) {
        console.warn("polaris: a sealed poll was not sent:", caught);
        return { error: notSent };
    }
}

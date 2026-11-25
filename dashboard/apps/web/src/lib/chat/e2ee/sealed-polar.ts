/**
 * Polar answering in a sealed conversation (docs/chat-e2ee-mls.md,
 * "Server-run members"): the server holds no text for a sealed question, so
 * where Polar was added it opens the question with its own MLS device, and
 * answers sealed from that device the way a person's device would.
 *
 * Only MLS work runs under the device's lease (`withServiceDevice`): opening
 * the question, then the conversation it reads, then sealing the answer. The
 * model's answer is written between them, outside it, so one slow answer never
 * holds the device another message needs.
 *
 * A change Polar offers here is sealed in its answer and kept sealed for its
 * approval (`polar-calls.ts`); "Approve" and "Cancel" seal what follows over
 * the offer from the same device (`approveSealedPolar`, `cancelSealedPolar`).
 *
 * Nothing here runs while `sealedChatServed()` is off, nor where Polar is not
 * a member: its device reaches only conversations it was added to.
 *
 * Server-only.
 */

import { sealedChatServed } from "./flag";
import * as polar from "@/lib/chat/polar-mention";
import { withServiceDevice } from "./service-device";
import { polarAdded } from "@/lib/chat/service-members";
import { polarMentioned } from "@/components/rich-text/markdown";
import { decodeSealedContent, encodeSealedContent } from "./sealed-chat";
import type { DoneCall } from "@/lib/chat/polar-calls";
import { updateAgentMessage } from "@/lib/chat/agent-message";

export interface SealedQuestion {
    readonly channelId: string;
    readonly messageId: string;
    readonly authorId: string;
    readonly parentId: string | null;
    readonly replyToId: string | null;
}

/** The text of these sealed messages as Polar's device in the conversation opens them. */
async function openAsPolar(channelId: string, ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await withServiceDevice("polar", channelId, async (device) => {
        // Joins the group on first use: from the Welcome a person's device sent it, or by its own external commit.
        await device.ensureGroup(channelId);
        return device.readSealed(channelId, [...ids]);
    });
    const out = new Map<string, string>();
    for (const row of rows) {
        const content = row.opened ? decodeSealedContent(row.opened) : null;
        if (content?.body) out.set(row.id, content.body);
    }
    return out;
}

/** How Polar reads and writes in this sealed conversation, all through its own device there. */
function sealedReply(question: SealedQuestion): polar.SealedReply {
    const { channelId } = question;
    return {
        open: (ids) => openAsPolar(channelId, ids),
        post: (answer) =>
            withServiceDevice("polar", channelId, async (device) => {
                await device.ensureGroup(channelId);
                return device.sendSealed(channelId, encodeSealedContent({ body: answer }), {
                    parentId: question.parentId,
                    replyToId: question.messageId
                });
            }),
        rewrite: (messageId, answer) =>
            withServiceDevice("polar", channelId, async (device) => {
                await device.ensureGroup(channelId);
                await device.editSealed(channelId, messageId, encodeSealedContent({ body: answer }));
            })
    };
}

/** Answer a sealed message if it asks Polar: the id of Polar's answer, or null when it did not ask. */
export async function answerSealedPolar(question: SealedQuestion): Promise<string | null> {
    if (!sealedChatServed() || !(await polarAdded(question.channelId))) return null;
    const body = (await openAsPolar(question.channelId, [question.messageId])).get(question.messageId);
    if (!body) return null;
    const replied = polarMentioned(body) ? false : await polar.repliesToPolar(question.channelId, question.replyToId);
    if (!polar.asksPolar(body, replied) || !polar.claimPolarAnswer(question.messageId)) return null;
    return polar.answerPolarMention({ ...question, body }, null, [], sealedReply(question));
}

/**
 * "Try again" under Polar's sealed answer `answerId` to the sealed `question`:
 * asked again, the new answer sealed over the old one. Null when Polar can no
 * longer open the question (sealed chat off, Polar taken out, the question
 * from before it was added), so the press is answered as gone.
 */
export async function retrySealedPolar(question: SealedQuestion, answerId: string): Promise<string | null> {
    if (!sealedChatServed() || !(await polarAdded(question.channelId))) return null;
    const body = (await openAsPolar(question.channelId, [question.messageId])).get(question.messageId);
    if (!body) return null;
    return polar.answerPolarMention({ ...question, body }, answerId, [], sealedReply(question));
}

/** Called for every sealed message a person sends; never throws, never holds the send up. */
export function answerSealedPolarLater(question: SealedQuestion): void {
    void answerSealedPolar(question).catch((error: unknown) => console.error("chat: Polar could not answer a sealed mention:", error));
}

/**
 * "Approve" under a change Polar offered in answer `answerId` to the sealed
 * `question`: Polar's device opens the question, `run` runs the change (the
 * changes done so far, or null when the asker can no longer act), and the
 * answer saying what was done is sealed over the offer. False, with nothing
 * run, when Polar can no longer open the question.
 */
export async function approveSealedPolar(
    question: SealedQuestion,
    answerId: string,
    run: () => Promise<readonly DoneCall[] | null>
): Promise<boolean> {
    if (!sealedChatServed() || !(await polarAdded(question.channelId))) return false;
    const body = (await openAsPolar(question.channelId, [question.messageId])).get(question.messageId);
    if (!body) return false;
    const done = await run();
    if (!done) return false;
    await polar.answerPolarMention({ ...question, body }, answerId, done, sealedReply(question));
    return true;
}

/**
 * "Cancel" under a change Polar offered in its sealed answer `answerId`: the
 * answer becomes `text`, sealed by Polar's device, and its buttons come off.
 * Where Polar can no longer seal there, only the buttons come off: nothing
 * runs either way.
 */
export async function cancelSealedPolar(channelId: string, answerId: string, text: string): Promise<void> {
    if (sealedChatServed() && (await polarAdded(channelId))) {
        await withServiceDevice("polar", channelId, async (device) => {
            await device.ensureGroup(channelId);
            await device.editSealed(channelId, answerId, encodeSealedContent({ body: text }));
        }).catch((error: unknown) => console.error("chat: Polar could not seal a cancelled change:", error));
    }
    await updateAgentMessage({ messageId: answerId, channelId, agent: polar.POLAR_AGENT, components: [], edited: false });
}

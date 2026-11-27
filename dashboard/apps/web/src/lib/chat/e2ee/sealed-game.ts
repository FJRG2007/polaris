/**
 * The game bridge in a sealed conversation (docs/chat-e2ee-mls.md,
 * "Server-run members"): where an operator shows a conversation in a game's
 * chat for everybody playing, the server holds no words to show, so a member
 * it runs - the game bridge, one MLS device per conversation - opens each
 * message the way a person's device would and hands the game what it opened.
 *
 * It reaches a conversation only while a game shows it (`serviceReaches`), so
 * it joins the group when the link is made and its leaf goes when the link
 * does: the next member to send finds it departed and removes it. It posts
 * nothing. What reaches it is read by whoever runs Polaris and by everybody
 * on that game server, which the conversation's info says.
 *
 * Nothing here runs while `sealedChatServed()` is off.
 *
 * Server-only.
 */

import { sealedChatServed } from "./flag";
import { conversationSealed } from "./sealed-conversation";
import { serviceReaches } from "@/lib/chat/service-members";
import { decodeSealedContent, type SealedContent } from "./sealed-chat";
import { forgetServiceDevice, withServiceDevice } from "./service-device";

/**
 * What the game bridge opens of one sealed message in a conversation a game
 * shows, or null: sealed chat off, no game showing it, or a message it cannot
 * open (sealed before it joined, or not signed by its sender's device).
 */
export async function openForGame(channelId: string, messageId: string): Promise<SealedContent | null> {
    if (!sealedChatServed() || !(await serviceReaches("game", channelId))) return null;
    const rows = await withServiceDevice("game", channelId, async (device) => {
        // Joins on first use, by its own external commit: what was sealed before stays closed to it.
        await device.ensureGroup(channelId);
        return device.readSealed(channelId, [messageId]);
    });
    const row = rows.find((one) => one.id === messageId);
    return row?.opened ? decodeSealedContent(row.opened) : null;
}

/**
 * Bring the game bridge in step with a conversation's link: joined where a game
 * now shows a sealed conversation, so it opens what is said from then on rather
 * than from the message after the first; forgotten where none does, so the
 * server keeps no key of a conversation it no longer shows. Never throws: the
 * link is saved either way, and the next message shown joins it.
 */
export async function syncGameBridge(channelId: string): Promise<void> {
    if (!sealedChatServed()) return;
    try {
        if (await serviceReaches("game", channelId)) {
            if (!(await conversationSealed(channelId))) return;
            await withServiceDevice("game", channelId, async (device) => void (await device.ensureGroup(channelId)));
        } else {
            await forgetServiceDevice("game", channelId);
        }
    } catch (error) {
        console.error("chat: the game bridge could not follow a conversation's link:", error);
    }
}

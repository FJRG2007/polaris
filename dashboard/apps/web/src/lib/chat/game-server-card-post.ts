/**
 * Telling somebody they were let onto a game server: the card in a direct
 * message with whoever let them in, and a line in their bell that opens it.
 *
 * Never at the cost of the grant. A person who is blocked, or who cannot be
 * messaged, still has their access; they simply get no message about it.
 */

import * as messages from "./messages";
import { openDirect } from "./chat-service";
import { postNoticeBody } from "./notices";
import { gameInviteMark, gameServerMark } from "./game-server-card";
import { translatorFor } from "@/lib/i18n/translate";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { createNotification } from "@/lib/notification-service";
import { gameServerCardFacts } from "@/lib/app-extensions/registry";

export async function announceGameServerAccess(input: {
    readonly sharer: { readonly id: string; readonly name: string };
    readonly targetId: string;
    readonly ownerId: string;
    readonly installedAppId: string;
    readonly serverName: string;
}): Promise<void> {
    // Nobody is told about access they gave themselves.
    if (input.targetId === input.sharer.id) return;
    try {
        // Only a game server has an address to hand over; any other app shared
        // the same way is told about in the usual places.
        if (!(await gameServerCardFacts(input.ownerId, input.installedAppId))) return;
        const channelId = await openDirect({ id: input.sharer.id }, [input.targetId]);
        await postNoticeBody(channelId, gameServerMark(input.installedAppId), input.sharer.id);
        const t = translatorFor(await getUserLocale(input.targetId), "chat");
        await createNotification({
            userId: input.targetId,
            type: "games.access",
            title: t("gameServerCard.notification", {
                name: input.sharer.name,
                server: input.serverName
            }),
            href: `/chat/c/${channelId}`
        });
    } catch (caught) {
        console.error("games: could not tell somebody about a server they were let onto", caught);
    }
}

/**
 * The invite a person gets when somebody adds them as a player: a direct message
 * from whoever did it, drawn as the server's card. Sent as that person because
 * it is their own click - the same as sending somebody a chat invite - and
 * through the same checks a message they typed would pass, so somebody who does
 * not take messages from them is not reached this way.
 *
 * @param input.fallback - What a screen that shows messages as text reads, in
 *   the invited person's language.
 * @returns "chat" once the message is in the conversation, or null when it could
 *   not be sent, for the caller to tell them some other way.
 */
export async function sendGamePlayerInvite(input: {
    readonly inviterId: string;
    readonly targetId: string;
    readonly installedAppId: string;
    readonly player: string;
    readonly fallback: string;
}): Promise<"chat" | null> {
    if (input.targetId === input.inviterId) return null;
    try {
        const actor = { id: input.inviterId };
        const body = gameInviteMark(input.installedAppId, input.player, input.fallback);
        const channelId = await openDirect(actor, [input.targetId]);
        await messages.send(actor, { channelId, body, replyToId: null }, [], null);
        return "chat";
    } catch (caught) {
        console.error("games: a player invite could not be sent in Chat", caught);
        return null;
    }
}

/**
 * Telling somebody they were let onto a game server: the card in a direct
 * message with whoever let them in, and a line in their bell that opens it.
 *
 * Never at the cost of the grant. A person who is blocked, or who cannot be
 * messaged, still has their access; they simply get no message about it.
 */

import { openDirect } from "./chat-service";
import { postNoticeBody } from "./notices";
import { gameServerMark } from "./game-server-card";
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

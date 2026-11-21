/**
 * Whether a message's link may be looked up and drawn as a card (ledger row 4).
 *
 * A preview is fetched by this server, which learns every address somebody
 * posts, and drawn or played in every reader's browser, which tells the site
 * who is reading. Three switches can stop it, any one of them enough:
 *
 * - the instance (`chat.linkPreviews` = "off"), for a deployment where no
 *   address may leave at all;
 * - the conversation (`ChatChannel.linkPreviews`), for one room;
 * - the author (`UserPrivacy.linkPreviews`), for everything they send.
 *
 * All three start on, so an existing deployment draws exactly what it drew.
 * Off means no fetch, no card and no embedded player - the address stays in
 * the text as a link like any other.
 */

import { prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";

/** The instance switch. Anything but "off" leaves previews on. */
export const LINK_PREVIEWS_KEY = "chat.linkPreviews";

/** Whether the instance allows link previews at all. */
export async function instancePreviewsAllowed(): Promise<boolean> {
    return (await getSetting(LINK_PREVIEWS_KEY)) !== "off";
}

/** Turn previews off for the whole instance, or back on. */
export async function setInstancePreviews(allowed: boolean): Promise<void> {
    await setSetting(LINK_PREVIEWS_KEY, allowed ? null : "off");
}

/** One message as this check needs it. */
export interface PreviewSubject {
    readonly id: string;
    readonly channelId: string;
    readonly authorId: string | null;
}

/**
 * Which of these messages may not have their link looked up or drawn.
 *
 * Two small reads at most, and none when the instance has them off - then
 * every one is withheld.
 */
export async function previewsWithheld(rows: readonly PreviewSubject[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    if (!(await instancePreviewsAllowed())) return new Set(rows.map((row) => row.id));
    const channelIds = [...new Set(rows.map((row) => row.channelId))];
    const authorIds = [
        ...new Set(rows.map((row) => row.authorId).filter((id): id is string => id !== null))
    ];
    const [quietRooms, quietAuthors] = await Promise.all([
        prisma.chatChannel.findMany({
            where: { id: { in: channelIds }, linkPreviews: false },
            select: { id: true }
        }),
        authorIds.length
            ? prisma.userPrivacy.findMany({
                  where: { userId: { in: authorIds }, linkPreviews: false },
                  select: { userId: true }
              })
            : Promise.resolve([])
    ]);
    const rooms = new Set(quietRooms.map((row) => row.id));
    const authors = new Set(quietAuthors.map((row) => row.userId));
    return new Set(
        rows
            .filter(
                (row) =>
                    rooms.has(row.channelId) || (row.authorId !== null && authors.has(row.authorId))
            )
            .map((row) => row.id)
    );
}

/** Whether one message's link may be looked up. */
export async function previewAllowed(subject: PreviewSubject): Promise<boolean> {
    return !(await previewsWithheld([subject])).has(subject.id);
}
